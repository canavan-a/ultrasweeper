#include "Arduino.h"
#include <SPI.h>
#include <RF24.h>
#include <vector>
#include "esp_task_wdt.h"
#include <esp_bt.h>
#include <esp_wifi.h>
#include <esp_bt_main.h>

#define CE_PIN 4
#define CSN_PIN 5

enum SpiType
{
  spiHSPI,
  spiVSPI,
};

struct Radio
{

  SPIClass hspi{HSPI};

  const byte address[6] = "00001";

  RF24 radio;

  SpiType m_spi;

  byte xChan = 45;

  int m_sck;
  int m_miso;
  int m_mosi;
  int m_csn;

  Radio(int CE, int CSN, SpiType spi, int sck, int miso, int mosi) : radio(CE, CSN), m_spi{spi}, m_sck{sck}, m_miso{miso}, m_mosi{mosi}, m_csn{CSN} {}

  void setup()
  {

    bool ok;
    if (m_spi == SpiType::spiHSPI)
    {
      hspi.begin(m_sck, m_miso, m_mosi, m_csn);

      ok = radio.begin(&hspi);
    }
    else
    {
      ok = radio.begin();
    }

    if (!ok)
    {
      Serial.println("Radio failed to init");
      for (;;)
      {
      }
    }
    else
    {
      Serial.println("Radio init!");
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

    radio.startConstCarrier(RF24_PA_MAX, xChan);
  }

  void run(int startChannel, int endChannel)
  {
    for (;;)
    {
      for (int channel = startChannel; channel < endChannel; channel++)
      {
        radio.setChannel(channel);
      }
    }
  }
};

std::vector<Radio> radios{};

void setup()
{
  esp_bt_controller_deinit();
  esp_wifi_stop();
  esp_wifi_deinit();
  esp_wifi_disconnect();
  if (esp_bluedroid_get_status() == ESP_BLUEDROID_STATUS_ENABLED)
  {
    esp_bluedroid_deinit();
    esp_bluedroid_disable();
  }

  Serial.begin(115200);

  radios.reserve(2);
  radios.emplace_back(4, 5, SpiType::spiVSPI, 18, 19, 23);
  radios.emplace_back(2, 15, SpiType::spiHSPI, 14, 12, 13);

  radios[0].setup();
  radios[1].setup();
}

void loop()
{

  // radios[0].radio.setChannel(random(0, 19));
  // radios[1].radio.setChannel(random(20, 39));
  radios[0].radio.setChannel(random(40, 59));
  radios[1].radio.setChannel(random(60, 79));
  delayMicroseconds(random(60));
}
