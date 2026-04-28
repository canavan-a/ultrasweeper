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
    else
    {
        Serial.println("radio device setup complete");
    }
    radio.openWritingPipe(address);
    radio.setPALevel(RF24_PA_LOW);
    radio.stopListening(); // TX mode
}

void loop()
{
    const char payload[] = "Hello";
    bool ok = radio.write(&payload, sizeof(payload));
    Serial.println(ok ? "Sent" : "Failed");
    delay(1000);
}