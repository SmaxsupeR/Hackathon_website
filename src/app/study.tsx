import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Grade } from 'ts-fsrs';
import { checkAnswer, type CheckResult } from '../core/answer';
import { newCard, previewDue, Rating, type CardState, type Skill } from '../core/scheduler';
import { getDb } from '../db';
import { finishSession, getStudyQueue, recordReview, startSession, type StudyItem } from '../db/repo';
import { speakKorean } from '../services/speech';
import { useApp } from '../state/store';
import { Bar, Body, Btn, Card, Empty, IconBtn, Row } from '../ui/components';
import { useInterval, useT, type StringKey } from '../ui/i18n';
import { radius, space, useTheme } from '../ui/theme';

type Mode = 'cards' | 'typing';

const RATINGS: { grade: Grade; key: StringKey; tone: 'danger' | 'warn' | 'primary' | 'info' }[] = [
  { grade: Rating.Again, key: 'again', tone: 'danger' },
  { grade: Rating.Hard, key: 'hard', tone: 'warn' },
  { grade: Rating.Good, key: 'good', tone: 'primary' },
  { grade: Rating.Easy, key: 'easy', tone: 'info' },
];

export default function Study() {
  const params = useLocalSearchParams<{ mode?: string; dicts?: string }>();
  const mode: Mode = params.mode === 'typing' ? 'typing' : 'cards';
  const skill: Skill = mode === 'typing' ? 'typing' : 'recall';
  const dicts = (params.dicts ?? '').split(',').filter(Boolean);
  const dictKey = dicts.join(',');

  const t = useTheme();
  const tr = useT();
  const interval = useInterval();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const settings = useApp((s) => s.settings);
  const touch = useApp((s) => s.touch);

  const [queue, setQueue] = useState<StudyItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [stats, setStats] = useState({ answers: 0, correct: 0 });
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [saving, setSaving] = useState(false);
  const sessionId = useRef<string | null>(null);
  const startedAt = useRef(Date.now());
  const shownAt = useRef(Date.now());
  const lastCard = useRef<CardState | null>(null);

  const load = useCallback(async () => {
    const db = await getDb();
    const now = Date.now();
    const items = await getStudyQueue(db, { dictionaryIds: dicts, skill, now, newPerDay: settings.newPerDay, maxReviews: settings.maxReviews });
    if (items.length > 0 && !sessionId.current) sessionId.current = await startSession(db, mode, dicts, now);
    setQueue(items);
    setTotal(items.length);
    setDone(0);
    shownAt.current = Date.now();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dictKey, skill, mode, settings.newPerDay, settings.maxReviews]);

  useEffect(() => {
    load().catch((e: unknown) => Alert.alert(tr('error'), e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = queue && queue.length > 0 ? queue[0] : null;
  const finished = queue !== null && queue.length === 0;

  const close = useCallback(async () => {
    try {
      if (sessionId.current) await finishSession(await getDb(), sessionId.current);
    } finally {
      touch();
      router.back();
    }
  }, [router, touch]);

  const askLeave = useCallback(() => {
    if (finished || stats.answers === 0) {
      close();
      return true;
    }
    Alert.alert(tr('leaveTitle'), tr('leaveText'), [
      { text: tr('stay'), style: 'cancel' },
      { text: tr('leave'), onPress: close },
    ]);
    return true;
  }, [finished, stats.answers, close, tr]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', askLeave);
    return () => sub.remove();
  }, [askLeave]);

  useEffect(() => {
    if (finished && sessionId.current) {
      getDb()
        .then((db) => finishSession(db, sessionId.current as string))
        .then(touch)
        .catch(() => {});
    }
  }, [finished, touch]);

  const speak = async (text: string) => {
    if (!(await speakKorean(text))) Alert.alert(tr('noVoiceTitle'), tr('noVoiceText'));
  };

  /** Saves the answer, then moves on. A forgotten word returns at the end of the session. */
  const answer = async (grade: Grade, given?: string) => {
    if (!current || saving) return;
    setSaving(true);
    try {
      const now = Date.now();
      lastCard.current = await recordReview(await getDb(), {
        entryId: current.entry.id,
        skill,
        mode,
        rating: grade,
        now,
        retention: settings.retention,
        sessionId: sessionId.current,
        durationMs: Math.min(now - shownAt.current, 120000),
        answerGiven: given ?? null,
      });
      setStats((s) => ({ answers: s.answers + 1, correct: s.correct + (grade > Rating.Again ? 1 : 0) }));
      if (mode === 'cards') advance(grade);
    } catch (e) {
      Alert.alert(tr('error'), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const advance = (grade: Grade) => {
    setQueue((q) => {
      if (!q) return q;
      const [head, ...rest] = q;
      if (grade !== Rating.Again) return rest;
      return [...rest, { entry: { ...head.entry, card: lastCard.current ?? head.entry.card }, isNew: false }];
    });
    if (grade !== Rating.Again) setDone((n) => n + 1);
    setRevealed(false);
    setTyped('');
    setResult(null);
    shownAt.current = Date.now();
  };

  const submitTyped = () => {
    if (!current || result || typed.trim() === '') return;
    const r = checkAnswer(typed, [current.entry.korean], { ignoreSpaces: !settings.strictSpacing, ignorePunctuation: true });
    setResult(r);
    answer(r.correct ? Rating.Good : Rating.Again, typed);
  };

  const header = (
    <Row style={[styles.header, { paddingTop: insets.top + space.sm }]}>
      <IconBtn name="close" label={tr('leave')} onPress={askLeave} />
      <View style={styles.flex}>
        <Bar value={total > 0 ? done / total : 0} />
      </View>
      <Text style={[styles.counter, { color: t.textDim }]}>{`${done}/${total}`}</Text>
    </Row>
  );

  if (queue === null) return <View style={[styles.flex, { backgroundColor: t.bg }]}>{header}</View>;

  if (finished) {
    const seconds = Math.round((Date.now() - startedAt.current) / 1000);
    const minutes = Math.max(1, Math.round(seconds / 60));
    return (
      <View style={[styles.flex, { backgroundColor: t.bg, paddingBottom: insets.bottom + space.lg }]}>
        {header}
        <View style={styles.body}>
          {stats.answers === 0 ? (
            <Empty icon="calendar-check" title={tr('nothingToStudy')} text={tr('nothingToStudyText')} />
          ) : (
            <Empty icon="party-popper" title={tr('sessionDone')} />
          )}
          {stats.answers > 0 ? (
            <Row style={styles.summary}>
              <Summary label={tr('sessionAnswers')} value={String(stats.answers)} />
              <Summary label={tr('sessionCorrect')} value={`${Math.round((stats.correct / stats.answers) * 100)}%`} />
              <Summary label={tr('sessionTime')} value={tr('minutes', { n: minutes })} />
            </Row>
          ) : null}
        </View>
        <View style={styles.footer}>
          <Btn title={tr('finish')} onPress={close} />
        </View>
      </View>
    );
  }

  const entry = (current as StudyItem).entry;
  const meaning = entry.meanings.join('; ');
  const koreanFirst = mode === 'cards' && settings.cardDirection === 'ko-first';
  const showBack = mode === 'cards' ? revealed : result !== null;
  const preview = previewDue(entry.card ?? newCard(Date.now()), Date.now(), settings.retention);
  const reading = settings.showRomanization ? entry.transcription || entry.romanization : null;

  const koreanBlock = (
    <View style={styles.centered}>
      <Row>
        <Text style={[styles.korean, { color: t.text }]}>{entry.korean}</Text>
        <IconBtn name="volume-high" label={tr('listen')} color={t.primary} onPress={() => speak(entry.korean)} />
      </Row>
      {reading ? <Text style={[styles.reading, { color: t.textDim }]}>{reading}</Text> : null}
    </View>
  );
  const meaningBlock = <Text style={[styles.meaning, { color: t.text }]}>{meaning}</Text>;

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.flex, { backgroundColor: t.bg }]}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Card style={styles.card}>
          {(current as StudyItem).isNew ? (
            <View style={[styles.badge, { backgroundColor: t.infoSoft }]}>
              <Text style={[styles.badgeText, { color: t.info }]}>{tr('newBadge')}</Text>
            </View>
          ) : null}
          {koreanFirst ? koreanBlock : meaningBlock}
          {showBack ? (
            <>
              <View style={[styles.divider, { backgroundColor: t.border }]} />
              {koreanFirst ? meaningBlock : koreanBlock}
              {entry.example ? (
                <View style={styles.centered}>
                  <Text style={[styles.example, { color: t.text }]}>{entry.example}</Text>
                  {entry.exampleTranslation ? <Body dim>{entry.exampleTranslation}</Body> : null}
                </View>
              ) : null}
              {entry.notes ? <Body dim>{entry.notes}</Body> : null}
            </>
          ) : null}
        </Card>

        {mode === 'typing' && !result ? (
          <TextInput
            value={typed}
            onChangeText={setTyped}
            onSubmitEditing={submitTyped}
            placeholder={tr('typeKorean')}
            placeholderTextColor={t.textDim + '99'}
            accessibilityLabel={tr('typeKorean')}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="done"
            submitBehavior="submit"
            style={[styles.typeInput, { color: t.text, backgroundColor: t.surface, borderColor: t.border }]}
          />
        ) : null}

        {mode === 'typing' && result ? (
          <Card style={{ backgroundColor: result.correct ? t.primarySoft : t.dangerSoft, borderColor: 'transparent' }}>
            <Text style={[styles.verdict, { color: result.correct ? t.primary : t.danger }]} accessibilityLiveRegion="polite">
              {result.correct ? tr('correct') : tr('wrong')}
            </Text>
            {!result.correct ? (
              <>
                <Text style={[styles.diffLabel, { color: t.textDim }]}>{tr('yourAnswer')}</Text>
                <Text style={styles.diffLine}>
                  {result.diff
                    .filter((p) => p.kind !== 'missing')
                    .map((p, i) => (
                      <Text key={i} style={p.kind === 'extra' ? { color: t.danger, textDecorationLine: 'line-through' } : { color: t.text }}>
                        {p.text}
                      </Text>
                    ))}
                </Text>
                <Text style={[styles.diffLabel, { color: t.textDim }]}>{tr('rightAnswer')}</Text>
                <Text style={styles.diffLine}>
                  {result.diff
                    .filter((p) => p.kind !== 'extra')
                    .map((p, i) => (
                      <Text key={i} style={p.kind === 'missing' ? { color: t.primary, fontWeight: '700', textDecorationLine: 'underline' } : { color: t.text }}>
                        {p.text}
                      </Text>
                    ))}
                </Text>
              </>
            ) : null}
          </Card>
        ) : null}
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>
        {mode === 'cards' && !revealed ? <Btn title={tr('showAnswer')} onPress={() => setRevealed(true)} /> : null}
        {mode === 'cards' && revealed ? (
          <Row style={styles.ratings}>
            {RATINGS.map((r) => (
              <RatingBtn key={r.grade} label={tr(r.key)} hint={interval(preview[r.grade] - Date.now())} tone={r.tone} disabled={saving} onPress={() => answer(r.grade)} />
            ))}
          </Row>
        ) : null}
        {mode === 'typing' && !result ? <Btn title={tr('check')} disabled={typed.trim() === ''} onPress={submitTyped} /> : null}
        {mode === 'typing' && result ? <Btn title={tr('next')} disabled={saving} onPress={() => advance(result.correct ? Rating.Good : Rating.Again)} /> : null}
      </View>
    </KeyboardAvoidingView>
  );
}

function RatingBtn({ label, hint, tone, disabled, onPress }: { label: string; hint: string; tone: 'danger' | 'warn' | 'primary' | 'info'; disabled: boolean; onPress: () => void }) {
  const t = useTheme();
  const bg = { danger: t.dangerSoft, warn: t.warnSoft, primary: t.primarySoft, info: t.infoSoft }[tone];
  const fg = t[tone];
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={`${label}, ${hint}`}
      android_ripple={{ color: '#00000022' }}
      style={[styles.rating, { backgroundColor: bg }]}>
      <Text style={[styles.ratingLabel, { color: fg }]} numberOfLines={1} adjustsFontSizeToFit>
        {label}
      </Text>
      <Text style={[styles.ratingHint, { color: fg }]}>{hint}</Text>
    </Pressable>
  );
}

function Summary({ label, value }: { label: string; value: string }) {
  const t = useTheme();
  return (
    <Card style={styles.summaryTile}>
      <Text style={[styles.summaryValue, { color: t.text }]}>{value}</Text>
      <Text style={[styles.summaryLabel, { color: t.textDim }]}>{label}</Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  header: { paddingHorizontal: space.sm, paddingRight: space.lg, gap: space.sm },
  counter: { fontSize: 13, fontWeight: '600', minWidth: 44, textAlign: 'right' },
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: space.lg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.md },
  card: { alignItems: 'center', paddingVertical: space.xxl, gap: space.lg, borderRadius: radius.lg },
  centered: { alignItems: 'center', gap: 4 },
  korean: { fontSize: 40, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  reading: { fontSize: 15 },
  meaning: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  example: { fontSize: 18, textAlign: 'center' },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  badge: { paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '700' },
  typeInput: { fontSize: 26, textAlign: 'center', borderWidth: 1, borderRadius: radius.md, paddingVertical: space.lg, paddingHorizontal: space.md },
  verdict: { fontSize: 20, fontWeight: '700' },
  diffLabel: { fontSize: 12, fontWeight: '600', marginTop: 4 },
  diffLine: { fontSize: 26 },
  footer: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm },
  ratings: { gap: space.sm, alignItems: 'stretch' },
  rating: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space.sm, paddingHorizontal: 4, borderRadius: radius.md, overflow: 'hidden', minHeight: 60 },
  ratingLabel: { fontSize: 14, fontWeight: '700' },
  ratingHint: { fontSize: 12, fontWeight: '500' },
  summary: { gap: space.md, alignItems: 'stretch' },
  summaryTile: { flex: 1, alignItems: 'center', padding: space.md },
  summaryValue: { fontSize: 22, fontWeight: '700' },
  summaryLabel: { fontSize: 12, fontWeight: '600' },
});
