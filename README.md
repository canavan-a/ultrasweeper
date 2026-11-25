# ultrasweeper — scanner

Passive police-scanner detector: one ESP32 devkit, two nRF24L01+
modules listening to BLE advertising directly, a PIR for presence.
USB-tethered to a phone (or any host); the device emits no RF.

- `PLAN.md` — the formal plan: device design, RF front-end, app,
  milestones.
- `PROTOCOL.md` — normative spec for the serial record stream.
- `mappings.md` — nRF24 / PIR <-> ESP32 wiring.
- `firmware/` — PlatformIO project:

  ```sh
  nix develop -c bash -c 'cd firmware && pio run -e scanner-usb'
  # flash + watch the record stream:
  nix develop -c bash -c 'cd firmware && pio run -e scanner-usb -t upload && pio device monitor'
  ```

- `app/` — the Android companion (React Native, bare gradle project in
  `app/android/`). It reads the record stream over USB Host serial
  (native Kotlin module over usb-serial-for-android), parses PROTOCOL.md,
  and does all interpretation client-side: device table, air-glitch
  folding, company-ID/service-UUID/OUI lookups (bundled IEEE dataset,
  regenerate with `npm run gen-oui`), the police classifier and police
  alerts (with background scanning). With location on, every sighting is
  tagged with the phone's GPS fix. Each scanner connection is recorded
  locally as `hunt_YYYY-MM-DD_HH-MM-SS.csv` (one row per sighting / fix;
  columns in `app/src/huntlog.ts`), listed with sizes on the Logs screen
  and shared, saved to Downloads, or uploaded to a flags server from
  there. Dev:

  ```sh
  nix develop -c bash -c 'cd app && npm ci && npx jest'
  # run on a device with the scanner attached (needs system Android SDK):
  nix develop -c bash -c 'cd app && npm run android'
  ```

- `release/` — signing setup + guided APK release (same sideload flow as
  super-badger; see `release/README.md`).

- `flagsrv/` — optional LAN companion server (Go, `net/http` + sqlite,
  no CGO): serves the flag records the app pulls, manages them over a
  plain HTTP API, and stores uploaded hunt files in a directory. The
  protocol is `FLAGS.md`; the app side is `app/src/flags.ts`:

  ```sh
  nix develop -c bash -c 'cd flagsrv && go test ./... && go run . -db flags.db -uploads ./uploads -upload-key <pw> -seed seed.json'
  ```

## Conventions

- One dev shell from the root `flake.nix` (PlatformIO, Node); `nix
  develop` is the only setup step.
- Firmware pins/channels/strides live as `build_flags` in
  `firmware/platformio.ini` — sources stay generic.
- Push target: the repo on the personal box
  (`ssh://nixos@framework16-connect.acanavan.com/home/nixos/canavan-a/ultrasweeper`).
