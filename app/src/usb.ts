// JS bridge to the native USB serial module (android/.../UsbSerialModule.kt).
// Everything here is bytes-in / events-out: the scanner is a write-only
// device, and all protocol meaning lives in src/protocol.ts.
import {NativeEventEmitter, NativeModules} from 'react-native';

export interface UsbDevice {
  /** /dev/bus/usb/NNN/NNN — the key open() and hot-plug events use */
  deviceId: string;
  productName: string;
  vendorId: number;
  productId: number;
}

interface UsbSerialNative {
  getDeviceList(): Promise<UsbDevice[]>;
  open(deviceId: string, baud: number): Promise<null>;
  close(): Promise<null>;
}

const Native = NativeModules.UsbSerial as UsbSerialNative | undefined;

export function usbAvailable(): boolean {
  return Native != null;
}

function native(): UsbSerialNative {
  if (!Native) throw new Error('UsbSerial native module unavailable (rebuild the app)');
  return Native;
}

export const listDevices = (): Promise<UsbDevice[]> => native().getDeviceList();
export const openDevice = (deviceId: string, baud: number): Promise<null> =>
  native().open(deviceId, baud);
export const closeDevice = (): Promise<null> => native().close();

export interface SerialDataEvent {
  deviceId: string;
  /** base64 of the raw bytes read (never assume chunk boundaries) */
  data64: string;
}

export interface SerialStateEvent {
  deviceId?: string;
  state: 'attached' | 'detached' | 'closed' | 'error';
  message?: string;
}

export function onSerialData(cb: (e: SerialDataEvent) => void): () => void {
  if (!Native) return () => {};
  const emitter = new NativeEventEmitter(NativeModules.UsbSerial);
  const sub = emitter.addListener('UsbSerialData', cb);
  return () => sub.remove();
}

export function onSerialState(cb: (e: SerialStateEvent) => void): () => void {
  if (!Native) return () => {};
  const emitter = new NativeEventEmitter(NativeModules.UsbSerial);
  const sub = emitter.addListener('UsbSerialState', cb);
  return () => sub.remove();
}

// Hermes has no Buffer/atob, so decode base64 to bytes by hand. The result
// is then latin1-decoded: PROTOCOL.md is pure ASCII, so mapping byte N to
// charCode N is exactly right for the line parser.
const B64CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function decodeBase64Ascii(b64: string): string {
  let out = '';
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const c = b64[i];
    if (c === '=' || c === '\n' || c === '\r') continue;
    const v = B64CHARS.indexOf(c);
    if (v < 0) continue; // skip anything malformed rather than throwing
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out += String.fromCharCode((acc >> bits) & 0xff);
    }
  }
  return out;
}
