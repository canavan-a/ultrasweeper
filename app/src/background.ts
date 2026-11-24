// Background scanning: while a scanner is connected (and Settings allows
// it), run a Notifee foreground service so Android keeps the process — and
// with it the JS scan session and police alerts — alive with the app in the
// background. The service's ongoing notification doubles as a live status
// line. The CPU side (reading USB with the screen off) is the wake lock
// UsbSerialModule.kt holds while a port is open.
//
// The service type is connectedDevice: that's what this is (a USB scanner),
// and Android 14+ allows it once the app holds USB permission for the
// device, which connect() guarantees before calling startBackground().
// While a hunt has location on, the service also carries the location type:
// that is what keeps GPS fixes coming with the screen off (src/location.ts).
// Android 14 rejects that type without a granted location permission, so
// session.ts only sets it after the permission prompt succeeded.
import notifee, {AndroidForegroundServiceType} from '@notifee/react-native';

import {CH_SCANNING, ensureChannels, NID_SCANNING, PRESS_ACTION, SMALL_ICON} from './notifications';

interface Countable {
  police: unknown;
}

let running = false;
let lastBody = '';
let withLocation = false;
// Resolves the promise the registered service runner is parked on (see
// registerBackgroundRunner); the service stops when it settles.
let release: (() => void) | null = null;

/** Called once from index.js, at bundle load, before any service starts. */
export function registerBackgroundRunner(): void {
  notifee.registerForegroundService(
    () =>
      new Promise<void>(resolve => {
        release = resolve;
      }),
  );
}

function body(view: Countable[]): string {
  const police = view.filter(d => d.police).length;
  return `${view.length} device${view.length === 1 ? '' : 's'} in range · ${police} police`;
}

async function show(text: string): Promise<void> {
  await ensureChannels();
  await notifee.displayNotification({
    id: NID_SCANNING,
    title: 'Scanner listening',
    body: text,
    android: {
      channelId: CH_SCANNING,
      smallIcon: SMALL_ICON,
      asForegroundService: true,
      foregroundServiceTypes: withLocation
        ? [
            AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE,
            AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_LOCATION,
          ]
        : [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE],
      ongoing: true,
      onlyAlertOnce: true,
      pressAction: PRESS_ACTION,
    },
  });
}

/** Add/remove the location service type; re-posts a running service. */
export function setBackgroundLocation(on: boolean): void {
  if (on === withLocation) return;
  withLocation = on;
  if (running) show(lastBody).catch(() => {});
}

export function startBackground(view: Countable[]): void {
  if (running) return;
  running = true;
  lastBody = body(view);
  show(lastBody).catch(err => {
    running = false;
    console.warn('[background] could not start the foreground service', err);
  });
}

/** Refresh the status line; cheap no-op when nothing changed. */
export function updateBackground(view: Countable[]): void {
  if (!running) return;
  const next = body(view);
  if (next === lastBody) return;
  lastBody = next;
  show(next).catch(() => {});
}

export function stopBackground(): void {
  if (!running) return;
  running = false;
  release?.();
  release = null;
  notifee.stopForegroundService().catch(() => {});
}
