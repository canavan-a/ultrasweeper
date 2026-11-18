// Reference sketch: send a packet once a second.
// Built by the `publisher` environment only (see platformio.ini src_filter).

#include <Arduino.h>
#include <SPI.h>

#include <RF24.h>

namespace {

RF24 radio{PUBLISHER_CE, PUBLISHER_CSN};
const uint8_t address[6] = {'0', '0', '0', '0', '1', '\0'};

} // namespace

void setup() {
	Serial.begin(115200);
	if (!radio.begin()) {
		Serial.println("Radio init failed");
		while (1) {
		}
	}
	Serial.println("radio device setup complete");
	radio.openWritingPipe(address);
	radio.setPALevel(RF24_PA_LOW);
	radio.stopListening(); // TX mode
}

void loop() {
	const char payload[] = "Hello";
	bool ok = radio.write(&payload, sizeof(payload));
	Serial.println(ok ? "Sent" : "Failed");
	delay(1000);
}
