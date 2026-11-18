import React, {useCallback, useState} from 'react';
import {Pressable, SafeAreaView, StatusBar, StyleSheet, Text, View} from 'react-native';

import {Route} from './routes';
import {ScanScreen} from './screens/ScanScreen';
import {SettingsScreen} from './screens/SettingsScreen';
import {useScanEngine} from './engine';
import {useThemedAppIcon} from './appIcon';
import {ThemeProvider, useTheme} from './theme';

const TITLES: Record<Route['name'], string> = {
  scan: 'Ultrasweeper Scanner',
  settings: 'Settings',
};

// Two screens, one tab bar — the whole "router" is switching on the Route
// union (see routes.ts), same approach as super-badger's app.
function AppInner(): React.JSX.Element {
  const theme = useTheme();
  // Keeps the launcher icon in step with the theme (Android; see appIcon.ts).
  useThemedAppIcon();
  const [route, setRoute] = useState<Route>({name: 'scan'});

  // The scan session lives up here so opening Settings never drops the
  // connection or clears the device table.
  const engine = useScanEngine();

  const navigate = useCallback((next: Route) => setRoute(next), []);

  const styles = makeStyles(theme);

  return (
    <SafeAreaView style={styles.root}>
        <StatusBar barStyle={theme.name === 'light' || theme.name === 'sepia' ? 'dark-content' : 'light-content'} />
        <View style={styles.header}>
          <Text style={styles.headerTitle} accessibilityRole="header">
            {TITLES[route.name]}
          </Text>
          <View style={styles.connectionBadge}>
            <View
              style={[
                styles.dot,
                {backgroundColor: engine.connected ? theme.success : theme.textMuted},
              ]}
            />
            <Text style={styles.connectionText}>
              {engine.connected ? 'connected' : 'no scanner'}
            </Text>
          </View>
        </View>

        {route.name === 'scan' ? (
          <ScanScreen engine={engine} />
        ) : (
          <SettingsScreen />
        )}

        <View style={styles.tabBar}>
          {(['scan', 'settings'] as const).map(name => {
            const active = route.name === name;
            return (
              <Pressable
                key={name}
                onPress={() => navigate({name})}
                style={styles.tab}
                accessibilityRole="tab"
                accessibilityState={{selected: active}}>
                <Text style={[styles.tabText, active && styles.tabTextActive]}>
                  {name === 'scan' ? 'Scan' : 'Settings'}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </SafeAreaView>
    );
  }

  // ThemeProvider is provided by the default export below; AppInner is the
export default function App(): React.JSX.Element {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}

function makeStyles(theme: ReturnType<typeof useTheme>) {
  return StyleSheet.create({
    root: {flex: 1, backgroundColor: theme.bg},
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.border,
    },
    headerTitle: {fontSize: 17, fontWeight: '700', color: theme.text},
    connectionBadge: {flexDirection: 'row', alignItems: 'center', gap: 6},
    dot: {width: 8, height: 8, borderRadius: 4},
    connectionText: {fontSize: 12, color: theme.textMuted},
    tabBar: {
      flexDirection: 'row',
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: theme.border,
      backgroundColor: theme.surface,
    },
    tab: {flex: 1, paddingVertical: 12, alignItems: 'center'},
    tabText: {fontSize: 13, color: theme.textMuted},
    tabTextActive: {color: theme.primary, fontWeight: '600'},
  });
}
