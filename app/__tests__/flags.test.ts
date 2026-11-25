// Flag matching rules (FLAGS.md v0): strong matchers hit alone, weak ones
// only as a full set; MAC matching tolerates the same air-glitch distance
// devices.ts folds on; pulls replace server records but never local ones.
import {
  FlagRecord,
  FlagsSnapshot,
  autoMatchers,
  effectiveScanFilter,
  matchDevice,
  matchDevicePayloads,
  matchLoggedDevice,
  matchFlag,
  matchedNotes,
  mergeServerRecords,
  parseRecord,
  pickLocalRecord,
  uploadUrl,
} from '../src/flags';
import {capNote, NOTE_MAX} from '../src/note';
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

describe('matchDevicePayloads (one advertisement at a time)', () => {
  const snap = {
    revision: 1,
    pulledAt: 0,
    server: [
      // both halves weak: the record only lands if one frame carries both
      {id: 'weak', flag: true, note: '', matchers: [{kind: 'company', value: '4C00'}, {kind: 'service', value: 'FE07'}]},
      {id: 'strong', flag: true, note: '', matchers: [{kind: 'eddy_uid', value: '11111111111111111111'}]},
    ],
    local: [] as FlagRecord[],
  };
  const named = cls({name: 'badge'});
  const eddystone = cls({eddystoneUids: ['11111111111111111111']});
  const mac = 'AA:BB:CC:DD:EE:01';

  it('a weak matcher set needs every matcher in one payload', () => {
    // company in one frame, service in the next: the scan screen would
    // never see them together, so the record must not land
    const split = matchDevicePayloads(snap as any, [named, cls({companyIds: [0x4c00]}), cls({serviceUuids: ['FE07']})], mac);
    expect(split.map(m => m.record.id)).toEqual([]);
    const together = matchDevicePayloads(snap as any, [cls({companyIds: [0x4c00], serviceUuids: ['FE07']})], mac);
    expect(together.map(m => m.record.id)).toEqual(['weak']);
  });

  it('a strong matcher hits from whichever payload carries it, once', () => {
    const hits = matchDevicePayloads(snap as any, [named, eddystone, eddystone, null], mac);
    expect(hits.map(m => m.record.id)).toEqual(['strong']);
  });
});

describe('matchLoggedDevice (map devices out of hunt logs)', () => {
  const parent = '54:92:6A:C4:6D:2D';
  const shard = '54:92:6A:C4:65:2D'; // 1 bit off, folded in by the map
  const record = (id: string, matchers: FlagRecord['matchers']): FlagRecord => ({id, flag: true, note: id, matchers});
  const snap = (server: FlagRecord[]) => ({revision: 1, pulledAt: 0, server, local: [] as FlagRecord[]});
  const dev = {mac: parent, name: '', payloads: [] as Classification[], aliases: [shard]};

  it('a flag on a folded shard MAC lands with glitch folding off', () => {
    // the scan screen lists the shard as its own device then, and a flag
    // made on that row names only the shard's address
    const s = snap([record('shard', [{kind: 'mac', value: shard}, {kind: 'company', value: '004C'}])]);
    expect(matchLoggedDevice(s, dev, {glitchTolerant: false}).map(m => m.record.id)).toEqual(['shard']);
    expect(matchLoggedDevice(s, {...dev, aliases: []}, {glitchTolerant: false})).toEqual([]);
    // and once, with tolerance on, where the parent MAC hits already
    expect(matchLoggedDevice(s, dev).map(m => m.record.id)).toEqual(['shard']);
  });

  it('a shard address only feeds exact mac matchers', () => {
    const s = snap([
      // 1 bit from the shard, 2 from the parent: a different device with
      // folding off
      record('near', [{kind: 'mac', value: '54:92:6A:C4:64:2D'}]),
      // weak-only: an OUI read off a bit-flipped address proves nothing
      record('oui', [{kind: 'oui', value: '54926A'}]),
    ]);
    const shardOnly = {...dev, mac: 'AA:BB:CC:DD:EE:FF'};
    expect(matchLoggedDevice(s, shardOnly, {glitchTolerant: false})).toEqual([]);
  });

  it('the logged name and the address still match with no AD capture', () => {
    const s = snap([record('name', [{kind: 'name', value: 'badge'}]), record('mac', [{kind: 'mac', value: parent}])]);
    const hits = matchLoggedDevice(s, {...dev, name: 'Badge', aliases: []});
    expect(hits.map(m => m.record.id)).toEqual(['name', 'mac']);
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

// ---- code-review regressions ----------------------------------------------

const MAC_A = 'AA:BB:CC:DD:EE:01';
const MAC_B = '5A:11:22:33:44:55';

describe('weak matchers next to strong ones never land a record', () => {
  it('flagging one Apple device does not flag every Apple device', () => {
    const iphone = cls({companyIds: [0x004c]});
    const r = rec('local-x', autoMatchers(iphone, MAC_A));
    expect(r.matchers).toContainEqual({kind: 'company', value: '004C'});
    expect(matchFlag(r, iphone, MAC_A)).toEqual({kind: 'mac', value: MAC_A});
    // a different Apple device: same company id, unrelated MAC
    expect(matchFlag(r, cls({companyIds: [0x004c]}), MAC_B)).toBeNull();
  });

  it('a FE2C-only device does not flag every Fast Pair device', () => {
    const r = rec('local-y', autoMatchers(cls({serviceUuids: ['FE2C']}), MAC_A));
    expect(matchFlag(r, cls({serviceUuids: ['FE2C']}), MAC_B)).toBeNull();
  });

  it('weak-only records still match on the full set', () => {
    const r = rec('srv', [{kind: 'company', value: '004C'}]);
    expect(matchFlag(r, cls({companyIds: [0x004c]}), MAC_B)).toEqual({kind: 'company', value: '004C'});
  });
});

describe('mac glitch tolerance follows mergeGlitches', () => {
  it('exact MAC only when glitch merging is off', () => {
    const r = rec('a', [{kind: 'mac', value: MAC_A}]);
    expect(matchFlag(r, cls(), 'AA:BB:CC:DD:EC:01', {glitchTolerant: true})).not.toBeNull();
    expect(matchFlag(r, cls(), 'AA:BB:CC:DD:EC:01', {glitchTolerant: false})).toBeNull();
    expect(matchFlag(r, cls(), MAC_A, {glitchTolerant: false})).not.toBeNull();
  });
});

describe('128-bit service matchers', () => {
  const uuid = '6E400001-B5A3-F393-E0A9-E50E24DCCA9E';
  it('match serviceUuids128, with or without dashes', () => {
    const c = cls({serviceUuids128: [uuid]});
    expect(matchFlag(rec('a', [{kind: 'service', value: uuid}]), c, MAC_B)).not.toBeNull();
    expect(matchFlag(rec('a', [{kind: 'service', value: uuid.replace(/-/g, '').toLowerCase()}]), c, MAC_B)).not.toBeNull();
    expect(matchFlag(rec('a', [{kind: 'service', value: uuid}]), cls(), MAC_B)).toBeNull();
  });
  it('autoMatchers records them', () => {
    expect(autoMatchers(cls({serviceUuids128: [uuid]}), MAC_A)).toContainEqual({kind: 'service', value: uuid});
  });
});

describe('ownership is by held set, not id prefix', () => {
  it('matchDevice tags the source; pickLocalRecord ignores server local-… ids', () => {
    const spoof = rec(localFlagIdOf(MAC_A), [{kind: 'mac', value: MAC_A}]);
    const snap = {revision: 1, pulledAt: 0, server: [spoof], local: []};
    const hits = matchDevice(snap, cls(), MAC_A);
    expect(hits.map(h => h.source)).toEqual(['server']);
    expect(pickLocalRecord(hits, MAC_A)).toBeUndefined();
  });
  it('pickLocalRecord prefers the exact-MAC record, else any local hit', () => {
    const exact = rec(localFlagIdOf(MAC_B), [{kind: 'mac', value: MAC_B}]);
    const older = rec(localFlagIdOf(MAC_A), [{kind: 'mac', value: MAC_A}, {kind: 'name', value: 'Tile'}]);
    const c = cls({name: 'Tile'});
    expect(pickLocalRecord(matchDevice({revision: 0, pulledAt: null, server: [], local: [older, exact]}, c, MAC_B), MAC_B)).toBe(exact);
    expect(pickLocalRecord(matchDevice({revision: 0, pulledAt: null, server: [], local: [older]}, c, MAC_B), MAC_B)).toBe(older);
  });
});

describe('effectiveScanFilter', () => {
  const empty = {revision: 0, pulledAt: null, server: [], local: []};
  it('falls back to all when the Flagged tab is not offered', () => {
    expect(effectiveScanFilter('flagged', empty)).toBe('all');
    expect(effectiveScanFilter('police', empty)).toBe('police');
    const held = {...empty, local: [rec('l', [{kind: 'mac', value: MAC_A}])]};
    expect(effectiveScanFilter('flagged', held)).toBe('flagged');
  });
});

describe('uploadUrl derivation', () => {
  it('keeps a secret path prefix and the query string', () => {
    expect(uploadUrl('http://10.0.0.2:8788/k3x9q/flags')).toBe('http://10.0.0.2:8788/k3x9q/upload');
    expect(uploadUrl('https://host/flags?t=1')).toBe('https://host/upload?t=1');
    expect(uploadUrl('https://host/a/flags/#x')).toBe('https://host/a/upload');
  });
  it('refuses URLs that do not end in /flags instead of posting to them', () => {
    expect(() => uploadUrl('https://host/api')).toThrow(/must look like/);
    expect(() => uploadUrl('https://host/flagsx')).toThrow(/must look like/);
    expect(() => uploadUrl('host/flags')).toThrow(/must look like/);
  });
});

describe('store regressions', () => {
  let mod: typeof import('../src/flags');
  let storage: typeof import('@react-native-async-storage/async-storage').default;
  const KEY = 'ultrascanner.flags.v1';
  beforeEach(async () => {
    jest.isolateModules(() => {
      mod = require('../src/flags');
      storage = asyncStorageOf(require('@react-native-async-storage/async-storage'));
    });
    await storage.clear(); // the mock's backing map outlives module isolation
  });

  it('a toggle racing the first load is not overwritten by the stale read', async () => {
    const stored = {revision: 2, pulledAt: 1, server: [], local: [{id: 'local-OLD', flag: true, note: 'kept', matchers: [{kind: 'mac', value: MAC_B}]}]};
    await storage.setItem(KEY, JSON.stringify(stored));
    const real = storage.getItem;
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let calls = 0;
    storage.getItem = async (k: string) => {
      calls++;
      if (calls === 1) {
        await gate; // the mount-time load is slow
      }
      return real(k);
    };
    const mounting = mod.flagsStore.load();
    const toggling = mod.toggleLocalFlag(MAC_A, cls());
    release();
    await Promise.all([mounting, toggling]);
    expect(calls).toBe(1);
    const ids = mod.flagsStore.get().local.map(r => r.id);
    expect(ids).toEqual(['local-OLD', mod.localFlagId(MAC_A)]);
    const disk = JSON.parse((await real(KEY)) as string);
    expect(disk.local.map((r: FlagRecord) => r.id)).toEqual(ids);
  });

  it('stored records are validated: malformed ones are dropped, not crashed on', async () => {
    const good = {id: 'local-OK', flag: true, note: '', matchers: [{kind: 'mac', value: MAC_A}], updatedAt: '2026-11-01T00:00:00Z'};
    await storage.setItem(KEY, JSON.stringify({revision: 1, pulledAt: 1, server: [{id: 'future', flag: true, note: ''}], local: [good, 7]}));
    const snap = await mod.flagsStore.load();
    expect(snap.server).toEqual([]);
    expect(snap.local).toEqual([good]);
    expect(() => mod.matchDevice(snap, cls(), MAC_A)).not.toThrow();
  });

  it('row toggle after an address rotation flips the original record, no duplicate', async () => {
    const c = cls({name: 'Tile Mate'});
    await mod.toggleLocalFlag(MAC_A, c);
    await mod.setLocalNote(MAC_A, 'on the car', c);
    // same device, new random address, still matched by name
    await mod.toggleLocalFlag(MAC_B, c);
    let local = mod.flagsStore.get().local;
    expect(local).toHaveLength(1);
    expect(local[0]).toMatchObject({id: mod.localFlagId(MAC_A), flag: false, note: 'on the car'});
    await mod.setLocalNote(MAC_B, 'moved to the bike', c);
    local = mod.flagsStore.get().local;
    expect(local).toHaveLength(1);
    expect(local[0].note).toBe('moved to the bike');
  });

  it('setLocalNote stamps updatedAt on a new record', async () => {
    await mod.setLocalNote(MAC_A, 'fresh', cls());
    expect(mod.flagsStore.get().local[0].updatedAt).toEqual(expect.any(String));
  });

  it('an unchanged note is not written again (submit + end-editing)', async () => {
    await mod.toggleLocalFlag(MAC_A, cls());
    const id = mod.localFlagId(MAC_A);
    await mod.setLocalNoteById(id, 'once');
    const before = mod.flagsStore.get();
    const real = storage.setItem;
    let writes = 0;
    storage.setItem = async (k: string, v: string) => {
      writes++;
      return real(k, v);
    };
    await mod.setLocalNoteById(id, 'once');
    expect(writes).toBe(0);
    expect(mod.flagsStore.get()).toBe(before);
  });

  it('pull reports a JSON null / non-object body as "no flags array"', async () => {
    for (const body of [null, 3, 'x', []]) {
      global.fetch = jest.fn().mockResolvedValue({ok: true, json: async () => body}) as never;
      await expect(mod.pullFlags('https://host/flags')).rejects.toThrow('flags server: response has no flags array');
    }
    global.fetch = jest.fn().mockResolvedValue({ok: true, json: async () => JSON.parse('{')}) as never;
    await expect(mod.pullFlags('https://host/flags')).rejects.toThrow('flags server: response is not JSON');
  });

  it('pull and upload time out instead of hanging, and abort the request', async () => {
    const signals: AbortSignal[] = [];
    global.fetch = jest.fn((_url: string, init: RequestInit) => {
      signals.push(init.signal as AbortSignal);
      return new Promise(() => {}); // unreachable LAN host: never settles
    }) as never;
    await expect(mod.pullFlags('https://host/flags', 20)).rejects.toThrow(/flags server: no response after/);
    await expect(mod.uploadHuntFile('https://host/flags', 'pw', 'hunt.csv', 'x', 20)).rejects.toThrow(
      /upload server: no response after/,
    );
    expect(signals.map(s => s.aborted)).toEqual([true, true]);
  });

  it('upload posts to the prefixed /upload with a percent-encoded file name', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ok: true});
    global.fetch = fetchMock as never;
    await mod.uploadHuntFile('http://h/k3x9q/flags', 'pw', 'hunt 1.csv', 'x');
    expect(fetchMock.mock.calls[0][0]).toBe('http://h/k3x9q/upload');
    expect(fetchMock.mock.calls[0][1].headers['X-File-Name']).toBe('hunt%201.csv');
  });
});

describe('settings store load race', () => {
  it('a save racing the first load survives it', async () => {
    let settings!: typeof import('../src/settings');
    let storage!: typeof import('@react-native-async-storage/async-storage').default;
    jest.isolateModules(() => {
      settings = require('../src/settings');
      storage = asyncStorageOf(require('@react-native-async-storage/async-storage'));
    });
    await storage.setItem('ultrascanner.settings.v1', JSON.stringify({flagsUrl: 'http://old/flags'}));
    const real = storage.getItem;
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let calls = 0;
    storage.getItem = async (k: string) => {
      calls++;
      await gate;
      return real(k);
    };
    const first = settings.settingsStore.load();
    const second = settings.settingsStore.load().then(s => settings.settingsStore.save({...s, flagsUrl: 'http://new/flags'}));
    release();
    await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(settings.settingsStore.get().flagsUrl).toBe('http://new/flags');
  });
});

function localFlagIdOf(mac: string): string {
  return `local-${mac.replace(/:/g, '')}`;
}

/** the jest mock is CommonJS (no .default); the real module is ESM */
function asyncStorageOf(m: any) {
  return m.default ?? m;
}

describe('note caps (notes are stored within NOTE_MAX)', () => {
  it('a local note is capped when stored', async () => {
    let m!: typeof import('../src/flags');
    jest.isolateModules(() => {
      m = require('../src/flags');
    });
    await m.toggleLocalFlag('AA:BB:CC:DD:EE:09', cls());
    const id = m.localFlagId('AA:BB:CC:DD:EE:09');
    await m.setLocalNoteById(id, 'y'.repeat(NOTE_MAX + 100));
    expect(m.flagsStore.get().local[0].note).toHaveLength(NOTE_MAX);
  });
});

describe('matchedNotes (the full description shown for a picked device)', () => {
  const m1: FlagRecord['matchers'][number] = {kind: 'mac', value: 'AA:BB:CC:DD:EE:01'};
  const m2: FlagRecord['matchers'][number] = {kind: 'name', value: 'badge'};
  const rec = (id: string, note: string, matchers = [m1], flag = true): FlagRecord => ({id, flag, note, matchers});
  const snap = (server: FlagRecord[], local: FlagRecord[]): FlagsSnapshot => ({revision: 0, pulledAt: null, server, local});

  it('returns every flagged record\'s full note, on-phone records first', () => {
    const s = snap(
      [rec('s1', 'server says: the long-battery tag in the hall, with details')],
      [rec('local-aabbccddeeff01', 'my own note\nwith a second line', [m1, m2])],
    );
    expect(matchedNotes(matchDevice(s, cls({name: 'badge'}), 'AA:BB:CC:DD:EE:01'))).toEqual([
      'my own note\nwith a second line',
      'server says: the long-battery tag in the hall, with details',
    ]);
  });

  it('skips unflagged records and empty notes', () => {
    const s = snap([rec('s1', '  ', [m1]), rec('s2', 'off', [m1], false)], []);
    expect(matchedNotes(matchDevice(s, cls(), 'AA:BB:CC:DD:EE:01'))).toEqual([]);
  });

  it('the same note on two records is shown once', () => {
    const s = snap([rec('s1', 'same note')], [rec('local-aabbccddeeff01', 'same note')]);
    expect(matchedNotes(matchDevice(s, cls(), 'AA:BB:CC:DD:EE:01'))).toEqual(['same note']);
  });

  it('a server note longer than the cap arrives capped', () => {
    const parsed = parseRecord({
      id: 's1',
      flag: true,
      note: 'y'.repeat(NOTE_MAX + 50),
      matchers: [{kind: 'mac', value: 'AA:BB:CC:DD:EE:01'}],
      updated_at: '2026-11-24T00:00:00Z',
    })!;
    expect(parsed.note).toBe('y'.repeat(NOTE_MAX));
  });

  it('capNote counts UTF-16 units like the input limit, never splitting an emoji', () => {
    expect(capNote('🏷'.repeat(NOTE_MAX + 5))).toBe('🏷'.repeat(NOTE_MAX / 2));
    // a pair straddling the limit is dropped whole rather than cut in half
    const straddle = 'x'.repeat(NOTE_MAX - 1) + '🏷';
    expect(capNote(straddle)).toBe('x'.repeat(NOTE_MAX - 1));
  });
});
