# scanner — police scanner

Status: **design**. One ESP32 board with two nRF24L01+ modules listens
to the Bluetooth LE advertising channels, decides what police equipment
is in range, and a phone app shows it — names, vendors, signal, map
pins, history. It is a *scanner* in the old sense: a box you leave on a
shelf by a window that tells you what's out there. The jammer is not
part of this design; this is its own product.

## 1. What it is for

Police activity around us shows up on Bluetooth: the body cameras in
use locally are Axon units (Albany PD on Body 2; NYSP on Body 3), and
Axon BLE traffic carries identifiable vendor signatures (company IDs
`0x034D`/`0xFC81`, OUI `00:25:DF` — re-verify against our own
captures). A stock nRF24L01 receiver is −85 dBm sensitive at 1 Mbps —
the exact PHY BLE advertises on — so nRF52-based transmitters like
those are detectable at ~50–100 m, farther with PA+LNA modules.

The scanner answers: *is police activity near me right now, how strong,
and what's the history* — and optionally *did a person just walk by*
(PIR). Logged over time, map-pinable.

## 2. The device — single board

One ESP32, two nRF24L01+ modules, one PIR sensor, one USB power
input. That's the whole product.

```
                 ┌───────────────────────────────────────┐
    USB-C ────── │ ESP32 dev board                       │
                 │   ├─ SPI (shared) ─┬─ nRF24 #A ── ant │   ← ch 37/39
    PIR in ───── │   │  CE1/CS1       │                  │
    PIR out ───► │   ├─ CE2/CS2 ──────┴─ nRF24 #B ── ant │   ← ch 38
                 └───────────────────────────────────────┘
                   USB-C ⟷ phone app (data + power, sole link)
                   (device emits no RF: both radios are quiet)
```

- **Boards/parts:** `esp32dev` (ESP32-D0WDQ6 devkit — same board
  class PlatformIO targets in this repo), 2× nRF24L01+ (the PA+LNA
  +20 dBm variants are a drop-in range upgrade, same SPI), HC-SR501
  PIR, 10 µF + 0.1 µF decoupling caps at each nRF24's VCC (nRF24s
  need these, more than any other part here).
- **Phone link via USB (primary).** The devkit's onboard USB-UART
  bridge (CP2102/CH340) is itself a USB *device*; an Android phone in
  USB-host/OTG mode enumerates it as a plain serial port and the
  firmware just writes to UART0 — the same stream M1 prints. No
  special ESP feature needed, and the same cable powers the board.
  Production option: an ESP32-**S3** devkit has native USB CDC (no
  bridge in the loop, true `COM` device, identical firmware idiom via
  `board = esp32s3-devkit`) — same PlatformIO conventions, decide at
  M5. Caveat to verify at M0: phone USB-host VBUS is spec'd 100–500 mA
  and some phones throttle; our ~200–300 mA budget usually fits, and a
  powered USB-C hub or powerbank (data-only to the phone) is the
  fallback if a particular phone starves it.
- **Wiring (final pins in `mappings.md` when built):** both modules
  share the hardware VSPI bus (SCK 18, MISO 19, MOSI 23); separate
  CE/CSN pairs, e.g. A: CE 4 / CSN 5, B: CE 2 / CSN 15. The RF24
  library supports two radio instances on one bus this way — the
  jammer's dual-module code is the same pattern. PIR: output → GPIO
  27 (input, ESD-tolerant, no strapping role). Avoid input-only
  GPIOs 34–39, strapping pins 0/2→(use 15 instead of 2 if a conflict
  shows), flash pins 6–11, and 16/17 (u.flashed-USB boards).
- **Power:** USB-C wall supply or powerbank; the nRF24s run off the
  devkit's 3.3 V pin. That is safe *because this device only
  receives*: RX is ~12–16 mA/module, ~30 mA total for both — trivial
  for the onboard regulator. The brownout folklore around nRF24s is
  about TX (115 mA bursts; PA modules worse), which this design never
  does on those radios. The main shared-rail hazard was the ESP32's
  own 240–500 mA radio bursts coupling noise into the 3.3 V rail —
  moot in the product build, which keeps the ESP32's radio stack
  **off** entirely (see §4); the decoupling caps still go on as
  matter of habit. Budget with radios off: roughly 60–120 mA
  board-total; M0 verifies regulator headroom on the board. Battery
  option (M5): a 3000 mAh 18650 + charger module runs this for
  ~24–36 h.
  *Optional insurance:* a dedicated $1 LDO (AMS1117/MCP1700) off the
  USB 5 V line feeding only the nRF pair buys back the ~1–2 dB of
  desense from ESP32 rail noise — real but small; caps come first,
  and range is dominated by antenna placement and (at M5) PA+LNA
  modules, not by supply topology.
- **Antenna placement:** the two modules at opposite ends of the
  enclosure, antennas clear of metal and of each other by a few cm.
  Two spatially separated antennas are the point: simultaneous coverage
  of two advertising channels, plus a crude left/right signal sense.
- **No display, no buttons.** Status is a single LED; everything else
  is the phone app. The box is deliberately dumb; the app is the UI.

## 3. Sensing front-end — the nRF24s decode BLE directly

The loophole: every BLE advertisement uses the same fixed access
address `0x8E89BED6` at 1 Mbps GFSK — within what an nRF24 hears.
Configuration per module (all via `build_flags`/constants, no magic
in sources):

- `setChannelRF`: A hops **37↔39**, B holds **38** (BLE adv channels;
  nRF numbers already documented in this repo: 37/38/39 = 2/26/80).
- Data rate 1 Mbps, `RX_ADDR_P0` = bit-reversed `0x8E89BED6`, CRC and
  auto-ACK off, fixed 32-byte payload.
- A small baseband shim (~20 lines, the classic Grinberg trick):
  bit-reverse, de-whiten with the per-channel LFSR, verify the 24-bit
  BLE CRC → packet is *real* or *noise*. Nothing else is decoded on
  the device; the raw AD bytes go to the phone untouched, so new
  device signatures are app rules, never firmware updates.

Hop discipline: A switches 37↔39 at ~5 ms during quiet, never during
an RX burst; PLL settle is 130 µs and irrelevant against 20 ms+
advertising intervals. With B holding 38, **every advertiser on the
air is heard on at least one channel every advertising event** — the
coverage two separate receivers buy is the core trick, not a
refinement.

Power readings: nRF24 has no real RSSI. Real L01+ gives one RPD bit
(≥ −64 dBm); most "L01+" modules are L01P-class clones with a coarse
7-bit register (~−95…−64, temp-drifting). Firmware forwards the raw
register as `PWR:`; the app draws honest relative bars and uses
**packet rate** as the primary strength signal. Never prints dBm.

Bonus mode (`-DSCANNER_SURVEY=1`): when not decoding, sweep the
modules' RPD across channels and emit band-occupancy records — the
scanner can show "how busy is 2.4 GHz right now" for free.

Wi-Fi occupancy vs identity: the nRF24s *feel* Wi-Fi (OFDM is not
GFSK — not one bit decodes) but map it as 20/40 MHz occupancy slabs on
the 1 MHz channel grid — that's survey mode's main diet. *Reading*
Wi-Fi is the ESP32's job, and it can be done without breaking the
RF-mute rule: **passive-only scanning** — listen for beacon frames
(shouted every 100 ms by every AP), never send a probe request, never
associate. That yields SSID/BSSID/RSSI/channel for every 2.4 GHz
network. It interleaves cleanly with everything else: the ESP32 radio
dwells ~120 ms per channel 1–13 on a slow cycle, while the nRF24s —
separate chips — keep catching BLE ads unaffected.

Why this matters for police: Axon's infrastructure is Wi-Fi as much as
BLE — vehicles run per-vehicle Wi-Fi networks (unique, sometimes
hidden SSIDs) and body cams auto-upload to in-car and station
networks. A new SSID appearing is *a car being here*. Limits, stated
honestly: ESP32 Wi-Fi is 2.4 GHz only (newer Axon vehicle guidance is
5 GHz — invisible to this box); hidden-SSID APs still beacon
(presence known, name absent); Wi-Fi RX adds ~76 mA while dwelling —
well inside the radio-off budget since it's a small duty cycle.

## 4. Firmware (`scanner/firmware/`, PlatformIO, repo conventions)

- Environments in one `platformio.ini`:
  - `scanner-usb` — THE product build: dual-nRF sensing, ESP32 radios
    **off** (no BLE stack, no WiFi), records out UART0 to the onboard
    USB bridge; the phone (or any laptop) is the USB host. Simplest,
    fastest, zero radio protocols in the data path — the M1 stream *is*
    the product transport.
  - `scanner-wifi` — same sensing, pushes records over WebSocket to a
    home server/laptop: the dev and desktop-dock build only. (Known
    artifact when used: the ESP32's own WiFi transmitter is in the
    band its nRF24s hear — survey mode will show itself. Fine for dev;
    another reason the field build is radio-off.)
  - `scanner-ble` — *experimental option, not in the v1 plan* (M5):
    same records over a GATT peripheral, for an untethered posture.
    Costs the RF-mute property — the device starts detecting its own
    advertising — plus the power and stack complexity.
  - All pins, channels, PWR floor, dedup intervals as `build_flags`;
    sources stay generic (horus-3 idiom). The record stream is
    identical in all envs; transport is the only per-env difference.
- **The device is RF-mute**: the nRF24s never transmit, and
  `scanner-usb` leaves the ESP32's radio stack down (`btTeardown()`
  /WiFi off — the same on-board-radio teardown idiom already used in
  the jammer firmware). Nothing to be heard, nothing to self-detect,
  and the ESP32's ~80–240 mA radio bursts leave the power budget —
  board total drops to well under 100 mA.
- **Buffering**: static ring buffer, no heap; ~40 B/record, 2 KB ≈
  50 records; overflow drops oldest and flags the gap to the app.
- **Dedup (on-device, transport hygiene only)**: re-report a MAC only
  if its PWR bucket changed or 5 s passed; new MACs report at once.
- **The wire protocol is a first-class artifact.** `scanner/PROTOCOL.md`
  is written at M1 as the normative spec — line grammar, field meanings,
  `PROTO=` handshake, error/overflow behavior — and the firmware, the
  phone app, and everything else conform to *it*, not to each other.
  The record stream is plain readable text on any byte pipe: a client
  is anything that opens a serial port. The phone app is *first
  client, not owner*: `picocom`/`pyserial` on a laptop, a Python
  script, a home server, future tooling all work from day one. Adding
  a record type or field is a spec revision (bump `PROTO=`), never an
  app-private detail. Machine-checkable conformance: the M1 laptop
  reader is the protocol's first test client.
- **Wire records** (versioned by `PROTO=1` handshake):

  ```
  MAC:aa:bb:cc:dd:ee:ff PWR:27 T:123456 CH:37 CRC:1 AD:<hex-raw-pdu>
  WIFI T:123456 BSSID:aa:bb:cc:dd:ee:ff CH:6 SSID:unit-214
  PIR T:123456 DUR:4.2
  BATCH-START seq=42      BATCH-END n=17
  ```

## 5. Phone app ("police app")

Android-first — Android exposes real MACs and background scanning; iOS
replaces MACs with per-app UUIDs and guts the lookup story (iOS would
be a later reduced variant). Native Kotlin: background service + list
+ map. All interpretation lives here:

1. **Link**: USB-serial via `usb-serial-for-android` (enumerates the
   devkit's CP2102/CH340 or an S3's native CDC on plug-in; Android
   USB-host permission dialog once per device) — the primary path.
   BLE GATT client for the optional untethered build (M5). Show link
   type/age and buffer/overflow stats.
2. Decode raw AD; offline IEEE OUI table (SQLite) for MAC→vendor.
3. **Police classifier** — editable rule list, seeded from the
   research: company ID `0x034D`/`0xFC81` or OUI `00:25:DF` → *Axon
   (likely)*; name regex `axon|body\s*[23]`; user-pinned MACs →
   *known unit*. Confidence shown honestly; extended from field
   captures.
4. SQLite `sightings(ts, mac, pwr, pwr_min/max, count, first_seen,
   last_seen, ad_blob, tag)`; CSV export.
5. Views: live list (relative bars + packet rate, vendor, tag),
   per-MAC history, **map pins** at the phone's GPS fix with rough
   proximity rings; PIR events interleaved on the timeline — a PIR hit
   coinciding with rising Axon packet rate is strong evidence either
   alone lacks.
6. MAC-randomization honesty: tag stable public addresses, flag
   rotating ones instead of seeing a new device each minute; if police
   units rotate, classify on AD payload — which is why raw AD is kept.

A home-server view (via `scanner-wifi`) is a later freebie: same
records, Grafana/SQLite on the server, no phone needed — decide at M4.

## 6. Milestones

- **M0 — bench bring-up.** Wire both nRF24s on one SPI bus, run the
  RF24 examples on both instances. *Done when: both modules TX/RX to a
  third module back-to-back; brownout-free with caps.*
- **M1 — see the air.** Dual-channel adv sniff + shim → NDJSON over
  USB serial; `PROTOCOL.md` written alongside the code as the spec.
  *Done when: walking near any known BLE advertiser yields its decoded
  records and PWR — read happily by `picocom`/a script, with no app
  anywhere.* Also wire PIR (one ISR, one record type) — cheap now,
  painful to retrofit.
- **M2 — plug it into the phone.** Same record stream over USB OTG:
  first read it with a laptop (`pyserial`), then with a minimal Kotlin
  reader (`usb-serial-for-android`) on the target phone, which also
  powers the board. *Done when: 30 min continuous capture read by the
  phone, zero batch loss, and this particular phone's VBUS sustains
  the board.*
- **M3 — app v0 (Android).** USB-plug-to-scan: live list with vendor
  lookups, SQLite. *Done when: a 30-min walk with the device tethered
  logs cleanly and shows vendors.*
- **M4 — the police view.** Classifier + map pins + per-device
  history + PIR timeline. *Done when: field sessions answer "was
  police activity nearby, when" from the app alone.*
- **M5 — product-ize.** Enclosure (shelf-by-window posture), battery
  option, `scanner-ble` untethered build, ESP32-S3 native-USB board
  swap (one cable, no bridge), CSV share, optional PA+LNA module
  upgrade, optional SD logging.

## 7. Risks

| Risk | Mitigation |
|---|---|
| nRF24 hears adv channels only (no connected/data traffic) | Detection is what advertising is for; anything invisible here is invisible to every passive scanner. Survey mode covers the band coarsely. |
| Power reading is coarse (RPD bit / 7-bit clone register) | Forward raw, relative bars, packet rate as primary; never claim dBm. |
| Adv PDUs > 32 B truncate at the nRF24 payload limit | Header + MAC + first ~21 AD bytes survive — exactly where OUI/company-ID signatures live; flag truncation. |
| No BLE5 2M/Coded extended advertising on nRF24 | Body cams and legacy police gear use legacy 1M adv; survey mode still sees ext-adv energy; revisit front-end only if a real target needs it. |
| nRF24 brownouts/RF saturation on shared 3.3 V rail | Caps at each module, quality supply, M0 exists to find this at the bench not in the field. |
| Phone USB-host VBUS throttles (< board budget) | Verify per-phone at M2; with the ESP32 radio off the budget is well under what any phone hosts, but a powered USB-C hub or powerbank + data-only to phone is the fallback. |
| Two nRF24s near each other (self-interference) | They only receive; antennas at opposite ends of the enclosure; verify capture rates in M1. |
| Target devices randomize MACs | Classify on AD payload, keep raw AD forever. |
| iOS lacks MAC access | Android-first; iOS later as reduced variant. |
| Duty of a listening device in public | The product build is RF-mute: passive sensing, ESP32 radio stack off, no transmissions of any kind, no location stored on-device. |

## 8. Open questions

1. Confirm Android. (An iPhone-only world changes §5 materially.)
2. Default posture: shelf-by-a-window on USB (recommended — the
   antenna height is worth more than portability), or primarily
   pocket-battery? Battery math changes §2.
3. Home server for the `scanner-wifi` path — wanted at M4, or skip?
