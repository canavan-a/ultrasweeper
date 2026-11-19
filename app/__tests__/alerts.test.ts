// Police alert decisions: who gets alerted, when it stays quiet, and which
// channel (chime / vibration combination) the notification goes to.
import notifee from '@notifee/react-native';

import {checkPoliceAlerts, resetPoliceAlerts} from '../src/alerts';
import type {PoliceMatch} from '../src/lookup/police';
import {alertChannelId} from '../src/notifications';
import {settingsStore} from '../src/settings';

const likely: PoliceMatch = {label: 'Axon', confidence: 'likely', reasons: ['test']};
const possible: PoliceMatch = {label: 'Motorola Solutions', confidence: 'possible', reasons: ['test']};
const dev = (mac: string, police: PoliceMatch | null) => ({mac, police});

const display = notifee.displayNotification as jest.Mock;
const flush = () => new Promise(r => setImmediate(r));
const lastChannel = () => display.mock.calls[display.mock.calls.length - 1][0].android.channelId;

beforeEach(async () => {
  resetPoliceAlerts();
  display.mockClear();
  await settingsStore.save({
    ...settingsStore.get(),
    policeAlerts: true,
    alertLevel: 'likely',
    alertSound: true,
    alertVibrate: true,
  });
});

describe('checkPoliceAlerts', () => {
  it('alerts once per device with the chime + vibration channel', async () => {
    const view = [dev('AA', likely), dev('BB', null)];
    expect(checkPoliceAlerts(view, 1_000_000).map(d => d.mac)).toEqual(['AA']);
    expect(checkPoliceAlerts(view, 1_100_000)).toEqual([]); // same device: quiet
    await flush();
    expect(display).toHaveBeenCalledTimes(1);
    expect(lastChannel()).toBe(alertChannelId(true, true));
  });

  it('respects the likely/possible level', () => {
    expect(checkPoliceAlerts([dev('CC', possible)], 2_000_000)).toEqual([]);
    settingsStore.save({...settingsStore.get(), alertLevel: 'possible'});
    expect(checkPoliceAlerts([dev('CC', possible)], 2_100_000).map(d => d.mac)).toEqual(['CC']);
  });

  it('alerts again after the device left the list', () => {
    checkPoliceAlerts([dev('DD', likely)], 3_000_000);
    checkPoliceAlerts([], 3_100_000); // pruned
    expect(checkPoliceAlerts([dev('DD', likely)], 3_200_000).map(d => d.mac)).toEqual(['DD']);
  });

  it('goes to the silent channel inside the 30 s gap', async () => {
    checkPoliceAlerts([dev('EE', likely)], 4_000_000);
    checkPoliceAlerts([dev('EE', likely), dev('FF', likely)], 4_010_000);
    await flush();
    expect(display).toHaveBeenCalledTimes(2);
    expect(lastChannel()).toBe(alertChannelId(false, false));
  });

  it('follows the sound/vibrate settings', async () => {
    settingsStore.save({...settingsStore.get(), alertSound: false});
    checkPoliceAlerts([dev('GG', likely)], 5_000_000);
    await flush();
    expect(lastChannel()).toBe(alertChannelId(false, true));
  });

  it('does nothing when alerts are off', () => {
    settingsStore.save({...settingsStore.get(), policeAlerts: false});
    expect(checkPoliceAlerts([dev('HH', likely)], 6_000_000)).toEqual([]);
  });
});
