# Flags & uploads (v0)

Ad-hoc annotations ("flags") attached to observed devices, pulled by the
app from one HTTP endpoint, plus a dumb file-upload endpoint for hunt CSVs.
The primitive is deliberately `flag: bool` + free-text `note` — no other
semantics.

`flagsrv/` is the reference server: Go `net/http` +
modernc.org/sqlite (no CGO), schema via goose migrations.

```
flagsrv -db flags.db -uploads ./uploads -upload-key <password> [-seed seed.json] [-base-path /<long-random>]
```

`-base-path` mounts every route below under that prefix (anything else is
404), so `<base>` = `http://host:port/<long-random>` and the phone's flags
URL is `<base>/flags`. Without it `<base>` is the bare host.

## Core idea: a flag is a matcher set, not a MAC

Keying flags by MAC fails: random addresses rotate, and air glitches shift
bits (the app already folds those twins client-side, see
`app/src/devices.ts`). So a flag record carries a **set of matchers** and
the client decides whether it matches a device, reusing the same folding
rule it already trusts.

```
GET <base>/flags
→ { "revision": 7,
    "flags": [
      { "id": "f-01J...",
        "flag": true,
        "note": "free text",
        "matchers": [
          { "kind": "mac",       "value": "E7:A7:25:FF:09:DA" },
          { "kind": "name",      "value": "Govee_H6099_5194" },
          { "kind": "company",   "value": "05A7" },
          { "kind": "service",   "value": "FD50" },
          { "kind": "eddy_uid",  "value": "534D4152542D4C4F434B" },
          { "kind": "oui",       "value": "54:92:6A" }
        ],
        "updated_at": "2026-11-24T18:00:00Z" }
    ] }
```

Matching (client side, `app/src/flags.ts`, same confidence ladder as
`classify()`):

1. `eddy_uid` — Eddystone-UID namespace (+instance) hex, 10- or 20-hex.
   Exact, stable for installed beacons. Strongest.
2. `name` — exact (case-insensitive) match on the advertised local name.
3. `mac` — matches the device **or any of its folded glitch twins**
   (≤2-bit hamming, the `devices.ts` rule) — only while the app's "merge
   glitches" setting is on; with it off, exact MAC only, matching how the
   list shows the devices.
4. `company` / `service` / `oui` — weak matchers. They count **only in a
   record with no strong matchers**, and then only when **all** of them hit
   (family-level notes, e.g. "every Tuya FD50 device"), never
   any-single-hit. In a record that has any strong matcher they are
   descriptive only and never land it — flagging one iPhone (mac + company
   004C) must not flag every Apple device in range.

Any strong hit alone lands the record. A device can hold several records
(notes shown per record; the flagged state is OR).

Matcher value formats (the server rejects anything else with 400, since
the client could never match it; `0x` prefixes and `:`/`-` separators are
ignored in hex values):

| kind       | value                                                     |
|------------|-----------------------------------------------------------|
| `mac`      | `AA:BB:CC:DD:EE:FF` (any case)                            |
| `name`     | 1..64 chars, compared case-insensitively                  |
| `company`  | 16-bit SIG company id, 1..4 hex (`004C`)                  |
| `service`  | 16-bit UUID, 4 hex (`FE2C`), or 128-bit UUID, 32 hex       |
|            | (`0000FE2C-0000-1000-8000-00805F9B34FB`, dashes optional)  |
| `eddy_uid` | 10 or 20 hex                                              |
| `oui`      | 6 hex (`54:92:6A`)                                        |

## Sync semantics

**Pull is always manual.** The app fetches the URL only when the user
taps "Pull flags" (Settings → Flags). No background refresh, no fetch at
hunt start, no timer.

- **Pull overwrites the held copy of server records wholesale.** The
  server is authoritative for `id`s it owns, until the next pull.
- **Local records are separate.** Flags created on the device
  (`local-<MAC>` ids, matchers auto-filled from the current
  classification) are never clobbered by a pull. The `local-` id prefix
  is reserved for them: the server refuses to store a record whose id
  starts with `local-` (400). The app tells the two sets apart by which
  set a record was held in, never by id. They persist across
  restarts and hunts — per device, globally — and re-apply whenever that
  device shows up again.
- Settings → Flags lists every held record: local ones can be renamed
  (note), re-flagged/unflagged, or deleted individually, or wiped with
  "Clear my flags"; the server copy can be dropped with "Clear server
  copy" (the next pull refetches it).
- `updated_at` + `revision` are recorded for display only in v0.

## Uploads (hunt files → server directory)

For later inspection: the screen that lists hunt files offers **Upload**
per file, enabled only when the app has both a server URL and an upload
password configured (Settings → Flags). The server just writes the bytes
into its uploads directory — no parsing, no dedup.

```
POST <base>/upload
X-Upload-Key: <password>        → 401 if missing/wrong; 403 if the server
                                   started without -upload-key
X-File-Name: hunt_2026-11-24…   → percent-encoded UTF-8 (encodeURIComponent);
                                   decoded, base name taken, then
                                   sanitized to [A-Za-z0-9._-], else '_'
body: raw file bytes            → capped at 64 MiB

→ { "ok": true, "path": "20261124-180102-hunt_2026-11-24_09-47-58.csv",
    "bytes": 48123 }
```

Stored names are prefixed with a UTC timestamp (`O_EXCL`) so uploads
never overwrite each other. `GET <base>/flags` stays unauthenticated in
v0 — the URL itself (long random path, flagsrv `-base-path`) is the
access control; uploads are separately keyed because they write.

## Server schema (goose)

See `flagsrv/migrations/0001_init.sql`: `flags` (id, flag, note,
updated_at), `flag_matchers` (kind CHECKed to the six kinds), `meta`
(holds `revision`). `GET /flags` joins them; every write bumps
`revision`. `-seed <file>` upserts records from a JSON file shaped like
the GET response — see `flagsrv/seed.example.json`.

## Server management API (LAN)

```
GET    /flags        pull payload (the phone's only flag read)
POST   /flags        add a record (client may omit "id"; server generates "f-…")
GET    /flags/{id}   one record
PUT    /flags/{id}   replace flag/note/matchers wholesale
DELETE /flags/{id}   remove a record
GET    /uploads      list stored hunt files (name, bytes, mtime)
POST   /upload       store one hunt file (X-Upload-Key password)
GET    /healthz      "ok"
```

The server manages its own flags — add/list/get/replace/delete through the
endpoints above, so you can curate the set from any LAN client (curl, a
future web page) without touching sqlite. Every write bumps
`meta.revision`, which the phone shows next to "last pull". Writes
validate the FLAGS.md shape (1..16 matchers, kinds restricted to the six
above, per-kind value formats, no `local-` ids, note ≤1000 chars) before touching the db; `POST` to an existing
id is 409, unknown ids are 404.

This is LAN-side management: no auth in v0, same rule as the pull — the
URL itself is the access control. Uploads are the one keyed endpoint
because they write files. (App → server write-back of local flags would
use the same `POST`/`PUT` endpoints; still phase 2 on the client.)

## Client state

`app/src/flags.ts` holds the store (AsyncStorage key
`ultrascanner.flags.v1`), the matchers, and `pullFlags`/`uploadHuntFile`
(derived: `<base>/upload` from the configured `<base>/flags`; the URL's
path must end in `/flags`, a query string is carried over, anything else
is refused rather than guessed). Pull times out after 15 s, upload after
120 s.
Settings keys `flagsUrl` + `uploadPassword` gate the feature; empty =
off.
