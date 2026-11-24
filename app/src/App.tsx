import React, {useCallback, useEffect, useState} from 'react';
import {BackHandler, Platform, Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View} from 'react-native';

import {Icon} from './components/Icon';
import {ensureChannels} from './notifications';
import {Route} from './routes';
import {LogsScreen} from './screens/LogsScreen';
import {ScanScreen} from './screens/ScanScreen';
import {SettingsScreen} from './screens/SettingsScreen';
import {useScanEngine} from './engine';
import {useThemedAppIcon} from './appIcon';
import {Theme, ThemeProvider, useTheme} from './theme';

const TITLES: Record<Route['name'], string> = {
  scan: 'Ultrasweeper Scanner',
  settings: 'Settings',
  logs: 'Hunt logs',
};

// Same shell as super-badger's app: one top bar, no tab bar. The scan screen
// is home; its gear opens Settings, and every other screen gets a back arrow
// (and Android back) that returns home.
function AppInner(): React.JSX.Element {
  const theme = useTheme();
  // Keeps the launcher icon in step with the theme (Android; see appIcon.ts).
  useThemedAppIcon();
  const [route, setRoute] = useState<Route>({name: 'scan'});

  // The scan session lives up here so opening Settings never drops the
  // connection or clears the device table.
  const engine = useScanEngine();

  // Create the notification channels up front so the first police alert
  // (or Test alert) doesn't wait on it; see notifications.ts.
  useEffect(() => {
    ensureChannels().catch(() => {});
  }, []);

  const navigate = useCallback((next: Route) => setRoute(next), []);
  const goBack = useCallback(() => navigate({name: 'scan'}), [navigate]);

  // Android back mirrors the header's back arrow; on the home screen the
  // system handles it as usual.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (route.name === 'scan') return false;
      goBack();
      return true;
    });
    return () => sub.remove();
  }, [route, goBack]);

  const styles = makeStyles(theme);
  const isHome = route.name === 'scan';

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle={theme.name === 'light' || theme.name === 'sepia' ? 'dark-content' : 'light-content'} />

      <View style={styles.header}>
        {!isHome && (
          <Pressable style={styles.headerBack} onPress={goBack} accessibilityLabel="Back" hitSlop={8}>
            <Icon name="chevron-left" size={22} color={theme.text} />
          </Pressable>
        )}

        <View style={styles.headerTextArea}>
          <Text style={styles.headerTitle} numberOfLines={1} accessibilityRole="header">
            {TITLES[route.name]}
          </Text>
        </View>

        {isHome && (
          <>
            <View
              style={styles.connectionBadge}
              accessibilityLabel={engine.connected ? 'Scanner connected' : 'No scanner connected'}>
              <View style={[styles.dot, {backgroundColor: engine.connected ? theme.success : theme.textMuted}]} />
              <Text style={styles.connectionText}>{engine.connected ? 'connected' : 'no scanner'}</Text>
            </View>
            <Pressable
              style={styles.headerIconButton}
              onPress={() => navigate({name: 'logs'})}
              accessibilityLabel="Hunt logs"
              hitSlop={4}>
              <Icon name="logs" size={20} color={theme.text} />
            </Pressable>
            <Pressable
              style={styles.headerIconButton}
              onPress={() => navigate({name: 'settings'})}
              accessibilityLabel="Settings"
              hitSlop={4}>
              <Icon name="gear" size={20} color={theme.text} />
            </Pressable>
          </>
        )}
      </View>

      <View style={styles.body}>
        {route.name === 'scan' && <ScanScreen engine={engine} />}
        {route.name === 'settings' && <SettingsScreen />}
        {route.name === 'logs' && <LogsScreen />}
      </View>
    </SafeAreaView>
  );
}

export default function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    root: {flex: 1, backgroundColor: theme.bg},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: theme.border,
    },
    headerBack: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      marginRight: 4,
      marginLeft: -6,
    },
    headerTextArea: {flex: 1, minWidth: 0},
    headerTitle: {fontSize: 16, fontWeight: '700', color: theme.text, flexShrink: 1},
    connectionBadge: {flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 4},
    dot: {width: 8, height: 8, borderRadius: 4},
    connectionText: {fontSize: 12, color: theme.textMuted},
    headerIconButton: {width: 32, height: 32, alignItems: 'center', justifyContent: 'center'},
    body: {flex: 1},
  });
}
