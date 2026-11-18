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

- `app/` — the Android companion (React Native, bare gradle project in
  `app/android/`). It reads the record stream over USB Host serial
  (native Kotlin module over usb-serial-for-android), parses PROTOCOL.md,
  and does all interpretation client-side: device table, air-glitch
  folding, company-ID/service-UUID/OUI lookups (bundled IEEE dataset,
  regenerate with `npm run gen-oui`). Dev:

  ```sh
  nix develop -c bash -c 'cd scanner/app && npm ci && npx jest'
  # run on a device with the scanner attached (needs system Android SDK):
  nix develop -c bash -c 'cd scanner/app && npm run android'
  ```

- `release/` — signing setup + guided APK release (same sideload flow as
  super-badger; see `release/README.md`).
