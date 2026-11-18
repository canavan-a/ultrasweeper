# detector — plan

Status: **planned**. Goal: a pocket ESP32 BLE detector that sniffs the
air, and a phone app that turns the sightings into "here is a police
device" — map pins, vendor lookups, signal strength.

## 1. What it is for

Police activity around us shows up on Bluetooth: the body cameras in use
locally are Axon units (Albany PD on Body 2; NYSP on Body 3, which is
LTE-capable), and Axon BLE traffic carries identifiable vendor signatures
(company IDs `0x034D`/`0xFC81`, OUI `00:25:DF` — worth re-verifying
against our own captures). nRF52-based transmitters like those are
detectable at ~50–100 m with an ESP32's PCB antenna, farther with a
better one.

The detector answers: *what BLE is around me, how strong, and which of it
looks like police equipment* — logged over time, map-pinable. It joins the
monorepo beside `bluetooth/` (the jammer); the two are a matched pair of
experiments — one fills the band, the other reads it.

## 2. Architecture — the split of work

```
ESP32 detector                         Phone (the "police app")
────────────────                       ─────────────────────────
BLE radio, passive scan                connects to the detector
raw AD records -> ring buffer          dedupe/history -> SQLite
compact batch records                 OUI + company-ID lookup (offline)
GATT notify (primary link)             "police?" classifier (rule list)
optional WiFi sidechannel (dev)        RSSI display, map, pins
```

Firmware does only what only it can do: hold the radio, capture
advertisements with RSSI and timestamps, never drop a batch. Everything
interpretive lives on the phone — decoding AD structures, vendor lookups,
classification, persistence, UI, maps. This keeps the firmware simple and
the app iterable, and means protocol changes ship in the app.

## 3. Firmware (`detector/firmware/`, PlatformIO, monorepo conventions)

- **Environments**: `detector-ble` (scan + BLE peripheral transport —
  the field build), `detector-wifi` (scan + WebSocket push to a network —
  dev/desktop build). Same core; transport selected per env. Config
  (scan window, RSSI floor, report filters) lives in `build_flags`.
- **Scan**: continuous passive scan on all 37 data channels via
  NimBLE-Arduino (`h2zero/NimBLE-Arduino` — small, leaves RAM for the
  buffer). Passive only: the detector never connects or answers, it just
  listens, so it cannot be identified as a scanner by the things it sees.
- **Capture**: keep the raw advertisement payload (all AD structures) as
  opaque bytes plus mac, rssi, channel, timestamp — decode nothing on the
  ESP32. Raw AD means the app can learn new signatures without any
  firmware change.
- **Buffering**: fixed static ring buffer (no heap), each record ~40 B;
  ~2 KB ≈ 50 records absorbs bursts; overflow drops oldest and sets an
  "overflowed" flag in the next batch so the app knows about gaps.
- **Dedup policy (cheap, on-device)**: re-report a MAC only if RSSI
  moved > 6 dB or 5 s passed since its last report; new MACs report
  immediately. This is transport hygiene, not interpretation.
- **Transport decision — BLE first.** `detector-ble` runs *dual-role*:
  central-side scanning plus a GATT peripheral the phone connects to
  (ESP32 supports both concurrently). One characteristic, notify-only,
  batch records as compact length-prefixed lines; write characteristic
  for app→device commands (set filter, flush, stats). Just Works pairing.
  Chosen because the field case has no network and no hotspot dependency,
  and pairing is a normal phone flow. WiFi mode kept because it is
  trivially debuggable from a laptop and useful at home.
  (Trade-off acknowledged: BLE transport throughput ~single-digit KB/s;
  our deduped scan load is well under that. If a capture ever needs more,
  that is the moment WiFi/HTTP bulk upload earns its place.)

## 4. Record format (wire)

One line per record, minimal binary-ish framing; readability beats
cleverness here:

```
MAC:aa:bb:cc:dd:ee:ff RSSI:-87 T:123456 CH:37 AD:<hex-of-raw-payload>
BATCH-START seq=42      BATCH-END n=17
```

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
5. **Storage**: SQLite `sightings(ts, mac, rssi, rssi_min/max, count,
   first_seen, last_seen, ad_blob, classifier_tag)`; CSV export.
6. **Views**: live list (strength meter, vendor, tag), per-MAC history
   sparkline, and **map pins**: pin each *classified* device at the
   phone's last GPS fix while sighting it, RSSI→rough-proximity ring
   (log-distance estimate, explicitly labeled rough). Later: two or more
   detectors → crude multilateration — one reason the repo is a monorepo.
7. **MAC randomization reality check**: many phones (not police radios)
   rotate addresses; the classifier tags *static* public addresses and
   flags rotated ones instead of pretending they're new devices each
   minute. Axon body cams plausibly use static addresses — verify in
   the first capture; if they rotate, classify by company-ID payload
   instead of MAC, which is exactly why the raw AD is kept.

## 6. Milestones

- **M1 — see it (firmware only, no transport).** Scan → USB serial,
  NDJSON records. *Done when: walking near an Axon/body cam (or any
  known-BLE reference) yields its records and RSSI.* No phone involved
  yet; this de-risks the radio work standalone.
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
raise each other's confidence ("a person moved past, and an Axon is
5 dB louder" is much stronger than either alone), and PIR timelines give
a device-independent "was anyone here" track.

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
| Dual-role (scan+peripheral) instability on ESP32 | NimBLE supports it, but M2 proves it early; WiFi env is the fallback transport |
| Target devices randomize MACs | classify on AD payload (company IDs), keep raw AD forever |
| RSSI ≠ distance (orientation, body loss) | label ranges as rough; compare statistically, don't claim meters |
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
