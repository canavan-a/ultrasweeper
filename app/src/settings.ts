import AsyncStorage from '@react-native-async-storage/async-storage';

// App settings, persisted under one AsyncStorage key — same load/save/
// subscribe shape as super-badger's settings.ts, with scanner-specific keys.

const STORAGE_KEY = 'ultrascanner.settings.v1';

export interface Settings {
  // Kept here (rather than a separate store) so the existing load/save/
  // subscribe plumbing — and its single AsyncStorage key — covers theme
  // persistence for free. See src/theme.tsx for the actual palettes.
  themeName: 'light' | 'dark' | 'slate' | 'sepia' | 'ember';
  // Android-only: switch the launcher icon to the one matching the current
  // theme (see src/appIcon.ts). On by default; turn it off if your launcher
  // reacts badly to icons changing.
  themedIcon: boolean;
  // Serial rate the scanner is expected to speak. Must match SCANNER_BAUD
  // in the firmware build (921600 is the default; 115200 is the safe
  // fallback if the board's bridge chip can't keep up).
  scanBaud: number;
  // Fold single-bit air-glitch copies (CRC:S frames whose MAC or payload
  // differs from an existing sighting only slightly) into the original
  // rather than showing a second near-identical device. See devices.ts.
  mergeGlitches: boolean;
  // Seconds a device with no fresh sighting stays listed before dropping
  // off the scan screen. Historical counts live here too; the M2 app
  // keeps only the live session view.
  keepSeconds: number;
  // Scan list filter: everything heard, or only devices the police
  // classifier (src/lookup/police.ts) matched. Kept here so it survives
  // a trip to Settings and app restarts.
  scanFilter: 'all' | 'police';
  // Police alerts (src/alerts.ts): a notification when a police match is
  // first heard, with the three-ping chime and/or a matching vibration.
  policeAlerts: boolean;
  // 'likely' alerts only on Axon signatures; 'possible' also on
  // public-safety vendor OUIs and weak name matches (more false alarms).
  alertLevel: 'likely' | 'possible';
  alertSound: boolean;
  alertVibrate: boolean;
  // Keep the scan (and alerts) running while the app is in the background,
  // via a foreground service shown as an ongoing notification.
  backgroundScan: boolean;
}

const DEFAULT_SETTINGS: Settings = {
  themeName: 'light',
  themedIcon: true,
  scanBaud: 921600,
  mergeGlitches: true,
  keepSeconds: 300,
  scanFilter: 'all',
  policeAlerts: true,
  alertLevel: 'likely',
  alertSound: true,
  alertVibrate: true,
  backgroundScan: true,
};

type Listener = (settings: Settings) => void;

let current: Settings = DEFAULT_SETTINGS;
let loaded = false;
const listeners = new Set<Listener>();

async function load(): Promise<Settings> {
  if (loaded) {
    return current;
  }
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (raw) {
      current = {...DEFAULT_SETTINGS, ...JSON.parse(raw)};
    }
  } catch {
    // fall back to defaults — a corrupt/missing value shouldn't crash startup
  }
  loaded = true;
  return current;
}

async function save(next: Settings): Promise<void> {
  current = next;
  listeners.forEach(l => l(current));
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // best-effort persistence; the in-memory value above is still updated
  }
}

export const settingsStore = {
  get: (): Settings => current,
  load,
  save,
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
