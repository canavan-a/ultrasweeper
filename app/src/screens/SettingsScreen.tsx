// Settings: themes, launcher icon, scanner behavior, and the sideload
// updater — same section layout and controls as super-badger's app.
import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Switch, Text, View} from 'react-native';

import {
  compareVersions,
  DowngradeBlockedError,
  fetchReleases,
  getVersionInfo,
  onDownloadProgress,
  Release,
  runUpdate,
} from '../appUpdater';
import {settingsStore, Settings} from '../settings';
import {THEME_OPTIONS, ThemeName, useTheme} from '../theme';

const BAUD_OPTIONS = [
  {value: 921600, label: '921600 (firmware default)'},
  {value: 115200, label: '115200 (compat)'},
];

const KEEP_OPTIONS = [
  {value: 60, label: '1 minute'},
  {value: 300, label: '5 minutes'},
  {value: 3600, label: '1 hour'},
  {value: 86400, label: '24 hours'},
];

export function SettingsScreen(): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const [settings, setSettings] = useState<Settings>(settingsStore.get());

  useEffect(() => settingsStore.subscribe(setSettings), []);

  const update = (patch: Partial<Settings>) => {
    settingsStore.save({...settingsStore.get(), ...patch});
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
      <Section title="Appearance">
        <Text style={styles.label}>Theme</Text>
        <View style={styles.optionRow}>
          {THEME_OPTIONS.map(opt => (
            <Choice
              key={opt.name}
              active={settings.themeName === opt.name}
              label={opt.label}
              onPress={() => update({themeName: opt.name as ThemeName})}
            />
          ))}
        </View>
        <Toggle
          label="Match launcher icon to theme"
          help="Android switches the app's home-screen icon to the current theme's colors."
          value={settings.themedIcon}
          onValueChange={v => update({themedIcon: v})}
        />
      </Section>

      <Section title="Scanning">
        <Text style={styles.label}>Serial baud rate</Text>
        <Text style={styles.help}>
          Must match SCANNER_BAUD in the firmware build. Only change this if the
          bridge chip can't keep up at 921600 (garbled PROTO lines).
        </Text>
        <View style={styles.optionRow}>
          {BAUD_OPTIONS.map(opt => (
            <Choice
              key={opt.value}
              active={settings.scanBaud === opt.value}
              label={opt.label}
              onPress={() => update({scanBaud: opt.value})}
            />
          ))}
        </View>
        <Toggle
          label="Fold air-glitch duplicates"
          help="Single-bit CRC:S copies of a device (common over the air) are merged into the original instead of listed as a second device."
          value={settings.mergeGlitches}
          onValueChange={v => update({mergeGlitches: v})}
        />
        <Text style={styles.label}>Keep devices for</Text>
        <View style={styles.optionRow}>
          {KEEP_OPTIONS.map(opt => (
            <Choice
              key={opt.value}
              active={settings.keepSeconds === opt.value}
              label={opt.label}
              onPress={() => update({keepSeconds: opt.value})}
            />
          ))}
        </View>
      </Section>

      <UpdaterSection />

      <Text style={styles.footer}>
        Ultrasweeper Scanner — reads the scanner box over USB serial (PROTOCOL.md
        v1). All interpretation happens here on the phone.
      </Text>
    </ScrollView>
  );
}

function UpdaterSection(): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const [current, setCurrent] = useState<string>('');
  const [releases, setReleases] = useState<Release[] | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getVersionInfo()
      .then(v => setCurrent(v.versionName))
      .catch(() => setCurrent('unknown'));
    const off = onDownloadProgress(p => {
      if (p.bytesTotal > 0) {
        setStatus(`downloading… ${Math.round((p.bytesDownloaded / p.bytesTotal) * 100)}%`);
      }
    });
    return off;
  }, []);

  const check = () => {
    setError(null);
    setStatus('checking GitHub Releases…');
    fetchReleases()
      .then(rs => {
        setReleases(rs);
        setStatus(null);
      })
      .catch(e => {
        setStatus(null);
        setError(String(e?.message ?? e));
      });
  };

  const install = async (rel: Release) => {
    setError(null);
    setStatus('downloading…');
    try {
      await runUpdate(rel);
      setStatus('installer should be opening');
    } catch (e) {
      setStatus(null);
      if (e instanceof DowngradeBlockedError) {
        setError('Android refused the downgrade — this build is newer than the release.');
      } else {
        setError(String((e as Error)?.message ?? e));
      }
    }
  };

  return (
    <Section title="Updates">
      <Text style={styles.help}>
        Installed version: {current || 'unknown'} — updates are sideloaded APKs
        published as GitHub Releases, not an app store.
      </Text>
      <Pressable style={[styles.button, styles.primaryButton]} onPress={check}>
        <Text style={[styles.buttonText, styles.primaryButtonText]}>Check for updates</Text>
      </Pressable>
      {status ? <Text style={styles.help}>{status}</Text> : null}
      {error ? <Text style={styles.errorText}>{error}</Text> : null}
      {releases?.length === 0 ? <Text style={styles.help}>No releases published yet.</Text> : null}
      {(releases ?? [])
        .filter(r => compareVersions(r.version, current) > 0)
        .map(r => (
          <View key={r.tag} style={styles.releaseRow}>
            <View style={styles.releaseInfo}>
              <Text style={styles.releaseTitle}>Version {r.version}</Text>
              <Text style={styles.help}>{new Date(r.publishedAt).toLocaleDateString()}</Text>
            </View>
            <Pressable style={[styles.button, styles.primaryButton]} onPress={() => install(r)}>
              <Text style={[styles.buttonText, styles.primaryButtonText]}>Install</Text>
            </Pressable>
          </View>
        ))}
    </Section>
  );
}

function Section({title, children}: {title: string; children: React.ReactNode}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Choice({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <Pressable
      onPress={onPress}
      style={[styles.choice, active && styles.choiceActive]}
      accessibilityRole="radio"
      accessibilityState={{selected: active}}>
      <Text style={[styles.choiceText, active && styles.choiceTextActive]}>{label}</Text>
    </Pressable>
  );
}

function Toggle({
  label,
  help,
  value,
  onValueChange,
}: {
  label: string;
  help: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  return (
    <View style={styles.toggleRow}>
      <View style={styles.toggleText}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.help}>{help}</Text>
      </View>
      <Switch value={value} onValueChange={onValueChange} />
    </View>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    scroll: {flex: 1},
    content: {padding: 12, gap: 16},
    section: {
      backgroundColor: theme.surface,
      borderRadius: 10,
      padding: 14,
      gap: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    sectionTitle: {fontSize: 13, fontWeight: '700', color: theme.textMuted},
    label: {fontSize: 14, color: theme.text, fontWeight: '600'},
    help: {fontSize: 12, color: theme.textMuted},
    errorText: {fontSize: 12, color: theme.danger},
    optionRow: {flexDirection: 'row', flexWrap: 'wrap', gap: 6},
    choice: {
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    choiceActive: {backgroundColor: theme.primary, borderColor: theme.primary},
    choiceText: {fontSize: 13, color: theme.text},
    choiceTextActive: {color: theme.primaryText},
    toggleRow: {flexDirection: 'row', alignItems: 'center', gap: 12},
    toggleText: {flex: 1},
    button: {
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      paddingHorizontal: 16,
      paddingVertical: 10,
      alignSelf: 'flex-start',
    },
    buttonText: {fontSize: 13, color: theme.text},
    primaryButton: {backgroundColor: theme.primary, borderColor: theme.primary},
    primaryButtonText: {color: theme.primaryText},
    releaseRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingTop: 10,
    },
    releaseInfo: {flex: 1},
    releaseTitle: {fontSize: 14, fontWeight: '600', color: theme.text},
    footer: {fontSize: 11, color: theme.textMuted, textAlign: 'center', paddingBottom: 24},
  });
}
