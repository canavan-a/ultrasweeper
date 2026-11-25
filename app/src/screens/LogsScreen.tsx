// Logs: the hunt CSV files recorded on this phone (src/huntlog.ts), newest
// first, with their date and size. Each can be shared (Android share
// sheet), copied into Downloads, uploaded to the flags server (FLAGS.md,
// needs a server URL + upload password in Settings → Flags), or deleted.
import React, {useCallback, useEffect, useState} from 'react';
import {Alert, FlatList, Pressable, StyleSheet, Text, View} from 'react-native';

import {
  deleteLog,
  formatBytes,
  huntLogAvailable,
  huntLogStatus,
  listLogs,
  LogFile,
  onHuntLog,
  readLog,
  saveLogToDownloads,
  shareLog,
} from '../huntlog';
import {uploadHuntFile} from '../flags';
import {settingsStore} from '../settings';
import {useTheme} from '../theme';

const REFRESH_MS = 3000;

export function LogsScreen(): React.JSX.Element {
  const theme = useTheme();
  const styles = makeStyles(theme);
  const [files, setFiles] = useState<LogFile[] | null>(null);
  const [message, setMessage] = useState<{ok: boolean; text: string} | null>(null);
  // Upload is only offered when both endpoints are configured: the flags
  // server URL (it also serves /upload) and the upload password.
  const [uploadCfg, setUploadCfg] = useState(settingsStore.get());
  useEffect(() => settingsStore.subscribe(setUploadCfg), []);

  const refresh = useCallback(() => {
    listLogs()
      .then(setFiles)
      .catch(e => setMessage({ok: false, text: String(e?.message ?? e)}));
  }, []);

  // The file being recorded grows while you watch: refresh on each write,
  // and on a slow timer as a fallback.
  useEffect(() => {
    refresh();
    const off = onHuntLog(refresh);
    const t = setInterval(refresh, REFRESH_MS);
    return () => {
      off();
      clearInterval(t);
    };
  }, [refresh]);

  const report = (p: Promise<unknown>, ok?: (v: unknown) => string) =>
    p
      .then(v => {
        if (ok) setMessage({ok: true, text: ok(v)});
        refresh();
      })
      .catch(e => setMessage({ok: false, text: String(e?.message ?? e)}));

  const confirmDelete = (f: LogFile) =>
    Alert.alert(
      'Delete this log?',
      `${f.name} (${formatBytes(f.size)})${f.open ? '\n\nIt is being recorded now; recording stops for this hunt.' : ''}`,
      [
        {text: 'Cancel', style: 'cancel'},
        {text: 'Delete', style: 'destructive', onPress: () => report(deleteLog(f.name), () => `Deleted ${f.name}.`)},
      ],
    );

  const canUpload = !!uploadCfg.flagsUrl && !!uploadCfg.uploadPassword;
  const [uploading, setUploading] = useState<string | null>(null);
  const upload = (f: LogFile) => {
    setUploading(f.name);
    readLog(f.name)
      .then(body => uploadHuntFile(uploadCfg.flagsUrl, uploadCfg.uploadPassword, f.name, body))
      .then(() => setMessage({ok: true, text: `Uploaded ${f.name} to the flags server.`}))
      .catch(e => setMessage({ok: false, text: String(e?.message ?? e)}))
      .finally(() => setUploading(null));
  };

  if (!huntLogAvailable()) {
    return (
      <View style={styles.empty}>
        <Text style={styles.emptyTitle}>Logs are not available</Text>
        <Text style={styles.emptyText}>Hunt logs are written by the Android app.</Text>
      </View>
    );
  }

  const total = (files ?? []).reduce((n, f) => n + f.size, 0);
  const recording = huntLogStatus().name;

  return (
    <View style={styles.container}>
      <Text style={styles.summary}>
        {files == null
          ? 'Loading…'
          : `${files.length} log${files.length === 1 ? '' : 's'} · ${formatBytes(total)} on this phone`}
      </Text>
      {message ? <Text style={message.ok ? styles.okText : styles.errorText}>{message.text}</Text> : null}
      {!canUpload ? (
        <Text style={styles.muted}>
          To upload hunt files to a server, set the flags server URL and upload
          password in Settings → Flags.
        </Text>
      ) : null}
      <FlatList
        data={files ?? []}
        keyExtractor={f => f.name}
        style={styles.list}
        renderItem={({item}) => (
          <View style={[styles.card, item.open && styles.cardOpen]}>
            <View style={styles.rowHeader}>
              <Text style={styles.cardTitle}>{started(item.name) ?? item.name}</Text>
              <Text style={styles.size}>{formatBytes(item.size)}</Text>
            </View>
            <Text style={styles.mono}>{item.name}</Text>
            <Text style={styles.muted}>
              {item.open || item.name === recording
                ? 'recording now'
                : `last written ${new Date(item.modified).toLocaleString()}`}
            </Text>
            <View style={styles.actions}>
              <Pressable style={[styles.button, styles.primaryButton]} onPress={() => report(shareLog(item.name))}>
                <Text style={[styles.buttonText, styles.primaryButtonText]}>Share</Text>
              </Pressable>
              <Pressable
                style={styles.button}
                onPress={() => report(saveLogToDownloads(item.name), where => `Saved to ${where}.`)}>
                <Text style={styles.buttonText}>Save to Downloads</Text>
              </Pressable>
              <Pressable
                style={[styles.button, !canUpload && styles.buttonDisabled]}
                onPress={() => upload(item)}
                disabled={!canUpload || uploading !== null}
                accessibilityLabel={`Upload ${item.name} to the flags server`}>
                <Text style={styles.buttonText}>{uploading === item.name ? 'Uploading…' : 'Upload'}</Text>
              </Pressable>
              <Pressable style={[styles.button, styles.dangerButton]} onPress={() => confirmDelete(item)}>
                <Text style={[styles.buttonText, styles.dangerButtonText]}>Delete</Text>
              </Pressable>
            </View>
          </View>
        )}
        ListEmptyComponent={
          files ? (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>No hunts recorded yet</Text>
              <Text style={styles.emptyText}>
                Connect the scanner with "Record hunts to CSV" on (Settings → Hunts); each connection becomes one
                file here.
              </Text>
            </View>
          ) : null
        }
      />
    </View>
  );
}

/** "hunt_2026-11-23_22-15-04.csv" -> a readable local date/time. */
function started(name: string): string | null {
  const m = /^hunt_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.csv$/.exec(name);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return d.toLocaleString();
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    container: {flex: 1, padding: 12, gap: 8},
    summary: {fontSize: 13, fontWeight: '600', color: theme.textMuted},
    list: {flex: 1},
    card: {
      backgroundColor: theme.surface,
      borderRadius: 8,
      padding: 12,
      marginBottom: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
    },
    cardOpen: {borderLeftWidth: 4, borderLeftColor: theme.success},
    rowHeader: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8},
    cardTitle: {fontSize: 15, fontWeight: '600', color: theme.text, flexShrink: 1},
    size: {fontSize: 15, fontWeight: '700', color: theme.text, fontVariant: ['tabular-nums']},
    mono: {fontSize: 12, color: theme.codeText, fontFamily: 'monospace', marginTop: 2},
    muted: {fontSize: 12, color: theme.textMuted, marginTop: 2},
    actions: {flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 10},
    button: {
      borderRadius: 8,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: theme.border,
      backgroundColor: theme.bg,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    buttonText: {fontSize: 13, color: theme.text},
    buttonDisabled: {opacity: 0.4},
    primaryButton: {backgroundColor: theme.primary, borderColor: theme.primary},
    primaryButtonText: {color: theme.primaryText},
    dangerButton: {backgroundColor: theme.dangerBg, borderColor: theme.danger},
    dangerButtonText: {color: theme.danger},
    okText: {fontSize: 12, color: theme.textMuted},
    errorText: {fontSize: 12, color: theme.danger},
    empty: {padding: 24, alignItems: 'center', gap: 8},
    emptyTitle: {fontSize: 15, fontWeight: '600', color: theme.text},
    emptyText: {fontSize: 13, color: theme.textMuted, textAlign: 'center'},
  });
}
