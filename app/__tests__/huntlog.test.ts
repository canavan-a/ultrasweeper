import {NativeModules} from 'react-native';

import type * as HuntLog from '../src/huntlog';
import type {MacRecord} from '../src/protocol';

const written: string[] = [];
const native = {
  open: jest.fn(async (_name: string, header: string) => {
    written.push(header);
    return header.length;
  }),
  append: jest.fn(async (text: string) => {
    written.push(text);
    return written.join('').length;
  }),
  close: jest.fn(async () => null),
  list: jest.fn(async () => []),
  remove: jest.fn(async () => true),
  share: jest.fn(async () => null),
  saveToDownloads: jest.fn(async () => 'Download/ultrasweeper/x.csv'),
};

let log: typeof HuntLog;
beforeAll(() => {
  NativeModules.HuntLog = native;
  jest.isolateModules(() => {
    log = require('../src/huntlog');
  });
});

const flushPromises = () => new Promise(r => jest.requireActual('timers').setImmediate(r));

/** minimal CSV parser for the round-trip check (quotes, doubled quotes) */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let f = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') (f += '"'), i++;
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') row.push(f), (f = '');
    else if (c === '\n') row.push(f), rows.push(row), (row = []), (f = '');
    else if (c !== '\r') f += c;
  }
  return rows;
}

describe('csv helpers', () => {
  it('quotes only what needs quoting', () => {
    expect(log.csvField('plain')).toBe('plain');
    expect(log.csvField('a,b')).toBe('"a,b"');
    expect(log.csvField('say "hi"')).toBe('"say ""hi"""');
    expect(log.csvField(null)).toBe('');
    expect(log.csvField(NaN)).toBe('');
    expect(log.csvField(42)).toBe('42');
  });

  it('names files by local start time', () => {
    const t = new Date(2026, 10, 23, 22, 15, 4).getTime();
    expect(log.logName(t)).toBe('hunt_2026-11-23_22-15-04.csv');
    expect(log.localIso(t)).toMatch(/^2026-11-23T22:15:04\.000[+-]\d{2}:\d{2}$/);
  });

  it('formats sizes', () => {
    expect(log.formatBytes(512)).toBe('512 B');
    expect(log.formatBytes(1536)).toBe('1.5 KB');
    expect(log.formatBytes(3.5 * 1024 * 1024)).toBe('3.5 MB');
  });
});

describe('hunt log', () => {
  it('records a hunt as one CSV with a header and typed rows', async () => {
    jest.useFakeTimers();
    const t0 = new Date(2026, 10, 23, 22, 15, 4).getTime();
    const name = await log.startHuntLog(t0);
    expect(name).toBe('hunt_2026-11-23_22-15-04.csv');
    expect(log.huntLogStatus().name).toBe(name);

    const fix = {lat: 42.6526, lon: -73.7562, t: t0, acc: 4.2};
    log.logSession('D0EF7613EAA0', 'M1', t0);
    log.logFix(fix, t0 + 500);
    const rec: MacRecord = {type: 'mac', mac: '00:25:DF:11:22:33', pwr: 1, t: 1234, ch: 37, crc: 'S', ad: '4011'};
    log.logSighting(rec, t0 + 1000, fix, {vendor: 'Axon', name: null}, {
      label: 'Axon body camera',
      confidence: 'likely',
      reasons: ['Axon OUI', 'name "X, Y"'],
    });
    log.endHuntLog(t0 + 2000);
    jest.useRealTimers();
    await flushPromises();

    expect(native.close).toHaveBeenCalled();
    expect(log.huntLogStatus().name).toBeNull();
    const rows = parseCsv(written.join(''));
    const header = rows[0];
    expect(header).toEqual([...log.COLUMNS]);
    const byCol = (r: string[]) => Object.fromEntries(header.map((h, i) => [h, r[i]]));
    const kinds = rows.slice(1).map(r => byCol(r).kind);
    expect(kinds).toEqual(['session', 'session', 'fix', 'sighting', 'end']);
    const s = byCol(rows[4]);
    expect(s).toMatchObject({
      mac: '00:25:DF:11:22:33',
      pwr: '1',
      ch: '37',
      crc: 'S',
      board_ms: '1234',
      police: 'Axon body camera',
      confidence: 'likely',
      reasons: 'Axon OUI; name "X, Y"',
      lat: '42.6526000',
      acc_m: '4.2',
      fix_age_ms: '1000',
      ad: '4011',
    });
    // every row has every column
    expect(rows.every(r => r.length === header.length)).toBe(true);
  });

  it('writes nothing when no hunt is being recorded', () => {
    const before = written.length;
    log.logFix({lat: 1, lon: 2, t: 0});
    expect(written.length).toBe(before);
  });
});
