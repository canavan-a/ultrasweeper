// React view of the scan session. The session itself lives in session.ts as
// a module-level singleton so it survives the UI going away (background
// scanning); this hook just subscribes to it.
import {useSyncExternalStore} from 'react';

import * as session from './session';
import type {SessionSnapshot} from './session';

export type {EngineState, ViewDevice} from './session';

export interface ScanEngine extends SessionSnapshot {
  refreshUsb: () => void;
  connect: (deviceId: string) => void;
  disconnect: () => void;
  clear: () => void;
}

export function useScanEngine(): ScanEngine {
  const snap = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return {
    ...snap,
    refreshUsb: session.refreshUsb,
    connect: session.connect,
    disconnect: session.disconnect,
    clear: session.clear,
  };
}
