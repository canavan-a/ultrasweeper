// Classification against the same real bench blobs the protocol tests use.
import {classify, parsePdu} from '../src/lookup/adparse';

// Real M1 bench captures (see __tests__/protocol.test.ts for provenance).
const APPLE_BLOB = '42211D0C3F9DEF7002011A17FF4C008908B322C0A803271B18160800EA798AA0';
const IBEACON_BLOB = '422459C7731D5C270201041AFF4C0002152686F39CBADA4658854AA62E7E5E8B';
const MSVP_BLOB = '422539BE1437B6171EFF060001092022BF0E3B1C9391CA5D1D0D347A8E52D48F';
const FD7F_BLOB = '0023E7A7093BB1AA0201061916F7FD01C2E1E6AF3C35400AA27BA89BB14BCDA2';
const NAME_BLOB = '44232FF5130B823D1C094C452D426F736520514320556C747261204865616470';

describe('parsePdu', () => {
  it('walks the AD chain of a real truncated capture', () => {
    const pdu = parsePdu(APPLE_BLOB)!;
    expect(pdu.pduType).toBe(0x2); // ADV_IND (header 0x42 & 0x0f)
    expect(pdu.pduLen).toBe(0x21);
    expect(pdu.adva[0]).toBe(0x1d); // air order, LSB first
    expect(pdu.structures.map(s => s.type)).toEqual([0x01, 0xff]);
    expect(pdu.truncated).toBe(true); // the 32-byte FIFO cut the tail
  });

  it('returns null for too-short input', () => {
    expect(parsePdu('001122')).toBeNull();
  });
});

describe('classify', () => {
  it('identifies an Apple advertisement (unknown subdomain stays generic)', () => {
    // The captured frame's manufacturer subdomain byte (0x89) is outside
    // the documented continuity set, so the classifier correctly stops at
    // "Apple" rather than guessing a specific feature.
    const c = classify('70:EF:9D:3F:0C:1D', APPLE_BLOB);
    expect(c.vendor).toBe('Apple');
    expect(c.labels).toContain('Apple advertisement');
  });

  it('identifies iBeacon-format frames', () => {
    const c = classify('27:5C:1D:73:C7:59', IBEACON_BLOB);
    expect(c.vendor).toBe('Apple');
    expect(c.labels).toContain('Apple iBeacon-format advertisement');
  });

  it('identifies Microsoft MSVPs', () => {
    const c = classify('17:B6:37:14:BE:39', MSVP_BLOB);
    expect(c.vendor).toBe('Microsoft');
    expect(c.labels).toContain('Microsoft presence (MSVP) advertisement');
  });

  it('extracts service UUIDs from service data (16 FDF7)', () => {
    const c = classify('AA:B1:3B:09:A7:E7', FD7F_BLOB);
    expect(c.serviceUuids).toContain('FDF7');
  });

  it('recovers a local name across a truncated AD', () => {
    const c = classify('1C:3D:82:0B:13:F5', NAME_BLOB);
    expect(c.name).toContain('Bose QC Ultra Headp');
  });

  it('uses OUI only for public/identity addresses', () => {
    const staticC = classify('00:25:DF:11:22:33', '');
    expect(staticC.randomAddress).toBe(false);
    expect(staticC.vendor).toBe('Axon Enterprise, Inc.');
    expect(staticC.labels).toContain('OUI-registered: Axon Enterprise, Inc.');

    // Every top-two-bits-nonzero form is random-ish and must be skipped.
    // The prefixes below are all genuinely ASSIGNED in the bundled OUI
    // registry, so a lookup here would confidently invent a vendor from a
    // rotating address: 40: (resolvable-private 0b01), 80: (the 0b10
    // form), F0: (static 0b11 — the same block F01898 proves Apple owns).
    for (const mac of ['F0:1B:24:11:22:33', '40:01:07:33:44:55', '80:00:10:F8:12:6F']) {
      const c = classify(mac, '');
      expect(c.randomAddress).toBe(true);
      expect(c.vendor).toBeUndefined();
    }
  });
});
