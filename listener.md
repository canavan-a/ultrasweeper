#include "Arduino.h"
#include <SPI.h>
#include <RF24.h>

#define CE_PIN 4
#define CSN_PIN 5

RF24 radio(CE_PIN, CSN_PIN);

const byte address[6] = "00001";

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
    radio.openReadingPipe(0, address);
    radio.setPALevel(RF24_PA_LOW);
    radio.startListening(); // RX mode
}

void loop()
{
    if (radio.available())
    {
        char payload[32] = "";
        radio.read(&payload, sizeof(payload));
        Serial.println(payload);
    }
}