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
  /** cumulative bytes native discarded because JS fell behind (normally 0) */
  dropped?: number;
}

export interface SerialStateEvent {
  deviceId?: string;
  state: 'attached' | 'detached' | 'error';
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

// Table-driven, and the output string is built from byte blocks rather than
// one += per character: this runs on every serial chunk (hundreds per
// scanner batch) on Hermes, which has no JIT, so it has to be cheap.
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64CHARS.length; i++) t[B64CHARS.charCodeAt(i)] = i;
  return t;
})();
const BLOCK = 4096;

export function decodeBase64Ascii(b64: string): string {
  const bytes = new Array<number>(Math.ceil((b64.length * 3) / 4));
  let n = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < b64.length; i++) {
    const code = b64.charCodeAt(i);
    const v = code < 128 ? B64_LOOKUP[code] : -1;
    if (v < 0) continue; // '=', CR/LF and anything malformed are skipped
    acc = ((acc << 6) | v) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[n++] = (acc >> bits) & 0xff;
    }
  }
  let out = '';
  for (let i = 0; i < n; i += BLOCK) {
    out += String.fromCharCode.apply(null, bytes.slice(i, Math.min(i + BLOCK, n)));
  }
  return out;
}
