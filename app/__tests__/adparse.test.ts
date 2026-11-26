// Classification against the same real bench blobs the protocol tests use.
import {advOpcode, classify, parsePdu} from '../src/lookup/adparse';

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

describe('advOpcode', () => {
  // Ground truth from the wardriving corpus: shout-only broadcasters
  // (iBeacon, Eddystone, Apple, Microsoft) vote 2; connectable consumer
  // devices (Govee, Furbo, Tuya, SP6, Axon) vote 0. The real blobs above
  // are those two families.
  it('reads shout-only (2) from iBeacon/Apple-style headers', () => {
    expect(advOpcode(IBEACON_BLOB)).toBe(2);
    expect(advOpcode(APPLE_BLOB)).toBe(2);
    expect(advOpcode(MSVP_BLOB)).toBe(2);
  });

  it('reads connectable (0) from a connectable advertiser', () => {
    expect(advOpcode(FD7F_BLOB)).toBe(0);
  });

  it('returns null for a header whose nibble is not an ADV opcode', () => {
    expect(advOpcode(NAME_BLOB)).toBeNull(); // 0x44 -> nibble 4: a glitched header
    expect(advOpcode('')).toBeNull();
    expect(advOpcode('0')).toBeNull();
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

// Synthetic frames (made-up addresses) for the payload decoders and the
// full SIG registry lookups.
const ADVA = 'EFCDAB896745'; // 45:67:89:AB:CD:EF, air order
const MAC = '45:67:89:AB:CD:EF';
// fullAd: the AD length the advertiser declared (real captures are cut short by the 32-byte FIFO)
const frame = (header: string, ad: string, fullAd = ad.length / 2) => header + (fullAd + 6).toString(16).padStart(2, '0') + ADVA + ad;

describe('classify: decoders and registry', () => {
  it('decodes the Microsoft CDP device type', () => {
    expect(classify('17:B6:37:14:BE:39', MSVP_BLOB).labels[0]).toBe('Windows desktop (Microsoft CDP beacon)');
    const laptop = classify(MAC, frame('42', '1EFF0600010F2022' + '00'.repeat(8), 31));
    expect(laptop.labels[0]).toBe('Windows laptop (Microsoft CDP beacon)');
    expect(laptop.labels).toContain('Microsoft presence (MSVP) advertisement');
  });

  it('names Apple continuity types, leaving unknown ones generic', () => {
    expect(classify(MAC, frame('42', '0AFF4C000906' + '00'.repeat(6))).labels[0]).toBe('Apple AirPlay target');
    expect(classify(MAC, frame('42', '1EFF4C001219' + '00'.repeat(20), 31)).labels[0]).toBe('Apple Find My');
    expect(classify('70:EF:9D:3F:0C:1D', APPLE_BLOB).labels[0]).toBe('Apple advertisement');
  });

  it('decodes an Eddystone frame and names the vendor from its member UUID', () => {
    const c = classify(MAC, frame('02', '0303AAFE1716AAFE00ED' + '11'.repeat(16), 28));
    expect(c.labels[0]).toBe('Eddystone-UID beacon');
    expect(c.vendor).toBe('Google LLC');
    expect(c.labels).toContain('Google LLC service FEAA');
    // ns ‖ instance as one 20-hex id (flags.ts matches on this)
    expect(c.eddystoneUids).toEqual(['11111111111111111111']);
  });

  it('reads a Fast Pair model ID only from an untruncated discoverable frame', () => {
    expect(classify(MAC, frame('42', '06162CFEAABBCC')).labels[0]).toBe('Google Fast Pair accessory, model 0xAABBCC');
  });

  it('recognises a known vendor 128-bit service', () => {
    // 1B19B844-038F-11E5-8418-1697F925EC7B, little-endian on air
    const c = classify(MAC, frame('00', '020106' + '11067BEC25F997161884E5118F0344B8191B'));
    expect(c.labels[0]).toBe('Xirgo vehicle telematics / ELD (engine service)');
  });

  it('falls back to the full SIG company registry', () => {
    // 0x0E9F is not in the curated list
    expect(classify(MAC, frame('00', '020106' + '05FF9F0E0102')).vendor).toBe('Owlet Baby Care Inc.');
  });
});
