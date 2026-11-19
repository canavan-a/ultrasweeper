// The live device table: everything the app knows about what the scanner
// is hearing this session. The firmware's dedup only suppresses repeats
// within SCANNER_DEDUP_MS with an unchanged PWR — PROTOCOL.md explicitly
// puts persistence, decay, and merge decisions here, on the client.
//
// The one piece of real signal processing is glitch folding. CRC:S records
// were accepted on AD-structure alone (their CRC never reached the nRF
// FIFO), so a single-bit air glitch can survive and produce a "second
// device" one bit away from a real one — we saw exactly this on the bench
// (`86:69:93:F8:12:6F` vs `86:69:B3:F8:12:6F` carrying the same payload).
// foldableInto() recognizes those and attributes the sighting to the
// original device instead of showing a twin.

import type {MacRecord} from './protocol';

export interface DeviceEntry {
  /** AdvA as printed, e.g. "86:69:93:F8:12:6F" */
  mac: string;
  macBytes: number[];
  /** most recent AD hex seen for this device (display + classification) */
  ad: string;
  /** best verification level ever seen for this exact MAC */
  crc: '1' | 'P' | 'S';
  /** highest raw power register seen */
  pwr: number;
  /** BLE adv channels it has appeared on (persistence is the strength signal) */
  channels: Set<number>;
  /** host wall-clock ms */
  firstSeen: number;
  lastSeen: number;
  /** sightings for this exact MAC, including ones folded into a twin */
  sightings: number;
  /** count of sightings that were glitch-folded in from other MACs */
  glitchSightings: number;
}

const CRC_RANK: Record<MacRecord['crc'], number> = {'1': 3, P: 2, S: 1};

export function macToBytes(mac: string): number[] {
  return mac.split(':').map(p => parseInt(p, 16));
}

function bitCount(x: number): number {
  let n = 0;
  while (x) {
    n += x & 1;
    x >>>= 1;
  }
  return n;
}

/** differing bits between two equal-length byte arrays */
export function hamming(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    return Infinity;
  }
  let n = 0;
  for (let i = 0; i < a.length; i++) {
    n += bitCount(a[i] ^ b[i]);
  }
  return n;
}

export function hexToBytes(hex: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 2 <= hex.length; i += 2) {
    const b = parseInt(hex.slice(i, i + 2), 16);
    if (Number.isFinite(b)) {
      out.push(b);
    }
  }
  return out;
}

/**
 * A new sighting of `mac` folds into `existing` when both MACs and both AD
 * payloads are within a couple of bits of each other — the signature of
 * one frame with a bit-flip in flight, not two devices. (Identical frames
 * never reach here; they merge by exact MAC.)
 */
export function foldableInto(
  existing: DeviceEntry,
  macBytes: number[],
  adHex: string,
): boolean {
  if (hamming(existing.macBytes, macBytes) > 2) {
    return false;
  }
  const theirs = hexToBytes(adHex);
  const ours = hexToBytes(existing.ad);
  // Compare only the common prefix; both may be FIFO-truncated at
  // different points. Too-short payloads prove nothing — require some.
  const n = Math.min(theirs.length, ours.length);
  if (n < 12) {
    return false;
  }
  return hamming(ours.slice(0, n), theirs.slice(0, n)) <= 2;
}

export class DeviceTable {
  private entries = new Map<string, DeviceEntry>();

  get size(): number {
    return this.entries.size;
  }

  /**
   * Apply one sighting. `mergeGlitches` gates only the cross-MAC folding;
   * exact-MAC merging always happens (that's just the same device again).
   */
  apply(rec: MacRecord, now: number, mergeGlitches: boolean): void {
    let entry = this.entries.get(rec.mac);
    if (!entry && mergeGlitches) {
      const mb = macToBytes(rec.mac);
      for (const candidate of this.entries.values()) {
        if (foldableInto(candidate, mb, rec.ad)) {
          candidate.lastSeen = now;
          candidate.sightings += 1;
          candidate.glitchSightings += 1;
          candidate.channels.add(rec.ch);
          return;
        }
      }
    }
    if (!entry) {
      entry = {
        mac: rec.mac,
        macBytes: macToBytes(rec.mac),
        ad: rec.ad,
        crc: rec.crc,
        pwr: rec.pwr,
        channels: new Set([rec.ch]),
        firstSeen: now,
        lastSeen: now,
        sightings: 1,
        glitchSightings: 0,
      };
      this.entries.set(rec.mac, entry);
      return;
    }
    entry.lastSeen = now;
    entry.sightings += 1;
    entry.channels.add(rec.ch);
    entry.pwr = Math.max(entry.pwr, rec.pwr);
    if (CRC_RANK[rec.crc] > CRC_RANK[entry.crc]) {
      entry.crc = rec.crc;
    }
    // Keep the most completely-verified payload for classification.
    if (rec.ad.length > entry.ad.length || (rec.ad.length === entry.ad.length && rec.crc !== 'S')) {
      entry.ad = rec.ad;
    }
  }

  /** current entries sorted for display: most recently seen first */
  snapshot(): DeviceEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  pruneOlderThan(now: number, maxAgeMs: number): void {
    for (const [mac, e] of this.entries) {
      if (now - e.lastSeen > maxAgeMs) {
        this.entries.delete(mac);
      }
    }
  }

  clear(): void {
    this.entries.clear();
  }
}
