import { useRouter } from 'expo-router';
import { StyleSheet, Text, View } from 'react-native';
import { getOverview, getQueueCounts, listDictionaries } from '../../db/repo';
import { useApp } from '../../state/store';
import { Bar, Body, Btn, Card, Empty, Icon, IconBtn, Row, Screen, Section, Title } from '../../ui/components';
import { useT, type StringKey } from '../../ui/i18n';
import { space, useTheme } from '../../ui/theme';
import { useLoad } from '../../ui/useLoad';

function greeting(hour: number): StringKey {
  if (hour < 5) return 'greetNight';
  if (hour < 12) return 'greetMorning';
  if (hour < 18) return 'greetDay';
  return 'greetEvening';
}

export default function Home() {
  const t = useTheme();
  const tr = useT();
  const router = useRouter();
  const settings = useApp((s) => s.settings);
  const { data } = useLoad(async (db) => {
    const now = Date.now();
    const [overview, counts, dictionaries] = await Promise.all([
      getOverview(db, now),
      getQueueCounts(db, { dictionaryIds: [], skill: 'recall', now, newPerDay: settings.newPerDay, maxReviews: settings.maxReviews }),
      listDictionaries(db, now),
    ]);
    return { overview, counts, dictionaries };
  }, [settings.newPerDay, settings.maxReviews]);

  const header = (
    <Row style={styles.header}>
      <Title>{tr(greeting(new Date().getHours()))}</Title>
      <IconBtn name="cog-outline" label={tr('settings')} onPress={() => router.push('/settings')} />
    </Row>
  );

  if (!data) return <Screen top>{header}</Screen>;
  const { overview, counts, dictionaries } = data;

  if (dictionaries.length === 0) {
    return (
      <Screen top>
        {header}
        <Empty
          icon="sprout"
          title={tr('welcomeTitle')}
          text={tr('welcomeText')}
          action={<Btn title={tr('createDictionary')} icon="plus" onPress={() => router.push('/dictionary-edit')} />}
        />
      </Screen>
    );
  }

  const todo = counts.due + counts.fresh;
  const goal = overview.reviewsToday + todo;
  return (
    <Screen top>
      {header}
      <Card style={{ backgroundColor: t.primarySoft, borderColor: t.primarySoft }}>
        <Text style={[styles.cardLabel, { color: t.primary }]}>{tr('todayTitle')}</Text>
        {todo > 0 ? (
          <>
            <Text style={[styles.big, { color: t.text }]}>{counts.due > 0 ? tr('toReview', { n: counts.due }) : tr('newAvailable', { n: counts.fresh })}</Text>
            {counts.due > 0 && counts.fresh > 0 ? <Body dim>{`+ ${tr('newAvailable', { n: counts.fresh })}`}</Body> : null}
            <Btn title={tr('startReview')} icon="play" onPress={() => router.push('/study?mode=cards')} style={styles.gapTop} />
          </>
        ) : (
          <>
            <Text style={[styles.big, { color: t.text }]}>{tr('allDone')}</Text>
            <Body dim>{tr('allDoneHint')}</Body>
          </>
        )}
      </Card>

      <Card>
        <Row style={styles.between}>
          <Text style={[styles.cardLabel, { color: t.textDim }]}>{tr('doneToday')}</Text>
          {overview.streakDays > 0 ? (
            <Row>
              <Icon name="fire" size={18} color={t.warn} />
              <Text style={[styles.small, { color: t.warn }]}>{tr('streak', { n: overview.streakDays })}</Text>
            </Row>
          ) : null}
        </Row>
        <Text style={[styles.medium, { color: t.text }]}>{tr('answers', { n: overview.reviewsToday })}</Text>
        <Bar value={goal > 0 ? overview.reviewsToday / goal : 0} />
      </Card>

      <Row style={styles.tiles}>
        <Tile label={tr('statLearning')} value={overview.learningWords} color={t.info} />
        <Tile label={tr('statStable')} value={overview.stableWords} color={t.primary} />
        <Tile label={tr('statWords')} value={overview.totalWords} color={t.text} />
      </Row>

      <Section>{tr('recentDictionaries')}</Section>
      {dictionaries.slice(0, 3).map((d) => (
        <Card key={d.id} onPress={() => router.push(`/dictionary/${d.id}`)}>
          <Row>
            <View style={[styles.dot, { backgroundColor: d.color }]} />
            <View style={styles.flex}>
              <Text style={[styles.dictName, { color: t.text }]} numberOfLines={1}>
                {d.name}
              </Text>
              <Body dim>{tr('words', { n: d.entry_count }) + (d.due_count > 0 ? ` · ${tr('due', { n: d.due_count })}` : '')}</Body>
            </View>
            <Icon name="chevron-right" color={t.textDim} />
          </Row>
        </Card>
      ))}
    </Screen>
  );
}

function Tile({ label, value, color }: { label: string; value: number; color: string }) {
  const t = useTheme();
  return (
    <Card style={styles.tile}>
      <Text style={[styles.tileValue, { color }]}>{value}</Text>
      <Text style={[styles.tileLabel, { color: t.textDim }]}>{label}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { justifyContent: 'space-between' },
  between: { justifyContent: 'space-between' },
  cardLabel: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.6 },
  big: { fontSize: 24, fontWeight: '700' },
  medium: { fontSize: 20, fontWeight: '700' },
  small: { fontSize: 13, fontWeight: '600' },
  gapTop: { marginTop: space.sm },
  tiles: { gap: space.md, alignItems: 'stretch' },
  tile: { flex: 1, padding: space.md, gap: 2 },
  tileValue: { fontSize: 24, fontWeight: '700' },
  tileLabel: { fontSize: 12, fontWeight: '600' },
  dot: { width: 14, height: 14, borderRadius: 7 },
  dictName: { fontSize: 17, fontWeight: '600' },
});
