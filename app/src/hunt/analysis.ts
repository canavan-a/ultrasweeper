// Hunt analysis for the Map screen: reads a hunt CSV (huntlog.ts writes
// them), folds bit-error "shard" MACs into the device they came from, and
// combines several hunts into one device list with an estimated spot each.
//
// Why folding matters: nearly every record is CRC:S (the firmware never
// captured the CRC, see PROTOCOL.md), so single-bit errors in the address
// survive and one device shows up under many MACs. In the field logs about
// half of all MACs were such shards.

import {distanceM} from '../geo';
import {classify, type Classification} from '../lookup/adparse';

// CRC check quality of a record, same ranking the live scan engine uses
// (src/devices.ts): '1' full, 'P' payload only, 'S' structure only (what
// nearly every hunt record is), '' unknown.
const CRC_RANK: Record<string, number> = {'1': 3, P: 2, S: 1, '': 0};
const crcRank = (crc: string): number => CRC_RANK[crc] ?? 0;

// Re-classifying payloads is the expensive part of opening a hunt on the
// map, so the frames decoded per device are capped. They are picked by
// advertisement shape rather than by frequency: a phone broadcasts an
// unbounded number of payloads whose counter bytes differ, and a beacon
// that sends an Eddystone UID frame once an hour must still be found.
const MAX_PER_SHAPE = 3;
const MAX_CLASSIFIED = 20;
const MAX_PAYLOADS = 12;

export interface Sighting {
  t: number;
  mac: string;
  police: string;
  vendor: string;
  name: string;
  lat: number | null;
  lon: number | null;
  ad: string;
  /** CRC check quality of this record: '1' full, 'P' payload-only, 'S' structure only */
  crc: string;
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
  /** best description from re-classifying its most common payload with today's tables */
  kind: string;
  police: string;
  /** number of distinct shard MACs folded in */
  shards: number;
  /** mean phone position while heard (null: never heard with a fix) */
  centroid: {lat: number; lon: number} | null;
  /** about the length of track it was heard along, m */
  spread: number;
  /** re-classification of its most common payload (null: no AD capture) */
  cls: Classification | null;
  /**
   * re-classification of each other distinct payload it was heard with,
   * most verified first, capped. One decoding may appear once per shape
   * it was heard in (combineHunts collapses those). Flags are matched one
   * of these at a time, never across them.
   */
  payloads: DevicePayload[];
  sightings: Sighting[];
}

/**
 * A REPORT POLICE sighting (ScanScreen police tab): the hunter saw police
 * at this time and place while the radio matched nothing. Devices heard
 * nearby at that moment are candidate police signatures — these anchors
 * are how new detectable signals get found.
 */
export interface HuntReport {
  t: number;
  lat: number | null;
  lon: number | null;
  note: string;
}

export interface Hunt {
  name: string;
  fixes: HuntFix[];
  devices: HuntDevice[];
  reports: HuntReport[];
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

/** a MAC as two 24-bit halves, for bit distances */
function macHalves(mac: string): [number, number] {
  const h = mac.replace(/:/g, '');
  return [parseInt(h.slice(0, 6), 16), parseInt(h.slice(6, 12), 16)];
}

function bits24(x: number): number {
  let n = 0;
  for (let v = x >>> 0; v; v &= v - 1) {
    n++;
  }
  return n;
}

function halvesDistance(a: [number, number], b: [number, number]): number {
  return bits24(a[0] ^ b[0]) + bits24(a[1] ^ b[1]);
}

/** Hamming distance between two MACs (48 bits, compared as two 24-bit halves). */
export function macBitDistance(a: string, b: string): number {
  return halvesDistance(macHalves(a), macHalves(b));
}

/** labels that say nothing beyond the vendor */
const GENERIC_LABEL = /advertisement$|^OUI-registered|service [0-9A-F]{4}$|^Google Fast Pair device$/;

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
  const reports: HuntReport[] = [];
  const byMac = new Map<string, Sighting[]>();
  for (const r of rows) {
    const t = Number(r.unix_ms);
    if (r.kind === 'fix') {
      const lat = num(r.lat);
      const lon = num(r.lon);
      if (lat != null && lon != null) fixes.push({t, lat, lon, speed: num(r.speed_mps)});
    } else if (r.kind === 'report') {
      reports.push({t, lat: num(r.lat), lon: num(r.lon), note: r.note ?? ''});
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
        crc: r.crc ?? '',
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
    // every MAC is compared with every louder one: parse the addresses once,
    // not once per pair (thousands of MACs in a long hunt)
    const list = [...byMac.entries()]
      .map(([mac, a]) => ({mac, a, bits: macHalves(mac)}))
      .sort((p, q) => q.a.length - p.a.length);
    for (let i = 1; i < list.length; i++) {
      const s = list[i];
      for (let j = 0; j < i; j++) {
        const p = list[j];
        if (p.a.length < s.a.length * ratio) break;
        if (alias.has(p.mac) || halvesDistance(p.bits, s.bits) > maxBits) continue;
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
      // Re-classify the payloads: old logs get today's lookup tables (the
      // CSV's vendor column is what the app knew at capture time). The most
      // common payload still describes the device; flag matching additionally
      // sees the other payloads this MAC was heard with, because a beacon
      // that alternates frames (an Eddystone UID in one, a service UUID in
      // the next) must keep every matcher that would hit on the scan screen.
      // Those are kept apart, never merged: matchDevicePayloads matches one
      // advertisement at a time, so a flag can never read fields that were
      // never in the same frame.
      //
      // Payloads whose CRC only checked out structurally ('S') are the
      // common case, not garbage to throw away: they carry most real frames,
      // and a bit-flipped copy almost never matches a flag exactly anyway
      // (it would have to land on the very name or UID the owner wrote
      // down). They rank below the frames that passed a CRC check, which is
      // all the difference the ranking makes. Of what is left, a few
      // representatives of each distinct advertisement shape are decoded:
      // shapes are what differs between a phone's rotating payloads
      // (unbounded, all decoding alike) and the separate frame a beacon
      // sends now and then (an Eddystone UID, a service UUID), and picking
      // the most frequent payloads alone would drop the latter. Decodings
      // that come out identical are then collapsed.
      const seenAd = new Map<string, {n: number; crc: string}>();
      for (const x of a) {
        if (!x.ad) continue;
        const e = seenAd.get(x.ad) ?? {n: 0, crc: ''};
        e.n += 1;
        if (crcRank(x.crc) > crcRank(e.crc)) e.crc = x.crc;
        seenAd.set(x.ad, e);
      }
      const ranked = [...seenAd.entries()].sort(
        (p, q) =>
          q[1].n - p[1].n || crcRank(q[1].crc) - crcRank(p[1].crc) || q[0].length - p[0].length,
      );
      // description: the best-verified common payload, as the scan screen's
      // engine picks one advertisement per device (src/devices.ts)
      const cls = ranked.length ? classify(mac, ranked[0][0]) : null;
      // One sample per shape first: a rare frame type keeps its sample
      // however many more frequent shapes the device also sends. Inside a
      // shape only the best-verified tier counts: a frame that passed its
      // CRC check outranks the bit-flipped copies of it, but where nothing
      // better was heard the structure-only copy is used, because that is
      // how nearly every real frame in these logs arrives. The shapes
      // themselves are taken in order of how often the device was heard
      // sending that form: a bit-flipped header or length byte makes a
      // one-off corrupt copy look like a new shape, and those must not
      // spend the sample budget before the real frame the owner flagged.
      const bestFirst = [...seenAd.entries()].sort(
        (p, q) =>
          crcRank(q[1].crc) - crcRank(p[1].crc) || q[0].length - p[0].length || q[1].n - p[1].n,
      );
      const byShape = new Map<string, {shape: string; ads: string[]; tier: number; n: number}>();
      for (const [ad, e] of bestFirst) {
        const shape = advertisementShape(ad);
        const rank = crcRank(e.crc);
        const g = byShape.get(shape);
        if (!g) {
          byShape.set(shape, {shape, ads: [ad], tier: rank, n: e.n});
        } else {
          g.n += e.n;
          if (g.tier === rank && g.ads.length < MAX_PER_SHAPE) {
            g.ads.push(ad);
          }
        }
      }
      const groups = [...byShape.values()].sort((x, y) => y.n - x.n);
      const samples: {ad: string; shape: string; crc: number}[] = [];
      for (let round = 0; round < MAX_PER_SHAPE && samples.length < MAX_CLASSIFIED; round++) {
        for (const g of groups) {
          if (samples.length >= MAX_CLASSIFIED) break;
          if (g.ads[round]) samples.push({ad: g.ads[round], shape: g.shape, crc: g.tier});
        }
      }
      // Identical decodings collapse per shape, not across shapes: another
      // hunt may outrank this hunt's copy of one shape (mergePayloads), and
      // the same decoding heard in a different shape must then survive it.
      // The cap counts distinct decodings; the list itself stays within
      // MAX_CLASSIFIED, as every entry is one sample.
      const payloads: DevicePayload[] = [];
      const decoded = new Set<string>();
      const sigs = new Set<string>();
      for (const s of samples) {
        const c = classify(mac, s.ad);
        const sig = payloadSignature(c);
        if (decoded.has(`${s.shape}|${sig}`) || (!sigs.has(sig) && sigs.size >= MAX_PAYLOADS)) {
          continue;
        }
        decoded.add(`${s.shape}|${sig}`);
        sigs.add(sig);
        payloads.push({cls: c, shape: s.shape, crc: s.crc});
      }
      return {
        mac,
        n: a.length,
        first: a[0].t,
        last: a[a.length - 1].t,
        name: mode('name') || cls?.name || '',
        vendor: cls?.vendor ?? mode('vendor'),
        kind: cls?.labels.find(l => !GENERIC_LABEL.test(l)) ?? '',
        cls,
        payloads,
        police: mode('police'),
        shards: new Set(a.filter(x => x.shardOf).map(x => x.shardOf)).size,
        centroid,
        spread,
        sightings: a,
      };
    })
    .sort((p, q) => q.n - p.n);

  return {name, fixes, devices, reports, rawMacs, merged: alias.size};
}

// --- several hunts -> one device list -------------------------------------

/**
 * The shape of an advertisement: its header byte plus the AD structures it
 * carries (type and length), not their bytes. Payloads of one shape differ
 * only in the bytes that rotate (Apple's counters and hashes, a bit-flipped
 * name), so decoding a few of them is enough to know what this device
 * broadcasts in that form; a frame of another shape says something else,
 * and that is the one worth keeping a sample of.
 *
 * This walks the length bytes only: it runs over every payload in the log,
 * where parsePdu's allocations would be the bulk of the work.
 */
function advertisementShape(ad: string): string {
  // header, declared length, AdvA: 8 fixed bytes, then (length, type, data)
  const parts = [ad.slice(0, 4), `n${ad.length}`];
  for (let i = 16; i + 4 <= ad.length; ) {
    const len = parseInt(ad.slice(i, i + 2), 16);
    if (!Number.isFinite(len) || len === 0) break;
    parts.push(`${ad.slice(i + 2, i + 4)}:${len}`);
    // a structure the capture cut short still counts, as parsePdu still
    // decodes it: FIFO truncation is common, and without its type two
    // different frames cut at the same length would look like one shape
    if (i + 2 + len * 2 > ad.length) break;
    i += 2 + len * 2;
  }
  return parts.join(',');
}

/**
 * What a flag can see in one advertisement: the fields flags.ts matches on.
 * Two payloads with the same signature match exactly the same flags, so
 * rotating counters (Apple's per-advertisement bytes) collapse to one entry.
 */
function payloadSignature(c: Classification): string {
  return [
    c.name ?? '',
    c.companyIds.join(','),
    c.serviceUuids.join(','),
    c.serviceUuids128.join(','),
    c.eddystoneUids.join(','),
    c.manufacturerData.map(m => m.company).join(','),
  ].join('|');
}

/**
 * Re-classification of one advertisement a device was heard with, plus the
 * advertisement shape it came from and that frame's CRC verification rank
 * (see crcRank). Shape and rank let the cross-hunt merge discard corrupt
 * copies of a frame another hunt logged with a better CRC check.
 */
export interface DevicePayload {
  cls: Classification;
  shape: string;
  crc: number;
}

/**
 * Join one MAC's payload lists from every picked hunt. The lists are taken
 * one payload at a time in turn - one from each hunt before a second from
 * any - so a frame only heard in a later hunt is not cut by the cap when
 * an earlier hunt happens to fill it with its own. Decodings that come out
 * identical collapse to one copy regardless of hunt, and for a given
 * advertisement shape only the best-verified tier survives: a bit-flipped
 * copy heard in one hunt yields to the CRC-checked frame another hunt heard.
 */
function mergePayloads(sets: DevicePayload[][]): DevicePayload[] {
  const tier = new Map<string, number>();
  for (const set of sets) {
    for (const p of set) {
      tier.set(p.shape, Math.max(tier.get(p.shape) ?? -1, p.crc));
    }
  }
  const out: DevicePayload[] = [];
  const seen = new Set<string>();
  // each hunt's list may hold one decoding under several shapes (see
  // analyzeHunt), so walk the whole lists; the cap applies to `out`
  const longest = Math.max(0, ...sets.map(s => s.length));
  for (let i = 0; i < longest; i++) {
    let any = false;
    for (const set of sets) {
      const p = set[i];
      if (!p) {
        continue;
      }
      any = true;
      if ((tier.get(p.shape) ?? -1) > p.crc) {
        continue;
      }
      const sig = payloadSignature(p.cls);
      if (seen.has(sig)) {
        continue;
      }
      seen.add(sig);
      out.push(p);
      if (out.length >= MAX_PAYLOADS) {
        return out;
      }
    }
    if (!any) {
      break;
    }
  }
  return out;
}

export interface MapDevice {
  mac: string;
  name: string;
  vendor: string;
  kind: string;
  police: string;
  n: number;
  /** re-classification from the most common payload, first device seen wins */
  cls: Classification | null;
  /** re-classifications from the other payloads it was heard with */
  payloads: DevicePayload[];
  /**
   * shard MACs folded into this device in any picked hunt (bit-error copies
   * of its address). With Settings → mergeGlitches off the scan screen
   * lists each as its own device, so a flag can name one of them.
   */
  aliases: string[];
  hunts: string[];
  /** sightings that had a fix, across all picked hunts */
  points: {t: number; lat: number; lon: number; hunt: string}[];
  /** estimated spot: mean phone position while heard; r = RMS distance from it (min 15 m) */
  est: {lat: number; lon: number; r: number};
}

export function combineHunts(hunts: Hunt[]): MapDevice[] {
  const byMac = new Map<string, MapDevice>();
  const payloadSets = new Map<string, DevicePayload[][]>();
  for (const h of hunts) {
    for (const d of h.devices) {
      let x = byMac.get(d.mac);
      if (!x) {
        x = {mac: d.mac, name: '', vendor: '', kind: '', police: '', n: 0, cls: null, payloads: [], aliases: [], hunts: [], points: [], est: {lat: 0, lon: 0, r: 0}};
        byMac.set(d.mac, x);
      }
      x.name ||= d.name;
      x.vendor ||= d.vendor;
      x.kind ||= d.kind;
      x.police ||= d.police;
      x.cls ??= d.cls;
      if (d.payloads.length) {
        const sets = payloadSets.get(d.mac);
        if (sets) {
          sets.push(d.payloads);
        } else {
          payloadSets.set(d.mac, [d.payloads]);
        }
      }
      x.n += d.n;
      x.hunts.push(h.name);
      const shards = new Set(x.aliases);
      for (const s of d.sightings) {
        if (s.shardOf) {
          shards.add(s.shardOf);
        }
      }
      x.aliases = [...shards];
      for (const s of d.sightings) {
        if (s.lat != null && s.lon != null) x.points.push({t: s.t, lat: s.lat, lon: s.lon, hunt: h.name});
      }
    }
  }
  for (const [mac, sets] of payloadSets) {
    const x = byMac.get(mac);
    if (x) {
      x.payloads = mergePayloads(sets);
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
