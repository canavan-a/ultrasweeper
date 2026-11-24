// Device table + glitch folding. The folded pair below is modeled on the
// real bench twin `86:69:93:F8:12:6F` / `86:69:B3:F8:12:6F` from the M1
// capture — same payload one bit-flipped in flight, both accepted as
// CRC:S.
import {DeviceTable, foldableInto, hamming, macToBytes} from '../src/devices';
import {MacRecord} from '../src/protocol';

const AD_BASE =
  '0023E7A7093BB1AA' + // hdr, len, AdvA (air order)
  '020106' + // flags
  '1916F7FD01C2E1E6AF3C35400AA27BA89BB14BCDA2'; // service data FDF7 family

function rec(mac: string, ad: string, crc: MacRecord['crc'] = 'S'): MacRecord {
  return {type: 'mac', mac, pwr: 20, t: 1000, ch: 37, crc, ad};
}

describe('DeviceTable', () => {
  it('merges repeat sightings of the exact MAC', () => {
    const t = new DeviceTable();
    t.apply(rec('86:69:93:F8:12:6F', AD_BASE), 1000, false);
    t.apply(rec('86:69:93:F8:12:6F', AD_BASE, '1'), 2000, false);
    expect(t.size).toBe(1);
    const [d] = t.snapshot();
    expect(d.sightings).toBe(2);
    expect(d.crc).toBe('1'); // upgraded to the best verification seen
  });

  it('folds a single-bit air glitch into the original', () => {
    const t = new DeviceTable();
    t.apply(rec('86:69:93:F8:12:6F', AD_BASE), 1000, true);
    // one bit different in the MAC (F8 -> FA) and one bit in the payload
    const glitchAd = AD_BASE.replace('E7A709', 'E7A509');
    t.apply(rec('86:69:93:FA:12:6F', glitchAd), 1100, true);
    expect(t.size).toBe(1);
    const [d] = t.snapshot();
    expect(d.sightings).toBe(2);
    expect(d.glitchSightings).toBe(1);
  });

  it('keeps genuinely different devices apart', () => {
    const t = new DeviceTable();
    t.apply(rec('86:69:93:F8:12:6F', AD_BASE), 1000, true);
    t.apply(rec('70:EF:9D:3F:0C:1D', '42211D0C3F9DEF7002011A17FF4C008908B322C0A803'), 1100, true);
    expect(t.size).toBe(2);
  });

  it('does not fold when the setting is off', () => {
    const t = new DeviceTable();
    t.apply(rec('86:69:93:F8:12:6F', AD_BASE), 1000, false);
    t.apply(rec('86:69:93:FA:12:6F', AD_BASE), 1100, false);
    expect(t.size).toBe(2);
  });

  it('prunes stale entries', () => {
    const t = new DeviceTable();
    t.apply(rec('86:69:93:F8:12:6F', AD_BASE), 1000, false);
    t.pruneOlderThan(1000 + 301_000, 300_000);
    expect(t.size).toBe(0);
  });
});

describe('foldableInto / hamming', () => {
  it('counts differing bits', () => {
    expect(hamming(macToBytes('AA:BB:CC:DD:EE:FF'), macToBytes('AA:BB:CC:DD:EE:FF'))).toBe(0);
    expect(hamming(macToBytes('AA:BB:CC:DD:EE:FF'), macToBytes('AA:BB:CC:DD:EE:FE'))).toBe(1);
  });

  it('refolds only with enough payload to prove something', () => {
    const t = new DeviceTable();
    t.apply(rec('86:69:93:F8:12:6F', AD_BASE), 1000, true);
    const entry = t.snapshot()[0];
    // too-short AD: proves nothing, must not fold
    expect(foldableInto(entry, macToBytes('86:69:93:FA:12:6F'), '0023E7A709')).toBe(false);
    // far MAC even with matching payload: must not fold
    expect(foldableInto(entry, macToBytes('86:69:93:01:12:6F'), AD_BASE)).toBe(false);
  });
});

describe('DeviceTable location', () => {
  const at = (lat: number, t: number) => ({lat, lon: -73.75, t, acc: 5});

  it('records first, last and strongest-sighting fixes', () => {
    const t = new DeviceTable();
    const mac = '00:25:DF:11:22:33';
    t.apply({...rec(mac, AD_BASE), pwr: 5}, 1000, false, at(42.1, 1000));
    t.apply({...rec(mac, AD_BASE), pwr: 30}, 2000, false, at(42.2, 2000));
    t.apply({...rec(mac, AD_BASE), pwr: 10}, 3000, false, at(42.3, 3000));
    t.apply({...rec(mac, AD_BASE), pwr: 10}, 4000, false, null); // no fix: keeps the old ones
    const [d] = t.snapshot();
    expect(d.firstFix?.lat).toBe(42.1);
    expect(d.bestFix?.lat).toBe(42.2);
    expect(d.lastFix?.lat).toBe(42.3);
    expect(d.lastPwr).toBe(10);
  });
});

describe('DeviceTable pruning', () => {
  it('keeps pinned MACs past the keep window', () => {
    const t = new DeviceTable();
    t.apply(rec('11:11:11:11:11:11', AD_BASE), 1000, false);
    t.apply(rec('22:22:22:22:22:22', AD_BASE.replace('E7', '17')), 1000, false);
    t.pruneOlderThan(100_000, 60_000, new Set(['22:22:22:22:22:22']));
    expect(t.snapshot().map(d => d.mac)).toEqual(['22:22:22:22:22:22']);
  });
});
