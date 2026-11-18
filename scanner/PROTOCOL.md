# Scanner line protocol (PROTO=1)

Normative spec for what the scanner writes on its serial line. The
physical path is UART0 at the baud set by `SCANNER_BAUD` (921600 by
default) through the devkit's onboard USB-UART bridge; any USB host —
phone app, laptop, `picocom`, a script — is an equal client. The phone
app is the first client, not the owner of this format.

## Framing

- Every record is one ASCII line terminated by `\r\n`.
- Clients must ignore record types and fields they do not recognize.
- A session starts with exactly two unbatched lines:

  ```
  PROTO=1 DEV:scanner-usb FW:M1
  BANNER:SCANNER A=37/39 B=38 BATCH=2000 STATS=10000 PIR=27
  ```

  `PROTO=` is the stream version; a client that does not speak `1`
  should stop reading. `BANNER:` echoes the live build configuration so
  a capture file is self-describing.

## Batches

Detection records (MAC, PIR) are grouped between framing lines so
clients can apply a batch as one atomic update and never interpolate
half a window:

```
BATCH-START seq=<n>
<records...>
BATCH-END n=<record-count>
```

- `seq` starts at 1 and increases by 1 per batch, including batches
  forced early by buffer overflow.
- On overflow the firmware force-flushes and the next `BATCH-START`
  carries `ovf=1`: records were dropped for that window. Expect gaps,
  never silence: an empty `BATCH-START`/`BATCH-END` pair still appears
  every window when nothing was heard, so the client can tell "quiet"
  from "dead".

## Records

### MAC — BLE advertisement (inside a batch)

```
MAC:AA:BB:CC:DD:EE:FF PWR:<p> T:<ms> CH:<37|38|39> CRC:1 AD:<hex>
```

- `MAC:` AdvA from the PDU, printed MSB-first as usual for Bluetooth.
- `PWR:` raw value of the nRF24 RPD/power register (0x09) masked to
  7 bits, forwarded verbatim. It is **not** dBm: genuine L01+ parts
  expose one RPD bit (~-64 dBm threshold), L01P clones expose a 7-bit
  coarse register. Treat packet rate and persistence as the primary
  strength signal; PWR is a tiebreaker at best.
- `T:` device uptime ms of the RX interrupt, monotonic per session.
  Client timestamps (host clock at batch arrival) are the reference
  for cross-session comparison.
- `CH:` the BLE advertising channel it was heard on.
- `CRC:1` — only CRC-valid PDUs are emitted in M1 (noise and
  32-byte-truncated PDUs are dropped on-device).
- `AD:` hex dump of the de-whitened PDU as received: header byte,
  length, AdvA (LSB-first, air order), AD structures, CRC — whatever
  fit in the 32-byte FIFO. Clients parse types; the firmware never
  interprets them.

### PIR — motion event (inside a batch)

```
PIR T:<ms> DUR:<ms>
```

One line per falling edge of the PIR output (end of a motion
period). Only present when the build enables `SCANNER_PIR_PIN`.

### STATS — counters (unbatched)

```
STATS T:<ms> RA:<n> RB:<n> OK:<n> DUP:<n> OVER:<n>
```

Cumulative counters: blobs received on radio A / radio B, CRC-valid
PDUs, records suppressed by dedup, forced early flushes. Diagnostic
only; clients may ignore.

## Dedup

The device suppresses repeat reports of the same MAC while its PWR
value is unchanged and within `SCANNER_DEDUP_MS`. This is transport
hygiene, not interpretation: clients must still do their own dedup,
persistence and decay logic, and must treat a re-appearance after the
window as the only guaranteed refresh.

## Future record types (reserved names)

`WIFI:` (passive 2.4 GHz beacon SSID/BSSID/RSSI), `RAW:` (CRC-failed
blobs, for research). Names are reserved by this document; adding a
record type does not bump `PROTO=`. Clients skip what they don't know.
