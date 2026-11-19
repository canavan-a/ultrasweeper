// Police alerts: when the police classifier (lookup/police.ts) first matches
// a device, post a high-priority notification that plays the three-ping
// chime and/or vibrates, per Settings. Runs from the scan session, so it
// works with the app in the background too.
//
// One alert per device: a MAC is alerted once and stays quiet until it drops
// off the device table (pruned after "Keep devices for", or cleared), so a
// unit parked outside doesn't ping forever, but one that leaves and comes
// back alerts again. Several new matches at once share one notification.
// A unit that rotates random addresses looks like a new device each time;
// MIN_GAP_MS keeps that from becoming a constant stream of chimes.
import notifee, {AndroidImportance, AndroidStyle} from '@notifee/react-native';

import {alertChannelId, ensureChannels, PRESS_ACTION, SMALL_ICON} from './notifications';
import type {PoliceMatch} from './lookup/police';
import {settingsStore} from './settings';

export const NID_POLICE = 'police-alert';
const MIN_GAP_MS = 30_000;

interface Alertable {
  mac: string;
  police: PoliceMatch | null;
}

const alerted = new Set<string>();
let lastAlertAt = 0;

function qualifies(m: PoliceMatch, level: 'likely' | 'possible'): boolean {
  return level === 'possible' || m.confidence === 'likely';
}

/**
 * Called with the full device view after every table update. Alerts on
 * matches not alerted before and forgets devices that have left the view.
 * `now` is injectable for tests.
 */
export function checkPoliceAlerts(view: Alertable[], now = Date.now()): Alertable[] {
  const present = new Set(view.map(d => d.mac));
  for (const mac of alerted) {
    if (!present.has(mac)) alerted.delete(mac);
  }

  const s = settingsStore.get();
  if (!s.policeAlerts) return [];
  const fresh = view.filter(d => d.police && qualifies(d.police, s.alertLevel) && !alerted.has(d.mac));
  if (fresh.length === 0) return [];
  fresh.forEach(d => alerted.add(d.mac));

  // Inside the gap the notification still updates, but on the silent
  // channel — no chime or vibration, even if the last alert was dismissed.
  const loud = now - lastAlertAt >= MIN_GAP_MS;
  if (loud) lastAlertAt = now;
  const total = view.filter(d => d.police && qualifies(d.police, s.alertLevel)).length;
  postAlert(fresh, total, !loud).catch(err => console.warn('[alerts] notification failed', err));
  return fresh;
}

export function resetPoliceAlerts(): void {
  alerted.clear();
}

function describe(m: PoliceMatch): string {
  return `${m.label} (${m.confidence})`;
}

async function postAlert(fresh: Alertable[], total: number, quiet: boolean): Promise<void> {
  await ensureChannels();
  const s = settingsStore.get();
  const first = fresh[0].police!;
  const title =
    fresh.length === 1 ? `Police device nearby: ${describe(first)}` : `${fresh.length} police devices nearby`;
  const lines = fresh.map(d => `${describe(d.police!)} · ${d.mac}`);
  await notifee.displayNotification({
    id: NID_POLICE,
    title,
    body: `${lines[0]}${total > fresh.length ? ` — ${total} matching in range` : ''}`,
    android: {
      channelId: quiet ? alertChannelId(false, false) : alertChannelId(s.alertSound, s.alertVibrate),
      smallIcon: SMALL_ICON,
      importance: AndroidImportance.HIGH,
      pressAction: PRESS_ACTION,
      style: fresh.length > 1 ? {type: AndroidStyle.INBOX as const, lines} : undefined,
    },
  });
}

/** Settings → "Test alert": the real notification path, with a fake match. */
export async function sendTestAlert(): Promise<void> {
  await postAlert(
    [{mac: '00:25:DF:00:00:00', police: {label: 'Axon (test)', confidence: 'likely', reasons: ['test alert']}}],
    1,
    false,
  );
}
