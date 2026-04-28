#include "Arduino.h"
#include <SPI.h>
#include <RF24.h>

#define CE_PIN 4
#define CSN_PIN 5

#define CE_PIN_2 16
#define CSN_PIN_2 15

RF24 radio(CE_PIN, CSN_PIN);

SPIClass hspi(HSPI);
RF24 radio2(CE_PIN_2, CSN_PIN_2);

const byte address[6] = "00001";

byte i = 45;

void setup()
{
  Serial.begin(115200);
  if (!radio.begin())
  {
    Serial.println("Radio init failed");
    while (1)
    {
    }
  }
  else
  {
    Serial.println("radio device setup complete");
  }
  radio.openWritingPipe(address);
  radio.setPALevel(RF24_PA_MAX, true);
  radio.setDataRate(RF24_2MBPS);
  radio.setCRCLength(RF24_CRC_DISABLED);
  radio.disableCRC();
  radio.setRetries(0, 0);
  radio.setAddressWidth(3);
  radio.stopListening(); // TX mode
  radio.setAutoAck(false);
  radio.disableAckPayload();
  radio.disableDynamicPayloads();
  radio.printPrettyDetails();
  radio.setPayloadSize(5);

  radio.startConstCarrier(RF24_PA_MAX, i);

  // hspi.begin(14, 12, 13, 15);
  // if (!radio2.begin(&hspi))
  // {
  //   Serial.println("Radio2 init failed");
  //   while (1)
  //   {
  //   }
  // }
  // else
  // {
  //   Serial.println("radio2 device setup complete");
  // }
  // radio2.openWritingPipe(address);
  // radio2.setPALevel(RF24_PA_MAX, true);
  // radio2.setDataRate(RF24_2MBPS);
  // radio2.setCRCLength(RF24_CRC_DISABLED);
  // radio2.disableCRC();
  // radio2.setRetries(0, 0);
  // radio2.setAddressWidth(3);
  // radio2.stopListening(); // TX mode
  // radio2.setAutoAck(false);
  // radio2.disableAckPayload();
  // radio2.disableDynamicPayloads();
  // radio2.printPrettyDetails();
  // radio2.setPayloadSize(5);

  // radio2.startConstCarrier(RF24_PA_MAX, i + 1);
}

void loop()
{

  // 79
  for (int i = 39; i < 79; i++)
  {
    radio.setChannel(i);
    // radio2.setChannel(i + 1);
  }

  // byte ble_channels[] = {37, 38, 39, 37};
  // for (int j = 0; j < 3; j++)
  // {
  //   radio.setChannel(ble_channels[j]);
  //   // radio2.setChannel(ble_channels[j + 1]);
  // }
}
