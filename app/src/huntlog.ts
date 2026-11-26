// Local hunt logs: every scanner connection is recorded to its own CSV file
// on the phone (HuntLogModule.kt keeps them in app storage). Nothing is
// uploaded anywhere; the Logs screen lists the files with their size and
// shares or saves them on request.
//
// One file per hunt, named by its start time in local time:
//   hunt_2026-11-23_22-15-04.csv
// with one row per event, all with the same columns (see COLUMNS):
//   session   a scanner connected / reported its board ID
//   fix       a phone GPS fix
//   sighting  one MAC record from the scanner, tagged with the latest fix
//   end       the hunt ended (disconnect)
// Every sighting is logged, not only police matches, so packet rate and
// "not heard here" can be worked out afterwards.
import {NativeModules} from 'react-native';

import type {Fix} from './geo';
import type {PoliceMatch} from './lookup/police';
import type {MacRecord} from './protocol';

interface HuntLogNative {
  open(name: string, header: string): Promise<number>;
  append(text: string): Promise<number>;
  close(): Promise<null>;
  list(): Promise<LogFile[]>;
  read(name: string): Promise<string>;
  remove(name: string): Promise<boolean>;
  share(name: string): Promise<null>;
  saveToDownloads(name: string): Promise<string>;
}

export interface LogFile {
  name: string;
  /** bytes */
  size: number;
  /** last write, ms */
  modified: number;
  /** the hunt being recorded right now */
  open: boolean;
}

export interface HuntLogStatus {
  /** file being written, or null when not recording */
  name: string | null;
  bytes: number;
  rows: number;
  lastError: string | null;
}

const Native = NativeModules.HuntLog as HuntLogNative | undefined;

export const COLUMNS = [
  'time',
  'unix_ms',
  'kind',
  'mac',
  'pwr',
  'ch',
  'crc',
  'board_ms',
  'police',
  'confidence',
  'reasons',
  'vendor',
  'name',
  'lat',
  'lon',
  'acc_m',
  'fix_age_ms',
  'speed_mps',
  'heading_deg',
  'note',
  'ad',
] as const;
type Column = (typeof COLUMNS)[number];
type Row = Partial<Record<Column, string | number | null | undefined>>;

const FLUSH_MS = 2000;
const FLUSH_BYTES = 256 * 1024;

let status: HuntLogStatus = {name: null, bytes: 0, rows: 0, lastError: null};
let buf: string[] = [];
let bufBytes = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
// Native calls are chained so open → appends → close stay in order.
let chain: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();

function setStatus(patch: Partial<HuntLogStatus>): void {
  status = {...status, ...patch};
  listeners.forEach(l => l());
}

export function huntLogAvailable(): boolean {
  return Native != null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** "2026-11-23T22:15:04.123-05:00": local wall time with its UTC offset. */
export function localIso(ms: number): string {
  const d = new Date(ms);
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`
  );
}

/** "hunt_2026-11-23_22-15-04.csv" */
export function logName(ms: number): string {
  const d = new Date(ms);
  return (
    `hunt_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}.csv`
  );
}

export function csvField(v: string | number | null | undefined): string {
  if (v == null) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(v) : '') : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function csvRow(row: Row): string {
  return COLUMNS.map(c => csvField(row[c])).join(',') + '\r\n';
}

const HEADER = COLUMNS.join(',') + '\r\n';

function fixFields(fix: Fix | null, now: number): Row {
  if (!fix) return {};
  return {
    lat: fix.lat.toFixed(7),
    lon: fix.lon.toFixed(7),
    acc_m: fix.acc != null ? Math.round(fix.acc * 10) / 10 : null,
    fix_age_ms: Math.max(0, now - fix.t),
    speed_mps: fix.speed != null ? Math.round(fix.speed * 100) / 100 : null,
    heading_deg: fix.heading != null ? Math.round(fix.heading) : null,
  };
}

function push(row: Row): void {
  if (!status.name) return;
  const line = csvRow(row);
  buf.push(line);
  bufBytes += line.length;
  status = {...status, rows: status.rows + 1};
  if (bufBytes >= FLUSH_BYTES) flush();
  else if (!timer) timer = setTimeout(flush, FLUSH_MS);
}

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

function flush(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!buf.length || !Native) return;
  const text = buf.join('');
  buf = [];
  bufBytes = 0;
  enqueue(() => Native.append(text))
    .then(bytes => setStatus({bytes, lastError: null}))
    .catch(e => setStatus({lastError: String(e?.message ?? e)}));
}

/** Start recording a new hunt file. Resolves to its name. */
export function startHuntLog(now = Date.now()): Promise<string | null> {
  if (!Native) return Promise.resolve(null);
  if (status.name) endHuntLog(now);
  const name = logName(now);
  setStatus({name, bytes: 0, rows: 0, lastError: null});
  push({time: localIso(now), unix_ms: now, kind: 'session', note: 'hunt started'});
  return enqueue(() => Native.open(name, HEADER))
    .then(bytes => {
      setStatus({bytes});
      return name;
    })
    .catch(e => {
      setStatus({name: null, lastError: String(e?.message ?? e)});
      buf = [];
      bufBytes = 0;
      return null;
    });
}

export function logSession(board: string, fw: string, now = Date.now()): void {
  push({time: localIso(now), unix_ms: now, kind: 'session', note: `board ${board} fw ${fw}`});
}

export function logFix(fix: Fix, now = Date.now()): void {
  push({time: localIso(now), unix_ms: now, kind: 'fix', ...fixFields(fix, now)});
}

export function logSighting(
  rec: MacRecord,
  now: number,
  fix: Fix | null,
  cls: {vendor?: string | null; name?: string | null},
  police: PoliceMatch | null,
): void {
  push({
    time: localIso(now),
    unix_ms: now,
    kind: 'sighting',
    mac: rec.mac,
    pwr: rec.pwr,
    ch: rec.ch,
    crc: rec.crc,
    board_ms: rec.t,
    police: police?.label,
    confidence: police?.confidence,
    reasons: police?.reasons.join('; '),
    vendor: cls.vendor ?? null,
    name: cls.name ?? null,
    ...fixFields(fix, now),
    ad: rec.ad,
  });
}

/** Write an `end` row, flush, and close the file. */
export function endHuntLog(now = Date.now()): void {
  if (!status.name || !Native) return;
  push({time: localIso(now), unix_ms: now, kind: 'end', note: 'hunt ended'});
  flush();
  setStatus({name: null});
  enqueue(() => Native.close()).catch(() => {});
}

/**
 * A REPORT POLICE sighting (ScanScreen police tab): the hunter saw police
 * but the radio matched nothing. The row is a time/position anchor — the
 * analysis layer looks for devices heard near it as candidate signatures.
 * Dropped silently when no hunt is recording (same as every other row).
 */
export function logPoliceReport(fix: Fix | null, note: string, now = Date.now()): void {
  push({
    time: localIso(now),
    unix_ms: now,
    kind: 'report',
    police: 'user',
    confidence: 'sighted',
    reasons: 'reported by eye',
    note,
    ...fixFields(fix, now),
  });
}

export function huntLogStatus(): HuntLogStatus {
  return status;
}

export function onHuntLog(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// --- file management (Logs screen) --------------------------------------

function native(): HuntLogNative {
  if (!Native) throw new Error('Hunt logs need the Android app (native module missing).');
  return Native;
}

export function listLogs(): Promise<LogFile[]> {
  return Native ? enqueue(() => Native.list()) : Promise.resolve([]);
}

/** A log's full text (the open one is flushed first). */
export function readLog(name: string): Promise<string> {
  if (name === status.name) flush();
  return enqueue(() => native().read(name));
}

export function deleteLog(name: string): Promise<boolean> {
  return enqueue(() => native().remove(name));
}

export function shareLog(name: string): Promise<null> {
  if (name === status.name) flush();
  return enqueue(() => native().share(name));
}

/** Resolves to where it was saved, e.g. "Download/ultrasweeper/hunt_….csv". */
export function saveLogToDownloads(name: string): Promise<string> {
  if (name === status.name) flush();
  return enqueue(() => native().saveToDownloads(name));
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
