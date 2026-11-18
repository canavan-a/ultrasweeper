# detector — plan

Status: **planned**. Goal: a pocket ESP32 + nRF24 detector that sniffs
Bluetooth LE out of the air — same radio hardware as the jammer, run in
reverse — and a phone app that turns the sightings into "here is a
police device": map pins, vendor lookups, signal strength.

## 1. What it is for

Police activity around us shows up on Bluetooth: the body cameras in use
locally are Axon units (Albany PD on Body 2; NYSP on Body 3, which is
LTE-capable), and Axon BLE traffic carries identifiable vendor signatures
(company IDs `0x034D`/`0xFC81`, OUI `00:25:DF` — worth re-verifying
against our own captures). nRF52-based transmitters like those are
detectable at ~50–100 m with a stock nRF24L01's PCB antenna (the nRF24
receiver is −85 dBm sensitive at 1 Mbps, the same PHY BLE advertises
on), farther with the PA+LNA (+20 dBm) modules we already considered
for the jammer.

The detector answers: *what BLE is around me, how strong, and which of it
looks like police equipment* — logged over time, map-pinable. It joins the
monorepo beside `bluetooth/` (the jammer); the two are a matched pair of
experiments — one fills the band, the other reads it.

## 2. Architecture — the split of work

```
ESP32 + nRF24 detector                     Phone (the "police app")
────────────────────                     ─────────────────────────
nRF24s sniff adv channels 37/38/39       connects to the detector
raw AD records -> ring buffer            dedupe/history -> SQLite
compact batch records                    OUI + company-ID lookup (offline)
ESP32 BLE radio = transport only         "police?" classifier (rule list)
optional WiFi sidechannel (dev)          signal display, map, pins
```

Firmware does only what only it can do: hold the radios, capture
advertisements with power readings and timestamps, never drop a batch.
Everything interpretive lives on the phone — decoding AD structures,
vendor lookups, classification, persistence, UI, maps. This keeps the
firmware simple and the app iterable, and means protocol changes ship
in the app.

## 3. Firmware (`detector/firmware/`, PlatformIO, monorepo conventions)

- **Environments**: `detector-ble` (nRF24 sensing + ESP32 BLE peripheral
  transport — the field build), `detector-wifi` (sensing + WebSocket push
  to a network — dev/desktop build). Same core; transport selected per
  env. Config (which module listens where, power floor, report filters)
  lives in `build_flags`, exactly like the jammer's channel ranges.
- **Sensing front-end — the nRF24s, same modules and same `nrf24/RF24`
  library as the jammer.** The trick that makes this possible: every
  BLE advertisement uses the same fixed access address `0x8E89BED6` and
  1 Mbps GFSK — which is inside what an nRF24L01 can hear. So:
  `setChannelRF(2/26/80)` (= BLE adv 37/38/39, the mapping already
  documented in `bluetooth/firmware/platformio.ini`), 1 Mbps data rate,
  `RX_ADDR_P0` = the bit-reversed access address, CRC and auto-ACK off,
  fixed 32-byte payload. The module then just hands us bursts that
  start with a BLE preamble + access address; a ~20-line baseband shim
  (bit-reverse, de-whiten with the per-channel LFSR, check the 24-bit
  BLE CRC) turns them into valid or rejected packets. This is framing
  recovery, not interpretation — the AD bytes are still forwarded raw.
- **Two modules = a small receive array.** BLE advertisers hit all
  three adv channels ~1.5 ms apart, which one module hopping between
  37/38/39 samples imperfectly. With the jammer's two modules we park
  A on 37/39 (stride-hop) and B on 38 — two channels covered
  simultaneously, much higher capture rate, and the two RSSI-style
  readings from spatially separated antennas give a crude left/right
  sense for free. This is the same A/B pairing the jammer already
  uses, run receive-only.
- **Power readings, honestly labeled.** nRF24 has no true RSSI: real
  nRF24L01+ exposes only RPD (1 bit: carrier ≥ −64 dBm), and most
  modules sold as "L01+" are L01P-class clones with a coarse 7-bit
  power register (~−95…−64 dBm, temperature-drifting). The firmware
  reads whatever the module gives and forwards it verbatim as `PWR:`;
  the app shows it as an honest 3-bar relative meter, not dBm. Packet
  *count* over time is a surprisingly good proxy for "how much of
  this device's traffic we're hearing" and is logged as primary signal.
- **Capture**: raw advertisement PDU (header, MAC, all AD bytes, CRC)
  as opaque bytes plus channel, timestamp, PWR, CRC-valid flag —
  decode nothing else on the ESP32. Raw AD means the app can learn new
  signatures without any firmware change.
- **Passive only**: the detector never connects or transmits on the
  nRF24s, so it cannot be identified by the things it watches. The
  ESP32's own BLE radio is *not used for sensing* — that keeps it
  clean for the phone transport and avoids the dual-role squeeze.
- **Buffering**: fixed static ring buffer (no heap), each record ~40 B;
  ~2 KB ≈ 50 records absorbs bursts; overflow drops oldest and sets an
  "overflowed" flag in the next batch so the app knows about gaps.
- **Dedup policy (cheap, on-device)**: re-report a MAC only if PWR
  bucket moved or 5 s passed since its last report; new MACs report
  immediately. This is transport hygiene, not interpretation.
- **Transport decision — BLE first.** `detector-ble` runs the ESP32's
  built-in radio as a plain GATT peripheral the phone connects to
  (it is no longer doing any scanning, so this is the boring, stable
  configuration, not a dual-role trick). One characteristic,
  notify-only, batch records as compact length-prefixed lines; write
  characteristic for app→device commands (set filter, flush, stats).
  Just Works pairing. Chosen because the field case has no network and
  no hotspot dependency, and pairing is a normal phone flow. WiFi mode
  kept because it is trivially debuggable from a laptop and useful at
  home.
  (Trade-off acknowledged: BLE transport throughput ~single-digit KB/s;
  our deduped scan load is well under that. If a capture ever needs
  more, that is the moment WiFi/HTTP bulk upload earns its place.)
- **Bonus mode (`-DSWEEPER_SURVEY=1`)**: when not decoding, the same
  modules can run the jammer's energy-sweep (RPD across all channels)
  and emit band-survey records — the detector doubles as a live
  occupancy view of the band the jammer floods. Shared code with the
  sweeper env.

## 4. Record format (wire)

One line per record, minimal binary-ish framing; readability beats
cleverness here:

```
MAC:aa:bb:cc:dd:ee:ff PWR:27 T:123456 CH:37 CRC:1 AD:<hex-of-raw-pdu>
BATCH-START seq=42      BATCH-END n=17
```

`PWR:` is the module's raw power reading (7-bit register where the
clone silicon has one, else 0/1 RPD) — the app maps it to relative
bars and never claims dBm. `CRC:` marks whether the BLE CRC checked,
so noise bursts can be shown or hidden by the app rather than silently
dropped on-device.

Versioned by an initial `PROTO=1` capability read, so the app and
firmware can disagree safely.

## 5. Phone app ("police app")

**Platform decision (this is the one hard fork):** Android first.
Android's BLE API exposes the real device MAC and background scanning —
the two things this project is built on. iOS does not give third-party
apps the peripheral MAC (per-app UUIDs instead) and throttles background
scan; on iOS the whole MAC-lookup/history story degrades. If an iPhone
build is later wanted, treat it as a reduced-coverage variant.
Recommendation: native Android (Kotlin) — a background service, a scan
list, a map. RN is possible (super-matrix's app stack is RN) but the
BLE background service is the core, and native handles it best; decide at
M3 if a shared RN UI is wanted over native comfort.

App responsibilities:

1. **Connect/reconnect** to the detector (bond + auto-reconnect; show
   connection age and buffer/overflow stats).
2. **Decode** raw AD: company IDs, service UUIDs, names, flags.
3. **Vendor lookup**: offline OUI table (IEEE list, a few MB in SQLite,
   bundled) — MAC → manufacturer string.
4. **Police classifier**: ordered rules, user-editable:
   - company ID `0x034D`/`0xFC81` or OUI `00:25:DF` → *Axon (likely)*;
   - name regex `axon|body\s*[23]` → *Axon (name)*;
   - user-added MACs → *known unit*;
   - plus per-rule "confidence" shown honestly.
   This rule list is data, not code, and starts from the catalog our
   research built — first field sessions are for extending it from what
   we actually see.
5. **Storage**: SQLite `sightings(ts, mac, pwr, pwr_min/max, count,
    first_seen, last_seen, ad_blob, classifier_tag)`; CSV export.
6. **Views**: live list (relative signal bars from the PWR register +
    packet rate, vendor, tag), per-MAC history sparkline, and **map
    pins**: pin each *classified* device at the phone's last GPS fix
    while sighting it, signal-stats→rough-proximity ring (log-distance
    estimate, explicitly labeled rough). Later: two or more
    detectors → crude multilateration — one reason the repo is a
    monorepo.
7. **MAC randomization reality check**: many phones (not police radios)
   rotate addresses; the classifier tags *static* public addresses and
   flags rotated ones instead of pretending they're new devices each
   minute. Axon body cams plausibly use static addresses — verify in
   the first capture; if they rotate, classify by company-ID payload
   instead of MAC, which is exactly why the raw AD is kept.

## 6. Milestones

- **M1 — see it (firmware only, no transport).** nRF24 adv sniff →
  USB serial, NDJSON records: bit-reverse/de-whiten/CRC shim, two
  modules on 37/39 + 38, PWR readings. *Done when: walking near an
  Axon/body cam (or any BLE advertiser) yields its decoded records
  and PWR.* No phone involved yet; this de-risks the radio shim
  standalone — it is the one genuinely novel piece in the firmware.
- **M2 — carry it (BLE transport).** GATT batches to a test client
  (`bleak` Python script on a laptop, or Android nRF Connect).
  *Done when: 30 min continuous capture over BLE with zero batch loss
  at desk distances.*
- **M3 — app v0 (Android).** Connect, live list with vendor lookups,
  save to SQLite. *Done when: a 30-minute walk logs cleanly and the
  table shows vendors.*
- **M4 — police view.** Classifier rules + map pins + per-device
  history. *Done when: field sessions produce a usable "was police
  activity nearby and when" record.*
- **M5 — polish.** Battery/enclosure, auto-start pairing, CSV share,
  overflow/duty stats in-app.

## 7. PIR presence option (`-DSWEEPER_PIR_PIN=…`)

A PIR motion sensor (HC-SR501-class, ~$3, an interrupt GPIO) is the other
half of "police activity nearby": BLE identifies *devices*; PIR senses
*people* — motion in a ~100° cone out to ~5–7 m, with no RF emission of
its own, so it never pollutes the band it shares a box with.

Firmware handles it as one more record type on the same stream:

```
PIR T:123456 DUR:4.2
```

GPIO ISR stamps the event edge; duration comes from the level pin. No
interpretation on-device, same as the radio path.

Value in the app: coincident PIR events and classified BLE sightings
raise each other's confidence ("a person moved past, and we started
hearing many more Axon packets" is much stronger than either alone),
and PIR timelines give a device-independent "was anyone here" track.

Honest limits: motion, not presence (still people are invisible); ~5 s
retrigger blanking on stock modules; false triggers from sunlight/HVAC
through windows; range collapses without line of sight. It's a presence
hint, not a person counter — displayed that way.

Bonus (M5): PIR's level pin is a valid deep-sleep wake source, so a
battery build can idle at µA and wake on movement.

Decided: **include from M1** — it's one ISR and one record type now, and
much harder to retrofit into the app's timeline model later.

## 8. Risks

| Risk | Mitigation |
|---|---|
| iOS lacks MAC access | Android-first; iOS later as reduced variant |
| nRF24 hears adv channels only (37/38/39) — not connected/data-channel traffic | Detection is exactly what advertising is for; a device that only talks while connected is invisible to every passive scanner anyway. Survey mode covers the rest of the band coarsely. |
| nRF24 power reading is coarse (RPD bit or 7-bit clone register, not dBm) | Forward raw, show relative bars, use packet *rate* as the primary strength signal; never print dBm |
| BLE adv PDUs > 32 bytes truncated by nRF24 payload limit | Header + MAC + first ~21 AD bytes still arrive — enough for OUI + company-ID matching, which is where the police signatures live; flag truncation honestly |
| No LE 2M/Coded-PHY extended advertising on nRF24 (1M legacy only) | Body cams and legacy police gear advertise legacy 1M on 37/38/39; if a target only ext-advertises, the survey mode still sees its energy and we revisit the front-end |
| Target devices randomize MACs | classify on AD payload (company IDs), keep raw AD forever |
| Power reading ≠ distance (orientation, body loss, temp drift of RPD threshold) | label ranges as rough; compare statistically, don't claim meters |
| Our own jammer polluting the band | detector and jammer are separate devices; if co-located, note that the jammer's own BLE is off — it is the band, not the device, at war |
| Duty of a listening device in public | passive listening only, no connections, no stored location on-device |

## 9. Open questions (for the user)

1. Phone: Android is the recommendation — confirm; an iPhone-only world
   changes section 5 materially.
2. Power model: USB/powerbank in a window vs battery pocket device?
   (drives antenna and enclosure choices, not the plan)
3. Should the detector also log to SD on top of the phone link
   (captures keep running if the phone is away), or is phone-coupled
   enough for now? (Suggestion: phone-coupled for v1, SD in M5 if
   wanted.)
