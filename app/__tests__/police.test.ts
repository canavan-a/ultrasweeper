// Police classifier rules. These frames are synthetic (no real patrol capture
// yet — see PLAN.md §1), built in the same layout the firmware forwards:
// [header][len][AdvA x6, LSB first][AD structures...].
import {classify} from '../src/lookup/adparse';
import {policeMatch} from '../src/lookup/police';

const APPLE_BLOB = '42211D0C3F9DEF7002011A17FF4C008908B322C0A803271B18160800EA798AA0';

// Header TxAdd (0x40) follows the address shape unless a test says otherwise,
// as a real device's header would.
function frame(mac: string, ...structures: string[]): string {
  return frameWith(mac, (parseInt(mac.slice(0, 2), 16) & 0xc0) !== 0, ...structures);
}
function frameWith(mac: string, random: boolean, ...structures: string[]): string {
  const adva = mac.split(':').reverse().join('');
  const ad = structures.join('');
  const len = (6 + ad.length / 2).toString(16).padStart(2, '0');
  return `${random ? '40' : '00'}${len}${adva}${ad}`;
}
const ad = (type: number, payloadHex: string) =>
  ((payloadHex.length / 2 + 1).toString(16).padStart(2, '0') + type.toString(16).padStart(2, '0')).toUpperCase() +
  payloadHex;
const name = (s: string) => ad(0x09, Buffer.from(s, 'ascii').toString('hex').toUpperCase());

function match(mac: string, ...structures: string[]) {
  const f = frame(mac, ...structures);
  return policeMatch(mac, classify(mac, f), f);
}
const ascii = (s: string) => Buffer.from(s, 'ascii').toString('hex').toUpperCase();

describe('policeMatch', () => {
  it('flags the Axon company ID with a serial payload, even on a random address', () => {
    const m = match('C3:11:22:33:44:55', ad(0xff, '4D0302' + Buffer.from('X870054FW').toString('hex').toUpperCase()));
    expect(m).toMatchObject({label: 'Axon', confidence: 'likely'});
    expect(m!.reasons[0]).toContain('0x034D');
  });

  it('treats 0x034D without the serial shape as only possible', () => {
    expect(match('C3:11:22:33:44:60', ad(0xff, '4D030102'))).toMatchObject({confidence: 'possible'});
  });

  it('decodes the real BWCDEVICE advert (tag reversed inside a 128-bit UUID)', () => {
    // On-air bytes reported by All Cameras Are Beacons: flags, then AD 0x21
    // whose UUID reads "AXJANUSBWCDEVICE" big-endian, then payload 01.
    const m = match('D8:1F:65:01:02:03', '020106', '1221454349564544435742535 54E414A584101'.replace(/ /g, ''));
    expect(m).toMatchObject({label: 'Axon body camera', confidence: 'likely'});
  });

  it('flags the METROPOLISDEVICE tag as a possible Axon device', () => {
    const f = '020106' + '1221' + '45434956454453494C4F504F5254454D' + '01' + '0512A0002003';
    expect(match('C3:22:33:44:55:66', f)).toMatchObject({label: 'Axon device', confidence: 'possible'});
  });

  it('reads the address type from the header, not the address shape', () => {
    // D8:1F:65 looks random-static by its top bits but is a public Axon block.
    const mac = 'D8:1F:65:0A:0B:0C';
    expect(policeMatch(mac, classify(mac, frameWith(mac, false, ad(0x01, '06'))))).toMatchObject({confidence: 'likely'});
    expect(policeMatch(mac, classify(mac, frameWith(mac, true, ad(0x01, '06'))))).toBeNull();
  });

  it('flags Axon service UUIDs as service data or in a service list', () => {
    // FE6B service data (UUID little-endian on air), random address
    expect(match('C3:11:22:33:44:56', ad(0x16, '6BFE0102'))).toMatchObject({label: 'Axon', confidence: 'likely'});
    // FE6C in a complete 16-bit service UUID list
    expect(match('C3:11:22:33:44:57', ad(0x03, '0F186CFE'))!.reasons).toContain('Axon service UUID FE6C');
    expect(match('C3:11:22:33:44:58', ad(0x03, '81FC'))).toMatchObject({confidence: 'likely'});
  });

  it('no longer treats 0xFC81 as a company ID', () => {
    expect(match('C3:11:22:33:44:59', ad(0xff, '81FC0102'))).toBeNull();
  });

  it('flags the BWCDEVICE body-cam tag, even in 128-bit service data', () => {
    const uuid128 = '00112233445566778899AABBCCDDEEFF';
    const m = match('C3:11:22:33:44:5A', ad(0x21, uuid128 + ascii('BWCDEVICE')));
    expect(m).toMatchObject({label: 'Axon body camera', confidence: 'likely'});
    // a tag cut off by the 32-byte capture doesn't count
    expect(match('C3:11:22:33:44:5B', ad(0x21, uuid128 + ascii('BWCDEV')))).toBeNull();
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

  it('flags Flock Safety battery and Raven signatures', () => {
    expect(match('C3:00:00:00:01:01', name('FS Ext Battery'))).toMatchObject({label: 'Flock Safety', confidence: 'likely'});
    expect(match('C3:00:00:00:01:02', name('Penguin-0123456789'))).toMatchObject({confidence: 'likely'});
    // battery 128-bit service UUID, little-endian on air
    const le = 'E8CCBB38953246A89FE51814DF172E6F'.match(/../g)!.reverse().join('');
    expect(match('C3:00:00:00:01:03', ad(0x07, le))).toMatchObject({label: 'Flock Safety', confidence: 'likely'});
    expect(match('C3:00:00:00:01:04', ad(0x03, '0031'))).toMatchObject({
      label: 'Flock Raven (gunshot sensor)',
      confidence: 'likely',
    });
  });

  it('needs the Flock module ID to trust an FS- name, and not the reverse', () => {
    expect(match('C3:00:00:00:02:01', name('FS-BEC46A'))).toMatchObject({confidence: 'possible'});
    expect(match('C3:00:00:00:02:02', name('FS-BEC46A'), ad(0xff, 'C8090000'))).toMatchObject({confidence: 'likely'});
    expect(match('C3:00:00:00:02:03', ad(0xff, 'C8090000'))).toMatchObject({confidence: 'possible'});
    expect(match('C3:00:00:00:02:04', name('FS-100'))).toBeNull();
    // removed upstream as a phone false positive
    expect(match('C3:00:00:00:02:05', name('0102000000'))).toBeNull();
  });

  it('flags Motorola capture-only IDs as possible', () => {
    expect(match('C3:00:00:00:03:01', ad(0xff, 'EC040000'))).toMatchObject({label: 'Motorola Solutions', confidence: 'possible'});
    expect(match('C3:00:00:00:03:02', ad(0x03, '8EFD'))).toMatchObject({confidence: 'possible'});
  });

  it('flags Yardarm holster sensors as likely and Tait radios as possible', () => {
    expect(match('C3:00:00:00:04:01', ad(0xff, '5F020000'))).toMatchObject({label: 'Yardarm holster/firearm sensor', confidence: 'likely'});
    expect(match('C3:00:00:00:04:02', ad(0xff, '8F080000'))).toMatchObject({label: 'Tait radio', confidence: 'possible'});
  });

  it('flags i-PRO, Tait and Cradlepoint address blocks as possible', () => {
    // D4's top bits look "random", but the header marks it public, as real hardware does
    const ipro = 'D4:2D:C5:00:00:01';
    const f = frameWith(ipro, false, ad(0x01, '06'));
    expect(policeMatch(ipro, classify(ipro, f), f)).toMatchObject({label: 'i-PRO', confidence: 'possible'});
    expect(match('00:0D:CA:00:00:01', ad(0x01, '06'))).toMatchObject({confidence: 'possible'});
    expect(match('00:30:44:00:00:01', ad(0x01, '06'))).toMatchObject({label: 'Cradlepoint (vehicle router)', confidence: 'possible'});
  });

  it('counts old Raven services only as the pair, and only as possible', () => {
    expect(match('C3:00:00:00:05:01', ad(0x03, '09181918'))).toMatchObject({label: 'Flock Raven (gunshot sensor)', confidence: 'possible'});
    expect(match('C3:00:00:00:05:02', ad(0x03, '0918'))).toBeNull(); // a plain health thermometer
  });

  it('does not treat Openpath door readers (FE04) as Motorola', () => {
    expect(match('C3:00:00:00:06:01', ad(0x03, '04FE'))).toBeNull();
  });

  it('leaves ordinary devices alone', () => {
    const mac = '70:EF:9D:3F:0C:1D';
    expect(policeMatch(mac, classify(mac, APPLE_BLOB))).toBeNull();
  });
});
