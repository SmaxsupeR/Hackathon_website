import { Tabs } from 'expo-router/js-tabs';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Icon, type IconName } from '../../ui/components';
import { useT } from '../../ui/i18n';
import { useTheme } from '../../ui/theme';

export default function TabsLayout() {
  const t = useTheme();
  const tr = useT();
  const insets = useSafeAreaInsets();
  const icon = (name: IconName) => ({ color, size }: { color: unknown; size: number }) => <Icon name={name} color={typeof color === 'string' ? color : undefined} size={size} />;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.textDim,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border, height: 62 + insets.bottom, paddingTop: 6, paddingBottom: insets.bottom + 6 },
        tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
        sceneStyle: { backgroundColor: t.bg },
      }}>
      <Tabs.Screen name="index" options={{ title: tr('tabHome'), tabBarIcon: icon('home-variant') }} />
      <Tabs.Screen name="dictionaries" options={{ title: tr('tabDictionaries'), tabBarIcon: icon('book-open-variant') }} />
      <Tabs.Screen name="practice" options={{ title: tr('tabPractice'), tabBarIcon: icon('cards') }} />
      <Tabs.Screen name="progress" options={{ title: tr('tabProgress'), tabBarIcon: icon('chart-bar') }} />
    </Tabs>
  );
}
