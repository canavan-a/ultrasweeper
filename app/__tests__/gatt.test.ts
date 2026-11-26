// GATT probe result interpretation (src/gatt.ts). The native side only
// moves bytes; everything a hunter reads off a probe comes from these
// pure functions. The synthetic results below are shaped exactly like
// what GattProbeModule.kt resolves — a real Govee-format identity tree
// and an SP6-style vendor-service answer.
import {
  decodeGattText,
  gattProbeErrorText,
  ProbeResult,
  summarizeProbe,
} from '../src/gatt';

describe('decodeGattText', () => {
  it('decodes printable ASCII', () => {
    expect(decodeGattText('476f766565204c616273')).toBe('Govee Labs');
  });

  it('rejects odd-length, binary, and empty-ish payloads', () => {
    expect(decodeGattText('476f7')).toBeNull();
    expect(decodeGattText('ff00ee')).toBeNull(); // firmware revisions aren't labels
    expect(decodeGattText('')).toBeNull();
    expect(decodeGattText(undefined)).toBeNull();
    expect(decodeGattText('2020')).toBeNull(); // whitespace only
  });
});

describe('summarizeProbe', () => {
  const DI = '0000180a-0000-1000-8000-00805f9b34fb';

  it('pulls identity labels out of a Device Information tree', () => {
    const r: ProbeResult = {
      address: 'C4:11:2D:33:44:55',
      services: [
        {
          uuid: '00001800-0000-1000-8000-00805f9b34fb',
          characteristics: [
            {uuid: '00002a00-0000-1000-8000-00805f9b34fb', properties: ['read'], valueHex: '476f76656520446576'},
          ],
        },
        {
          uuid: DI.toUpperCase(), // Android prints these uppercase; must still match
          characteristics: [
            {uuid: '00002a29-0000-1000-8000-00805f9b34fb', properties: ['read'], valueHex: '476f766565204c616273'},
            {uuid: '00002a24-0000-1000-8000-00805f9b34fb', properties: ['read'], valueHex: '47303130'},
            {uuid: '00002a26-0000-1000-8000-00805f9b34fb', properties: ['read'], valueHex: '010203'}, // binary: not a label
            {uuid: '00002a50-0000-1000-8000-00805f9b34fb', properties: ['read'], valueHex: '01090014ef2736'},
            {uuid: '00002a25-0000-1000-8000-00805f9b34fb', properties: ['read']}, // read failed
          ],
        },
      ],
    };
    const s = summarizeProbe(r);
    expect(s.identity).toEqual([
      {label: 'manufacturer', value: 'Govee Labs'},
      {label: 'model', value: 'G010'},
      {label: 'PnP ID', value: '01:09:00:14:ef:27:36'},
    ]);
    expect(s.serviceNames).toEqual(['GAP', 'Device Information']);
    expect(s.readCount).toBe(5); // everything that came back, labels or not
  });

  it('names vendor services and keeps non-identity reads out of the labels', () => {
    // SP6-style answer: a private FFE0 service and nothing standard.
    const r: ProbeResult = {
      address: 'D8:30:CC:11:22:33',
      services: [
        {
          uuid: '0000ffe0-0000-1000-8000-00805f9b34fb',
          characteristics: [
            {uuid: '0000ffe1-0000-1000-8000-00805f9b34fb', properties: ['read', 'write'], valueHex: '535036'},
          ],
        },
      ],
      truncated: 'read-timeout',
    };
    const s = summarizeProbe(r);
    expect(s.identity).toEqual([]);
    expect(s.serviceNames).toEqual(['service FFE0']);
    expect(s.readCount).toBe(1);
  });

  it('shortens non-base 128-bit uuids to their leading word', () => {
    const r: ProbeResult = {
      address: 'AA:BB:CC:DD:EE:FF',
      services: [{uuid: '06aa1910-f22a-11e3-9daa-0002a5d5c51b', characteristics: []}],
    };
    expect(summarizeProbe(r).serviceNames).toEqual(['service 06AA1910']);
  });
});

describe('gattProbeErrorText', () => {
  it('explains every native reject code', () => {
    expect(gattProbeErrorText('not-found')).toContain('drive closer');
    expect(gattProbeErrorText('connect-refused')).toContain('refused');
    expect(gattProbeErrorText('no-permission')).toContain('Nearby devices');
  });

  it('passes unknown codes through rather than swallowing them', () => {
    expect(gattProbeErrorText('some-new-code')).toBe('some-new-code');
  });
});
