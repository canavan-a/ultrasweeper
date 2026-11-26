// GATT probe: connect to one connectable device with the phone's own BLE
// radio and read its GATT table. The nRF24 rig can only ever hear what a
// device shouts; this is what it will tell you if asked.
//
// Native side: android/.../GattProbeModule.kt (scan → connect → discover →
// read → disconnect, bounded budgets). Everything above the bytes —
// labels, decoding, what counts as an identity — lives here.

import {NativeModules, PermissionsAndroid, Platform} from 'react-native';

import {sigService} from './lookup/sig';

export interface ProbeCharacteristic {
  /** full 128-bit GATT uuid, e.g. "00002a24-0000-1000-8000-00805f9b34fb" */
  uuid: string;
  properties: string[];
  /** hex of the read value; absent when the read failed or was skipped */
  valueHex?: string;
}

export interface ProbeService {
  uuid: string;
  characteristics: ProbeCharacteristic[];
}

export interface ProbeResult {
  address: string;
  services: ProbeService[];
  /** set when the read budget ran out mid-table: the rest was not read */
  truncated?: string;
}

interface GattProbeNative {
  probe(mac: string): Promise<ProbeResult>;
}

const Native = NativeModules.GattProbe as GattProbeNative | undefined;

export function gattProbeAvailable(): boolean {
  return Native != null;
}

export function gattProbeErrorText(code: string): string {
  switch (code) {
    case 'not-found':
      return 'not heard by the phone — drive closer, or the ad stopped';
    case 'connect-refused':
      return 'refused the connection (busy or by design)';
    case 'connect-timeout':
      return 'answered the phone, then stayed quiet';
    case 'read-timeout':
      return 'connected, but read nothing in time';
    case 'discover-failed':
      return 'connected, then dropped the service lookup';
    case 'no-permission':
      return 'Nearby devices permission not granted';
    case 'no-bluetooth':
      return "this phone's Bluetooth is off";
    case 'busy':
      return 'another probe is running';
    default:
      return code;
  }
}

/**
 * Ask for the runtime permissions the probe needs (Android 12+; below
 * that BLE rides on location, which the app already holds). Resolves
 * true when the native side should be able to run.
 */
export async function ensureBlePermissions(): Promise<boolean> {
  if (!Native) return false;
  if (Platform.OS !== 'android' || typeof Platform.Version !== 'number' || Platform.Version < 31) {
    return true;
  }
  const grant = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
  ]);
  return (
    grant['android.permission.BLUETOOTH_CONNECT'] === 'granted' &&
    grant['android.permission.BLUETOOTH_SCAN'] === 'granted'
  );
}

export async function probeDeviceGatt(mac: string): Promise<ProbeResult> {
  if (!Native) throw new Error('no-native-module');
  return Native.probe(mac);
}

// ---------------------------------------------------------------- result

/** printable ASCII/UTF-8 for the small GATT strings, null for binary */
export function decodeGattText(valueHex: string | undefined): string | null {
  if (!valueHex || valueHex.length % 2 !== 0) return null;
  let out = '';
  for (let i = 0; i < valueHex.length; i += 2) {
    const b = parseInt(valueHex.slice(i, i + 2), 16);
    if (!Number.isFinite(b)) return null;
    // printable ASCII only; anything else was never a label
    if (b < 0x20 || b > 0x7e) return null;
    out += String.fromCharCode(b);
  }
  return out.trim() || null;
}

/** Device Information service + its SIG-defined label characteristics. */
const DEVICE_INFO_SERVICE = '0000180a-0000-1000-8000-00805f9b34fb';
const INFO_CHARACTERISTICS: Record<string, string> = {
  '00002a24-0000-1000-8000-00805f9b34fb': 'model',
  '00002a29-0000-1000-8000-00805f9b34fb': 'manufacturer',
  '00002a25-0000-1000-8000-00805f9b34fb': 'serial',
  '00002a26-0000-1000-8000-00805f9b34fb': 'firmware rev',
  '00002a27-0000-1000-8000-00805f9b34fb': 'hardware rev',
  '00002a50-0000-1000-8000-00805f9b34fb': 'PnP ID',
};

export interface ProbeSummary {
  /** Device Information labels worth showing in big text */
  identity: {label: string; value: string}[];
  /** "Generic Access", "Battery", "FF E0" style names for every service */
  serviceNames: string[];
  readCount: number;
}

function shortUuid(uuid: string): string | null {
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  return m ? m[1].toUpperCase() : null;
}

/** Turn a raw probe into what a human wants to read off it. */
export function summarizeProbe(r: ProbeResult): ProbeSummary {
  const identity: ProbeSummary['identity'] = [];
  const serviceNames: string[] = [];
  let readCount = 0;
  for (const svc of r.services) {
    const u16 = shortUuid(svc.uuid);
    if (u16) {
      serviceNames.push(sigService(u16) ?? `service ${u16}`);
    } else {
      serviceNames.push(`service ${svc.uuid.slice(0, 8).toUpperCase()}`);
    }
    const isDeviceInfo = svc.uuid.toLowerCase() === DEVICE_INFO_SERVICE;
    for (const ch of svc.characteristics) {
      if (ch.valueHex === undefined) continue;
      readCount += 1;
      if (!isDeviceInfo) continue;
      const infoLabel = INFO_CHARACTERISTICS[ch.uuid.toLowerCase()];
      if (!infoLabel) continue;
      // PnP ID is a binary struct (vendor id source + id + version), not a
      // string; hex pairs are the readable form for it.
      const text =
        ch.uuid.toLowerCase() === '00002a50-0000-1000-8000-00805f9b34fb'
          ? (ch.valueHex.match(/../g) ?? []).join(':')
          : decodeGattText(ch.valueHex);
      if (text) identity.push({label: infoLabel, value: text});
    }
  }
  return {identity, serviceNames, readCount};
}
