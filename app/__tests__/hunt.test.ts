import fs from 'fs';

import {analyzeHunt, combineHunts, estimate, huntLabel, macBitDistance, parseCsv} from '../src/hunt/analysis';
import {deviceColor, fanOffset} from '../src/hunt/color';
import {findUnusual} from '../src/hunt/unusual';
import {COLUMNS, csvRow} from '../src/huntlog';

// AD hex as logged: header, length, AdvA (LSB first), AD structures.
const advA = (mac: string) => mac.split(':').reverse().join('');
const AD_PUBLIC = (mac: string) => `0009${advA(mac)}020106`; // ADV_IND, public, flags only
// Apple Find My "separated" beacon (12 19 …), random address (TxAdd set)
const AD_FINDMY = (mac: string) => `4225${advA(mac)}1EFF4C001219${'00'.repeat(20)}`;

const BASE = 1_800_000_000_000;
function csv(rows: Record<string, string | number>[]): string {
  return COLUMNS.join(',') + '\r\n' + rows.map(r => csvRow(r)).join('');
}
const fix = (s: number, lat: number, lon: number) => ({unix_ms: BASE + s * 1000, kind: 'fix', lat, lon});
const seen = (s: number, mac: string, ad: string, lat = 42.7, lon = -73.8, extra: Record<string, string> = {}) => ({
  unix_ms: BASE + s * 1000,
  kind: 'sighting',
  mac,
  ad,
  lat,
  lon,
  ...extra,
});

describe('macBitDistance', () => {
  test('counts differing bits across both halves', () => {
    expect(macBitDistance('54:92:6A:C4:6D:2D', '54:92:6A:C4:6D:2D')).toBe(0);
    expect(macBitDistance('54:92:6A:C4:6D:2D', '54:92:6A:C4:65:2D')).toBe(1);
    expect(macBitDistance('54:92:6A:C4:6D:2D', '54:92:6A:D4:6D:2D')).toBe(1);
    expect(macBitDistance('00:00:00:00:00:00', 'FF:FF:FF:FF:FF:FF')).toBe(48);
  });
});

describe('analyzeHunt', () => {
  const loud = '54:92:6A:C4:6D:2D';
  const shard = '54:92:6A:C4:65:2D'; // 1 bit off
  const other = '54:92:6A:C4:6D:D2'; // many bits off: a different device
  const rows: Record<string, string | number>[] = [fix(0, 42.7, -73.8)];
  for (let i = 0; i < 12; i++) rows.push(seen(i, loud, AD_PUBLIC(loud), 42.7, -73.8, {name: 'net'}));
  rows.push(seen(5, shard, AD_PUBLIC(shard), 42.7, -73.8, {name: 'jet'}));
  rows.push(seen(5, other, AD_PUBLIC(other)), seen(6, other, AD_PUBLIC(other)));
  const hunt = analyzeHunt('hunt_2026-11-24_09-47-58.csv', parseCsv(csv(rows)));

  test('folds a 1-bit shard into the louder device heard at the same time', () => {
    expect(hunt.rawMacs).toBe(3);
    expect(hunt.merged).toBe(1);
    const d = hunt.devices.find(x => x.mac === loud)!;
    expect(d.n).toBe(13);
    expect(d.shards).toBe(1);
    expect(d.name).toBe('net'); // the common name wins over the bit-flipped one
    expect(hunt.devices.find(x => x.mac === other)?.n).toBe(2);
  });

  test('the map device lists the shard MACs folded into it', () => {
    const d = combineHunts([hunt]).find(x => x.mac === loud)!;
    expect(d.aliases).toEqual([shard]);
    expect(combineHunts([hunt]).find(x => x.mac === other)!.aliases).toEqual([]);
  });

  test('does not fold when folding is off', () => {
    const h = analyzeHunt('x', parseCsv(csv(rows)), {merge: false});
    expect(h.devices).toHaveLength(3);
  });

  test('does not fold a near MAC heard far apart in time', () => {
    const late = [...rows.filter(r => r.mac !== shard), seen(600, shard, AD_PUBLIC(shard))];
    expect(analyzeHunt('x', parseCsv(csv(late))).merged).toBe(0);
  });

  test('keeps REPORT POLICE rows as report anchors', () => {
    const withReports = [
      ...rows,
      {unix_ms: BASE + 20_000, kind: 'report', police: 'user', note: 'squad car at the park', lat: 42.700123, lon: -73.800456, acc_m: '8.0'},
      {unix_ms: BASE + 30_000, kind: 'report', note: 'no fix at the time'},
    ];
    const h = analyzeHunt('x', parseCsv(csv(withReports)));
    expect(h.devices.map(d => d.mac)).toContain(loud); // reports are not devices
    expect(h.reports).toEqual([
      {t: BASE + 20_000, lat: 42.700123, lon: -73.800456, note: 'squad car at the park'},
      {t: BASE + 30_000, lat: null, lon: null, note: 'no fix at the time'},
    ]);
  });
});

describe('combineHunts / estimate', () => {
  test('joins a MAC across hunts and estimates its spot', () => {
    const mac = 'AA:BB:CC:00:11:22';
    const a = analyzeHunt('a', parseCsv(csv([seen(0, mac, AD_PUBLIC(mac), 42.7, -73.8), seen(1, mac, AD_PUBLIC(mac), 42.7002, -73.8)])));
    const b = analyzeHunt('b', parseCsv(csv([seen(0, mac, AD_PUBLIC(mac), 42.7001, -73.8)])));
    const [d] = combineHunts([a, b]);
    expect(d.n).toBe(3);
    expect(d.hunts).toEqual(['a', 'b']);
    expect(d.est.lat).toBeCloseTo(42.7001, 6);
    expect(d.est.r).toBeGreaterThanOrEqual(15);
  });

  test('radius has a 15 m floor and grows with spread', () => {
    expect(estimate([{lat: 1, lon: 1}]).r).toBe(15);
    expect(estimate([{lat: 42.7, lon: -73.8}, {lat: 42.701, lon: -73.8}]).r).toBeCloseTo(55.7, 0);
  });

  test('sightings without a fix are left off the map', () => {
    const mac = 'AA:BB:CC:00:11:23';
    const h = analyzeHunt('a', parseCsv(csv([{unix_ms: BASE, kind: 'sighting', mac, ad: AD_PUBLIC(mac)}])));
    expect(combineHunts([h])).toHaveLength(0);
  });

  test('carries the re-classification onto combined map devices', () => {
    const tag = '7A:11:22:33:44:56';
    const h = analyzeHunt('a', parseCsv(csv([seen(0, tag, AD_FINDMY(tag), 42.7, -73.8), seen(1, tag, AD_FINDMY(tag), 42.7002, -73.8)])));
    const [d] = combineHunts([h]);
    expect(d.cls).not.toBeNull();
    expect(d.cls!.companyIds).toContain(0x4c); // Apple: a flag's company matcher can hit
  });

  test('keeps every distinct payload one MAC is seen with in one hunt', () => {
    // a beacon that alternates a bare advertisement and an Eddystone-UID
    // frame: the UID is rare, but a flag with an eddystone matcher must
    // still hit the device on the map - and only through the frame that
    // actually carried it, never merged with the other one
    const tag = '7A:11:22:33:44:58';
    const eddy = (mac: string) => {
      // the Eddystone-UID frame from the adparse tests: the declared PDU
      // length must cover it, or the parser treats it as truncated
      const ad = '0303AAFE1716AAFE00ED' + '11'.repeat(16);
      return `02${(ad.length / 2 + 8).toString(16).padStart(2, '0')}${advA(mac)}${ad}`;
    };
    const h = analyzeHunt(
      'a',
      parseCsv(csv([
        seen(0, tag, AD_PUBLIC(tag), 42.7, -73.8),
        seen(1, tag, AD_PUBLIC(tag), 42.7, -73.8),
        seen(2, tag, AD_PUBLIC(tag), 42.7002, -73.8),
        seen(3, tag, eddy(tag), 42.7002, -73.8),
      ])),
    );
    const [d] = combineHunts([h]);
    // description stays in the common payload
    expect(d.cls!.eddystoneUids).toEqual([]);
    // matching sees both frames, apart
    const [eddyCls] = d.payloads.map(p => p.cls).filter(c => c.eddystoneUids.length);
    expect(eddyCls.eddystoneUids).toEqual(['11111111111111111111']);
    expect(eddyCls.vendor).toBe('Google LLC');
    expect(d.payloads.map(p => p.cls).some(c => !c.eddystoneUids.length)).toBe(true);
  });

  test('a CRC-checked frame outranks bit-flipped copies of the same shape', () => {
    // nearly every record is CRC:S, and those are used - most real frames
    // arrive that way. But where the same advertisement form also passed a
    // CRC check, only that tier is sampled: a bit-corrupt copy seen once
    // must not add a name or UID the device never broadcasts
    const tag = '7A:11:22:33:44:59';
    const eddy = (mac: string) => {
      const ad = '0303AAFE1716AAFE00ED' + '22'.repeat(16);
      return `02${(ad.length / 2 + 8).toString(16).padStart(2, '0')}${advA(mac)}${ad}`;
    };
    const h = analyzeHunt(
      'a',
      parseCsv(csv([
        seen(0, tag, eddy(tag), 42.7, -73.8, {crc: '1'}),
        seen(1, tag, AD_PUBLIC(tag), 42.7, -73.8, {crc: '1'}),
        seen(2, tag, AD_PUBLIC(tag), 42.7002, -73.8, {crc: '1'}),
        seen(3, tag, AD_PUBLIC(tag), 42.7002, -73.8, {crc: '1'}),
        // a bit-flipped copy of an Eddystone UID that was never broadcast
        seen(4, tag, eddy(tag).replace('AAFE00ED', 'AAFE00EE'), 42.7002, -73.8, {crc: 'S'}),
      ])),
    );
    const [d] = combineHunts([h]);
    const uids = d.payloads.map(p => p.cls).flatMap(c => c.eddystoneUids);
    expect(uids).toEqual(['22222222222222222222']);
  });

  test('decodes one frame of each advertisement shape, not just the common ones', () => {
    // a phone rotating its counter bytes: hundreds of payloads that all
    // decode the same, plus the beacon frame it sends once. Ranking by
    // frequency alone would spend the whole budget on the counter copies
    // and never see the beacon frame the owner flagged
    const tag = '7A:11:22:33:44:60';
    const rows: Record<string, string | number>[] = [];
    for (let s = 0; s < 200; s++) {
      const ad = `4225${advA(tag)}1EFF4C001219${s.toString(16).padStart(4, '0')}${'00'.repeat(18)}`;
      rows.push(seen(s, tag, ad, 42.7, -73.8, {crc: '1'}));
    }
    const ed = '0303AAFE1716AAFE00ED' + '33'.repeat(16);
    rows.push(seen(900, tag, `02${(ed.length / 2 + 8).toString(16).padStart(2, '0')}${advA(tag)}${ed}`, 42.7, -73.8, {crc: '1'}));
    const [d] = combineHunts([analyzeHunt('a', parseCsv(csv(rows)))]);
    const uids = d.payloads.map(p => p.cls).flatMap(c => c.eddystoneUids);
    expect(uids).toEqual(['33333333333333333333']);
    // the counter copies all decode alike: one entry, not two hundred
    expect(d.payloads).toHaveLength(2);
  });

  test('unions payloads and names for one MAC across hunts', () => {
    // one hunt logs the tag with only flags, the other with a local name:
    // a name or company matcher must hit however the hunts are ordered
    const tag = '7A:11:22:33:44:57';
    // flags AD + Complete Local Name ('AirTag-9'), length bytes correct
    const AD_NAMED = (mac: string) => `0013${advA(mac)}0201060909${Buffer.from('AirTag-9').toString('hex')}`;
    const bare = analyzeHunt('bare', parseCsv(csv([seen(0, tag, AD_PUBLIC(tag), 42.7, -73.8), seen(1, tag, AD_PUBLIC(tag), 42.7002, -73.8)])));
    const named = analyzeHunt('named', parseCsv(csv([seen(0, tag, AD_NAMED(tag), 42.7001, -73.8), seen(1, tag, AD_NAMED(tag), 42.7002, -73.8)])));
    const beacon = analyzeHunt('beacon', parseCsv(csv([seen(0, tag, AD_FINDMY(tag), 42.7002, -73.8)])));
    for (const order of [
      [bare, named, beacon],
      [beacon, named, bare],
    ]) {
      const [d] = combineHunts(order);
      expect(d.n).toBe(5);
      // every hunt's evidence is available, and each stays inside its frame
      expect(d.payloads.map(p => p.cls).some(c => c.companyIds.includes(0x4c))).toBe(true); // Apple, from one hunt only
      expect(d.payloads.map(p => p.cls).some(c => c.name === 'AirTag-9')).toBe(true); // name, from another hunt only
    }
  });

  test('a rare frame survives a hunt that filled the payload list', () => {
    // one hunt's cap could otherwise crowd out the frame only the other
    // hunt heard, depending on the order the hunts are picked: the merge
    // takes turns between them
    const tag = '7A:11:22:33:44:61';
    const named = (n: number) => {
      // flags + Complete Local Name, one length per row: each is another
      // advertisement shape, so this hunt really has more payloads than the
      // cap keeps
      const name = 'x'.repeat(n);
      const ad = `020106${(n + 1).toString(16).padStart(2, '0')}09${Buffer.from(name).toString('hex')}`;
      return `00${(6 + ad.length / 2).toString(16).padStart(2, '0')}${advA(tag)}${ad}`;
    };
    const rows = Array.from({length: 15}, (_, i) => seen(i, tag, named(i + 1), 42.7, -73.8));
    const many = analyzeHunt('many', parseCsv(csv(rows)));
    expect(many.devices[0].payloads.length).toBe(12); // capped
    const ed = '0303AAFE1716AAFE00ED' + '33'.repeat(16);
    const beacon = analyzeHunt(
      'beacon',
      parseCsv(csv([seen(0, tag, `02${(ed.length / 2 + 8).toString(16).padStart(2, '0')}${advA(tag)}${ed}`, 42.7, -73.8)])),
    );
    for (const order of [
      [many, beacon],
      [beacon, many],
    ]) {
      const [d] = combineHunts(order);
      expect(d.payloads.length).toBeLessThanOrEqual(12);
      const uids = d.payloads.map(p => p.cls).flatMap(c => c.eddystoneUids);
      expect(uids).toEqual(['33333333333333333333']);
    }
  });

  test('a CRC-checked frame outranks a corrupt copy heard in another hunt', () => {
    // the tier rule reaches across hunts too: one hunt checked the frame's
    // CRC, the other only its structure and heard a bit-flipped UID - the
    // map must match the real UID, not the invented one
    const tag = '7A:11:22:33:44:62';
    const ed = '0303AAFE1716AAFE00ED' + '22'.repeat(16);
    const hex = `02${(ed.length / 2 + 8).toString(16).padStart(2, '0')}${advA(tag)}${ed}`;
    const checked = analyzeHunt(
      'checked',
      parseCsv(csv([seen(0, tag, hex, 42.7, -73.8, {crc: '1'})])),
    );
    const corrupt = analyzeHunt(
      'corrupt',
      parseCsv(csv([seen(0, tag, hex.replace('AAFE00ED', 'AAFE00EE'), 42.7, -73.8, {crc: 'S'})])),
    );
    for (const order of [
      [checked, corrupt],
      [corrupt, checked],
    ]) {
      const [d] = combineHunts(order);
      const uids = d.payloads.map(p => p.cls).flatMap(c => c.eddystoneUids);
      expect(uids).toEqual(['22222222222222222222']);
    }
  });

  test('a frequent frame keeps its sample despite corrupt one-off copies', () => {
    // a bit-flipped header or length byte makes one corrupt copy look like
    // a whole new advertisement shape; those must not crowd the real frame
    // out of the sample budget just because they sort by CRC tier and length
    const tag = '7A:11:22:33:44:63';
    // a whole Eddystone UID frame (namespace, instance, RFU), nothing cut
    const frame = (type: string, tail = '') => {
      const ed = `0303AAFE1716AAFE${type}ED${'44'.repeat(16)}0000${tail}`;
      return `02${(6 + ed.length / 2).toString(16).padStart(2, '0')}${advA(tag)}${ed}`;
    };
    const rows: Record<string, string | number>[] = [];
    for (let s = 0; s < 300; s++) {
      rows.push(seen(s, tag, frame('00'), 42.7, -73.8, {crc: 'S'}));
    }
    // thirty one-off copies with the frame type bit-flipped (no UID decodes
    // from them) and one more trailing structure each: all 'S', all longer
    // than the real frame, so a length-first order would spend every sample
    // on them even though none of them repeats
    for (let n = 1; n <= 30; n++) {
      const pad = `${(n + 1).toString(16).padStart(2, '0')}ff${'aa'.repeat(n)}`;
      rows.push(seen(1000 + n, tag, frame('20', pad), 42.7, -73.8, {crc: 'S'}));
    }
    const [d] = combineHunts([analyzeHunt('a', parseCsv(csv(rows)))]);
    const uids = d.payloads.map(p => p.cls).flatMap(c => c.eddystoneUids);
    expect(uids).toEqual(['44444444444444444444']);
  });

  test('a frame outranked in one shape is still kept from another shape', () => {
    // hunt A hears the name in two forms, both structure-only; hunt B
    // CRC-checks the first form, with other bytes. B's check outranks A's
    // copy of that form only - A's other form still carries the name, and
    // must not vanish because both of A's forms decoded alike
    const tag = '7A:11:22:33:44:65';
    const hex = (ad: string) => `00${(6 + ad.length / 2).toString(16).padStart(2, '0')}${advA(tag)}${ad}`;
    const name = (s: string) => `${(s.length + 1).toString(16).padStart(2, '0')}09${Buffer.from(s).toString('hex')}`;
    const a = analyzeHunt(
      'a',
      parseCsv(csv([
        ...[0, 1, 2, 3, 4].map(s => seen(s, tag, hex(`020106${name('Tag')}`), 42.7, -73.8, {crc: 'S'})),
        ...[5, 6].map(s => seen(s, tag, hex(name('Tag')), 42.7, -73.8, {crc: 'S'})),
      ])),
    );
    const b = analyzeHunt('b', parseCsv(csv([seen(0, tag, hex(`020106${name('Tbg')}`), 42.7, -73.8, {crc: '1'})])));
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const [d] = combineHunts(order);
      const names = d.payloads.map(p => p.cls.name);
      expect(names).toContain('Tag');
      expect(names).toContain('Tbg');
    }
  });

  test('a structure the capture cut short still tells shapes apart', () => {
    // FIFO truncation cuts the last AD structure short. A rotating Apple
    // frame and the beacon's Eddystone UID frame, both cut at the same
    // length, share every whole structure; if the cut-short one did not
    // count, both would be one shape and the rotating copies would take
    // every sample of it
    const tag = '7A:11:22:33:44:64';
    const rows: Record<string, string | number>[] = [];
    for (let r = 0; r < 5; r++) {
      const ad = `4225${advA(tag)}0201061AFF4C001219${r.toString(16).padStart(2, '0').repeat(10)}`;
      for (let k = 0; k < 10; k++) {
        rows.push(seen(r * 10 + k, tag, ad, 42.7, -73.8, {crc: 'S'}));
      }
    }
    rows.push(seen(100, tag, `4225${advA(tag)}0201061716AAFE00ED${'55'.repeat(10)}`, 42.7, -73.8, {crc: 'S'}));
    const [d] = combineHunts([analyzeHunt('a', parseCsv(csv(rows)))]);
    const uids = d.payloads.map(p => p.cls).flatMap(c => c.eddystoneUids);
    expect(uids).toEqual(['55555555555555555555']);
  });
});

describe('findUnusual', () => {
  test('flags an Apple Find My beacon away from its owner', () => {
    const tag = '7A:11:22:33:44:55';
    const h = analyzeHunt('a', parseCsv(csv([0, 1, 2].map(s => seen(s, tag, AD_FINDMY(tag))))));
    const u = findUnusual([h]).get(tag);
    expect(u?.reasons[0].tag).toBe('tracker');
    expect(u?.score).toBe(40);
  });

  test('police beats everything; everyday devices are not flagged', () => {
    const cop = '00:25:DF:00:00:01';
    const tv = '00:11:22:33:44:56';
    const h = analyzeHunt(
      'a',
      parseCsv(
        csv([
          seen(0, cop, AD_PUBLIC(cop), 42.7, -73.8, {police: 'Axon body camera'}),
          seen(1, cop, AD_PUBLIC(cop), 42.7, -73.8, {police: 'Axon body camera'}),
          seen(0, tv, AD_PUBLIC(tv)),
          seen(1, tv, AD_PUBLIC(tv)),
        ]),
      ),
    );
    const u = findUnusual([h]);
    expect(u.get(cop)?.score).toBeGreaterThanOrEqual(100);
    expect(u.has(tv)).toBe(false);
  });

  test('a modem-maker address prefix alone is weak evidence', () => {
    const g5 = 'CC:93:4A:42:6F:04';
    const rows = [0, 1, 2, 3, 4, 5].map(s => seen(s, g5, AD_PUBLIC(g5), 42.7, -73.8, {vendor: 'Sierra Wireless, ULC'}));
    expect(findUnusual([analyzeHunt('a', parseCsv(csv(rows)))]).has(g5)).toBe(false);
  });
});

describe('colors and labels', () => {
  test('device colors are stable and never in the police-red band', () => {
    expect(deviceColor('AA:BB:CC:DD:EE:FF', false)).toBe(deviceColor('AA:BB:CC:DD:EE:FF', false));
    for (let i = 0; i < 200; i++) {
      const hex = deviceColor(`00:00:00:00:${(i >> 8).toString(16)}:${(i & 255).toString(16)}`, false);
      const [r, g, b] = [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16));
      expect(r > 180 && g < 90 && b < 90).toBe(false);
    }
  });

  test('fan-out stays within 12 m', () => {
    const [dx, dy] = fanOffset('AA:BB:CC:DD:EE:FF', 42.7);
    const m = Math.hypot(dx * Math.cos((42.7 * Math.PI) / 180) * 111320, dy * 111320);
    expect(m).toBeGreaterThanOrEqual(4);
    expect(m).toBeLessThanOrEqual(12.01);
  });

  test('hunt labels', () => {
    expect(huntLabel('hunt_2026-11-24_09-47-58.csv')).toBe('11/24 09:47');
  });
});

// Opt-in check against a real field log (kept out of the repo: it holds
// locations). HUNT_CSV=/path/to/hunt_….csv npx jest hunt
const real = process.env.HUNT_CSV;
(real ? test : test.skip)('real hunt log: folding and scoring run', () => {
  const h = analyzeHunt('real', parseCsv(fs.readFileSync(real!, 'utf8')));
  const u = findUnusual([h]);
  // eslint-disable-next-line no-console
  console.log(`raw ${h.rawMacs} -> ${h.devices.length} devices (${h.merged} shards folded), ${u.size} unusual`);
  expect(h.devices.length).toBeLessThan(h.rawMacs);
});
