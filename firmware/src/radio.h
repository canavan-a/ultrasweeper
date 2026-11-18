// One nRF24L01 on a hardware SPI bus, wired for sweeping: no ACK, no CRC,
// no retries -- we only ever push a constant carrier and hop channels, so
// every reliability feature of the chip is noise we can turn off.
#pragma once

#include <SPI.h>

#include <RF24.h>

// Which hardware SPI bus the radio sits on. Both buses are used at once by
// the sweeper; the pin sets are non-negotiable per bus.
enum class SpiBus {
	vspi,
	hspi,
};

struct RadioPins {
	int ce;
	int csn;
	int sck;
	int miso;
	int mosi;
};

// The shared pipe address. Only the carrier and channel spacing matter to us,
// so a short address width is fine and keeps timing tight.
inline constexpr uint8_t SWEEP_ADDRESS[6] = {'0', '0', '0', '0', '1', '\0'};
constexpr uint8_t SWEEP_ADDRESS_WIDTH = 3;
constexpr uint8_t SWEEP_PAYLOAD_SIZE = 5;
constexpr uint8_t SWEEP_INITIAL_CHANNEL = 45;

// A single nRF24L01 driven in constant-carrier mode. Not a horus-33-style
// Control: there is no host protocol here, the sweeper has exactly one job.
struct SweeperRadio {
	SweeperRadio(int ce, int csn, SpiBus bus, int sck, int miso, int mosi)
		: rf{static_cast<uint8_t>(ce), static_cast<uint8_t>(csn)},
		  // Parenthesized init: HSPI/VSPI are bus-number constants and the
		  // SPIClass ctor takes a uint8_t, so brace-init would narrow.
		  spi((bus == SpiBus::hspi) ? HSPI : VSPI),
		  pins{ce, csn, sck, miso, mosi} {}

	// Brings up the SPI bus and the radio. Returns false if the chip does
	// not answer over SPI; the caller decides whether that is fatal.
	bool setup();

	// Jump to one random channel in [low, high).
	void hop(int low, int high);

	// Deterministic sweep: step through [low, high) with a fixed stride,
	// wrapping around. With stride coprime to the range size (checked at
	// compile time in main.cpp), every channel is hit exactly once per
	// cycle -- uniform duty, no starved channels like random hopping.
	void hopNext(int low, int high, int stride);

	RF24 rf;
	SPIClass spi;
	RadioPins pins;

private:
	// Position within the stride sweep; the first hopNext starts here.
	int cursor = 0;
};
