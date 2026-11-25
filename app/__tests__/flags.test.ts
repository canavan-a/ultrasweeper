// Flag matching rules (FLAGS.md v0): strong matchers hit alone, weak ones
// only as a full set; MAC matching tolerates the same air-glitch distance
// devices.ts folds on; pulls replace server records but never local ones.
import {
  FlagRecord,
  autoMatchers,
  matchDevice,
  matchFlag,
  mergeServerRecords,
  parseRecord,
  uploadUrl,
} from '../src/flags';
import type {Classification} from '../src/lookup/adparse';

function cls(over: Partial<Classification> = {}): Classification {
  return {
    labels: [],
    serviceUuids: [],
    serviceUuids128: [],
    companyIds: [],
    manufacturerData: [],
    eddystoneUids: [],
    randomAddress: false,
    ...over,
  };
}

function rec(id: string, matchers: FlagRecord['matchers'], flag = true): FlagRecord {
  return {id, flag, note: '', matchers};
}

describe('matchFlag', () => {
  it('exact MAC hits and reports the matcher', () => {
    const m = matchFlag(rec('a', [{kind: 'mac', value: 'AA:BB:CC:DD:EE:01'}]), cls(), 'AA:BB:CC:DD:EE:01');
    expect(m).toEqual({kind: 'mac', value: 'AA:BB:CC:DD:EE:01'});
  });

  it('MAC tolerates 2 glitched bits but not 3', () => {
    // EE=11101110: one bit flip -> EC (accept); three flips -> E0 (reject)
    const matcher = {kind: 'mac', value: 'AA:BB:CC:DD:EE:01'} as const;
    expect(matchFlag(rec('a', [matcher]), cls(), 'AA:BB:CC:DD:EC:01')).not.toBeNull();
    expect(matchFlag(rec('a', [matcher]), cls(), 'AA:BB:CC:DD:E0:01')).toBeNull();
  });

  it('name matches case-insensitively', () => {
    const m = matchFlag(rec('a', [{kind: 'name', value: 'Bosch QC Ultra Head'}]), cls({name: 'bosch qc ultra head'}), '11:22:33:44:55:66');
    expect(m).not.toBeNull();
  });

  it('company and service use normalized hex', () => {
    const c = cls({companyIds: [0xfd50], serviceUuids: ['FE2C']});
    expect(matchFlag(rec('a', [{kind: 'company', value: '0xfd50'}]), c, '11:22:33:44:55:66')).not.toBeNull();
    expect(matchFlag(rec('b', [{kind: 'service', value: 'fe2c'}]), c, '11:22:33:44:55:66')).not.toBeNull();
  });

  it('eddy_uid matches full uid or namespace prefix', () => {
    const c = cls({eddystoneUids: ['ABCDEF0123456789ABCD']}); // 10-hex ns ‖ 10-hex instance
    expect(matchFlag(rec('a', [{kind: 'eddy_uid', value: 'abcdef0123456789abcd'}]), c, '11:22:33:44:55:66')).not.toBeNull();
    expect(matchFlag(rec('b', [{kind: 'eddy_uid', value: 'ABCDEF0123'}]), c, '11:22:33:44:55:66')).not.toBeNull();
    expect(matchFlag(rec('c', [{kind: 'eddy_uid', value: 'DEADBEEF01'}]), c, '11:22:33:44:55:66')).toBeNull();
  });

  it('oui matches the high half of public addresses', () => {
    expect(matchFlag(rec('a', [{kind: 'oui', value: 'AABBCC'}]), cls(), 'AA:BB:CC:DD:EE:01')).not.toBeNull();
    expect(matchFlag(rec('a', [{kind: 'oui', value: 'AABBCC'}]), cls(), '11:22:33:44:55:66')).toBeNull();
  });

  it('weak-only matchers all must hit', () => {
    const c = cls({companyIds: [0xfd50]}); // service NOT present
    const weakOnly = rec('a', [{kind: 'company', value: 'FD50'}, {kind: 'service', value: 'FF90'}]);
    expect(matchFlag(weakOnly, c, '11:22:33:44:55:66')).toBeNull();
    const c2 = cls({companyIds: [0xfd50], serviceUuids: ['FF90']});
    expect(matchFlag(weakOnly, c2, '11:22:33:44:55:66')).not.toBeNull();
  });

  it('one strong matcher is enough even without the weak ones', () => {
    const r = rec('a', [{kind: 'name', value: 'Sonos Era 100'}, {kind: 'service', value: 'FE07'}]);
    expect(matchFlag(r, cls({name: 'Sonos Era 100'}), '11:22:33:44:55:66')).toEqual({kind: 'name', value: 'Sonos Era 100'});
  });
});

describe('matchDevice', () => {
  it('returns every hitting record from server and local sets', () => {
    const snap = {
      revision: 1,
      pulledAt: 0,
      server: [rec('srv-1', [{kind: 'service', value: 'FE07'}])],
      local: [rec('local-1', [{kind: 'name', value: 'Sonos Era 100'}])],
    };
    const hits = matchDevice(snap as any, cls({name: 'Sonos Era 100', serviceUuids: ['FE07']}), '11:22:33:44:55:66');
    expect(hits.map(h => h.record.id)).toEqual(['srv-1', 'local-1']);
    expect(hits[0].hit).toEqual({kind: 'service', value: 'FE07'});
  });
});

describe('autoMatchers', () => {
  it('includes the MAC plus everything the AD corroborates', () => {
    const ms = autoMatchers(
      cls({name: 'Govee Outdoor', companyIds: [0x8801], serviceUuids: ['FE2C'], eddystoneUids: ['112233445566778899AABBCC']}),
      'AA:BB:CC:DD:EE:01',
    );
    expect(ms).toContainEqual({kind: 'mac', value: 'AA:BB:CC:DD:EE:01'});
    expect(ms).toContainEqual({kind: 'name', value: 'Govee Outdoor'});
    expect(ms).toContainEqual({kind: 'service', value: 'FE2C'});
    expect(ms).toContainEqual({kind: 'company', value: '8801'});
  });
});

describe('local record management (store)', () => {
  // fresh module instance so the AsyncStorage-backed store starts clean
  let mod: typeof import('../src/flags');
  beforeEach(() => {
    jest.isolateModules(() => {
      mod = require('../src/flags');
    });
  });

  it('flag → note → unflag → delete round-trips on one device', async () => {
    const c = cls({name: 'Bose QC Ultra Headphones'});
    await mod.toggleLocalFlag('AA:BB:CC:DD:EE:01', c);
    const id = mod.localFlagId('AA:BB:CC:DD:EE:01');
    let snap = mod.flagsStore.get();
    expect(snap.local.map(r => r.id)).toEqual([id]);
    expect(snap.local[0].matchers).toContainEqual({kind: 'name', value: 'Bose QC Ultra Headphones'});

    await mod.setLocalNoteById(id, 'OTA over BLE');
    expect(mod.flagsStore.get().local[0].note).toBe('OTA over BLE');

    await mod.setLocalFlagById(id, false);
    expect(mod.flagsStore.get().local[0].flag).toBe(false);

    await mod.deleteLocalFlag(id);
    expect(mod.flagsStore.get().local).toEqual([]);
  });

  it('clears wipe one side only', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        revision: 3,
        flags: [{id: 'srv-1', flag: true, note: '', matchers: [{kind: 'name', value: 'X'}]}],
      }),
    }) as never;
    await mod.toggleLocalFlag('AA:BB:CC:DD:EE:01', cls());
    await mod.pullFlags('https://example.test/flags');
    expect(mod.flagsStore.get().server).toHaveLength(1);

    await mod.clearServerFlags();
    let snap = mod.flagsStore.get();
    expect(snap.server).toEqual([]);
    expect(snap.local).toHaveLength(1);

    await mod.clearLocalFlags();
    snap = mod.flagsStore.get();
    expect(snap.local).toEqual([]);
    expect(snap.server).toEqual([]);
  });
});

describe('uploadUrl', () => {
  it('derives /upload from the configured /flags URL', () => {
    expect(uploadUrl('https://host/flags')).toBe('https://host/upload');
    expect(uploadUrl('https://host/flags/')).toBe('https://host/upload');
  });
});

describe('parseRecord + mergeServerRecords', () => {
  it('drops records without usable matchers', () => {
    expect(parseRecord({id: 'x', flag: true, note: '', matchers: []})).toBeNull();
    expect(parseRecord({id: 'x', flag: true, note: '', matchers: [{kind: 'bogus', value: 'q'}]})).toBeNull();
    const ok = parseRecord({id: 'x', flag: true, note: 'hi', matchers: [{kind: 'name', value: 'Jarvis'}], updated_at: '2026-11-01T00:00:00Z'});
    expect(ok).toEqual({id: 'x', flag: true, note: 'hi', matchers: [{kind: 'name', value: 'Jarvis'}], updatedAt: '2026-11-01T00:00:00Z'});
  });

  it('pull replaces server records and keeps local ones', () => {
    const prev = {
      revision: 1,
      pulledAt: 0,
      server: [rec('srv-old', [{kind: 'name', value: 'gone'}])],
      local: [rec('local-mine', [{kind: 'mac', value: 'AA:BB:CC:DD:EE:01'}])],
    };
    const next = mergeServerRecords(prev as any, [rec('srv-new', [{kind: 'name', value: 'fresh'}])]);
    expect(next.server.map(r => r.id)).toEqual(['srv-new']);
    expect(next.local.map(r => r.id)).toEqual(['local-mine']);
  });
});
