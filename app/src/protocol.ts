// Parser for the scanner line protocol (PROTO=1). PROTOCOL.md in the
// firmware tree is the normative spec; this file mirrors it record for
// record. Rules that come from the spec and shape how we parse:
//
// - one record per \r\n line; unknown record types are skipped, not errors;
// - the session opens with `PROTO=...` and `BANNER:SCANNER ...` lines;
// - MAC/PIR records arrive between BATCH-START/BATCH-END framing;
// - the firmware's dedup is transport hygiene, not interpretation: every
//   record here is treated as one sighting, and all dedup/merge/persistence
//   logic lives on this side (devices.ts).
//
// The parser is deliberately allocation-light and stateless beyond a line
// buffer: usb.ts feeds it arbitrary byte-chunks straight off the wire.

export interface SessionInfo {
  type: 'session';
  proto: number;
  dev: string;
  /** board eFuse MAC, e.g. "D0EF7613EAA0" — the stable device key */
  id: string;
  fw: string;
  banner: string;
}

export interface MacRecord {
  type: 'mac';
  /** AdvA, MSB-first as printed: "AA:BB:CC:DD:EE:FF" */
  mac: string;
  /** raw nRF24 power register, 7-bit — a tiebreaker, not dBm (PROTOCOL.md) */
  pwr: number;
  /** device uptime ms of the RX; only comparable within one session */
  t: number;
  ch: 37 | 38 | 39;
  /** verification level the firmware reached: full / partial CRC / structure */
  crc: '1' | 'P' | 'S';
  /** hex of the de-whitened PDU prefix as received (no separators) */
  ad: string;
}

export interface PirRecord {
  type: 'pir';
  t: number;
  dur: number;
}

export interface StatsRecord {
  type: 'stats';
  t: number;
  ra: number;
  rb: number;
  ok: number;
  dup: number;
  over: number;
}

export interface BatchStart {
  type: 'batch-start';
  seq: number;
  ovf: boolean;
}

export interface BatchEnd {
  type: 'batch-end';
  n: number;
}

export interface RawRecord {
  type: 'raw';
  t: number;
  ch: number;
  pwr: number;
  hex: string;
}

export interface UnknownRecord {
  type: 'unknown';
  line: string;
}

export type ParsedRecord =
  | SessionInfo
  | MacRecord
  | PirRecord
  | StatsRecord
  | BatchStart
  | BatchEnd
  | RawRecord
  | UnknownRecord;

// Field tokens are `KEY:value` (records) or `KEY=value` (framing/session
// lines); this matches both. Values run to whitespace.
const KV = /([A-Za-z]+)[=:]([^\s]*)/g;

function fields(line: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of line.matchAll(KV)) {
    out.set(m[1], m[2]);
  }
  return out;
}

function num(f: Map<string, string>, key: string): number {
  const v = Number(f.get(key));
  return Number.isFinite(v) ? v : 0;
}

const MAC_RE = /^MAC:([0-9A-F]{2}(?::[0-9A-F]{2}){5})\b/;

/**
 * Parse one protocol line. Returns null only for blank lines; anything
 * unrecognized comes back as an `unknown` record so callers can count
 * (and future builds can keep adding record types without breaking us).
 */
export function parseLine(line: string): ParsedRecord | null {
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('PROTO=')) {
    const f = fields(trimmed);
    return {
      type: 'session',
      proto: num(f, 'PROTO'),
      dev: f.get('DEV') ?? '',
      id: f.get('ID') ?? '',
      fw: f.get('FW') ?? '',
      banner: '',
    };
  }
  if (trimmed.startsWith('BANNER:')) {
    // merged into the SessionInfo by the StreamParser's pairing logic;
    // on its own (e.g. a mid-session diag banner) it is informational.
    return {type: 'unknown', line: trimmed};
  }
  if (trimmed.startsWith('RESET:')) {
    // power-on resets: informative for a debug view, not a record type.
    return {type: 'unknown', line: trimmed};
  }

  if (trimmed.startsWith('BATCH-START')) {
    const f = fields(trimmed);
    return {type: 'batch-start', seq: num(f, 'seq'), ovf: f.get('ovf') === '1'};
  }
  if (trimmed.startsWith('BATCH-END')) {
    const f = fields(trimmed);
    return {type: 'batch-end', n: num(f, 'n')};
  }

  const mac = trimmed.match(MAC_RE);
  if (mac) {
    const f = fields(trimmed);
    const ch = num(f, 'CH');
    // A record without a CRC field is weakest-proof, not strongest:
    // default to structure-only rather than claiming a verified frame.
    const crc = (f.get('CRC') ?? 'S') as MacRecord['crc'];
    return {
      type: 'mac',
      mac: mac[1],
      pwr: num(f, 'PWR'),
      t: num(f, 'T'),
      ch: (ch === 38 || ch === 39 ? ch : 37) as MacRecord['ch'],
      crc,
      ad: (f.get('AD') ?? '').toUpperCase().replace(/[^0-9A-F]/g, ''),
    };
  }

  if (trimmed.startsWith('PIR ')) {
    const f = fields(trimmed);
    return {type: 'pir', t: num(f, 'T'), dur: num(f, 'DUR')};
  }
  if (trimmed.startsWith('STATS ')) {
    const f = fields(trimmed);
    return {
      type: 'stats',
      t: num(f, 'T'),
      ra: num(f, 'RA'),
      rb: num(f, 'RB'),
      ok: num(f, 'OK'),
      dup: num(f, 'DUP'),
      over: num(f, 'OVER'),
    };
  }
  if (trimmed.startsWith('RAW ')) {
    const f = fields(trimmed);
    return {
      type: 'raw',
      t: num(f, 'T'),
      ch: num(f, 'CH'),
      pwr: num(f, 'PWR'),
      hex: (f.get('HEX') ?? '').toUpperCase().replace(/[^0-9A-F]/g, ''),
    };
  }

  // DIAG/boot chatter and anything a newer firmware invents.
  return {type: 'unknown', line: trimmed};
}

// Where a record can begin. None of these can occur inside a healthy line
// (AD/HEX payloads are uppercase hex, and none of these prefixes is), so
// finding one past column 0 means bytes were lost and two lines ran
// together: the head is a truncated record and the tail is a fresh one.
const RECORD_START = /MAC:[0-9A-F]{2}:|BATCH-(?:START|END)|STATS T:|PIR T:|RAW T:|PROTO=/g;

/** index of the last record start past column 0, or -1 */
function lastEmbeddedStart(line: string): number {
  let at = -1;
  RECORD_START.lastIndex = 1;
  let m: RegExpExecArray | null;
  while ((m = RECORD_START.exec(line)) !== null) {
    if (m.index > 0) at = m.index;
  }
  return at;
}

/** longest line PROTOCOL.md can produce, with headroom (MAC + 32-byte AD ~ 130) */
const MAX_LINE = 512;

/**
 * Splits a byte-stream (already decoded to a string) into protocol lines.
 * feed() may be called with any chunk boundary; a partial trailing line is
 * kept in the buffer. The firmware's startup garble (ROM chatter at the
 * wrong baud) simply arrives as unparseable lines, which parseLine turns
 * into `unknown` — no special-casing needed here.
 *
 * Lost bytes (a dropped USB packet, a bridge-chip overrun) are survivable:
 * a line that swallowed the start of the next record is cut back to that
 * record (`corrupt` counts how often), and an over-long run without a line
 * ending is thrown away instead of being parsed or buffered forever.
 *
 * One pass with indexOf per chunk: native hands JS large coalesced chunks,
 * and re-slicing the whole buffer per line (as this used to) was quadratic.
 */
export class StreamParser {
  private buf = '';
  /** lines dropped or cut because bytes were evidently lost */
  corrupt = 0;

  feed(chunk: string): ParsedRecord[] {
    const data = this.buf.length ? this.buf + chunk : chunk;
    const out: ParsedRecord[] = [];
    let pos = 0;
    let nl: number;
    // Accept bare \n too: tolerating it costs nothing and covers a host
    // driver that strips \r.
    while ((nl = data.indexOf('\n', pos)) >= 0) {
      let line = data.slice(pos, nl);
      pos = nl + 1;
      if (line.length > MAX_LINE) {
        // keep whatever valid record the tail holds; the rest is garbage
        const at = lastEmbeddedStart(line);
        this.corrupt++;
        if (at < 0) continue;
        line = line.slice(at);
      } else {
        const at = lastEmbeddedStart(line);
        if (at > 0) {
          this.corrupt++;
          line = line.slice(at);
        }
      }
      const rec = parseLine(line);
      if (rec) {
        out.push(rec);
      }
    }
    this.buf = pos < data.length ? data.slice(pos) : '';
    // A stuck device that stops terminating lines shouldn't grow this
    // forever; past a few lines' worth of unterminated text is noise.
    if (this.buf.length > 8 * MAX_LINE) {
      this.buf = '';
      this.corrupt++;
    }
    return out;
  }

  reset(): void {
    this.buf = '';
    this.corrupt = 0;
  }
}
