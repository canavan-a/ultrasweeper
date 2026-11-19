// Police classifier rules. These frames are synthetic (no real patrol capture
// yet — see PLAN.md §1), built in the same layout the firmware forwards:
// [header][len][AdvA x6, LSB first][AD structures...].
import {classify} from '../src/lookup/adparse';
import {policeMatch} from '../src/lookup/police';

const APPLE_BLOB = '42211D0C3F9DEF7002011A17FF4C008908B322C0A803271B18160800EA798AA0';

function frame(mac: string, ...structures: string[]): string {
  const adva = mac.split(':').reverse().join('');
  const ad = structures.join('');
  const len = (6 + ad.length / 2).toString(16).padStart(2, '0');
  return `40${len}${adva}${ad}`;
}
const ad = (type: number, payloadHex: string) =>
  ((payloadHex.length / 2 + 1).toString(16).padStart(2, '0') + type.toString(16).padStart(2, '0')).toUpperCase() +
  payloadHex;
const name = (s: string) => ad(0x09, Buffer.from(s, 'ascii').toString('hex').toUpperCase());

function match(mac: string, ...structures: string[]) {
  return policeMatch(mac, classify(mac, frame(mac, ...structures)));
}

describe('policeMatch', () => {
  it('flags the Axon company ID even on a rotating random address', () => {
    const m = match('C3:11:22:33:44:55', ad(0xff, '4D030102'));
    expect(m).toMatchObject({label: 'Axon', confidence: 'likely'});
    expect(m!.reasons[0]).toContain('0x034D');
  });

  it('flags the Axon OUI on a public address', () => {
    const m = match('00:25:DF:01:02:03', ad(0x01, '06'));
    expect(m).toMatchObject({label: 'Axon', confidence: 'likely'});
  });

  it('marks public-safety vendor OUIs as possible, not likely', () => {
    expect(match('00:1D:96:01:02:03', ad(0x01, '06'))).toMatchObject({
      label: 'WatchGuard Video',
      confidence: 'possible',
    });
  });

  it('does not confuse same-named non-police vendors', () => {
    // WatchGuard Technologies (firewalls) and Axon Networks (ISP gear).
    expect(match('00:01:21:01:02:03', ad(0x01, '06'))).toBeNull();
    expect(match('84:70:03:01:02:03', ad(0x01, '06'))).toBeNull();
  });

  it('ignores the OUI on random addresses', () => {
    // 0x40 top bits = resolvable private address; the prefix proves nothing.
    expect(match('40:25:DF:01:02:03', ad(0x01, '06'))).toBeNull();
  });

  it('uses names: Axon/TASER likely, a bare "Body 3" only possible', () => {
    expect(match('C3:00:00:00:00:01', name('Axon Body 3'))).toMatchObject({confidence: 'likely'});
    expect(match('C3:00:00:00:00:02', name('TASER 7'))).toMatchObject({confidence: 'likely'});
    expect(match('C3:00:00:00:00:03', name('Body 3'))).toMatchObject({confidence: 'possible'});
    expect(match('C3:00:00:00:00:04', name('Somebody 3'))).toBeNull();
  });

  it('lets a likely rule outrank an earlier possible one', () => {
    const m = match('00:1D:96:01:02:03', name('Axon Body 3'));
    expect(m).toMatchObject({label: 'Axon', confidence: 'likely'});
    expect(m!.reasons).toHaveLength(2);
  });

  it('leaves ordinary devices alone', () => {
    const mac = '70:EF:9D:3F:0C:1D';
    expect(policeMatch(mac, classify(mac, APPLE_BLOB))).toBeNull();
  });
});
