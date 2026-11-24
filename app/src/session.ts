// The scan session: glue between the USB byte stream (usb.ts), the line
// parser (protocol.ts), the device table (devices.ts), police alerts
// (alerts.ts), the background service (background.ts), phone location
// (location.ts) and the local hunt log (huntlog.ts).
//
// It is a module-level singleton rather than React state on purpose: the
// session has to keep running — and keep alerting — while the app is in the
// background, including after Android destroys the activity and unmounts the
// React tree (the foreground service keeps the process and JS runtime
// alive). Screens read it through useScanEngine() in engine.ts.
//
// Keeping the JS thread free matters more than anything else here. Serial
// data arrives continuously; if handling it ever takes longer than the data
// takes to arrive, native events queue up without bound and the app
// "freezes". So: records only mutate state, and listeners (= React
// re-renders) are notified at most every EMIT_MS, never per record.

import {checkPoliceAlerts, resetPoliceAlerts} from './alerts';
import {setBackgroundLocation, startBackground, stopBackground, updateBackground} from './background';
import {requestNotificationPermission} from './notifications';
import {DeviceEntry, DeviceTable} from './devices';
import type {Fix} from './geo';
import {
  currentFix,
  lastFix,
  LocationStatus,
  locationStatus,
  onLocation,
  startLocation,
  stopLocation,
} from './location';
import {classify, Classification} from './lookup/adparse';
import {policeMatch, PoliceMatch} from './lookup/police';
import {ParsedRecord, SessionInfo, StatsRecord, StreamParser} from './protocol';
import {settingsStore} from './settings';
import {
  endHuntLog,
  HuntLogStatus,
  huntLogStatus,
  logFix,
  logSession,
  logSighting,
  onHuntLog,
  startHuntLog,
} from './huntlog';
import {
  closeDevice,
  decodeBase64Ascii,
  listDevices,
  onSerialData,
  onSerialState,
  openDevice,
  UsbDevice,
  usbAvailable,
} from './usb';

export interface ViewDevice extends DeviceEntry {
  cls: Classification;
  /** non-null when the police classifier (lookup/police.ts) matched */
  police: PoliceMatch | null;
}

export interface EngineState {
  connected: boolean;
  connectedDeviceId: string | null;
  session: SessionInfo | null;
  stats: StatsRecord | null;
  batchCount: number;
  parseErrors: number;
  /** lines cut or dropped because bytes were lost on the wire */
  corruptLines: number;
  /** batches missing from the seq numbering (lost whole, or flagged ovf) */
  lostBatches: number;
  /** times the stream went silent and the port was reopened */
  reopens: number;
  lastError: string | null;
}

export interface SessionSnapshot extends EngineState {
  available: boolean;
  devices: UsbDevice[];
  view: ViewDevice[];
  /** latest phone fix (may be stale; compare fix.t to now) */
  fix: Fix | null;
  locStatus: LocationStatus;
  log: HuntLogStatus;
}

type Listener = () => void;

const EMIT_MS = 250;
const REBUILD_MS = 300;
// The firmware sends a (possibly empty) batch every window (2 s by
// default), so this much silence means the stream is stuck, not quiet.
const STALL_MS = 10_000;
const WATCHDOG_MS = 2000;

const available = usbAvailable();
let state: EngineState = {
  connected: false,
  connectedDeviceId: null,
  session: null,
  stats: null,
  batchCount: 0,
  parseErrors: 0,
  corruptLines: 0,
  lostBatches: 0,
  reopens: 0,
  lastError: null,
};
let devices: UsbDevice[] = [];
let view: ViewDevice[] = [];
let snapshot: SessionSnapshot = makeSnapshot();

const parser = new StreamParser();
const table = new DeviceTable();
const listeners = new Set<Listener>();
let started = false;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let emitTimer: ReturnType<typeof setTimeout> | null = null;
let watchdog: ReturnType<typeof setInterval> | null = null;
let lastDataAt = 0;
let lastSeq = 0;
let reopening = false;
// whether this connection is being recorded (Settings → Record hunts)
let logging = false;

// classify() + policeMatch() are pure in (mac, ad) and the AD rarely
// changes, so cache them per device instead of redoing every device on
// every rebuild (that was most of the per-rebuild cost on big tables).
type Classified = {ad: string; cls: Classification; police: PoliceMatch | null};
const clsCache = new Map<string, Classified>();
// Same, for individual records going into the hunt log (their AD can
// differ from the device's best one, so they get their own cache).
const recCache = new Map<string, Classified>();

function classifyCached(cache: Map<string, Classified>, mac: string, ad: string): Classified {
  const hit = cache.get(mac);
  if (hit && hit.ad === ad) return hit;
  const cls = classify(mac, ad);
  const entry = {ad, cls, police: policeMatch(mac, cls, ad)};
  cache.set(mac, entry);
  return entry;
}

function makeSnapshot(): SessionSnapshot {
  return {
    ...state,
    available,
    devices,
    view,
    fix: lastFix(),
    locStatus: locationStatus(),
    log: huntLogStatus(),
  };
}

function emitNow(): void {
  if (emitTimer) {
    clearTimeout(emitTimer);
    emitTimer = null;
  }
  snapshot = makeSnapshot();
  listeners.forEach(l => l());
}

/** Coalesced notify: at most one snapshot + re-render per EMIT_MS. */
function emitSoon(): void {
  if (emitTimer) return;
  emitTimer = setTimeout(() => {
    emitTimer = null;
    emitNow();
  }, EMIT_MS);
}

/** User-visible state changes (connect, errors): notify right away. */
function setState(patch: Partial<EngineState>): void {
  state = {...state, ...patch};
  emitNow();
}

function classified(d: DeviceEntry): Classified {
  return classifyCached(clsCache, d.mac, d.ad);
}

function rebuildView(): void {
  const entries = table.snapshot();
  if (clsCache.size > entries.length * 2 + 64) {
    const live = new Set(entries.map(e => e.mac));
    for (const mac of clsCache.keys()) if (!live.has(mac)) clsCache.delete(mac);
    for (const mac of recCache.keys()) if (!live.has(mac)) recCache.delete(mac);
  }
  view = entries.map(d => {
    const {cls, police} = classified(d);
    // snapshot() returns live entry references; copy so the view doesn't
    // mutate under the renderer later
    return {...d, channels: new Set(d.channels), cls, police};
  });
  checkPoliceAlerts(view);
  if (state.connected) updateBackground(view);
  emitSoon();
}

function scheduleRebuild(): void {
  if (rebuildTimer) return;
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    rebuildView();
  }, REBUILD_MS);
}

/** Apply one record. Mutates state only; the caller schedules the emit. */
let pinnedSrc: string[] | null = null;
let pinnedCache: ReadonlySet<string> = new Set();
function pinnedSet(): ReadonlySet<string> {
  const list = settingsStore.get().pinnedMacs;
  if (list !== pinnedSrc) {
    pinnedSrc = list;
    pinnedCache = new Set(list);
  }
  return pinnedCache;
}

function applyRecord(rec: ParsedRecord, now: number, fix: Fix | null): void {
  switch (rec.type) {
    case 'session':
      state = {...state, session: rec};
      lastSeq = 0;
      logSession(rec.id, rec.fw, now);
      break;
    case 'stats':
      state = {...state, stats: rec};
      break;
    case 'batch-start': {
      // seq increases by one per batch (PROTOCOL.md); a jump means whole
      // batches were lost in transit, ovf=1 that the firmware dropped some.
      const gap = lastSeq > 0 && rec.seq > lastSeq + 1 ? rec.seq - lastSeq - 1 : 0;
      if (gap > 0 || rec.ovf) state = {...state, lostBatches: state.lostBatches + gap + (rec.ovf ? 1 : 0)};
      lastSeq = rec.seq;
      break;
    }
    case 'batch-end':
      state = {...state, batchCount: state.batchCount + 1};
      // periodic pruning lives here rather than a timer: it only needs to
      // happen when data is actually flowing
      table.pruneOlderThan(now, settingsStore.get().keepSeconds * 1000, pinnedSet());
      break;
    case 'mac': {
      table.apply(rec, now, settingsStore.get().mergeGlitches, fix);
      if (logging) {
        const c = classifyCached(recCache, rec.mac, rec.ad);
        logSighting(rec, now, fix, c.cls, c.police);
      }
      break;
    }
    case 'unknown':
      state = {...state, parseErrors: state.parseErrors + 1};
      break;
    default:
      break;
  }
}

function onData(data64: string): void {
  lastDataAt = Date.now();
  const before = parser.corrupt;
  const records = parser.feed(decodeBase64Ascii(data64));
  if (parser.corrupt !== before) state = {...state, corruptLines: parser.corrupt};
  if (records.length === 0) return;
  const now = Date.now();
  const fix = currentFix(now);
  let applied = false;
  for (const rec of records) {
    applyRecord(rec, now, fix);
    if (rec.type === 'mac') applied = true;
  }
  if (applied) scheduleRebuild();
  emitSoon();
}

function startWatchdog(): void {
  stopWatchdog();
  lastDataAt = Date.now();
  watchdog = setInterval(() => {
    if (!state.connected || reopening) return;
    if (Date.now() - lastDataAt > STALL_MS) reopen('no data from the scanner');
  }, WATCHDOG_MS);
}

function stopWatchdog(): void {
  if (watchdog) clearInterval(watchdog);
  watchdog = null;
}

/**
 * The stream stalled or the read failed, but the cable is still in:
 * close and reopen the same port instead of dropping the session.
 */
function reopen(why: string): void {
  const id = state.connectedDeviceId;
  if (!id || reopening) return;
  reopening = true;
  parser.reset();
  closeDevice()
    .catch(() => {})
    .then(() => openDevice(id, settingsStore.get().scanBaud))
    .then(() => {
      lastDataAt = Date.now();
      setState({reopens: state.reopens + 1, lastError: `${why} — reconnected`});
    })
    .catch(e => markDisconnected(`${why}; reconnect failed: ${String(e?.message ?? e)}`))
    .finally(() => {
      reopening = false;
    });
}

function markDisconnected(lastError?: string): void {
  stopWatchdog();
  // Always release the native side (port, reader, wake lock), whatever
  // ended the session — a pulled cable leaves the port object behind.
  closeDevice().catch(() => {});
  setState({
    connected: false,
    connectedDeviceId: null,
    lastError: lastError ?? state.lastError,
  });
  stopBackground();
  stopLocation();
  if (logging) endHuntLog();
  logging = false;
}

/** Subscribe to native USB events. Idempotent; called by the first subscriber. */
function start(): void {
  if (started || !available) return;
  started = true;
  refreshUsb();
  onSerialData(ev => onData(ev.data64));
  // Hot-plug: keep the picker honest without a manual refresh, and drop
  // out of "connected" when the cable is pulled.
  onSerialState(ev => {
    if (state.connected && (!ev.deviceId || ev.deviceId === state.connectedDeviceId)) {
      if (ev.state === 'detached') markDisconnected();
      else if (ev.state === 'error' && !reopening) reopen(ev.message ?? 'serial error');
    }
    if (ev.state === 'attached' || ev.state === 'detached') refreshUsb();
  });
  onLocation(() => {
    const f = currentFix();
    if (f && state.connected && logging) logFix(f);
    emitSoon();
  });
  onHuntLog(emitSoon);
}

export function refreshUsb(): void {
  if (!available) return;
  listDevices()
    .then(d => {
      devices = d;
      emitNow();
    })
    .catch(() => {
      devices = [];
      emitNow();
    });
}

export function connect(deviceId: string): void {
  setState({lastError: null, corruptLines: 0, lostBatches: 0, reopens: 0});
  parser.reset();
  lastSeq = 0;
  openDevice(deviceId, settingsStore.get().scanBaud)
    .then(async () => {
      setState({connected: true, connectedDeviceId: deviceId});
      startWatchdog();
      const s = settingsStore.get();
      logging = s.recordHunts;
      if (logging) startHuntLog();
      // Alerts and the background-scan notification both need
      // POST_NOTIFICATIONS on Android 13+; ask at the moment it matters.
      if (s.policeAlerts || s.backgroundScan) await requestNotificationPermission().catch(() => {});
      // Location before the service: Android 14 only lets the service take
      // the "location" type once the permission is held.
      const loc = s.locationEnabled ? await startLocation().catch(() => 'denied' as const) : 'off';
      setBackgroundLocation(loc !== 'off' && loc !== 'denied');
      emitSoon();
      // Only after open() succeeded: Android 14 lets a connectedDevice
      // foreground service start once the app holds USB permission.
      if (s.backgroundScan && state.connected) startBackground(view);
    })
    .catch(e => {
      setState({lastError: String(e?.message ?? e)});
    });
}

export function disconnect(): void {
  markDisconnected();
}

export function clear(): void {
  table.clear();
  clsCache.clear();
  resetPoliceAlerts();
  rebuildView();
}

export function subscribe(listener: Listener): () => void {
  start();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSnapshot(): SessionSnapshot {
  return snapshot;
}

// Settings that apply to a running session.
let prevSettings = settingsStore.get();
settingsStore.subscribe(s => {
  const prev = prevSettings;
  prevSettings = s;
  if (!state.connected) return;
  if (s.backgroundScan !== prev.backgroundScan) {
    if (s.backgroundScan) startBackground(view);
    else stopBackground();
  }
  if (s.recordHunts !== prev.recordHunts) {
    logging = s.recordHunts;
    if (logging) startHuntLog();
    else endHuntLog();
  }
  if (s.locationEnabled !== prev.locationEnabled) {
    if (s.locationEnabled) {
      startLocation()
        .then(st => setBackgroundLocation(st !== 'off' && st !== 'denied'))
        .catch(() => {});
    } else {
      stopLocation();
      setBackgroundLocation(false);
    }
    emitSoon();
  }
});
