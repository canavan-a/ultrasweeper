// Hunt analysis for the Map screen: reads a hunt CSV (huntlog.ts writes
// them), folds bit-error "shard" MACs into the device they came from, and
// combines several hunts into one device list with an estimated spot each.
//
// Why folding matters: nearly every record is CRC:S (the firmware never
// captured the CRC, see PROTOCOL.md), so single-bit errors in the address
// survive and one device shows up under many MACs. In the field logs about
// half of all MACs were such shards.

import {distanceM} from '../geo';

export interface Sighting {
  t: number;
  mac: string;
  police: string;
  vendor: string;
  name: string;
  lat: number | null;
  lon: number | null;
  ad: string;
  /** the MAC this row was logged under, when it was folded into another */
  shardOf?: string;
}

export interface HuntFix {
  t: number;
  lat: number;
  lon: number;
  speed: number | null;
}

export interface HuntDevice {
  mac: string;
  n: number;
  first: number;
  last: number;
  name: string;
  vendor: string;
  police: string;
  /** number of distinct shard MACs folded in */
  shards: number;
  /** mean phone position while heard (null: never heard with a fix) */
  centroid: {lat: number; lon: number} | null;
  /** about the length of track it was heard along, m */
  spread: number;
  sightings: Sighting[];
}

export interface Hunt {
  name: string;
  fixes: HuntFix[];
  devices: HuntDevice[];
  rawMacs: number;
  merged: number;
}

/** RFC 4180-ish CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cell = '';
  let quoted = false;
  let row: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [header, ...rest] = rows;
  if (!header) return [];
  return rest
    .filter(r => r.length >= header.length - 1)
    .map(r => Object.fromEntries(header.map((k, i) => [k, r[i] ?? ''])));
}

/** Hamming distance between two MACs (48 bits, compared as two 24-bit halves). */
export function macBitDistance(a: string, b: string): number {
  const hx = (m: string) => m.replace(/:/g, '');
  const pa = hx(a);
  const pb = hx(b);
  let n = 0;
  for (const [s, e] of [
    [0, 6],
    [6, 12],
  ]) {
    let x = (parseInt(pa.slice(s, e), 16) ^ parseInt(pb.slice(s, e), 16)) >>> 0;
    while (x) {
      x &= x - 1;
      n++;
    }
  }
  return n;
}

const num = (s: string | undefined): number | null => (s == null || s === '' ? null : Number(s));

export interface AnalyzeOptions {
  /** fold shards (default true) */
  merge?: boolean;
  /** a shard differs from its parent in at most this many bits */
  maxBits?: number;
  /** the parent was heard at least this many times as often */
  ratio?: number;
  /** and within this long of the shard */
  windowMs?: number;
}

export function analyzeHunt(name: string, rows: Record<string, string>[], opts: AnalyzeOptions = {}): Hunt {
  const {merge = true, maxBits = 2, ratio = 4, windowMs = 15000} = opts;
  const fixes: HuntFix[] = [];
  const byMac = new Map<string, Sighting[]>();
  for (const r of rows) {
    const t = Number(r.unix_ms);
    if (r.kind === 'fix') {
      const lat = num(r.lat);
      const lon = num(r.lon);
      if (lat != null && lon != null) fixes.push({t, lat, lon, speed: num(r.speed_mps)});
    } else if (r.kind === 'sighting' && r.mac) {
      const s: Sighting = {
        t,
        mac: r.mac,
        police: r.police ?? '',
        vendor: r.vendor ?? '',
        name: r.name ?? '',
        lat: num(r.lat),
        lon: num(r.lon),
        ad: r.ad ?? '',
      };
      const list = byMac.get(s.mac);
      if (list) list.push(s);
      else byMac.set(s.mac, [s]);
    }
  }
  const rawMacs = byMac.size;

  // Loudest first; each MAC may fold into an earlier (louder) one that is
  // not itself a shard. A MAC within maxBits of a much louder MAC heard at
  // the same time is a bit-error copy: random 48-bit addresses almost
  // never land that close by chance.
  const alias = new Map<string, string>();
  if (merge) {
    const list = [...byMac.entries()].map(([mac, a]) => ({mac, a})).sort((p, q) => q.a.length - p.a.length);
    for (let i = 1; i < list.length; i++) {
      const s = list[i];
      for (let j = 0; j < i; j++) {
        const p = list[j];
        if (p.a.length < s.a.length * ratio) break;
        if (alias.has(p.mac) || macBitDistance(p.mac, s.mac) > maxBits) continue;
        if (s.a.some(x => p.a.some(y => Math.abs(x.t - y.t) <= windowMs))) {
          alias.set(s.mac, p.mac);
          break;
        }
      }
    }
    for (const [shard, parent] of alias) {
      const target = byMac.get(parent)!;
      for (const x of byMac.get(shard)!) target.push({...x, mac: parent, shardOf: shard});
      byMac.delete(shard);
    }
  }

  const devices = [...byMac.entries()]
    .map(([mac, a]): HuntDevice => {
      a.sort((p, q) => p.t - q.t);
      const located = a.filter(x => x.lat != null && x.lon != null) as (Sighting & {lat: number; lon: number})[];
      let centroid: HuntDevice['centroid'] = null;
      let spread = 0;
      if (located.length) {
        centroid = {
          lat: located.reduce((s, x) => s + x.lat, 0) / located.length,
          lon: located.reduce((s, x) => s + x.lon, 0) / located.length,
        };
        for (const x of located) spread = Math.max(spread, distanceM(centroid, x) * 2);
      }
      // shard copies carry bit-flipped names too: take the most common
      const mode = (k: 'name' | 'vendor' | 'police') => {
        const m = new Map<string, number>();
        for (const x of a) if (x[k]) m.set(x[k], (m.get(x[k]) ?? 0) + 1);
        return [...m.entries()].sort((p, q) => q[1] - p[1])[0]?.[0] ?? '';
      };
      return {
        mac,
        n: a.length,
        first: a[0].t,
        last: a[a.length - 1].t,
        name: mode('name'),
        vendor: mode('vendor'),
        police: mode('police'),
        shards: new Set(a.filter(x => x.shardOf).map(x => x.shardOf)).size,
        centroid,
        spread,
        sightings: a,
      };
    })
    .sort((p, q) => q.n - p.n);

  return {name, fixes, devices, rawMacs, merged: alias.size};
}

// --- several hunts -> one device list -------------------------------------

export interface MapDevice {
  mac: string;
  name: string;
  vendor: string;
  police: string;
  n: number;
  hunts: string[];
  /** sightings that had a fix, across all picked hunts */
  points: {t: number; lat: number; lon: number; hunt: string}[];
  /** estimated spot: mean phone position while heard; r = RMS distance from it (min 15 m) */
  est: {lat: number; lon: number; r: number};
}

export function combineHunts(hunts: Hunt[]): MapDevice[] {
  const byMac = new Map<string, MapDevice>();
  for (const h of hunts) {
    for (const d of h.devices) {
      let x = byMac.get(d.mac);
      if (!x) {
        x = {mac: d.mac, name: '', vendor: '', police: '', n: 0, hunts: [], points: [], est: {lat: 0, lon: 0, r: 0}};
        byMac.set(d.mac, x);
      }
      x.name ||= d.name;
      x.vendor ||= d.vendor;
      x.police ||= d.police;
      x.n += d.n;
      x.hunts.push(h.name);
      for (const s of d.sightings) {
        if (s.lat != null && s.lon != null) x.points.push({t: s.t, lat: s.lat, lon: s.lon, hunt: h.name});
      }
    }
  }
  const out = [...byMac.values()].filter(d => d.points.length);
  for (const d of out) d.est = estimate(d.points);
  return out.sort((a, b) => b.n - a.n);
}

export function estimate(pts: {lat: number; lon: number}[]): {lat: number; lon: number; r: number} {
  const lat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const lon = pts.reduce((s, p) => s + p.lon, 0) / pts.length;
  const k = Math.cos((lat * Math.PI) / 180) * 111320;
  const sq = pts.reduce((s, p) => s + ((p.lat - lat) * 111320) ** 2 + ((p.lon - lon) * k) ** 2, 0);
  return {lat, lon, r: Math.max(15, Math.sqrt(sq / pts.length))};
}

/** "hunt_2026-11-24_09-47-58.csv" -> "11/24 09:47" */
export function huntLabel(name: string): string {
  const m = name.match(/hunt_(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)/);
  return m ? `${m[2]}/${m[3]} ${m[4]}:${m[5]}` : name;
}
