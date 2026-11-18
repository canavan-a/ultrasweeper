# scanner

Passive police-scanner detector: one ESP32 devkit, two nRF24L01+
modules listening to BLE advertising directly, a PIR for presence.
USB-tethered to a phone (or any host); the device emits no RF.

- `PLAN.md` — the formal plan: device design, RF front-end, app,
  milestones.
- `PROTOCOL.md` — normative spec for the serial record stream.
- `mappings.md` — nRF24 / PIR <-> ESP32 wiring.
- `firmware/` — PlatformIO project. Build from the repo root:

  ```sh
  nix develop -c bash -c 'cd scanner/firmware && pio run -e scanner-usb'
  # flash + watch the record stream:
  nix develop -c bash -c 'cd scanner/firmware && pio run -e scanner-usb -t upload && pio device monitor'
  ```
