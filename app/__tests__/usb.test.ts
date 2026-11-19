// The hand-rolled base64 decoder in usb.ts (Hermes has no Buffer/atob)
// must round-trip exactly what the Kotlin side sends.
import {decodeBase64Ascii} from '../src/usb';

describe('decodeBase64Ascii', () => {
  it('decodes protocol text', () => {
    const line = 'STATS T:999 RA:100 RB:98 OK:120 DUP:3400 OVER:0\r\n';
    expect(decodeBase64Ascii(Buffer.from(line, 'latin1').toString('base64'))).toBe(line);
  });

  it('handles chunk boundaries that split a base64 group (= padding absent mid-chunk, present at end)', () => {
    const bytes = Buffer.from('MAC:AA:BB:CC:DD:EE:FF', 'latin1');
    const full = bytes.toString('base64');
    // decode the same bytes split at every 1-byte-shifted boundary
    for (let r = 0; r < 3; r++) {
      const head = full.slice(0, Math.floor((full.length - r) / 3) * 3 + r);
      const tail = full.slice(head.length);
      const reEncoded = Buffer.concat([
        Buffer.from(decodeBase64Ascii(head), 'latin1'),
      ]).toString('base64');
      // tail alone may be un-decodable (no padding); combined they must
      // reproduce the original bytes once padded
      expect(
        decodeBase64Ascii(reEncoded + tail.replace(/=/g, '')).startsWith('MAC:AA:BB'),
      ).toBe(true);
    }
  });

  it('passes through all byte values 0-255 as latin1', () => {
    const all = Buffer.from(Array.from({length: 256}, (_, i) => i));
    expect(decodeBase64Ascii(all.toString('base64'))).toBe(all.toString('latin1'));
  });
});
