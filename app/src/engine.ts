// The scan session engine: glue between the USB byte stream (usb.ts), the
// line parser (protocol.ts), and the device table (devices.ts). App.tsx
// owns one instance and passes it to screens, so navigating to Settings
// doesn't drop the session.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';

import {classify, Classification} from './lookup/adparse';
import {DeviceEntry, DeviceTable} from './devices';
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

export interface ScanEngine extends EngineState {
  available: boolean;
  devices: UsbDevice[];
  view: ViewDevice[];
  refreshUsb: () => void;
  connect: (deviceId: string) => void;
  disconnect: () => void;
  clear: () => void;
}

export function useScanEngine(): ScanEngine {
  const [available] = useState(usbAvailable());
  const [devices, setDevices] = useState<UsbDevice[]>([]);
  const [state, setState] = useState<EngineState>({
    connected: false,
    connectedDeviceId: null,
    session: null,
    stats: null,
    batchCount: 0,
    parseErrors: 0,
    lastError: null,
  });
  // Bumped on every applied sighting; the render path recomputes `view`
  // off it. A ref would be invisible to React, state is the notification.
  const [tableVersion, setTableVersion] = useState(0);

  const parser = useRef(new StreamParser());
  const table = useRef(new DeviceTable());
  // Records arriving faster than a second (the scanner batches ~2k lines
  // per burst) — coalesce table notifications so we re-render at most a
  // few times per second, not per batch.
  const notifyPending = useRef(false);

  const refreshUsb = useCallback(() => {
    if (!available) return;
    listDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, [available]);

  // Hot-plug: keep the picker honest without a manual refresh, and drop the
  // UI out of "connected" when the cable is pulled.
  useEffect(() => {
    if (!available) return;
    refreshUsb();
    const offData = onSerialData(ev => {
      const records = parser.current.feed(decodeBase64Ascii(ev.data64));
      if (records.length === 0) return;
      const now = Date.now();
      let applied = false;
      for (const rec of records) {
        applyRecord(rec, now);
        if (rec.type === 'mac') applied = true;
      }
      if (applied) scheduleNotify();
    });
    const offState = onSerialState(ev => {
      if (ev.state === 'detached' || ev.state === 'closed' || ev.state === 'error') {
        setState(s => ({
          ...s,
          connected: false,
          connectedDeviceId: null,
          lastError: ev.state === 'error' ? (ev.message ?? 'serial error') : s.lastError,
        }));
      }
      if (ev.state === 'attached' || ev.state === 'detached') refreshUsb();
    });
    return () => {
      offData();
      offState();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, refreshUsb]);

  const applyRecord = (rec: ParsedRecord, now: number) => {
    switch (rec.type) {
      case 'session':
        setState(s => ({...s, session: rec}));
        break;
      case 'stats':
        setState(s => ({...s, stats: rec}));
        break;
      case 'batch-end':
        setState(s => ({...s, batchCount: s.batchCount + 1}));
        // periodic pruning lives here rather than a timer: it only needs
        // to happen when data is actually flowing
        table.current.pruneOlderThan(now, settingsStore.get().keepSeconds * 1000);
        break;
      case 'mac':
        table.current.apply(rec as MacRecord, now, settingsStore.get().mergeGlitches);
        break;
      case 'unknown':
        setState(s => ({...s, parseErrors: s.parseErrors + 1}));
        break;
      default:
        break;
    }
  };

  const scheduleNotify = () => {
    if (notifyPending.current) return;
    notifyPending.current = true;
    setTimeout(() => {
      notifyPending.current = false;
      setTableVersion(v => v + 1);
    }, 300);
  };

  const connect = useCallback(
    (deviceId: string) => {
      setState(s => ({...s, lastError: null}));
      parser.current.reset();
      openDevice(deviceId, settingsStore.get().scanBaud)
        .then(() => {
          setState(s => ({...s, connected: true, connectedDeviceId: deviceId}));
        })
        .catch(e => {
          setState(s => ({...s, lastError: String(e?.message ?? e)}));
        });
    },
    [],
  );

  const disconnect = useCallback(() => {
    closeDevice().catch(() => {});
    setState(s => ({...s, connected: false, connectedDeviceId: null}));
  }, []);

  const clear = useCallback(() => {
    table.current.clear();
    setTableVersion(v => v + 1);
  }, []);

  const view = useMemo<ViewDevice[]>(
    () =>
      table.current.snapshot().map(d => ({
        ...d,
        // snapshot() returns live entry references; spread so the
        // classified view doesn't mutate under the renderer later
        channels: new Set(d.channels),
        cls: classify(d.mac, d.ad),
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tableVersion],
  );

  return {...state, available, devices, view, refreshUsb, connect, disconnect, clear};
}
