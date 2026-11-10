import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { getDb } from '../../db';
import { getPlanCounts, listDictionaries, savePreference } from '../../db/repo';
import { directionList, useApp, type DirectionSetting } from '../../state/store';
import { Body, Btn, Card, Chip, Empty, Icon, Screen, Section, Title, type IconName } from '../../ui/components';
import { useT, type StringKey } from '../../ui/i18n';
import { radius, space, useTheme } from '../../ui/theme';
import { useLoad } from '../../ui/useLoad';

const DIRECTION_OPTIONS: { value: DirectionSetting; label: StringKey; hint: StringKey; icon: IconName }[] = [
  { value: 'both', label: 'dirBoth', hint: 'dirBothHint', icon: 'swap-horizontal' },
  { value: 'ko_ru', label: 'dirKoRu', hint: 'dirKoRuHint', icon: 'arrow-right' },
  { value: 'ru_ko', label: 'dirRuKo', hint: 'dirRuKoHint', icon: 'arrow-left' },
];

export default function Practice() {
  const t = useTheme();
  const tr = useT();
  const router = useRouter();
  const settings = useApp((s) => s.settings);
  const patchSettings = useApp((s) => s.patchSettings);
  const [selected, setSelected] = useState<string[]>([]);

  const { data } = useLoad(async (db) => {
    const now = Date.now();
    const dictionaries = await listDictionaries(db, now);
    const ids = selected.filter((id) => dictionaries.some((d) => d.id === id));
    const counts = await getPlanCounts(db, { dictionaryIds: ids, directions: directionList(settings.directions), now, newPerDay: settings.newPerDay, maxReviews: settings.maxReviews });
    return { dictionaries, counts, ids };
  }, [selected.join(','), settings.directions, settings.newPerDay, settings.maxReviews]);

  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const setDirections = (directions: DirectionSetting) => {
    patchSettings({ directions });
    getDb().then((db) => savePreference(db, 'directions', JSON.stringify(directions))).catch(() => {});
  };

  if (data && data.dictionaries.length === 0) {
    return (
      <Screen top>
        <Title>{tr('tabPractice')}</Title>
        <Empty icon="cards-outline" title={tr('welcomeTitle')} text={tr('welcomeText')} action={<Btn title={tr('createDictionary')} icon="plus" onPress={() => router.push('/dictionary-edit')} />} />
      </Screen>
    );
  }

  const c = data?.counts;
  const total = c ? c.due + c.learning + c.fresh : 0;
  const lines = c ? [c.due > 0 && tr('planDue', { n: c.due }), c.learning > 0 && tr('planLearning', { n: c.learning }), c.fresh > 0 && tr('planFresh', { n: c.fresh })].filter(Boolean) : [];

  return (
    <Screen top>
      <Title>{tr('tabPractice')}</Title>
      <Section>{tr('practiceWhat')}</Section>
      <View style={styles.chips}>
        <Chip label={tr('allDictionaries')} active={selected.length === 0} onPress={() => setSelected([])} />
        {data?.dictionaries.map((d) => (
          <Chip key={d.id} label={d.name} active={selected.includes(d.id)} onPress={() => toggle(d.id)} />
        ))}
      </View>

      <Section>{tr('practiceHow')}</Section>
      {DIRECTION_OPTIONS.map((o) => {
        const active = settings.directions === o.value;
        return (
          <Pressable
            key={o.value}
            onPress={() => setDirections(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            style={[styles.mode, { backgroundColor: active ? t.primarySoft : t.surface, borderColor: active ? t.primary : t.border }]}>
            <Icon name={o.icon} size={24} color={active ? t.primary : t.textDim} />
            <View style={styles.flex}>
              <Text style={[styles.modeTitle, { color: t.text }]}>{tr(o.label)}</Text>
              <Text style={[styles.modeText, { color: t.textDim }]}>{tr(o.hint)}</Text>
            </View>
            {active ? <Icon name="check-circle" color={t.primary} /> : null}
          </Pressable>
        );
      })}
      {(['modeListening', 'modeHandwriting'] as const).map((k) => (
        <View key={k} style={[styles.mode, { backgroundColor: t.surface, borderColor: t.border, opacity: 0.55 }]}>
          <Icon name={k === 'modeListening' ? 'headphones' : 'draw'} size={24} color={t.textDim} />
          <View style={styles.flex}>
            <Text style={[styles.modeTitle, { color: t.text }]}>{tr(k)}</Text>
            <Text style={[styles.modeText, { color: t.textDim }]}>{tr('soon')}</Text>
          </View>
        </View>
      ))}

      <Card>{data ? lines.length > 0 ? lines.map((l, i) => <Body key={i}>{l as string}</Body>) : <Body dim>{tr('nothingToStudyText')}</Body> : null}</Card>
      <Btn title={tr('start')} icon="play" disabled={total === 0} onPress={() => router.push(`/study?dicts=${(data?.ids ?? []).join(',')}`)} />

      <Section>{tr('howItWorks')}</Section>
      <Body dim>{tr('howItWorksText')}</Body>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  mode: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, minHeight: 64 },
  modeTitle: { fontSize: 16, fontWeight: '600' },
  modeText: { fontSize: 13 },
});
