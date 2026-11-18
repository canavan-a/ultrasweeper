#include "radio.h"

bool SweeperRadio::setup() {
	spi.begin(pins.sck, pins.miso, pins.mosi, pins.csn);
	if (!rf.begin(&spi)) {
		return false;
	}

	rf.openWritingPipe(SWEEP_ADDRESS);
	rf.setPALevel(RF24_PA_MAX, true);
	rf.setDataRate(RF24_2MBPS);
	rf.disableCRC();
	rf.setRetries(0, 0);
	rf.setAddressWidth(SWEEP_ADDRESS_WIDTH);
	rf.stopListening(); // TX mode
	rf.setAutoAck(false);
	rf.disableAckPayload();
	rf.disableDynamicPayloads();
	rf.printPrettyDetails();
	rf.setPayloadSize(SWEEP_PAYLOAD_SIZE);

	rf.startConstCarrier(RF24_PA_MAX, SWEEP_INITIAL_CHANNEL);
	return true;
}

void SweeperRadio::hop(int low, int high) {
	rf.setChannel(static_cast<uint8_t>(random(low, high)));
}

void SweeperRadio::hopNext(int low, int high, int stride) {
	cursor = (cursor + stride) % (high - low);
	rf.setChannel(static_cast<uint8_t>(low + cursor));
}
