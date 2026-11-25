// Flag annotations (FLAGS.md v0): flag/note records attached to observed
// devices. A flag is a *matcher set*, never a bare MAC — addresses rotate
// and air glitches shift bits, so the record floats until one of its
// matchers hits a device we're actually seeing.
//
// Server records are pulled ONLY when the user taps "Pull flags"; the pull
// overwrites the local copy of every server record wholesale. Records the
// user flagged on-device live under `local` and the pull can't touch them.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {useEffect, useState} from 'react';

import {hamming, macToBytes} from './devices';
import type {Classification} from './lookup/adparse';

export type MatcherKind = 'mac' | 'name' | 'company' | 'service' | 'eddy_uid' | 'oui';

export interface FlagMatcher {
  kind: MatcherKind;
  value: string;
}

export interface FlagRecord {
  id: string;
  flag: boolean;
  note: string;
  matchers: FlagMatcher[];
  updatedAt?: string;
}

export interface FlagsSnapshot {
  /** server revision we hold, for display only — never used to skip a pull */
  revision: number;
  pulledAt: number | null;
  /** last pulled server set, verbatim */
  server: FlagRecord[];
  /** created on this device; the pull never overwrites these */
  local: FlagRecord[];
}

const STORAGE_KEY = 'ultrascanner.flags.v1';
const EMPTY: FlagsSnapshot = {revision: 0, pulledAt: null, server: [], local: []};

// Strong matchers identify one device; weak ones (company/service/oui)
// identify a class. A record with strong matchers can still carry weak
// ones as a family-level fallback, but weak-only matchers only fire when
// ALL of them hit — "every Tuya FD50 device", not "any device with FD50
// or a Tuya company ID".
const STRONG: MatcherKind[] = ['eddy_uid', 'name', 'mac'];

export const MATCHER_KINDS: MatcherKind[] = ['mac', 'name', 'company', 'service', 'eddy_uid', 'oui'];

function normHex(value: string): string {
  return value.toUpperCase().replace(/^0X/, '').replace(/[^0-9A-F]/g, '');
}

function normMac(value: string): string | null {
  const m = value.toUpperCase().replace(/[^0-9A-F:]/g, '');
  return /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(m) ? m : null;
}

function matcherHits(m: FlagMatcher, cls: Classification, mac: string): boolean {
  switch (m.kind) {
    case 'mac': {
      const want = normMac(m.value);
      if (!want) {
        return false;
      }
      if (want === mac) {
        return true;
      }
      // the matcher MAC itself may be the corrupted one: accept the
      // same ≤2-bit distance devices.ts uses to fold glitch twins
      const theirs = macToBytes(want);
      return theirs.length === 6 && hamming(theirs, macToBytes(mac)) <= 2;
    }
    case 'name':
      return !!cls.name && cls.name.toUpperCase() === m.value.toUpperCase();
    case 'company': {
      const want = parseInt(normHex(m.value), 16);
      return Number.isFinite(want) && cls.companyIds.includes(want);
    }
    case 'service':
      return cls.serviceUuids.includes(normHex(m.value));
    case 'eddy_uid': {
      // full 20-hex ns‖instance, or 10-hex namespace-only (flags a whole
      // beacon installation the owner only knows the namespace of)
      const want = normHex(m.value);
      return (
        (want.length === 10 || want.length === 20) &&
        cls.eddystoneUids.some(uid => uid.startsWith(want))
      );
    }
    case 'oui': {
      const want = normHex(m.value);
      return want.length === 6 && normHex(mac.slice(0, 8)).startsWith(want);
    }
    default:
      return false;
  }
}

/** which matcher (if any) lands this record on this device; null = no match */
export function matchFlag(
  rec: FlagRecord,
  cls: Classification,
  mac: string,
): FlagMatcher | null {
  for (const m of rec.matchers) {
    if (STRONG.includes(m.kind) && matcherHits(m, cls, mac)) {
      return m;
    }
  }
  const weak = rec.matchers.filter(m => !STRONG.includes(m.kind));
  if (weak.length && weak.every(m => matcherHits(m, cls, mac))) {
    return weak[0];
  }
  return null;
}

/** every record that lands on this device, plus the matcher that hit each */
export interface MatchedFlag {
  record: FlagRecord;
  hit: FlagMatcher;
}

export function matchDevice(
  snapshot: FlagsSnapshot,
  cls: Classification,
  mac: string,
): MatchedFlag[] {
  const out: MatchedFlag[] = [];
  for (const record of [...snapshot.server, ...snapshot.local]) {
    const hit = matchFlag(record, cls, mac);
    if (hit) {
      out.push({record, hit});
    }
  }
  return out;
}

/**
 * Matchers auto-filled when the user flags a device by hand: everything
 * the captures corroborate about it, so the flag survives address
 * rotation and bit-garbled MACs.
 */
export function autoMatchers(cls: Classification, mac: string): FlagMatcher[] {
  const out: FlagMatcher[] = [{kind: 'mac', value: mac}];
  if (cls.name) {
    out.push({kind: 'name', value: cls.name});
  }
  for (const uid of cls.eddystoneUids) {
    out.push({kind: 'eddy_uid', value: uid});
  }
  for (const c of cls.companyIds) {
    out.push({kind: 'company', value: c.toString(16).toUpperCase().padStart(4, '0')});
  }
  for (const s of cls.serviceUuids) {
    out.push({kind: 'service', value: s});
  }
  return out;
}

/** one stable id per flagged device, derived from the MAC we're displaying */
export function localFlagId(mac: string): string {
  return `local-${mac.replace(/:/g, '').toUpperCase()}`;
}

// ---- wire format (FLAGS.md v0) ---------------------------------------------

export interface PullResult {
  count: number;
  revision: number;
}

export function parseRecord(raw: unknown): FlagRecord | null {
  if (typeof raw !== 'object' || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || typeof r.flag !== 'boolean' || typeof r.note !== 'string') {
    return null;
  }
  const rawMatchers = Array.isArray(r.matchers) ? r.matchers : [];
  const matchers: FlagMatcher[] = [];
  for (const m of rawMatchers) {
    if (typeof m !== 'object' || m === null) {
      continue;
    }
    const mm = m as Record<string, unknown>;
    if (
      MATCHER_KINDS.includes(mm.kind as MatcherKind) &&
      typeof mm.value === 'string' &&
      mm.value.length > 0
    ) {
      matchers.push({kind: mm.kind as MatcherKind, value: mm.value});
    }
  }
  if (matchers.length === 0) {
    return null; // a flag that can't match anything is not a flag
  }
  return {
    id: r.id,
    flag: r.flag,
    note: r.note,
    matchers,
    updatedAt: typeof r.updated_at === 'string' ? r.updated_at : undefined,
  };
}

/** merge a pull into stored records: server set replaces wholesale, local kept */
export function mergeServerRecords(prev: FlagsSnapshot, pulled: FlagRecord[]): FlagsSnapshot {
  return {...prev, server: pulled};
}

// ---- store (same load/save/subscribe shape as settings.ts) ------------------

let current: FlagsSnapshot = EMPTY;
let loaded = false;
const listeners = new Set<(s: FlagsSnapshot) => void>();

async function load(): Promise<FlagsSnapshot> {
  if (loaded) {
    return current;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<FlagsSnapshot>;
      current = {
        revision: typeof p.revision === 'number' ? p.revision : 0,
        pulledAt: typeof p.pulledAt === 'number' ? p.pulledAt : null,
        server: Array.isArray(p.server) ? (p.server.filter(Boolean) as FlagRecord[]) : [],
        local: Array.isArray(p.local) ? (p.local.filter(Boolean) as FlagRecord[]) : [],
      };
    }
  } catch {
    // corrupt cache: start clean rather than crash
  }
  loaded = true;
  return current;
}

async function save(next: FlagsSnapshot): Promise<void> {
  current = next;
  listeners.forEach(l => l(current));
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort persistence; in-memory value is still current
  }
}

/** manual "Pull flags": fetch the URL and overwrite server records. */
export async function pullFlags(url: string): Promise<PullResult> {
  await load();
  if (!url) {
    throw new Error('no flags URL configured (Settings → Flags)');
  }
  const res = await fetch(url, {headers: {Accept: 'application/json'}});
  if (!res.ok) {
    throw new Error(`flags server: HTTP ${res.status}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  if (!Array.isArray(body.flags)) {
    throw new Error('flags server: response has no flags array');
  }
  const pulled = body.flags.map(parseRecord).filter(Boolean) as FlagRecord[];
  const revision = typeof body.revision === 'number' ? body.revision : current.revision + 1;
  await save({...mergeServerRecords(current, pulled), revision, pulledAt: Date.now()});
  return {count: pulled.length, revision};
}

export async function toggleLocalFlag(mac: string, cls: Classification): Promise<void> {
  await load();
  const id = localFlagId(mac);
  const existing = current.local.find(r => r.id === id);
  let local: FlagRecord[];
  if (existing) {
    local = current.local.map(r => (r.id === id ? {...r, flag: !r.flag} : r));
  } else {
    local = [
      ...current.local,
      {id, flag: true, note: '', matchers: autoMatchers(cls, mac), updatedAt: new Date().toISOString()},
    ];
  }
  await save({...current, local});
}

export async function setLocalNote(mac: string, note: string, cls: Classification): Promise<void> {
  await load();
  const id = localFlagId(mac);
  const existing = current.local.find(r => r.id === id);
  const local = existing
    ? current.local.map(r => (r.id === id ? {...r, note, updatedAt: new Date().toISOString()} : r))
    : [...current.local, {id, flag: true, note, matchers: autoMatchers(cls, mac)}];
  await save({...current, local});
}

// ---- management (Settings → Flags): the full local list lives here, so
// tags are per-device and global — they survive restarts and hunts, and
// match whenever the device shows up again. ----------------------------------

export async function setLocalFlagById(id: string, flag: boolean): Promise<void> {
  await load();
  await save({
    ...current,
    local: current.local.map(r =>
      r.id === id ? {...r, flag, updatedAt: new Date().toISOString()} : r,
    ),
  });
}

export async function setLocalNoteById(id: string, note: string): Promise<void> {
  await load();
  await save({
    ...current,
    local: current.local.map(r =>
      r.id === id ? {...r, note, updatedAt: new Date().toISOString()} : r,
    ),
  });
}

export async function deleteLocalFlag(id: string): Promise<void> {
  await load();
  await save({...current, local: current.local.filter(r => r.id !== id)});
}

export async function clearLocalFlags(): Promise<void> {
  await load();
  await save({...current, local: []});
}

/** drop the held copy of the server set (the next pull refetches it) */
export async function clearServerFlags(): Promise<void> {
  await load();
  await save({...current, server: [], revision: 0, pulledAt: null});
}

/** human-readable one-liner for a record's matchers, for the manage list */
export function describeMatchers(rec: FlagRecord): string {
  return rec.matchers.map(m => `${m.kind} ${m.value}`).join(' · ');
}

// ---- upload (FLAGS.md v0): hunt files → server uploads/ directory ----------

/** derive <base>/upload from the configured <base>/flags URL */
export function uploadUrl(flagsUrl: string): string {
  return flagsUrl.replace(/\/flags\/?$/, '/upload');
}

/**
 * Upload one hunt file for later inspection; the server just stores it in
 * a directory. Only meaningful when both a server URL and the upload
 * password are configured — callers should gate the action on that.
 */
export async function uploadHuntFile(
  flagsUrl: string,
  password: string,
  filename: string,
  body: string | ArrayBuffer,
): Promise<void> {
  if (!flagsUrl) {
    throw new Error('no flags server configured (Settings → Flags)');
  }
  if (!password) {
    throw new Error('no upload password configured (Settings → Flags)');
  }
  const res = await fetch(uploadUrl(flagsUrl), {
    method: 'POST',
    headers: {
      'X-Upload-Key': password,
      'X-File-Name': encodeURIComponent(filename),
      'Content-Type': 'application/octet-stream',
    },
    body: body as BodyInit_,
  });
  if (!res.ok) {
    throw new Error(`upload server: HTTP ${res.status}`);
  }
}

export const flagsStore = {
  get: (): FlagsSnapshot => current,
  load,
  subscribe(listener: (s: FlagsSnapshot) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** Subscribe a screen to the flag snapshot (loads once on mount). */
export function useFlagsSnapshot(): FlagsSnapshot {
  const [snap, setSnap] = useState<FlagsSnapshot>(current);
  useEffect(() => {
    let on = true;
    load().then(s => on && setSnap(s));
    const off = flagsStore.subscribe(setSnap);
    return () => {
      on = false;
      off();
    };
  }, []);
  return snap;
}
