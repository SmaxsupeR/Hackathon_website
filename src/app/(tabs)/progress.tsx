import { StyleSheet, Text, View } from 'react-native';
import { getAccuracyBySkill, getDailyActivity, getForecast, getHardestWords, getOverview } from '../../db/repo';
import { useApp } from '../../state/store';
import { Bar, Body, Card, Empty, Row, Screen, Section, Title } from '../../ui/components';
import { useT, WEEKDAYS, type StringKey, type T } from '../../ui/i18n';
import { space, useTheme } from '../../ui/theme';
import { useLoad } from '../../ui/useLoad';

const SKILL_LABEL: Record<string, StringKey> = { recall: 'skillRecall', typing: 'skillTyping', listening: 'skillListening', handwriting: 'skillHandwriting' };

function duration(tr: T, ms: number): string {
  const minutes = Math.round(ms / 60000);
  return minutes < 60 ? tr('minutes', { n: minutes }) : tr('hours', { h: Math.floor(minutes / 60), m: minutes % 60 });
}

export default function Progress() {
  const t = useTheme();
  const tr = useT();
  const lang = useApp((s) => s.settings.language);
  const { data } = useLoad(async (db) => {
    const now = Date.now();
    const [overview, activity, forecast, accuracy, hardest] = await Promise.all([
      getOverview(db, now),
      getDailyActivity(db, now, 7),
      getForecast(db, now, 7),
      getAccuracyBySkill(db),
      getHardestWords(db, 8),
    ]);
    return { overview, activity, forecast, accuracy, hardest };
  });

  if (!data) {
    return (
      <Screen top>
        <Title>{tr('tabProgress')}</Title>
      </Screen>
    );
  }
  const { overview: o, activity, forecast, accuracy, hardest } = data;
  const weekday = (ts: number) => WEEKDAYS[lang][new Date(ts).getDay()];

  return (
    <Screen top>
      <Title>{tr('tabProgress')}</Title>
      {o.totalReviews === 0 ? <Empty icon="chart-line" title={tr('noStats')} /> : null}

      <Card>
        <Row style={styles.between}>
          <Text style={[styles.cardTitle, { color: t.text }]}>{tr('statWords')}</Text>
          <Text style={[styles.cardTitle, { color: t.text }]}>{o.totalWords}</Text>
        </Row>
        {o.totalWords > 0 ? (
          <View style={[styles.stack, { backgroundColor: t.surfaceAlt }]}>
            <View style={{ flex: o.stableWords, backgroundColor: t.primary }} />
            <View style={{ flex: o.learningWords, backgroundColor: t.info }} />
            <View style={{ flex: o.newWords, backgroundColor: t.surfaceAlt }} />
          </View>
        ) : null}
        <Legend color={t.primary} label={tr('statStable')} hint={tr('statStableHint')} value={o.stableWords} />
        <Legend color={t.info} label={tr('statLearning')} value={o.learningWords} />
        <Legend color={t.textDim} label={tr('statNew')} value={o.newWords} />
      </Card>

      <Row style={styles.tiles}>
        <Tile label={tr('statReviews')} value={String(o.totalReviews)} />
        <Tile label={tr('statTime')} value={duration(tr, o.totalMs)} />
        <Tile label={tr('statStreak')} value={tr('streak', { n: o.streakDays }).split(' ').slice(0, 2).join(' ')} />
      </Row>

      <Section>{tr('activity')}</Section>
      <Card>
        <Chart items={activity.map((d) => ({ label: weekday(d.day), value: d.reviews }))} color={t.primary} />
      </Card>

      <Section>{tr('forecast')}</Section>
      <Card>
        <Chart items={forecast.map((d) => ({ label: weekday(d.day), value: d.count }))} color={t.info} />
      </Card>

      {accuracy.length > 0 ? (
        <>
          <Section>{tr('accuracy')}</Section>
          <Card>
            {accuracy.map((a) => (
              <View key={a.skill} style={styles.accuracy}>
                <Row style={styles.between}>
                  <Text style={{ color: t.text, fontWeight: '600' }}>{tr(SKILL_LABEL[a.skill] ?? 'skillRecall')}</Text>
                  <Text style={{ color: t.textDim }}>{`${Math.round((a.correct / a.total) * 100)}% · ${a.total}`}</Text>
                </Row>
                <Bar value={a.correct / a.total} />
              </View>
            ))}
            <Body dim>{tr('accuracyNote')}</Body>
          </Card>
        </>
      ) : null}

      <Section>{tr('hardest')}</Section>
      <Card>
        {hardest.length === 0 ? <Body dim>{tr('hardestNone')}</Body> : null}
        {hardest.map((w) => (
          <Row key={w.id} style={styles.between}>
            <View style={styles.flex}>
              <Text style={[styles.word, { color: t.text }]}>{w.korean}</Text>
              <Body dim>{w.meaning ?? ''}</Body>
            </View>
            <Text style={{ color: t.danger, fontWeight: '600' }}>{tr('lapses', { n: w.lapses })}</Text>
          </Row>
        ))}
      </Card>
    </Screen>
  );
}

function Legend({ color, label, hint, value }: { color: string; label: string; hint?: string; value: number }) {
  const t = useTheme();
  return (
    <Row>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <View style={styles.flex}>
        <Text style={{ color: t.text, fontSize: 15 }}>{label}</Text>
        {hint ? <Text style={{ color: t.textDim, fontSize: 12 }}>{hint}</Text> : null}
      </View>
      <Text style={{ color: t.text, fontSize: 15, fontWeight: '700' }}>{value}</Text>
    </Row>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <Card style={styles.tile}>
      <Text style={[styles.tileValue, { color: t.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      <Text style={[styles.tileLabel, { color: t.textDim }]}>{label}</Text>
    </Card>
  );
}

function Chart({ items, color }: { items: { label: string; value: number }[]; color: string }) {
  const t = useTheme();
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <View style={styles.chart}>
      {items.map((item, i) => (
        <View key={i} style={styles.column} accessible accessibilityLabel={`${item.label}: ${item.value}`}>
          <Text style={[styles.columnValue, { color: t.textDim }]}>{item.value > 0 ? item.value : ''}</Text>
          <View style={styles.columnTrack}>
            <View style={{ height: `${Math.max(item.value > 0 ? 6 : 2, (item.value / max) * 100)}%`, backgroundColor: item.value > 0 ? color : t.border, borderRadius: 4 }} />
          </View>
          <Text style={[styles.columnLabel, { color: t.textDim }]} numberOfLines={1}>
            {item.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  between: { justifyContent: 'space-between' },
  cardTitle: { fontSize: 17, fontWeight: '700' },
  stack: { flexDirection: 'row', height: 12, borderRadius: 6, overflow: 'hidden' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  tiles: { gap: space.md, alignItems: 'stretch' },
  tile: { flex: 1, padding: space.md, gap: 2 },
  tileValue: { fontSize: 20, fontWeight: '700' },
  tileLabel: { fontSize: 12, fontWeight: '600' },
  chart: { flexDirection: 'row', gap: space.sm, height: 150 },
  column: { flex: 1, alignItems: 'stretch', gap: 4 },
  columnValue: { fontSize: 11, textAlign: 'center', height: 14 },
  columnTrack: { flex: 1, justifyContent: 'flex-end' },
  columnLabel: { fontSize: 11, textAlign: 'center' },
  accuracy: { gap: 6 },
  word: { fontSize: 18, fontWeight: '600' },
});
