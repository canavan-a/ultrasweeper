// Phone location for hunts: a thin JS half of LocationModule.kt. Keeps the
// latest fix in memory so the scan session can tag every sighting with it
// synchronously (no native round-trip per record).
import {NativeEventEmitter, NativeModules, PermissionsAndroid, Platform} from 'react-native';

import type {Fix} from './geo';

interface LocationNative {
  start(intervalMs: number): Promise<boolean>;
  stop(): Promise<null>;
  isEnabled(): Promise<boolean>;
}

const Native = NativeModules.PhoneLocation as LocationNative | undefined;

export type LocationStatus = 'off' | 'denied' | 'disabled' | 'waiting' | 'ok';

/** How often to ask the providers for a fix while hunting. */
const INTERVAL_MS = 2000;
/** A fix older than this is not "where we are now". */
export const STALE_MS = 30_000;

let latest: Fix | null = null;
let status: LocationStatus = 'off';
let subscribed = false;
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach(l => l());
}

function ensureSubscribed(): void {
  if (subscribed || !Native) return;
  subscribed = true;
  new NativeEventEmitter(NativeModules.PhoneLocation).addListener('PhoneLocation', (f: Fix) => {
    // A provider can hand back an older last-known fix after a newer one.
    if (latest && f.t < latest.t) return;
    latest = f;
    if (status === 'waiting' || status === 'disabled') status = 'ok';
    notify();
  });
}

export function locationAvailable(): boolean {
  return Platform.OS === 'android' && Native != null;
}

/** Ask for fine location (falls back to coarse if that's all they allow). */
export async function requestLocationPermission(): Promise<boolean> {
  if (!locationAvailable()) return false;
  const P = PermissionsAndroid.PERMISSIONS;
  const res = await PermissionsAndroid.requestMultiple([P.ACCESS_FINE_LOCATION, P.ACCESS_COARSE_LOCATION]);
  const G = PermissionsAndroid.RESULTS.GRANTED;
  return res[P.ACCESS_FINE_LOCATION] === G || res[P.ACCESS_COARSE_LOCATION] === G;
}

export async function hasLocationPermission(): Promise<boolean> {
  if (!locationAvailable()) return false;
  const P = PermissionsAndroid.PERMISSIONS;
  return (
    (await PermissionsAndroid.check(P.ACCESS_FINE_LOCATION)) ||
    (await PermissionsAndroid.check(P.ACCESS_COARSE_LOCATION))
  );
}

/** Start updates (asking for permission if needed). Resolves to the status. */
export async function startLocation(): Promise<LocationStatus> {
  if (!locationAvailable()) return status;
  ensureSubscribed();
  if (!(await requestLocationPermission())) {
    status = 'denied';
    notify();
    return status;
  }
  const started = await Native!.start(INTERVAL_MS).catch(() => false);
  const enabled = await Native!.isEnabled().catch(() => false);
  status = !started ? 'denied' : !enabled && !latest ? 'disabled' : latest ? 'ok' : 'waiting';
  notify();
  return status;
}

export function stopLocation(): void {
  if (!Native) return;
  Native.stop().catch(() => {});
  status = 'off';
  notify();
}

/** Latest fix, or null when there is none fresh enough to trust. */
export function currentFix(now = Date.now()): Fix | null {
  if (!latest || now - latest.t > STALE_MS) return null;
  return latest;
}

export function lastFix(): Fix | null {
  return latest;
}

export function locationStatus(): LocationStatus {
  return status;
}

export function onLocation(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
