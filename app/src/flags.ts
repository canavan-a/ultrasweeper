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
import {capNote} from './note';
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
// identify a class. Weak matchers only land a record that has NO strong
// matchers, and then only when ALL of them hit — "every Tuya FD50
// device", not "any device with FD50 or a Tuya company ID". In a record
// with any strong matcher the weak ones are descriptive only: otherwise
// hand-flagging one iPhone (mac + company 004C) would flag every Apple
// device in range.
const STRONG: MatcherKind[] = ['eddy_uid', 'name', 'mac'];

export const MATCHER_KINDS: MatcherKind[] = ['mac', 'name', 'company', 'service', 'eddy_uid', 'oui'];

function normHex(value: string): string {
  return value.toUpperCase().replace(/^0X/, '').replace(/[^0-9A-F]/g, '');
}

function normMac(value: string): string | null {
  const m = value.toUpperCase().replace(/[^0-9A-F:]/g, '');
  return /^[0-9A-F]{2}(:[0-9A-F]{2}){5}$/.test(m) ? m : null;
}

export interface MatchOptions {
  /**
   * Let a `mac` matcher accept the ≤2-bit glitch twins devices.ts folds.
   * Follows Settings → mergeGlitches: when the list deliberately shows
   * near-identical MACs as distinct devices, a flag must not hop between
   * them. Default true.
   */
  glitchTolerant?: boolean;
}

function matcherHits(m: FlagMatcher, cls: Classification, mac: string, opts: MatchOptions): boolean {
  switch (m.kind) {
    case 'mac': {
      const want = normMac(m.value);
      if (!want) {
        return false;
      }
      if (want === mac) {
        return true;
      }
      if (opts.glitchTolerant === false) {
        return false;
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
    case 'service': {
      // 16-bit (4 hex) against the 16-bit list; full 128-bit (32 hex,
      // dashes optional) against the 128-bit list
      const want = normHex(m.value);
      if (want.length === 4) {
        return cls.serviceUuids.some(u => normHex(u) === want);
      }
      return want.length === 32 && cls.serviceUuids128.some(u => normHex(u) === want);
    }
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
  opts: MatchOptions = {},
): FlagMatcher | null {
  const strong = rec.matchers.filter(m => STRONG.includes(m.kind));
  if (strong.length) {
    // weak matchers next to strong ones never land the record (FLAGS.md)
    return strong.find(m => matcherHits(m, cls, mac, opts)) ?? null;
  }
  const weak = rec.matchers;
  if (weak.length && weak.every(m => matcherHits(m, cls, mac, opts))) {
    return weak[0];
  }
  return null;
}

/** every record that lands on this device, plus the matcher that hit each */
export interface MatchedFlag {
  record: FlagRecord;
  hit: FlagMatcher;
  /**
   * which held set the record came from. Ownership is by set, never by id
   * prefix: a server record could carry any id.
   */
  source: 'server' | 'local';
}

export function matchDevice(
  snapshot: FlagsSnapshot,
  cls: Classification,
  mac: string,
  opts: MatchOptions = {},
): MatchedFlag[] {
  const out: MatchedFlag[] = [];
  const sets: [FlagRecord[], MatchedFlag['source']][] = [
    [snapshot.server, 'server'],
    [snapshot.local, 'local'],
  ];
  for (const [records, source] of sets) {
    for (const record of records) {
      const hit = matchFlag(record, cls, mac, opts);
      if (hit) {
        out.push({record, hit, source});
      }
    }
  }
  return out;
}

/**
 * Match against each advertisement a device was heard with, separately: a
 * hunt log records the same device sending different frames (an Eddystone
 * UID in one, a service UUID in the next), and the scan screen matches
 * whichever single frame it happened to keep. Merging the frames would let
 * one flag read fields that were never in the same advertisement - a weak
 * matcher set would hit on a name from one frame plus a service from
 * another. So each payload is matched apart, and the results combined.
 * Null payloads (no AD capture) are skipped.
 */
export function matchDevicePayloads(
  snapshot: FlagsSnapshot,
  payloads: (Classification | null)[],
  mac: string,
  opts: MatchOptions = {},
): MatchedFlag[] {
  const out: MatchedFlag[] = [];
  const seen = new Set<string>();
  for (const cls of payloads) {
    if (!cls) continue;
    for (const m of matchDevice(snapshot, cls, mac, opts)) {
      const key = `${m.source}:${m.record.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

// a classification with no payload fields: only name/oui/mac matchers can
// land on it
const NO_PAYLOAD: Classification = {
  labels: [],
  serviceUuids: [],
  serviceUuids128: [],
  companyIds: [],
  manufacturerData: [],
  eddystoneUids: [],
  randomAddress: false,
};

/** a device read back from hunt logs (the Map screen) */
export interface LoggedDevice {
  mac: string;
  /** the logger's own name column (decoded at capture time) */
  name: string;
  /** re-decoded advertisements it was heard with, matched one at a time */
  payloads: Classification[];
  /** shard MACs folded into it: bit-error copies of its address */
  aliases: string[];
}

/**
 * Every record that lands on a logged device: each advertisement matched
 * apart (matchDevicePayloads), plus a stub carrying only the logged name -
 * a MAC or OUI matcher reads the address and needs some classification to
 * be handed a record at all, which matters for a device logged without
 * any AD capture, and the name column is what the logger decoded at the
 * time. The stub has no payload fields, so it can only add a name hit.
 *
 * Shard MACs count for `mac` matchers, exactly: the map always folds
 * shards, but with Settings → mergeGlitches off the scan screen lists a
 * shard as its own device, and a flag made on that row names only the
 * shard's address. Nothing else is read from a shard address (an OUI from
 * a bit-flipped address proves nothing), and the match is exact, since a
 * shard is already within the glitch distance of the device it folded
 * into.
 */
export function matchLoggedDevice(
  snapshot: FlagsSnapshot,
  device: LoggedDevice,
  opts: MatchOptions = {},
): MatchedFlag[] {
  const out = matchDevicePayloads(
    snapshot,
    [...device.payloads, {...NO_PAYLOAD, name: device.name || undefined}],
    device.mac,
    opts,
  );
  const seen = new Set(out.map(m => `${m.source}:${m.record.id}`));
  for (const alias of device.aliases) {
    for (const m of matchDevice(snapshot, NO_PAYLOAD, alias, {glitchTolerant: false})) {
      const key = `${m.source}:${m.record.id}`;
      if (m.hit.kind !== 'mac' || seen.has(key)) {
        continue;
      }
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

/**
 * The on-phone record a scan row edits: the one created for this exact
 * MAC if it matched, else any other local record that lands on the device
 * (it rotated its address and still matches by name or Eddystone UID).
 * Undefined = none; flagging the row then creates one.
 */
export function pickLocalRecord(matched: MatchedFlag[], mac: string): FlagRecord | undefined {
  const local = matched.filter(m => m.source === 'local');
  const id = localFlagId(mac);
  return (local.find(m => m.record.id === id) ?? local[0])?.record;
}

/**
 * Full note text for every flagged record that matched, on-phone records
 * first: the description shown when the device is picked open. Unflagged
 * (disabled) records never describe the device.
 */
export function matchedNotes(matched: MatchedFlag[]): string[] {
  const ordered = matched
    .filter(m => m.record.flag)
    .sort((a, b) => (a.source === b.source ? 0 : a.source === 'local' ? -1 : 1));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of ordered) {
    const note = m.record.note.trim();
    if (note && !seen.has(note)) {
      seen.add(note);
      out.push(note);
    }
  }
  return out;
}

export type ScanFilter = 'all' | 'police' | 'flagged';

/**
 * The scan filter that actually applies: the Flagged tab is only offered
 * while flag records are held, so a saved 'flagged' falls back to 'all'
 * when there are none (otherwise the list is stuck on a hidden tab).
 */
export function effectiveScanFilter(filter: ScanFilter, snapshot: FlagsSnapshot): ScanFilter {
  return filter === 'flagged' && snapshot.server.length + snapshot.local.length === 0 ? 'all' : filter;
}

/**
 * Matchers auto-filled when the user flags a device by hand: everything
 * the captures corroborate about it, so the flag survives address
 * rotation and bit-garbled MACs. Company/service matchers ride along to
 * describe the device only — next to the strong ones they never land the
 * record (see matchFlag).
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
  for (const s of cls.serviceUuids128) {
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
  // the wire says updated_at; the on-phone cache stores updatedAt
  const updatedAt =
    typeof r.updated_at === 'string' ? r.updated_at : typeof r.updatedAt === 'string' ? r.updatedAt : undefined;
  return {id: r.id, flag: r.flag, note: capNote(r.note), matchers, updatedAt};
}

/** merge a pull into stored records: server set replaces wholesale, local kept */
export function mergeServerRecords(prev: FlagsSnapshot, pulled: FlagRecord[]): FlagsSnapshot {
  return {...prev, server: pulled};
}

// ---- store (same load/save/subscribe shape as settings.ts) ------------------

let current: FlagsSnapshot = EMPTY;
// One shared load: concurrent callers (the mount-time useFlagsSnapshot and
// a row toggle right after launch) await the same read, so a slow getItem
// can never land after a save and overwrite it with the stale snapshot.
let loading: Promise<void> | null = null;
const listeners = new Set<(s: FlagsSnapshot) => void>();

/** stored records go through the same validation as pulled ones */
function parseStored(list: unknown): FlagRecord[] {
  return Array.isArray(list) ? (list.map(parseRecord).filter(Boolean) as FlagRecord[]) : [];
}

async function readStored(): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Record<string, unknown>;
      current = {
        revision: typeof p.revision === 'number' ? p.revision : 0,
        pulledAt: typeof p.pulledAt === 'number' ? p.pulledAt : null,
        server: parseStored(p.server),
        local: parseStored(p.local),
      };
    }
  } catch {
    // corrupt cache: start clean rather than crash
  }
}

async function load(): Promise<FlagsSnapshot> {
  if (!loading) {
    loading = readStored();
  }
  await loading;
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

export const PULL_TIMEOUT_MS = 15_000;
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * fetch with a hard deadline: React Native's fetch can hang for minutes on
 * an unreachable LAN address, which would leave "Pulling…" / Upload stuck.
 */
async function fetchWithTimeout(
  what: string,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new Error(`${what}: no response after ${Math.max(1, Math.round(timeoutMs / 1000))} s`));
    }, timeoutMs);
  });
  try {
    // race too, not just abort: an RN fetch that ignores the signal still
    // releases the UI on time
    return await Promise.race([fetch(url, {...init, signal: ctl.signal}), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** manual "Pull flags": fetch the URL and overwrite server records. */
export async function pullFlags(url: string, timeoutMs = PULL_TIMEOUT_MS): Promise<PullResult> {
  await load();
  if (!url) {
    throw new Error('no flags URL configured (Settings → Flags)');
  }
  const res = await fetchWithTimeout('flags server', url, {headers: {Accept: 'application/json'}}, timeoutMs);
  if (!res.ok) {
    throw new Error(`flags server: HTTP ${res.status}`);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    throw new Error('flags server: response is not JSON');
  }
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Record<string, unknown>;
  if (!Array.isArray(body.flags)) {
    throw new Error('flags server: response has no flags array');
  }
  const pulled = body.flags.map(parseRecord).filter(Boolean) as FlagRecord[];
  const revision = typeof body.revision === 'number' ? body.revision : current.revision + 1;
  await save({...mergeServerRecords(current, pulled), revision, pulledAt: Date.now()});
  return {count: pulled.length, revision};
}

/** the local record a row for this device edits (see pickLocalRecord) */
function findLocalRecord(cls: Classification, mac: string, opts: MatchOptions): FlagRecord | undefined {
  return pickLocalRecord(matchDevice({...current, server: []}, cls, mac, opts), mac);
}

/**
 * Row flag button: flip the local record that lands on this device — even
 * one made under an earlier address — or create one for this MAC.
 */
export async function toggleLocalFlag(mac: string, cls: Classification, opts: MatchOptions = {}): Promise<void> {
  await load();
  const existing = findLocalRecord(cls, mac, opts);
  const now = new Date().toISOString();
  const local: FlagRecord[] = existing
    ? current.local.map(r => (r.id === existing.id ? {...r, flag: !r.flag, updatedAt: now} : r))
    : [...current.local, {id: localFlagId(mac), flag: true, note: '', matchers: autoMatchers(cls, mac), updatedAt: now}];
  await save({...current, local});
}

export async function setLocalNote(
  mac: string,
  note: string,
  cls: Classification,
  opts: MatchOptions = {},
): Promise<void> {
  await load();
  const existing = findLocalRecord(cls, mac, opts);
  if (existing) {
    await setLocalNoteById(existing.id, note);
    return;
  }
  const rec: FlagRecord = {
    id: localFlagId(mac),
    flag: true,
    note: capNote(note),
    matchers: autoMatchers(cls, mac),
    updatedAt: new Date().toISOString(),
  };
  await save({...current, local: [...current.local, rec]});
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
  const existing = current.local.find(r => r.id === id);
  const capped = capNote(note);
  if (!existing || existing.note === capped) {
    return; // unchanged (e.g. submit + end-editing both fired): no write
  }
  await save({
    ...current,
    local: current.local.map(r =>
      r.id === id ? {...r, note: capped, updatedAt: new Date().toISOString()} : r,
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

/**
 * Derive <base>/upload from the configured <base>/flags URL. <base> may
 * carry a path prefix (flagsrv -base-path); a query string is kept. A URL
 * whose path doesn't end in /flags is rejected rather than guessed at —
 * posting the file to the flags URL itself only yields a confusing error.
 */
export function uploadUrl(flagsUrl: string): string {
  const m = /^(https?:\/\/[^/?#]+(?:\/[^?#]*)?)\/flags\/?(\?[^#]*)?(?:#.*)?$/i.exec(flagsUrl.trim());
  if (!m) {
    throw new Error('flags URL must look like http(s)://host[/prefix]/flags to derive the upload URL');
  }
  return `${m[1]}/upload${m[2] ?? ''}`;
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
  timeoutMs = UPLOAD_TIMEOUT_MS,
): Promise<void> {
  if (!flagsUrl) {
    throw new Error('no flags server configured (Settings → Flags)');
  }
  if (!password) {
    throw new Error('no upload password configured (Settings → Flags)');
  }
  const res = await fetchWithTimeout(
    'upload server',
    uploadUrl(flagsUrl),
    {
      method: 'POST',
      headers: {
        'X-Upload-Key': password,
        // percent-encoded UTF-8 (FLAGS.md); the server decodes it
        'X-File-Name': encodeURIComponent(filename),
        'Content-Type': 'application/octet-stream',
      },
      body: body as BodyInit_,
    },
    timeoutMs,
  );
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
