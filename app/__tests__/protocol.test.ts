// Parser tests against real bench output: the AD hex blobs below are
// actual captures from the M1 bench session (replay harness in
// /tmp/accept/cap.txt), assembled into the line format PROTOCOL.md
// specifies.
import {parseLine, StreamParser} from '../src/protocol';

const SESSION_LINE = 'PROTO=1 DEV:scanner-usb ID:D0EF7613EAA0 FW:M1';
const BANNER_LINE = 'BANNER:SCANNER A=37/39 B=38 BATCH=2000 STATS=10000 PIR=27';

// Apple continuity-style frame captured on the bench (0x42 header, company
// 0x004C, subdomain 0x89). AdvA in air order 1D:0C:3F:9D:EF:70.
const APPLE_BLOB = '42211D0C3F9DEF7002011A17FF4C008908B322C0A803271B18160800EA798AA0';

describe('parseLine', () => {
  it('parses the session line', () => {
    const r = parseLine(SESSION_LINE)!;
    expect(r).toMatchObject({
      type: 'session',
      proto: 1,
      dev: 'scanner-usb',
      id: 'D0EF7613EAA0',
      fw: 'M1',
    });
  });

  it('treats BANNER as a passthrough record, not an error', () => {
    expect(parseLine(BANNER_LINE)).toEqual({type: 'unknown', line: BANNER_LINE});
  });

  it('parses batch framing', () => {
    expect(parseLine('BATCH-START seq=7')).toEqual({type: 'batch-start', seq: 7, ovf: false});
    expect(parseLine('BATCH-START seq=8 ovf=1')).toEqual({type: 'batch-start', seq: 8, ovf: true});
    expect(parseLine('BATCH-END n=42')).toEqual({type: 'batch-end', n: 42});
  });

  it('parses a real MAC record', () => {
    const line = `MAC:70:EF:9D:3F:0C:1D PWR:19 T:200118 CH:37 CRC:S AD:${APPLE_BLOB}`;
    const r = parseLine(line)!;
    expect(r).toMatchObject({
      type: 'mac',
      mac: '70:EF:9D:3F:0C:1D',
      pwr: 19,
      t: 200118,
      ch: 37,
      crc: 'S',
      ad: APPLE_BLOB,
    });
  });

  it('parses PIR and STATS records', () => {
    expect(parseLine('PIR T:12345 DUR:2000')).toEqual({type: 'pir', t: 12345, dur: 2000});
    expect(parseLine('STATS T:999 RA:100 RB:98 OK:120 DUP:3400 OVER:0')).toMatchObject({
      type: 'stats',
      ok: 120,
      dup: 3400,
      over: 0,
    });
  });

  it('skips blank lines and passes unknown records through', () => {
    expect(parseLine('')).toBeNull();
    expect(parseLine('   ')).toBeNull();
    expect(parseLine('WIFI:AA:BB:CC:DD:EE:FF SSID:test')).toEqual({
      type: 'unknown',
      line: 'WIFI:AA:BB:CC:DD:EE:FF SSID:test',
    });
  });
});

describe('StreamParser', () => {
  it('reassembles lines split across arbitrary chunk boundaries', () => {
    const full = `${SESSION_LINE}\r\n${BANNER_LINE}\r\nBATCH-START seq=1\r\nMAC:70:EF:9D:3F:0C:1D PWR:19 T:1 CH:37 CRC:S AD:${APPLE_BLOB}\r\nBATCH-END n=1\r\n`;
    const p = new StreamParser();
    const records = [];
    // feed one byte at a time: no chunk boundary may matter
    for (let i = 0; i < full.length; i++) {
      records.push(...p.feed(full[i]));
    }
    expect(records.filter(r => r.type === 'session')).toHaveLength(1);
    expect(records.filter(r => r.type === 'mac')).toHaveLength(1);
    expect(records.filter(r => r.type === 'batch-end')).toHaveLength(1);
  });

  it('survives the startup garble from a wrong-baud ROM dump', () => {
    const p = new StreamParser();
    const out = p.feed('\u00ffýÀÀò\u0000some garble\r\n' + SESSION_LINE + '\r\n');
    const kinds = out.map(r => r.type);
    expect(kinds).toContain('unknown');
    expect(kinds).toContain('session');
  });

  it('accepts bare LF line endings', () => {
    const p = new StreamParser();
    const out = p.feed('STATS T:1 RA:1 RB:1 OK:1 DUP:0 OVER:0\n');
    expect(out[0]).toMatchObject({type: 'stats', ok: 1});
  });
});
