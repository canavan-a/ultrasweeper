// The scan screen: USB connect controls, live session stats, and the
// classified device list. All data comes from the engine (App.tsx owns it);
// this file is presentation only.
import React from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';

import type {ScanEngine, ViewDevice} from '../engine';
import {useTheme} from '../theme';

const CRC_LABEL: Record<string, string> = {'1': 'CRC', P: 'partial', S: 'struct'};

export function ScanScreen({engine}: {engine: ScanEngine}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);

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
  return (
    <View style={styles.container}>
      <View style={styles.statsRow}>
        <Stat label="devices" value={String(engine.view.length)} />
        <Stat label="batch" value={String(engine.batchCount)} />
        {st ? <Stat label="ok" value={String(st.ok)} /> : null}
        {st ? <Stat label="dup" value={String(st.dup)} /> : null}
        {st ? <Stat label="over" value={String(st.over)} /> : null}
      </View>
      <Text style={styles.muted}>
        {s ? `board ${s.id}  fw ${s.fw}  proto ${s.proto}` : 'waiting for PROTO=1 …'}
        {engine.parseErrors > 0 ? `   ${engine.parseErrors} unparsed lines` : ''}
      </Text>

      <FlatList
        data={engine.view}
        keyExtractor={d => d.mac}
        renderItem={({item}) => <DeviceRow item={item} />}
        style={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyTitle}>Listening…</Text>
            <Text style={styles.emptyText}>
              Connected. The scanner sweeps channels 37/38/39; devices appear as
              batches arrive.
            </Text>
          </View>
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

function Stat({label, value}: {label: string; value: string}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.stat}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function DeviceRow({item}: {item: ViewDevice}): React.JSX.Element {
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

  return (
    <View style={styles.card}>
      <View style={styles.rowHeader}>
        <Text style={styles.cardTitle} numberOfLines={1}>
          {title}
        </Text>
        <Text style={styles.count}>{item.sightings}</Text>
      </View>
      <Text style={styles.mono}>{item.mac}</Text>
      {sub ? <Text style={styles.muted}>{sub}</Text> : null}
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
    rowHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
    cardTitle: {fontSize: 15, fontWeight: '600', color: theme.text, flexShrink: 1},
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
  });
}
