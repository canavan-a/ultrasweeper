// The scan screen: USB connect controls, live session stats, and the
// classified device list. All data comes from the engine (App.tsx owns it);
// this file is presentation only.
import React, {useEffect, useState} from 'react';
import {FlatList, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';

import {formatAgo} from '../ago';
import {Icon} from '../components/Icon';
import type {ScanEngine, ViewDevice} from '../engine';
import {
  effectiveScanFilter,
  matchDevice,
  pickLocalRecord,
  setLocalNoteById,
  toggleLocalFlag,
  useFlagsSnapshot,
} from '../flags';
import type {MatchedFlag, MatchOptions} from '../flags';
import {NOTE_MAX} from '../note';
import {describeRelative, Fix, formatFix} from '../geo';
import {formatBytes} from '../huntlog';
import {STALE_MS} from '../location';
import {settingsStore, Settings, togglePinned} from '../settings';
import {useTheme} from '../theme';

const CRC_LABEL: Record<string, string> = {'1': 'CRC', P: 'partial', S: 'struct'};

/** A list row: a device, or a pinned MAC not heard since the app started. */
type Item = {key: string; pinned: boolean; device: ViewDevice | null; mac: string};

/** Re-render every `ms` so "last heard 12s ago" keeps counting. */
function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}


export function ScanScreen({engine}: {engine: ScanEngine}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const flags = useFlagsSnapshot();
  const [savedFilter, setFilter] = useState<Settings['scanFilter']>(settingsStore.get().scanFilter);
  const [pinned, setPinned] = useState<string[]>(settingsStore.get().pinnedMacs);
  const [mergeGlitches, setMergeGlitches] = useState(settingsStore.get().mergeGlitches);
  useEffect(
    () =>
      settingsStore.subscribe(s => {
        setFilter(s.scanFilter);
        setPinned(s.pinnedMacs);
        setMergeGlitches(s.mergeGlitches);
      }),
    [],
  );
  // a saved 'flagged' with no flag records held shows All (the tab is hidden)
  const filter = effectiveScanFilter(savedFilter, flags);
  // flag MAC matchers fold glitch twins only when the list does
  const matchOpts: MatchOptions = {glitchTolerant: mergeGlitches};
  const now = useNow(1000);
  const chooseFilter = (f: Settings['scanFilter']) => settingsStore.save({...settingsStore.get(), scanFilter: f});

  if (!engine.available) {
    // iOS or a dev build without the native module — say so plainly rather
    // than showing an empty picker.
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>USB serial is not available</Text>
        <Text style={styles.emptyText}>
          This app reads the scanner over USB Host on Android. On this platform
          there is nothing to connect to.
        </Text>
      </View>
    );
  }

  if (!engine.connected) {
    return (
      <View style={styles.container}>
        <Text style={styles.sectionTitle}>Scanner boards on USB</Text>
        {engine.devices.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>No serial device found</Text>
            <Text style={styles.emptyText}>
              Plug the scanner into the phone with a USB-C OTG adapter. If it is
              already plugged in, unlock the phone and re-plug — Android only
              grants USB permission to an unlocked screen.
            </Text>
            <Pressable style={styles.button} onPress={engine.refreshUsb}>
              <Text style={styles.buttonText}>Rescan USB</Text>
            </Pressable>
          </View>
        ) : (
          engine.devices.map(d => (
            <View key={d.deviceId} style={styles.card}>
              <Text style={styles.cardTitle}>{d.productName}</Text>
              <Text style={styles.muted}>
                VID {hex(d.vendorId)} PID {hex(d.productId)}
              </Text>
              <Pressable style={[styles.button, styles.primaryButton]} onPress={() => engine.connect(d.deviceId)}>
                <Text style={[styles.buttonText, styles.primaryButtonText]}>Connect</Text>
              </Pressable>
            </View>
          ))
        )}
        {engine.lastError ? <Text style={styles.error}>{engine.lastError}</Text> : null}
      </View>
    );
  }

  const s = engine.session;
  const st = engine.stats;
  const here = engine.fix && Date.now() - engine.fix.t < STALE_MS ? engine.fix : null;
  const policeCount = engine.view.filter(d => d.police).length;
  // Flag records (flags.ts) are matched at render time: the record set is
  // small, and both the filter and the rows need the result.
  const matched = new Map(engine.view.map(d => [d.mac, matchDevice(flags, d.cls, d.mac, matchOpts)]));
  const isFlagged = (mac: string) => (matched.get(mac) ?? []).some(m => m.record.flag);
  const flaggedCount = engine.view.filter(d => isFlagged(d.mac)).length;
  // Police matches float to the top (likely before possible), each group
  // still most-recent-first as the engine sorted it.
  const rank = (d: ViewDevice) => (!d.police ? 2 : d.police.confidence === 'likely' ? 0 : 1);
  const shown =
    filter === 'police'
      ? engine.view.filter(d => d.police)
      : filter === 'flagged'
      ? engine.view.filter(d => isFlagged(d.mac))
      : [...engine.view].sort((a, b) => rank(a) - rank(b));
  // Pinned devices sit on top in pin order, in either filter, even when
  // they have not been heard yet this session.
  const pinnedSet = new Set(pinned);
  const byMac = new Map(engine.view.map(d => [d.mac, d]));
  const items: Item[] = [
    ...pinned.map(mac => ({key: mac, pinned: true, device: byMac.get(mac) ?? null, mac})),
    ...shown.filter(d => !pinnedSet.has(d.mac)).map(d => ({key: d.mac, pinned: false, device: d, mac: d.mac})),
  ];
  const filters: [Settings['scanFilter'], string][] = [
    ['all', `All (${engine.view.length})`],
    ['police', `Police (${policeCount})`],
  ];
  // The flagged tab only appears once there is something to flag with —
  // server records pulled, or flags made on this phone.
  if (flags.server.length + flags.local.length > 0) {
    filters.push(['flagged', `Flagged (${flaggedCount})`]);
  }
  return (
    <View style={styles.container}>
      <View style={styles.statsRow}>
        <Stat label="devices" value={String(engine.view.length)} />
        <Stat label="police" value={String(policeCount)} alert={policeCount > 0} />
        <Stat label="batch" value={String(engine.batchCount)} />
        {st ? <Stat label="ok" value={String(st.ok)} /> : null}
        {st ? <Stat label="dup" value={String(st.dup)} /> : null}
        {st ? <Stat label="over" value={String(st.over)} /> : null}
      </View>
      <Text style={styles.muted}>
        {s ? `board ${s.id}  fw ${s.fw}  proto ${s.proto}` : 'waiting for PROTO=1 …'}
        {engine.parseErrors > 0 ? `   ${engine.parseErrors} unparsed lines` : ''}
      </Text>
      <HuntLine engine={engine} />
      {engine.corruptLines + engine.lostBatches + engine.reopens > 0 ? (
        <Text style={styles.warn}>
          {linkHealth(engine)}
        </Text>
      ) : null}

      <View style={styles.segment} accessibilityRole="tablist">
        {filters.map(([key, label]) => (
          <Pressable
            key={key}
            style={[styles.segmentTab, filter === key && styles.segmentTabActive]}
            onPress={() => chooseFilter(key)}
            accessibilityRole="tab"
            accessibilityState={{selected: filter === key}}>
            <Text style={[styles.segmentText, filter === key && styles.segmentTextActive]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <FlatList
        data={items}
        extraData={now}
        keyExtractor={it => it.key}
        renderItem={({item}) =>
          item.device ? (
            <DeviceRow
              item={item.device}
              matched={matched.get(item.mac) ?? []}
              matchOpts={matchOpts}
              here={here}
              pinned={item.pinned}
              now={now}
            />
          ) : (
            <MissingPinRow mac={item.mac} />
          )
        }
        style={styles.list}
        ListEmptyComponent={
          filter === 'police' ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No police devices heard</Text>
              <Text style={styles.emptyText}>
                Nothing in range matches the police rules (Axon body-cam tag,
                IDs and OUIs; Motorola Solutions; Flock Safety batteries and
                Raven; other public-safety vendor OUIs and names). Devices that
                rotate random addresses are only caught by their payload.
              </Text>
            </View>
          ) : filter === 'flagged' ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Nothing flagged here yet</Text>
              <Text style={styles.emptyText}>
                Pull the server set in Settings → Flags, or tap the flag on a
                device row to make one on this phone.
              </Text>
            </View>
          ) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>Listening…</Text>
              <Text style={styles.emptyText}>
                Connected. The scanner sweeps channels 37/38/39; devices appear as
                batches arrive.
              </Text>
            </View>
          )
        }
      />

      <View style={styles.actionRow}>
        <Pressable style={styles.button} onPress={engine.clear}>
          <Text style={styles.buttonText}>Clear list</Text>
        </Pressable>
        <Pressable style={[styles.button, styles.dangerButton]} onPress={engine.disconnect}>
          <Text style={[styles.buttonText, styles.dangerButtonText]}>Disconnect</Text>
        </Pressable>
      </View>
      {engine.lastError ? <Text style={styles.error}>{engine.lastError}</Text> : null}
    </View>
  );
}

function Stat({label, value, alert}: {label: string; value: string; alert?: boolean}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={[styles.stat, alert && styles.statAlert]}>
      <Text style={[styles.statValue, alert && styles.alertText]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function linkHealth(e: ScanEngine): string {
  const parts: string[] = [];
  if (e.corruptLines) parts.push(`${e.corruptLines} garbled line${e.corruptLines === 1 ? '' : 's'} skipped`);
  if (e.lostBatches) parts.push(`${e.lostBatches} batch${e.lostBatches === 1 ? '' : 'es'} lost`);
  if (e.reopens) parts.push(`${e.reopens} auto-reconnect${e.reopens === 1 ? '' : 's'}`);
  return `link: ${parts.join(' · ')}`;
}

/** One line of hunt status: phone location + the CSV being recorded. */
function HuntLine({engine}: {engine: ScanEngine}): React.JSX.Element | null {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const f = engine.fix;
  const fresh = f && Date.now() - f.t < STALE_MS;
  const loc =
    engine.locStatus === 'off'
      ? 'location off'
      : engine.locStatus === 'denied'
      ? 'location permission denied'
      : engine.locStatus === 'disabled' && !fresh
      ? 'location is switched off in Android'
      : fresh
      ? `GPS ${formatFix(f!)}`
      : 'waiting for a GPS fix…';
  const log = engine.log;
  const rec = log.lastError
    ? `log write failed: ${log.lastError}`
    : log.name
    ? `recording ${log.name} · ${formatBytes(log.bytes)}`
    : 'not recording';
  return (
    <Text style={[styles.muted, log.lastError ? styles.warn : null]} numberOfLines={2}>
      {loc} · {rec}
    </Text>
  );
}

function PinButton({mac, pinned}: {mac: string; pinned: boolean}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <Pressable
      onPress={() => togglePinned(mac)}
      hitSlop={10}
      style={styles.pinButton}
      accessibilityRole="button"
      accessibilityLabel={pinned ? `Unpin ${mac}` : `Pin ${mac} to the top`}>
      <Icon name={pinned ? 'pin-off' : 'pin'} size={16} color={pinned ? theme.primary : theme.textMuted} />
    </Pressable>
  );
}

/** A pinned MAC with no sighting since the app (re)started. */
function MissingPinRow({mac}: {mac: string}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={[styles.card, styles.cardPinned]}>
      <View style={styles.rowHeader}>
        <Text style={styles.pinTag}>PINNED</Text>
        <PinButton mac={mac} pinned />
      </View>
      <Text style={styles.mono}>{mac}</Text>
      <Text style={styles.muted}>Not heard this session yet.</Text>
    </View>
  );
}

function FlagButton({
  mac,
  cls,
  active,
  matchOpts,
}: {
  mac: string;
  cls: ViewDevice['cls'];
  active: boolean;
  matchOpts: MatchOptions;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <Pressable
      // flips whichever local record lands on this device (pickLocalRecord),
      // even one made under an earlier address, else creates one
      onPress={() => toggleLocalFlag(mac, cls, matchOpts)}
      hitSlop={10}
      style={styles.pinButton}
      accessibilityRole="button"
      accessibilityLabel={active ? `Unflag ${mac}` : `Flag ${mac} on this phone`}>
      <Icon name={active ? 'flag-off' : 'flag'} size={16} color={active ? theme.primary : theme.textMuted} />
    </Pressable>
  );
}

function DeviceRow({
  item,
  matched,
  matchOpts,
  here,
  pinned,
  now,
}: {
  item: ViewDevice;
  matched: MatchedFlag[];
  matchOpts: MatchOptions;
  here: Fix | null;
  pinned: boolean;
  now: number;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const cls = item.cls;
  const title = cls.name ?? cls.labels[0] ?? 'Unknown advertiser';
  const chips: string[] = [];
  for (const ch of [37, 38, 39]) {
    if (item.channels.has(ch)) {
      chips.push(String(ch));
    }
  }
  chips.push(CRC_LABEL[item.crc] ?? item.crc);
  if (item.glitchSightings > 0) {
    chips.push(`+${item.glitchSightings} glitch`);
  }
  const sub = [cls.vendor, ...cls.labels.filter(l => !cls.vendor || !l.startsWith(cls.vendor))]
    .filter(Boolean)
    .join(' · ');

  const police = item.police;
  const flagged = matched.some(m => m.record.flag);
  // notes are edited on the row only for a record made on this phone (the
  // one for this MAC, or one made under an earlier address that still
  // matches); server records are managed as a whole in Settings → Flags
  const localRecord = pickLocalRecord(matched, item.mac);
  const [note, setNote] = useState(localRecord?.note ?? '');
  // follow edits made elsewhere (Settings, delete/clear) so a later blur
  // here never writes stale text back over them
  const storedNote = localRecord?.note ?? '';
  useEffect(() => setNote(storedNote), [localRecord?.id, storedNote]);
  const age = now - item.lastSeen;
  // fresh: heard within the last few batches; stale: probably gone
  const ageStyle = age < 10_000 ? styles.ageFresh : age < 60_000 ? styles.ageRecent : styles.ageStale;
  return (
    <View
      style={[
        styles.card,
        police && styles.cardPolice,
        police?.confidence === 'possible' && styles.cardPolicePossible,
        pinned && styles.cardPinned,
        flagged && styles.cardFlagged,
      ]}>
      {pinned || police || flagged ? (
        <View style={styles.tagRow}>
          {pinned ? <Text style={styles.pinTag}>PINNED</Text> : null}
          {police ? (
            <Text style={styles.policeTag}>
              {police.confidence === 'likely' ? 'POLICE · likely' : 'POLICE · possible'} — {police.label}
            </Text>
          ) : null}
          {flagged ? (
            <Text style={styles.flagTag}>
              FLAGGED — {matched.filter(m => m.record.flag).map(m => m.hit.kind).join(' · ')}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View style={styles.rowHeader}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.count}>{item.sightings}×</Text>
        <FlagButton mac={item.mac} cls={cls} active={!!localRecord?.flag} matchOpts={matchOpts} />
        <PinButton mac={item.mac} pinned={pinned} />
      </View>
      <Text style={[styles.age, pinned && styles.agePinned, ageStyle]}>last heard {formatAgo(age)}</Text>
      <Text style={styles.mono}>{item.mac}</Text>
      {sub ? <Text style={styles.muted}>{sub}</Text> : null}
      {police ? <Text style={styles.muted}>{police.reasons.join(' · ')}</Text> : null}
      {matched
        .filter(m => m.record.note && m.record !== localRecord)
        .map(m => (
          <Text key={`${m.source}:${m.record.id}`} style={styles.flagNote}>
            ⚑ {m.record.note}
          </Text>
        ))}
      {localRecord ? (
        <TextInput
          style={styles.noteInput}
          value={note}
          onChangeText={setNote}
          maxLength={NOTE_MAX}
          placeholder="note for this flag…"
          placeholderTextColor={theme.textMuted}
          // return blurs a single-line input, so end-editing covers submit
          // too; one handler = one save
          onEndEditing={() => setLocalNoteById(localRecord.id, note)}
        />
      ) : null}
      {item.bestFix ? (
        <Text style={styles.where}>
          {here ? `strongest ${describeRelative(here, item.bestFix)}` : `strongest at ${formatFix(item.bestFix)}`}
          {item.lastFix && item.lastFix !== item.bestFix && here
            ? ` · last ${describeRelative(here, item.lastFix)}`
            : ''}
        </Text>
      ) : null}
      <View style={styles.chips}>
        {chips.map(c => (
          <Text key={c} style={styles.chip}>
            {c}
          </Text>
        ))}
      </View>
    </View>
  );
}

function hex(n: number): string {
  return `0x${n.toString(16).padStart(4, '0').toUpperCase()}`;
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    container: {flex: 1, padding: 12, gap: 8},
    sectionTitle: {fontSize: 13, fontWeight: '600', color: theme.textMuted},
    statsRow: {flexDirection: 'row', gap: 8},
    stat: {
      flex: 1,
      backgroundColor: theme.surface,
      borderRadius: 8,
      paddingVertical: 8,
      alignItems: 'center',
    },
    statAlert: {backgroundColor: theme.dangerBg},
    alertText: {color: theme.danger},
    statValue: {fontSize: 18, fontWeight: '700', color: theme.text},
    statLabel: {fontSize: 11, color: theme.textMuted},
    list: {flex: 1},
    card: {
      backgroundColor: theme.surface,
      borderRadius: 8,
      padding: 12,
      marginBottom: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    cardPolice: {borderLeftWidth: 4, borderLeftColor: theme.danger, borderColor: theme.danger},
    // weaker evidence: keep the accent stripe, drop the full red outline
    cardPolicePossible: {borderColor: theme.border},
    policeTag: {fontSize: 11, fontWeight: '700', color: theme.danger, marginBottom: 4, letterSpacing: 0.3, flexShrink: 1},
    cardPinned: {borderLeftWidth: 4, borderLeftColor: theme.primary},
    cardFlagged: {borderColor: theme.primary, borderWidth: 1},
    flagTag: {fontSize: 11, fontWeight: '700', color: theme.primary, marginBottom: 4, letterSpacing: 0.3, flexShrink: 1},
    flagNote: {fontSize: 12, color: theme.text, marginTop: 4},
    noteInput: {
      marginTop: 8,
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.surfaceAlt,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 13,
      color: theme.text,
    },
    tagRow: {flexDirection: 'row', gap: 8, alignItems: 'center'},
    pinTag: {fontSize: 11, fontWeight: '700', color: theme.primary, marginBottom: 4, letterSpacing: 0.3},
    pinButton: {paddingLeft: 10, paddingVertical: 2},
    age: {fontSize: 12, marginTop: 2, fontVariant: ['tabular-nums']},
    agePinned: {fontSize: 14, fontWeight: '700'},
    ageFresh: {color: theme.success},
    ageRecent: {color: theme.text},
    ageStale: {color: theme.textMuted},
    // Same segmented control as super-badger's Settings tabs.
    segment: {flexDirection: 'row', gap: 6, padding: 4, borderRadius: 10, backgroundColor: theme.surfaceAlt},
    segmentTab: {flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 8},
    segmentTabActive: {backgroundColor: theme.surface},
    segmentText: {fontSize: 13, fontWeight: '600', color: theme.textMuted},
    segmentTextActive: {color: theme.text},
    rowHeader: {flexDirection: 'row', alignItems: 'center', gap: 6},
    cardTitle: {fontSize: 15, fontWeight: '600', color: theme.text, flexShrink: 1, flexGrow: 1},
    count: {fontSize: 13, color: theme.textMuted, fontVariant: ['tabular-nums']},
    mono: {fontSize: 12, color: theme.codeText, fontFamily: 'monospace', marginTop: 2},
    muted: {fontSize: 12, color: theme.textMuted, marginTop: 2},
    chips: {flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 8},
    chip: {
      fontSize: 10,
      color: theme.textMuted,
      backgroundColor: theme.surfaceAlt,
      borderRadius: 4,
      paddingHorizontal: 6,
      paddingVertical: 2,
      overflow: 'hidden',
    },
    empty: {padding: 24, alignItems: 'center', gap: 8},
    emptyTitle: {fontSize: 15, fontWeight: '600', color: theme.text},
    emptyText: {fontSize: 13, color: theme.textMuted, textAlign: 'center'},
    actionRow: {flexDirection: 'row', gap: 8, marginTop: 8},
    button: {
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.surface,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignSelf: 'flex-start',
    },
    buttonText: {fontSize: 13, color: theme.text},
    primaryButton: {backgroundColor: theme.primary, borderColor: theme.primary},
    primaryButtonText: {color: theme.primaryText},
    dangerButton: {backgroundColor: theme.dangerBg, borderColor: theme.danger},
    dangerButtonText: {color: theme.danger},
    error: {fontSize: 12, color: theme.danger, marginTop: 4},
    warn: {fontSize: 12, color: theme.danger},
    where: {fontSize: 12, color: theme.text, marginTop: 4},
  });
}
