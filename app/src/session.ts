// The scan session: glue between the USB byte stream (usb.ts), the line
// parser (protocol.ts), the device table (devices.ts), police alerts
// (alerts.ts) and the background service (background.ts).
//
// It is a module-level singleton rather than React state on purpose: the
// session has to keep running — and keep alerting — while the app is in the
// background, including after Android destroys the activity and unmounts the
// React tree (the foreground service keeps the process and JS runtime
// alive). Screens read it through useScanEngine() in engine.ts.

import {checkPoliceAlerts, resetPoliceAlerts} from './alerts';
import {startBackground, stopBackground, updateBackground} from './background';
import {requestNotificationPermission} from './notifications';
import {DeviceEntry, DeviceTable} from './devices';
import {classify, Classification} from './lookup/adparse';
import {policeMatch, PoliceMatch} from './lookup/police';
import {MacRecord, ParsedRecord, SessionInfo, StatsRecord, StreamParser} from './protocol';
import {settingsStore} from './settings';
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
  lastError: string | null;
}

export interface SessionSnapshot extends EngineState {
  available: boolean;
  devices: UsbDevice[];
  view: ViewDevice[];
}

type Listener = () => void;

const available = usbAvailable();
let state: EngineState = {
  connected: false,
  connectedDeviceId: null,
  session: null,
  stats: null,
  batchCount: 0,
  parseErrors: 0,
  lastError: null,
};
let devices: UsbDevice[] = [];
let view: ViewDevice[] = [];
let snapshot: SessionSnapshot = {...state, available, devices, view};

const parser = new StreamParser();
const table = new DeviceTable();
const listeners = new Set<Listener>();
let started = false;
// Records arrive in bursts (the scanner batches ~2k lines) — coalesce table
// updates so the view, alerts and listeners run at most a few times a
// second, not per batch.
let notifyTimer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  snapshot = {...state, available, devices, view};
  listeners.forEach(l => l());
}

function setState(patch: Partial<EngineState>): void {
  state = {...state, ...patch};
  emit();
}

function rebuildView(): void {
  view = table.snapshot().map(d => {
    const cls = classify(d.mac, d.ad);
    return {
      ...d,
      // snapshot() returns live entry references; copy so the view doesn't
      // mutate under the renderer later
      channels: new Set(d.channels),
      cls,
      police: policeMatch(d.mac, cls, d.ad),
    };
  });
  checkPoliceAlerts(view);
  if (state.connected) updateBackground(view);
  emit();
}

function scheduleRebuild(): void {
  if (notifyTimer) return;
  notifyTimer = setTimeout(() => {
    notifyTimer = null;
    rebuildView();
  }, 300);
}

function applyRecord(rec: ParsedRecord, now: number): void {
  switch (rec.type) {
    case 'session':
      setState({session: rec});
      break;
    case 'stats':
      setState({stats: rec});
      break;
    case 'batch-end':
      setState({batchCount: state.batchCount + 1});
      // periodic pruning lives here rather than a timer: it only needs to
      // happen when data is actually flowing
      table.pruneOlderThan(now, settingsStore.get().keepSeconds * 1000);
      break;
    case 'mac':
      table.apply(rec as MacRecord, now, settingsStore.get().mergeGlitches);
      break;
    case 'unknown':
      setState({parseErrors: state.parseErrors + 1});
      break;
    default:
      break;
  }
}

function markDisconnected(lastError?: string): void {
  setState({
    connected: false,
    connectedDeviceId: null,
    lastError: lastError ?? state.lastError,
  });
  stopBackground();
}

/** Subscribe to native USB events. Idempotent; called by the first subscriber. */
function start(): void {
  if (started || !available) return;
  started = true;
  refreshUsb();
  onSerialData(ev => {
    const records = parser.feed(decodeBase64Ascii(ev.data64));
    if (records.length === 0) return;
    const now = Date.now();
    let applied = false;
    for (const rec of records) {
      applyRecord(rec, now);
      if (rec.type === 'mac') applied = true;
    }
    if (applied) scheduleRebuild();
  });
  // Hot-plug: keep the picker honest without a manual refresh, and drop
  // out of "connected" when the cable is pulled.
  onSerialState(ev => {
    if (ev.state === 'detached' || ev.state === 'closed' || ev.state === 'error') {
      if (state.connected) {
        markDisconnected(ev.state === 'error' ? (ev.message ?? 'serial error') : undefined);
      }
    }
    if (ev.state === 'attached' || ev.state === 'detached') refreshUsb();
  });
}

export function refreshUsb(): void {
  if (!available) return;
  listDevices()
    .then(d => {
      devices = d;
      emit();
    })
    .catch(() => {
      devices = [];
      emit();
    });
}

export function connect(deviceId: string): void {
  setState({lastError: null});
  parser.reset();
  openDevice(deviceId, settingsStore.get().scanBaud)
    .then(() => {
      setState({connected: true, connectedDeviceId: deviceId});
      // Alerts and the background-scan notification both need
      // POST_NOTIFICATIONS on Android 13+; ask at the moment it matters.
      const s = settingsStore.get();
      if (s.policeAlerts || s.backgroundScan) requestNotificationPermission().catch(() => {});
      // Only after open() succeeded: Android 14 lets a connectedDevice
      // foreground service start once the app holds USB permission.
      if (s.backgroundScan) startBackground(view);
    })
    .catch(e => {
      setState({lastError: String(e?.message ?? e)});
    });
}

export function disconnect(): void {
  closeDevice().catch(() => {});
  markDisconnected();
}

export function clear(): void {
  table.clear();
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

// The background toggle applies to a running session too.
settingsStore.subscribe(s => {
  if (!state.connected) return;
  if (s.backgroundScan) startBackground(view);
  else stopBackground();
});
