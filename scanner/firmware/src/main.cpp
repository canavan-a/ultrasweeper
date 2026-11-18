// scanner — police scanner firmware (M1: see the air).
//
// Two nRF24L01+ modules receive BLE advertising packets directly. The
// loophole: every BLE advertisement on the air uses the same fixed
// access address (0x8E89BED6) at 1 Mbps GFSK, which an nRF24 can
// demodulate. We point each module's RX pipe at that address (with
// each address byte bit-reversed, as the nRF24 expects), turn CRC and
// auto-ACK off, and receive fixed 32-byte blobs. A small baseband
// shim — bit-reverse, de-whiten with the per-channel BLE LFSR, verify
// the 24-bit BLE CRC — then says "real packet" or "noise". The raw
// (de-whitened) PDU bytes go out as text records; nothing is
// interpreted on-device. See ../PROTOCOL.md for the stream spec.
//
// Radio A hops BLE channels 37<->39 (nRF 2<->80), radio B holds 38
// (nRF 26): every advertiser is heard on at least one channel per
// advertising event. The ESP32's own radios are torn down at boot, so
// the device emits no RF and never detects itself.
//
// Pins, channels, timing: build_flags in platformio.ini. Output is
// line records on UART0 -> the onboard USB bridge -> whatever USB host
// is attached (phone app, laptop, scripts).

#include <Arduino.h>
#include <SPI.h>
#include <stdint.h>
#include <string.h>

#include <esp_bt.h>
#include <esp_bt_main.h>
#include <esp_mac.h>
#include <esp_system.h>
#include <esp_wifi.h>

#include "RF24.h"

namespace {

// ---------------------------------------------------------------- setup

// Both radios share the VSPI bus; CE/CSN select the module. Statics so
// nothing touches the heap at runtime (repo convention).
//
// ScanRadio just re-exposes read_register (protected in RF24) so we
// can forward the raw RPD/power register (0x09) instead of only the
// single RPD bit that getRPD() returns — on L01P clones that register
// is a 7-bit coarse power reading.
class ScanRadio : public RF24 {
      public:
	using RF24::RF24;
	uint8_t reg(uint8_t r) { return read_register(r); }
	uint8_t power_register() { return reg(0x09); } // RPD/power byte
};

ScanRadio radioA{SCANNER_A_CE, SCANNER_A_CSN};
ScanRadio radioB{SCANNER_B_CE, SCANNER_B_CSN};

// BLE access address 0x8E89BED6 with each byte bit-reversed (nRF24
// clocks bits out MSB-first, BLE LSB-first): air order is
// 8E->71, 89->91, BE->7D, D6->6B. The nRF24 transits/checks the
// address least-significant byte of the register first, and RF24's
// openReadingPipe writes the uint64's LSB into byte 0 — so the value
// here is little-endian air order. Four-byte address width.
constexpr uint64_t kAccessAddress = 0x6B7D9171ULL;

// Diagnostic mode (SCANNER_DIAG=1): address width 2 with an arbitrary
// 2-byte pattern, the RF24 library's "accept nearly any framed
// energy" trick. The radio then matches only the first two address
// bytes, so the FIFO starts two bytes early: the remaining two
// address bytes (7D 6B in air order) precede the PDU. The shim's
// offset below accounts for that.
constexpr uint64_t kPipeAddress =
    SCANNER_DIAG ? 0x0F0AULL : kAccessAddress;
constexpr uint8_t kAddrPad = SCANNER_DIAG ? 2 : 0;

// Fixed payload blob per RX interrupt: 32 bytes, the nRF24 maximum.
constexpr uint8_t kBlobLen = 32;

// BLE advertising PDU as received (post shim): [0]=hdr [1]=len
// [2..7]=AdvA (LSB first) [8..]=AD data, then 3-byte CRC. len covers
// AdvA+AD, so total = 2 + len + 3. AD payloads longer than kBlobLen
// truncate on air; those cannot be CRC-checked and M1 drops them.

void silenceOnboardRadios() {	// The ESP32 radio cores would be the loudest thing in the band we
	// are listening to; deinit everything that could emit, and never
	// re-init. Same teardown idiom as the jammer firmware.
	esp_bt_controller_deinit();
	esp_wifi_stop();
	esp_wifi_deinit();
	esp_wifi_disconnect();
	if (esp_bluedroid_get_status() == ESP_BLUEDROID_STATUS_ENABLED) {
		esp_bluedroid_deinit();
		esp_bluedroid_disable();
	}
}

// ---------------------------------------------------------------- BLE shim

uint8_t swapbits(uint8_t b) {
	b = static_cast<uint8_t>((b & 0xF0u) >> 4u | (b & 0x0Fu) << 4u);
	b = static_cast<uint8_t>((b & 0xCcu) >> 2u | (b & 0x33u) << 2u);
	b = static_cast<uint8_t>((b & 0xAAu) >> 1u | (b & 0x55u) << 1u);
	return b;
}

// BLE data whitening is a 7-bit LFSR seeded with (channel<<1)|1, run
// over the PDU bits in air order. After swapbits() each byte is in BLE
// bit order, so XORing m=1,2,4... per byte with this LFSR undoes it.
// (The classic Grinberg routine.)
void dewhiten(uint8_t *data, uint8_t len, uint8_t ble_channel) {
	uint8_t lfsr = static_cast<uint8_t>((ble_channel << 1u) | 1u);
	while (len--) {
		for (uint8_t m = 1; m; m <<= 1) {
			if (lfsr & 0x80u) {
				lfsr ^= 0x11u;
				*data ^= m;
			}
			lfsr <<= 1;
		}
		data++;
	}
}

// BLE CRC-24: init 0xFFFFFF, reflected poly 0x800006, LSB first.
uint32_t ble_crc24(const uint8_t *p, uint8_t len) {
	uint32_t crc = 0xFFFFFFu;
	while (len--) {
		uint8_t b = *p++;
		for (uint8_t i = 0; i < 8u; i++) {
			if ((crc ^ b) & 1u) {
				crc = (crc >> 1u) ^ 0x800006u;
			} else {
				crc >>= 1u;
			}
			b >>= 1u;
		}
	}
	return crc;
}

// ---------------------------------------------------------------- output

// One batch window lives in this static line buffer; a full buffer
// forces an early flush and counts an overflow in STATS (the stream
// spec tells clients to expect gaps, never silence, on drops).
constexpr size_t kBatchCap = 2048;
char batch[kBatchCap];
size_t batch_len = 0;
uint32_t batch_seq = 0;
uint32_t batch_records = 0;

struct Counters {
	uint32_t rx_a = 0, rx_b = 0; // blobs from each radio
	uint32_t ok = 0;            // CRC-valid PDUs
	uint32_t dup = 0;           // suppressed by dedup
	uint32_t overflow = 0;      // forced early flushes
} cnt;

void batch_flush() {
	if (batch_len) {
		Serial.write(batch, batch_len);
		Serial.printf("BATCH-END n=%lu\r\n",
		              static_cast<unsigned long>(batch_records));
	}
	batch_len = 0;
	batch_records = 0;
}

void batch_add(const char *line, size_t n) {
	if (batch_len == 0) {
		batch_seq++;
		batch_len = static_cast<size_t>(snprintf(
		    batch, sizeof(batch), "BATCH-START seq=%lu\r\n",
		    static_cast<unsigned long>(batch_seq)));
	}
	if (batch_len + n + 13 >= kBatchCap) { // 13 = BATCH-END line
		cnt.overflow++;
		batch_flush();
		batch_seq++;
		batch_len = static_cast<size_t>(snprintf(
		    batch, sizeof(batch), "BATCH-START seq=%lu ovf=1\r\n",
		    static_cast<unsigned long>(batch_seq)));
	}
	memcpy(batch + batch_len, line, n);
	batch_len += n;
	batch_records++;
}

// On-device dedup: transport hygiene only, not interpretation. Re-
// report a MAC when its PWR reading moved or SCANNER_DEDUP_MS passed.
struct Seen {
	uint8_t mac[6];
	uint32_t last_ms;
	uint8_t pwr;
} seen[32];
size_t seen_n = 0;

bool dedup_pass(const uint8_t *mac, uint8_t pwr, uint32_t now) {
	Seen *hit = nullptr;
	for (size_t i = 0; i < seen_n; i++) {
		if (memcmp(seen[i].mac, mac, 6) == 0) {
			hit = &seen[i];
			break;
		}
	}
	if (!hit) {
		if (seen_n < sizeof(seen) / sizeof(seen[0])) {
			hit = &seen[seen_n++];
			memcpy(hit->mac, mac, 6);
		} else {
			hit = &seen[0]; // tiny table: recycle the first slot
			memcpy(hit->mac, mac, 6);
		}
		hit->last_ms = 0;
		hit->pwr = 0xFF;
	}
	if (hit->pwr == pwr &&
	    static_cast<int32_t>(now - hit->last_ms) < SCANNER_DEDUP_MS) {
		cnt.dup++;
		return false;
	}
	hit->last_ms = now;
	hit->pwr = pwr;
	return true;
}

// ---------------------------------------------------------------- capture

// Handle one 32-byte FIFO blob from `ble_channel`. `rpd` is the raw
// power register value forwarded verbatim (see PROTOCOL.md).
void handle_blob(const uint8_t *blob, uint8_t ble_channel, uint8_t rpd,
                 uint32_t now) {
	uint8_t pdu[kBlobLen];
	for (uint8_t i = 0; i < kBlobLen; i++) {
		pdu[i] = swapbits(i + kAddrPad < kBlobLen ? blob[i + kAddrPad]
		                                          : 0);
	}
	dewhiten(pdu, kBlobLen, ble_channel);

	const uint8_t len = pdu[1];
#if SCANNER_DIAG
	// PDU-shaped blobs are dumped raw (capped at 200) so a capture
	// can be decoded by hand: header types 0-7 are the legacy
	// ADV/SCAN opcodes. This runs before the length rejection so
	// truncated-on-air PDUs are visible too.
	static uint32_t raw_emitted = 0;
	if (raw_emitted < 200u && (pdu[0] & 0x1Fu) <= 0x07u && len >= 6u) {
		raw_emitted++;
		char raw[32 + 2 * kBlobLen];
		int n = snprintf(raw, sizeof(raw), "RAW T:%lu CH:%u PWR:%u HEX:",
		                 static_cast<unsigned long>(now),
		                 static_cast<unsigned>(ble_channel),
		                 static_cast<unsigned>(rpd));
		for (uint8_t i = 0; i < kBlobLen && n < static_cast<int>(sizeof(raw)) - 3;
		     i++) {
			n += snprintf(raw + n, sizeof(raw) - n, "%02X", pdu[i]);
		}
		raw[n++] = '\r';
		raw[n++] = '\n';
		batch_add(raw, n);
	}
#endif
	if (len < 6u || static_cast<uint16_t>(2u + len + 3u) > kBlobLen) {
		// Either a noise blob with a junk length field, or an ADV
		// truncated at the 32-byte FIFO limit: its trailing CRC was
		// never received, so it cannot be verified. M1 drops both.
		return;
	}
	const uint8_t total = static_cast<uint8_t>(2u + len + 3u);
	const uint32_t want = ble_crc24(pdu, total - 3u);
	const uint32_t got = static_cast<uint32_t>(pdu[total - 3u]) |
	                     static_cast<uint32_t>(pdu[total - 2u]) << 8u |
	                     static_cast<uint32_t>(pdu[total - 1u]) << 16u;
	const bool crc_ok = (want == got);
	if (!crc_ok) {
		return; // noise blob; M1 keeps the stream clean (flagged records
	                // come with the batched transport in later milestones)
	}

	// AdvA, LSB first on air -> print MSB first.
	const uint8_t *mac = pdu + 2;
	cnt.ok++; // counts CRC-valid PDUs, even if dedup suppresses it
	if (!dedup_pass(mac, rpd, now)) {
		return;
	}

	char line[16 + 12 * kBlobLen + 64];
	int n = 0;
	n = snprintf(line, sizeof(line),
	             "MAC:%02X:%02X:%02X:%02X:%02X:%02X PWR:%u T:%lu CH:%u CRC:1 AD:",
	             mac[5], mac[4], mac[3], mac[2], mac[1], mac[0],
	             static_cast<unsigned>(rpd),
	             static_cast<unsigned long>(now),
	             static_cast<unsigned>(ble_channel));
	for (int i = 0; i < total && n < static_cast<int>(sizeof(line)) - 3; i++) {
		n += snprintf(line + n, sizeof(line) - n, "%02X", pdu[i]);
	}
	line[n++] = '\r';
	line[n++] = '\n';
	batch_add(line, n);
}

// Drain any FIFO blobs on `radio`, then grab the raw power register.
void pump(ScanRadio &radio, uint8_t ble_channel, uint32_t now) {
	while (radio.available()) {
		uint8_t blob[kBlobLen];
		radio.read(blob, kBlobLen);
		uint8_t rpd = radio.power_register(); // RPD: 1 bit on real
		                                      // L01+, 7-bit register
		                                      // on L01P clones
		if (&radio == &radioA) {
			cnt.rx_a++;
		} else {
			cnt.rx_b++;
		}
		handle_blob(blob, ble_channel, rpd & 0x7Fu, now);
	}
}

// All three configured channels must be BLE advertising channels; the
// whitening seeds and nRF mapping below are only valid for 37/38/39.
static_assert(SCANNER_A_CH1 == 37 || SCANNER_A_CH1 == 38 || SCANNER_A_CH1 == 39,
              "SCANNER_A_CH1 must be a BLE adv channel (37/38/39)");
static_assert(SCANNER_A_CH2 == 37 || SCANNER_A_CH2 == 38 || SCANNER_A_CH2 == 39,
              "SCANNER_A_CH2 must be a BLE adv channel (37/38/39)");
static_assert(SCANNER_B_CH == 37 || SCANNER_B_CH == 38 || SCANNER_B_CH == 39,
              "SCANNER_B_CH must be a BLE adv channel (37/38/39)");

// BLE channel number -> nRF24 channel number. BLE 37/38/39 are
// 2402/2426/2480 MHz, and the nRF24 channel number is MHz - 2400.
constexpr uint8_t nrf_ch(int ble_channel) {
	return ble_channel == 37 ? 2 : ble_channel == 38 ? 26
	                                                : 80; // 39
}

// Channel radio A is currently parked on (BLE number); alternated by
// the hop timer in loop().
uint8_t a_channel_now = SCANNER_A_CH1;

void configure_rx(ScanRadio &radio, uint8_t nrf_channel) {
	radio.begin();
	radio.setDataRate(RF24_1MBPS);
	radio.disableCRC();          // BLE's CRC is checked in the shim
	radio.setAutoAck(false);
	radio.setAddressWidth(SCANNER_DIAG ? 2 : 4); // see kPipeAddress
	radio.setPayloadSize(kBlobLen); // RF24 1.6.x name for fixed size
	radio.stopListening();
	radio.setChannel(nrf_channel);
	radio.openReadingPipe(0, kPipeAddress);
	radio.startListening();
}

// ---------------------------------------------------------------- PIR

volatile uint32_t pir_start_ms = 0;
volatile bool pir_pending = false;
volatile uint32_t pir_dur_ms = 0;

void pir_isr() {
	const uint32_t now = millis();
	if (digitalRead(SCANNER_PIR_PIN)) {
		pir_start_ms = now;
	} else if (pir_start_ms) {
		pir_dur_ms = now - pir_start_ms;
		pir_start_ms = 0;
		pir_pending = true;
	}
}

// Boot self-test: read back each radio's key registers. Proves the
// SPI path is alive (garbage/00/FF means wiring or power), that
// openReadingPipe wrote the address we think it did (RX_ADDR_P0 at
// 0x0A..0x0D must read 71 91 7D 6B), and shows FIFO/carrier-detect
// state (0x17 FIFO_STATUS, 0x14 RSSI: bit6 = carrier found).
void dump_diag(const char *name, ScanRadio &radio) {
	Serial.printf(
	    "DIAG %s CFG:%02X RPD:%02X RSSI:%02X FIFO:%02X "
	    "ADDR:%02X %02X %02X %02X\r\n",
	    name, radio.reg(0x00), radio.reg(0x09), radio.reg(0x14),
	    radio.reg(0x17), radio.reg(0x0A), radio.reg(0x0B), radio.reg(0x0C),
	    radio.reg(0x0D));
}

const char *reset_reason_name() {
	switch (esp_reset_reason()) {
	case ESP_RST_POWERON:
		return "POWERON";
	case ESP_RST_BROWNOUT:
		return "BROWNOUT";
	case ESP_RST_PANIC:
		return "PANIC";
	case ESP_RST_INT_WDT:
		return "INT-WDT";
	case ESP_RST_TASK_WDT:
		return "TASK-WDT";
	case ESP_RST_WDT:
		return "WDT";
	case ESP_RST_SW:
		return "SOFTWARE";
	default:
		return "OTHER";
	}
}

} // namespace

void setup() {
	Serial.begin(SCANNER_BAUD);
	silenceOnboardRadios();

	configure_rx(radioA, nrf_ch(SCANNER_A_CH1));
	configure_rx(radioB, nrf_ch(SCANNER_B_CH));
	dump_diag("A", radioA);
	dump_diag("B", radioB);

#if SCANNER_PIR_PIN >= 0
	pinMode(SCANNER_PIR_PIN, INPUT);
	attachInterrupt(digitalPinToInterrupt(SCANNER_PIR_PIN), pir_isr, CHANGE);
#endif

	uint8_t base_mac[6];
	esp_efuse_mac_get_default(base_mac); // factory eFuse: unique per
	                                     // board, stable across reflashes
	Serial.printf(
	    "PROTO=1 DEV:scanner-usb ID:%02X%02X%02X%02X%02X%02X FW:M1%s\r\n",
	    base_mac[0], base_mac[1], base_mac[2], base_mac[3], base_mac[4],
	    base_mac[5], SCANNER_DIAG ? "-diag" : "");
	Serial.printf("RESET:%s\r\n", reset_reason_name());
	Serial.printf("BANNER:SCANNER A=%d/%d B=%d BATCH=%d STATS=%d PIR=%d\r\n",
	              SCANNER_A_CH1, SCANNER_A_CH2, SCANNER_B_CH,
	              SCANNER_BATCH_MS, SCANNER_STATS_MS, SCANNER_PIR_PIN);
}

void loop() {
	const uint32_t now = millis();

	pump(radioA, a_channel_now, now);
	pump(radioB, SCANNER_B_CH, now);

	// PIR events.
#if SCANNER_PIR_PIN >= 0
	if (pir_pending) {
		pir_pending = false;
		char line[48];
		int n = snprintf(line, sizeof(line), "PIR T:%lu DUR:%lu\r\n",
		                 static_cast<unsigned long>(now),
		                 static_cast<unsigned long>(pir_dur_ms));
		batch_add(line, n);
	}
#endif

	// Radio A alternates its two channels between blobs only: CE low,
	// re-tune, CE high; PLL settle is 130 us and HOP_MS dwarfs it.
	static uint32_t last_hop = 0;
	if (now - last_hop >= SCANNER_HOP_MS && !radioA.available()) {
		const uint8_t next = a_channel_now == SCANNER_A_CH1 ? SCANNER_A_CH2
		                                                   : SCANNER_A_CH1;
		radioA.stopListening();
		radioA.setChannel(nrf_ch(next));
		radioA.startListening();
		a_channel_now = next;
		last_hop = now;
	}

	// Batch and stats framing.
	static uint32_t batch_deadline = SCANNER_BATCH_MS;
	if (now >= batch_deadline) {
		batch_flush();
		batch_deadline = now + SCANNER_BATCH_MS;
	}
	static uint32_t stats_deadline = SCANNER_STATS_MS;
	if (now >= stats_deadline) {
		Serial.printf(
		    "STATS T:%lu RA:%lu RB:%lu OK:%lu DUP:%lu OVER:%lu\r\n",
		    static_cast<unsigned long>(now),
		    static_cast<unsigned long>(cnt.rx_a),
		    static_cast<unsigned long>(cnt.rx_b),
		    static_cast<unsigned long>(cnt.ok),
		    static_cast<unsigned long>(cnt.dup),
		    static_cast<unsigned long>(cnt.overflow));
		stats_deadline = now + SCANNER_STATS_MS;
	}
}
