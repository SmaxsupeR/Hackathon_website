import { Stack } from 'expo-router/stack';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Text, useColorScheme, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { getDb } from '../db';
import { loadPreferences } from '../db/repo';
import { settingsFromPrefs, useApp } from '../state/store';
import { useT } from '../ui/i18n';
import { useTheme } from '../ui/theme';

SplashScreen.preventAutoHideAsync().catch(() => {});

export default function RootLayout() {
  const t = useTheme();
  const tr = useT();
  const dark = useColorScheme() === 'dark';
  const setSettings = useApp((s) => s.setSettings);
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');

  useEffect(() => {
    getDb()
      .then(loadPreferences)
      .then((prefs) => {
        setSettings(settingsFromPrefs(prefs));
        setState('ready');
      })
      .catch((e: unknown) => setState(e instanceof Error ? e.message : String(e)))
      .finally(() => SplashScreen.hideAsync().catch(() => {}));
  }, [setSettings]);

  if (state === 'loading') return <View style={{ flex: 1, backgroundColor: t.bg }} />;
  if (state !== 'ready') {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, padding: 32, justifyContent: 'center' }}>
        <Text style={{ color: t.danger, fontSize: 18, fontWeight: '700' }}>{tr('error')}</Text>
        <Text style={{ color: t.text, marginTop: 8 }}>{state}</Text>
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <StatusBar style={dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.bg },
          headerTintColor: t.text,
          headerShadowVisible: false,
          headerTitleStyle: { fontWeight: '700' },
          contentStyle: { backgroundColor: t.bg },
        }}>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="settings" options={{ title: tr('settings') }} />
        <Stack.Screen name="study" options={{ headerShown: false, gestureEnabled: false }} />
      </Stack>
    </SafeAreaProvider>
  );
}
