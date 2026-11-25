// Settings: themes, launcher icon, scanner behavior, and the sideload
// updater — same section layout and controls as super-badger's app.
import React, {useEffect, useState} from 'react';
import {Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View} from 'react-native';

import {
  compareVersions,
  DowngradeBlockedError,
  fetchReleases,
  getVersionInfo,
  onDownloadProgress,
  Release,
  runUpdate,
} from '../appUpdater';
import {sendTestAlert} from '../alerts';
import {
  clearLocalFlags,
  clearServerFlags,
  deleteLocalFlag,
  describeMatchers,
  pullFlags,
  setLocalFlagById,
  setLocalNoteById,
  useFlagsSnapshot,
} from '../flags';
import type {FlagRecord} from '../flags';
import {requestNotificationPermission} from '../notifications';
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

      <AlertsSection settings={settings} update={update} />

      <HuntSection settings={settings} update={update} />

      <FlagsSection settings={settings} update={update} />

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

const ALERT_LEVELS = [
  {value: 'likely', label: 'Likely only (Axon)'},
  {value: 'possible', label: 'Likely + possible'},
] as const;

function AlertsSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const [status, setStatus] = useState<string | null>(null);

  // Turning anything notification-related on is the moment to ask for
  // Android 13+'s notification permission, and to say plainly if it's denied.
  const enable = (patch: Partial<Settings>) => {
    update(patch);
    requestNotificationPermission()
      .then(ok => setStatus(ok ? null : 'Notifications are blocked for this app — allow them in Android settings.'))
      .catch(() => {});
  };

  const test = () => {
    setStatus(null);
    requestNotificationPermission()
      .then(ok => {
        if (!ok) {
          setStatus('Notifications are blocked for this app — allow them in Android settings.');
          return;
        }
        return sendTestAlert();
      })
      .catch(e => setStatus(String(e?.message ?? e)));
  };

  return (
    <Section title="Police alerts">
      <Toggle
        label="Alert when police devices are heard"
        help="A notification the first time each matching device is heard. It alerts again only after the device has dropped off the list."
        value={settings.policeAlerts}
        onValueChange={v => (v ? enable({policeAlerts: v}) : update({policeAlerts: v}))}
      />
      {settings.policeAlerts ? (
        <>
          <Text style={styles.label}>Alert on</Text>
          <View style={styles.optionRow}>
            {ALERT_LEVELS.map(opt => (
              <Choice
                key={opt.value}
                active={settings.alertLevel === opt.value}
                label={opt.label}
                onPress={() => update({alertLevel: opt.value})}
              />
            ))}
          </View>
          <Toggle
            label="Chime"
            help="Three quick pings. Follows the phone's ringer: silent mode mutes it."
            value={settings.alertSound}
            onValueChange={v => update({alertSound: v})}
          />
          <Toggle
            label="Vibrate"
            help="Three short buzzes in time with the chime."
            value={settings.alertVibrate}
            onValueChange={v => update({alertVibrate: v})}
          />
          <Pressable style={styles.button} onPress={test}>
            <Text style={styles.buttonText}>Test alert</Text>
          </Pressable>
        </>
      ) : null}
      <Toggle
        label="Keep scanning in the background"
        help="While the scanner is plugged in, keep listening (and alerting) with the app closed or the screen off. Shows an ongoing notification and keeps the phone awake."
        value={settings.backgroundScan}
        onValueChange={v => (v ? enable({backgroundScan: v}) : update({backgroundScan: v}))}
      />
      {status ? <Text style={styles.errorText}>{status}</Text> : null}
    </Section>
  );
}

function HuntSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}): React.JSX.Element {
  return (
    <Section title="Hunts">
      <Toggle
        label="Tag sightings with my location"
        help="While a scanner is connected, record the phone's GPS position with every sighting, and show how far and which way each device was heard from where you are now."
        value={settings.locationEnabled}
        onValueChange={v => update({locationEnabled: v})}
      />
      <Toggle
        label="Record hunts to CSV"
        help="Each scanner connection is saved on this phone as its own timestamped CSV file: every sighting and GPS fix. Nothing is uploaded. Open Logs (the list icon on the scan screen) to see sizes, share, save to Downloads or delete."
        value={settings.recordHunts}
        onValueChange={v => update({recordHunts: v})}
      />
    </Section>
  );
}

function FlagsSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const flags = useFlagsSnapshot();
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pull = () => {
    setStatus(null);
    setBusy(true);
    pullFlags(settings.flagsUrl)
      .then(r => setStatus(`pulled ${r.count} flag record${r.count === 1 ? '' : 's'} (revision ${r.revision})`))
      .catch(e => setStatus(`pull failed: ${String((e as Error)?.message ?? e)}`))
      .finally(() => setBusy(false));
  };

  return (
    <Section title="Flags">
      <Text style={styles.help}>
        Flag records (FLAGS.md) mark devices worth a closer look. They match on
        what a device advertises — its Eddystone UID, name, MAC, company or
        service IDs — not just its address, so a flag survives the address
        rotation real devices do.
      </Text>
      <Text style={styles.label}>Flags server URL</Text>
      <Text style={styles.help}>
        The /flags endpoint to pull from, e.g. http://192.168.1.10:8787/flags —
        it also serves the hunt-file uploads below. Leave empty to keep this
        feature off.
      </Text>
      <TextInput
        style={styles.input}
        value={settings.flagsUrl}
        onChangeText={v => update({flagsUrl: v.trim()})}
        placeholder="http://…/flags"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />
      <Text style={styles.label}>Upload password</Text>
      <Text style={styles.help}>
        The key the server expects on uploads (X-Upload-Key). Used by the
        Upload button on the Logs screen; pulling needs no password.
      </Text>
      <TextInput
        style={styles.input}
        value={settings.uploadPassword}
        onChangeText={v => update({uploadPassword: v})}
        placeholder="upload key"
        placeholderTextColor={theme.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />
      <View style={styles.optionRow}>
        <Pressable
          style={[styles.button, styles.primaryButton, (!settings.flagsUrl || busy) && styles.buttonDisabled]}
          onPress={pull}
          disabled={!settings.flagsUrl || busy}>
          <Text style={[styles.buttonText, styles.primaryButtonText]}>{busy ? 'Pulling…' : 'Pull flags'}</Text>
        </Pressable>
        <Text style={styles.help}>
          {flags.pulledAt
            ? `${flags.server.length} from server (rev ${flags.revision}) · pulled ${new Date(flags.pulledAt).toLocaleString()}`
            : 'server set never pulled'}
          {' · '}
          {flags.local.length} made on this phone
        </Text>
      </View>
      <Text style={styles.help}>
        A pull replaces the local copy of the server set wholesale; flags you
        made on this phone are never touched by it.
      </Text>
      {status ? <Text style={styles.errorText}>{status}</Text> : null}
      {[...flags.local, ...flags.server].map(rec => (
        <FlagRow key={`${rec.id}`} rec={rec} />
      ))}
      {flags.local.length + flags.server.length === 0 ? (
        <Text style={styles.help}>No flag records held. Flag a device from its row on the scan screen.</Text>
      ) : null}
      <View style={styles.optionRow}>
        {flags.local.length > 0 ? (
          <Pressable style={styles.button} onPress={() => clearLocalFlags()}>
            <Text style={styles.buttonText}>Clear my flags</Text>
          </Pressable>
        ) : null}
        {flags.server.length > 0 ? (
          <Pressable style={styles.button} onPress={() => clearServerFlags()}>
            <Text style={styles.buttonText}>Clear server copy</Text>
          </Pressable>
        ) : null}
      </View>
    </Section>
  );
}

function FlagRow({rec}: {rec: FlagRecord}): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const [note, setNote] = useState(rec.note);
  const isLocal = rec.id.startsWith('local-');
  return (
    <View style={styles.flagRow}>
      <View style={styles.flagHead}>
        <Text style={styles.flagId}>{isLocal ? 'on this phone' : 'from server'}</Text>
        <Pressable
          style={[styles.choice, rec.flag && styles.choiceActive]}
          onPress={() => isLocal && setLocalFlagById(rec.id, !rec.flag)}>
          <Text style={[styles.choiceText, rec.flag && styles.choiceTextActive]}>
            {rec.flag ? 'flagged' : 'off'}
          </Text>
        </Pressable>
        {isLocal ? (
          <Pressable style={styles.choice} onPress={() => deleteLocalFlag(rec.id)}>
            <Text style={styles.choiceText}>delete</Text>
          </Pressable>
        ) : null}
      </View>
      <Text style={styles.mono}>{describeMatchers(rec)}</Text>
      {isLocal ? (
        <TextInput
          style={styles.input}
          value={note}
          onChangeText={setNote}
          placeholder="note…"
          placeholderTextColor={theme.textMuted}
          onSubmitEditing={() => setLocalNoteById(rec.id, note)}
          onEndEditing={() => setLocalNoteById(rec.id, note)}
        />
      ) : rec.note ? (
        <Text style={styles.flagNote}>{rec.note}</Text>
      ) : null}
    </View>
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
    input: {
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      paddingHorizontal: 10,
      paddingVertical: 8,
      fontSize: 13,
      color: theme.text,
    },
    mono: {fontSize: 12, color: theme.codeText, fontFamily: 'monospace'},
    flagRow: {
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      paddingTop: 10,
      gap: 4,
    },
    flagHead: {flexDirection: 'row', alignItems: 'center', gap: 8},
    flagId: {fontSize: 11, fontWeight: '700', color: theme.textMuted, flex: 1},
    flagNote: {fontSize: 12, color: theme.text},
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
    buttonDisabled: {opacity: 0.4},
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
