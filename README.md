# ultrasweeper

Two nRF24L01 modules on an ESP32 act as hopping constant carriers across
2.4 GHz: one sweeps channels 40–58 (2440–2458 MHz at 2 Mbps), the other
60–78 (2460–2478 MHz), hopping
randomly as fast as the SPI bus allows. The ESP32's own BLE/WiFi radios are
deinitialized at boot so they don't contaminate the band.

## Layout

    firmware/            PlatformIO project (espressif32, Arduino framework)
      platformio.ini     three environments; all pin/channel config lives here
      src/main.cpp       the sweeper device
      src/radio.[hc]     one nRF24L01 in constant-carrier mode
      src/listener.cpp   reference sketch: RX + print
      src/publisher.cpp  reference sketch: TX once per second
    mappings.md          nRF24L01 <-> ESP32 wiring
    listener.md, publisher.md   original pre-PlatformIO sketch notes

## Building

`nix develop` is the only setup step:

    pio run -e sweeper     # build the device firmware
    pio run -e listener    # reference RX build
    pio run -e publisher   # reference TX build

    pio run -e sweeper -t upload -t monitor   # flash + serial at 115200

## Wiring

See [mappings.md](mappings.md). The sweeper uses both SPI buses:
Radio A on VSPI (SCK 18 / MISO 19 / MOSI 23, CE 4, CSN 5), Radio B on HSPI
(SCK 14 / MISO 12 / MOSI 13, CE 2, CSN 15). Change pins in
`firmware/platformio.ini`, not in the sources.
