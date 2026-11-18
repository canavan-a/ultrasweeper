# ultrasweeper

Constant-carrier RF sweepers: cheap nRF24L01 modules on ESP32s held as
unmodulated carriers and stepped across 2.4 GHz, hopping fast enough to act
as programmable jammers/probes for whatever is in the band.

Each tool is its own directory with its own PlatformIO project; they share
this repo's dev shell (`nix develop` at the root is the only setup step)
and the same hardware idiom.

## Tools

    bluetooth/   BLE jammer: two devices sweep nRF channels 0-80 between
                 them, blanketing the whole Bluetooth band (2400-2480 MHz)
                 including the three advertising channels.
                 See bluetooth/README.md.

More sweepers to come; each gets a directory here when it exists.

## Conventions

- One PlatformIO project per tool, `firmware/platformio.ini`, with all
  pins/channels/strides as `build_flags` — sources stay generic.
- Shared dev shell from the root `flake.nix` (PlatformIO); `pio run -e …`
  from the tool's `firmware/` dir.
- Wiring notes live next to the tool that needs them (`mappings.md`).
- Push target: the repo on the personal box
  (`ssh://nixos@framework16-connect.acanavan.com/home/nixos/canavan-a/ultrasweeper`).
