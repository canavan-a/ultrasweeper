// Reference sketch: receive and print packets from the publisher.
// Built by the `listener` environment only (see platformio.ini src_filter).

#include <Arduino.h>
#include <SPI.h>

#include <RF24.h>

namespace {

RF24 radio{LISTENER_CE, LISTENER_CSN};
const uint8_t address[6] = {'0', '0', '0', '0', '1', '\0'};

} // namespace

void setup() {
	Serial.begin(115200);
	if (!radio.begin()) {
		Serial.println("Radio init failed");
		while (1) {
		}
	}
	radio.openReadingPipe(0, address);
	radio.setPALevel(RF24_PA_LOW);
	radio.startListening(); // RX mode
}

void loop() {
	if (radio.available()) {
		char payload[32] = "";
		radio.read(&payload, sizeof(payload));
		Serial.println(payload);
	}
}
