import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { Skill } from '../../core/scheduler';
import { getDb } from '../../db';
import { getQueueCounts, listDictionaries, savePreference } from '../../db/repo';
import { useApp, type CardDirection } from '../../state/store';
import { Body, Btn, Chip, Empty, Icon, Row, Screen, Section, Title, type IconName } from '../../ui/components';
import { useT } from '../../ui/i18n';
import { radius, space, useTheme } from '../../ui/theme';
import { useLoad } from '../../ui/useLoad';

type Mode = 'cards' | 'typing';
const SKILL: Record<Mode, Skill> = { cards: 'recall', typing: 'typing' };

export default function Practice() {
  const t = useTheme();
  const tr = useT();
  const router = useRouter();
  const settings = useApp((s) => s.settings);
  const patchSettings = useApp((s) => s.patchSettings);
  const [selected, setSelected] = useState<string[]>([]);
  const [mode, setMode] = useState<Mode>('cards');

  const { data } = useLoad(async (db) => {
    const now = Date.now();
    const dictionaries = await listDictionaries(db, now);
    const ids = selected.filter((id) => dictionaries.some((d) => d.id === id));
    const counts = await getQueueCounts(db, { dictionaryIds: ids, skill: SKILL[mode], now, newPerDay: settings.newPerDay, maxReviews: settings.maxReviews });
    return { dictionaries, counts, ids };
  }, [selected.join(','), mode, settings.newPerDay, settings.maxReviews]);

  const toggle = (id: string) => setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));

  const setDirection = (cardDirection: CardDirection) => {
    patchSettings({ cardDirection });
    getDb().then((db) => savePreference(db, 'cardDirection', JSON.stringify(cardDirection))).catch(() => {});
  };

  const modeCard = (m: Mode | null, icon: IconName, title: string, text: string) => {
    const active = m !== null && m === mode;
    return (
      <Pressable
        onPress={m ? () => setMode(m) : undefined}
        disabled={!m}
        accessibilityRole="button"
        accessibilityState={{ selected: active, disabled: !m }}
        style={[styles.mode, { backgroundColor: active ? t.primarySoft : t.surface, borderColor: active ? t.primary : t.border, opacity: m ? 1 : 0.55 }]}>
        <Icon name={icon} size={26} color={active ? t.primary : t.textDim} />
        <View style={styles.flex}>
          <Text style={[styles.modeTitle, { color: t.text }]}>{title}</Text>
          <Text style={[styles.modeText, { color: t.textDim }]}>{text}</Text>
        </View>
        {active ? <Icon name="check-circle" color={t.primary} /> : null}
      </Pressable>
    );
  };

  if (data && data.dictionaries.length === 0) {
    return (
      <Screen top>
        <Title>{tr('tabPractice')}</Title>
        <Empty icon="cards-outline" title={tr('welcomeTitle')} text={tr('welcomeText')} action={<Btn title={tr('createDictionary')} icon="plus" onPress={() => router.push('/dictionary-edit')} />} />
      </Screen>
    );
  }

  const total = data ? data.counts.due + data.counts.fresh : 0;
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
      {modeCard('cards', 'cards-outline', tr('modeCards'), tr('modeCardsText'))}
      {modeCard('typing', 'keyboard-outline', tr('modeTyping'), tr('modeTypingText'))}
      {modeCard(null, 'headphones', tr('modeListening'), tr('soon'))}
      {modeCard(null, 'draw', tr('modeHandwriting'), tr('soon'))}

      {mode === 'cards' ? (
        <>
          <Section>{tr('direction')}</Section>
          <View style={styles.chips}>
            <Chip label={tr('dirKo')} active={settings.cardDirection === 'ko-first'} onPress={() => setDirection('ko-first')} />
            <Chip label={tr('dirMeaning')} active={settings.cardDirection === 'meaning-first'} onPress={() => setDirection('meaning-first')} />
          </View>
        </>
      ) : null}

      <Row style={styles.startRow}>
        {data ? <Body dim>{total > 0 ? tr('queueInfo', { due: data.counts.due, fresh: data.counts.fresh }) : tr('nothingToStudy')}</Body> : null}
      </Row>
      <Btn title={tr('start')} icon="play" disabled={total === 0} onPress={() => router.push(`/study?mode=${mode}&dicts=${(data?.ids ?? []).join(',')}`)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  mode: { flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.md, borderRadius: radius.md, borderWidth: 1, minHeight: 64 },
  modeTitle: { fontSize: 16, fontWeight: '600' },
  modeText: { fontSize: 13 },
  startRow: { marginTop: space.sm },
});
