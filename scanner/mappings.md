# Scanner wiring

Both nRF24L01+ modules share the ESP32 VSPI bus (SCK/MOSI/MISO are
bus-wide); only CE and CSN differ per module. Power comes from the
board's 3.3V rail — fine for receive-only use (~12-16 mA per module);
see PLAN.md for the optional-LDO note. A 10 uF bulk cap across each
module's VCC/GND pins is still recommended.

## Radio A (hops BLE 37 <-> 39)

| NRF24L01 | ESP32   |
|----------|---------|
| VCC      | 3.3V    |
| GND      | GND     |
| CE       | GPIO 4  |
| CSN      | GPIO 5  |
| SCK      | GPIO 18 |
| MOSI     | GPIO 23 |
| MISO     | GPIO 19 |
| IRQ      | unused (polled) |

## Radio B (holds BLE 38)

| NRF24L01 | ESP32   |
|----------|---------|
| VCC      | 3.3V    |
| GND      | GND     |
| CE       | GPIO 21 |
| CSN      | GPIO 22 |
| SCK      | GPIO 18 |
| MOSI     | GPIO 23 |
| MISO     | GPIO 19 |
| IRQ      | unused (polled) |

Do not put CSN on GPIO15: it is a strapping pin (pulled low at boot),
which puts module B on the shared MISO line during boot and garbles
SPI for both radios (seen as all-FF and corrupted register reads).

## PIR (HC-SR501 class)

| PIR     | ESP32  |
|---------|--------|
| VCC     | 5V     |
| GND     | GND    |
| OUT     | GPIO 27 |

Set the module's retrigger pot to minimum and the time pot low so
events end quickly; the firmware reports falling edges (see
PROTOCOL.md). Set `SCANNER_PIR_PIN=-1` in platformio.ini to build
without PIR.
