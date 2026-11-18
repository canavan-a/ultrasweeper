// ultrasweeper device firmware.
//
// Two nRF24L01s ride both ESP32 hardware SPI buses and act as hopping
// constant carriers: radio A sweeps one range of 2.4 GHz channels, radio B a
// disjoint range above it, hopping randomly as fast as the bus allows. The
// ESP32's own radios (BLE + WiFi) are torn down at boot so they cannot
// contaminate the band. Pin maps and channel ranges are build_flags in
// platformio.ini; wiring notes are in ../../mappings.md.
//
// The plain send/receive reference sketches the device was built against are
// separate environments: listener.cpp and publisher.cpp.

#include <Arduino.h>
#include <esp_bt.h>
#include <esp_bt_main.h>
#include <esp_wifi.h>

#include "radio.h"

namespace {

// A on VSPI, B on HSPI. Statics so nothing touches the heap at runtime.
SweeperRadio radioA{SWEEPER_A_CE, SWEEPER_A_CSN, SpiBus::vspi, SWEEPER_A_SCK,
                   SWEEPER_A_MISO, SWEEPER_A_MOSI};
SweeperRadio radioB{SWEEPER_B_CE, SWEEPER_B_CSN, SpiBus::hspi, SWEEPER_B_SCK,
                   SWEEPER_B_MISO, SWEEPER_B_MOSI};

// The ESP32 radio cores are the loudest thing in the band we are sweeping;
// deinit everything that could emit, then never re-init it.
void silenceOnboardRadios() {
	esp_bt_controller_deinit();
	esp_wifi_stop();
	esp_wifi_deinit();
	esp_wifi_disconnect();
	if (esp_bluedroid_get_status() == ESP_BLUEDROID_STATUS_ENABLED) {
		esp_bluedroid_deinit();
		esp_bluedroid_disable();
	}
}

} // namespace

void setup() {
	silenceOnboardRadios();

	Serial.begin(115200);

	if (!radioA.setup()) {
		Serial.println("Radio A failed to init");
		for (;;) {
		}
	}
	Serial.println("Radio A init!");

	if (!radioB.setup()) {
		Serial.println("Radio B failed to init");
		for (;;) {
		}
	}
	Serial.println("Radio B init!");
}

void loop() {
	radioA.hop(SWEEPER_A_CHANNEL_LOW, SWEEPER_A_CHANNEL_HIGH);
	radioB.hop(SWEEPER_B_CHANNEL_LOW, SWEEPER_B_CHANNEL_HIGH);
	delayMicroseconds(random(60));
}
