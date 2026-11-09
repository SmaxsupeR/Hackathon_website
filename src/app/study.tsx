import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Grade } from 'ts-fsrs';
import { checkAnswer, type CheckResult } from '../core/answer';
import { newCard, previewDue, Rating, type CardState, type Skill } from '../core/scheduler';
import { buildSteps, insertAfter, pickOptions, type Step } from '../core/session';
import { getDb } from '../db';
import { finishSession, getRandomMeanings, getStudyQueue, recordReview, startSession, type Entry, type StudyItem } from '../db/repo';
import { speakKorean } from '../services/speech';
import { useApp } from '../state/store';
import { Bar, Body, Btn, Card, Empty, Icon, IconBtn, Row } from '../ui/components';
import { useInterval, useT, type StringKey } from '../ui/i18n';
import { radius, space, useTheme } from '../ui/theme';

type Mode = 'cards' | 'typing';
type Tone = 'danger' | 'warn' | 'primary' | 'info';

const DETAILED: { grade: Grade; key: StringKey; tone: Tone }[] = [
  { grade: Rating.Again, key: 'again', tone: 'danger' },
  { grade: Rating.Hard, key: 'hard', tone: 'warn' },
  { grade: Rating.Good, key: 'good', tone: 'primary' },
  { grade: Rating.Easy, key: 'easy', tone: 'info' },
];
const SIMPLE: typeof DETAILED = [
  { grade: Rating.Again, key: 'again', tone: 'danger' },
  { grade: Rating.Good, key: 'remember', tone: 'primary' },
];

/** New words are introduced this many at a time. */
const BATCH = 4;
/** A missed question comes back after this many other steps. */
const RETRY_GAP = 3;

const meaningOf = (e: Entry) => e.meanings.join('; ');

export default function Study() {
  const params = useLocalSearchParams<{ mode?: string; dicts?: string }>();
  const mode: Mode = params.mode === 'typing' ? 'typing' : 'cards';
  const skill: Skill = mode === 'typing' ? 'typing' : 'recall';
  const dicts = (params.dicts ?? '').split(',').filter(Boolean);

  const t = useTheme();
  const tr = useT();
  const interval = useInterval();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const settings = useApp((s) => s.settings);
  const touch = useApp((s) => s.touch);

  const [steps, setSteps] = useState<Step<StudyItem>[] | null>(null);
  const [total, setTotal] = useState(0);
  const [done, setDone] = useState(0);
  const [stats, setStats] = useState({ answers: 0, correct: 0 });
  const [revealed, setRevealed] = useState(false);
  const [typed, setTyped] = useState('');
  const [result, setResult] = useState<CheckResult | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const options = useRef(new Map<string, string[]>());
  const sessionId = useRef<string | null>(null);
  const startedAt = useRef(Date.now());
  const shownAt = useRef(Date.now());

  useEffect(() => {
    (async () => {
      const db = await getDb();
      const now = Date.now();
      const items = await getStudyQueue(db, { dictionaryIds: dicts, skill, now, newPerDay: settings.newPerDay, maxReviews: settings.maxReviews });
      if (items.length > 0) sessionId.current = await startSession(db, mode, dicts, now);
      const pool = [...items.map((i) => i.entry.meanings[0] ?? ''), ...(await getRandomMeanings(db, 40))];
      for (const { entry, isNew } of items) {
        if (!isNew) continue;
        const choice = pickOptions(meaningOf(entry), entry.meanings, pool, 4);
        if (choice) options.current.set(entry.id, choice);
      }
      const built = buildSteps(items, { batchSize: BATCH, hasChoice: (i) => options.current.has(i.entry.id) });
      setSteps(built);
      setTotal(built.length);
      shownAt.current = Date.now();
    })().catch((e: unknown) => Alert.alert(tr('error'), e instanceof Error ? e.message : String(e)));
    // The session is built once, when the screen opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const current = steps && steps.length > 0 ? steps[0] : null;
  const finished = steps !== null && steps.length === 0;

  const close = useCallback(async () => {
    try {
      if (sessionId.current) await finishSession(await getDb(), sessionId.current);
    } finally {
      touch();
      router.back();
    }
  }, [router, touch]);

  const askLeave = useCallback(() => {
    if (finished || done === 0) {
      close();
      return true;
    }
    Alert.alert(tr('leaveTitle'), tr('leaveText'), [
      { text: tr('stay'), style: 'cancel' },
      { text: tr('leave'), onPress: close },
    ]);
    return true;
  }, [finished, done, close, tr]);

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

  /** Leaves the current step. With `retry`, that step comes back a little later. */
  const next = (retry?: Step<StudyItem>) => {
    setSteps((q) => {
      if (!q) return q;
      const rest = q.slice(1);
      return retry ? insertAfter(rest, retry, RETRY_GAP) : rest;
    });
    if (!retry) setDone((n) => n + 1);
    setRevealed(false);
    setTyped('');
    setResult(null);
    setPicked(null);
    shownAt.current = Date.now();
  };

  /** Saves a test answer and returns the step to repeat if the word was not recalled. */
  const record = async (step: Step<StudyItem>, grade: Grade, given?: string): Promise<Step<StudyItem> | undefined> => {
    const now = Date.now();
    const card: CardState = await recordReview(await getDb(), {
      entryId: step.item.entry.id,
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
    return grade === Rating.Again ? { kind: 'test', item: { entry: { ...step.item.entry, card }, isNew: false } } : undefined;
  };

  const retryStep = useRef<Step<StudyItem> | undefined>(undefined);

  const rate = async (grade: Grade) => {
    if (!current || saving) return;
    setSaving(true);
    try {
      next(await record(current, grade));
    } catch (e) {
      Alert.alert(tr('error'), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const submitTyped = async () => {
    if (!current || result || saving || typed.trim() === '') return;
    const r = checkAnswer(typed, [current.item.entry.korean], { ignoreSpaces: !settings.strictSpacing, ignorePunctuation: true });
    setResult(r);
    setSaving(true);
    try {
      retryStep.current = await record(current, r.correct ? Rating.Good : Rating.Again, typed);
    } catch (e) {
      Alert.alert(tr('error'), e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const pick = (option: string) => {
    if (!current || picked !== null) return;
    setPicked(option);
  };

  const header = (
    <Row style={[styles.header, { paddingTop: insets.top + space.sm }]}>
      <IconBtn name="close" label={tr('leave')} onPress={askLeave} />
      <View style={styles.flex}>
        <Bar value={total > 0 ? done / total : 0} />
      </View>
    </Row>
  );

  if (steps === null) return <View style={[styles.flex, { backgroundColor: t.bg }]}>{header}</View>;

  if (!current) {
    const minutes = Math.max(1, Math.round((Date.now() - startedAt.current) / 60000));
    return (
      <View style={[styles.flex, { backgroundColor: t.bg, paddingBottom: insets.bottom + space.lg }]}>
        {header}
        <View style={styles.body}>
          {total === 0 ? <Empty icon="calendar-check" title={tr('nothingToStudy')} text={tr('nothingToStudyText')} /> : <Empty icon="party-popper" title={tr('sessionDone')} />}
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

  const { kind } = current;
  const entry = current.item.entry;
  const meaning = meaningOf(entry);
  const reading = settings.showRomanization ? entry.transcription || entry.romanization : null;
  const koreanFirst = mode === 'cards' && settings.cardDirection === 'ko-first';
  const answered = mode === 'cards' ? revealed : result !== null;

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
  const divider = <View style={[styles.divider, { backgroundColor: t.border }]} />;
  const extras = (
    <>
      {entry.example ? (
        <View style={styles.centered}>
          <Text style={[styles.example, { color: t.text }]}>{entry.example}</Text>
          {entry.exampleTranslation ? <Body dim>{entry.exampleTranslation}</Body> : null}
        </View>
      ) : null}
      {entry.notes ? <Body dim>{entry.notes}</Body> : null}
    </>
  );

  let hint: string;
  let content: React.ReactNode;
  let footer: React.ReactNode;

  if (kind === 'intro') {
    hint = tr('introHint');
    content = (
      <Card style={styles.card}>
        <View style={[styles.badge, { backgroundColor: t.infoSoft }]}>
          <Text style={[styles.badgeText, { color: t.info }]}>{tr('introTitle')}</Text>
        </View>
        {koreanBlock}
        {divider}
        {meaningBlock}
        {extras}
      </Card>
    );
    footer = <Btn title={tr('gotIt')} onPress={() => next()} />;
  } else if (kind === 'choice') {
    const correct = meaning;
    hint = tr('chooseTranslation');
    content = (
      <>
        <Card style={styles.card}>{koreanBlock}</Card>
        {(options.current.get(entry.id) ?? [correct]).map((option) => {
          const isCorrect = option === correct;
          const show = picked !== null && (isCorrect || option === picked);
          const color = show ? (isCorrect ? t.primary : t.danger) : t.border;
          return (
            <Pressable
              key={option}
              onPress={() => pick(option)}
              disabled={picked !== null}
              accessibilityRole="button"
              accessibilityLabel={option}
              android_ripple={{ color: t.surfaceAlt }}
              style={[styles.option, { borderColor: color, backgroundColor: show ? (isCorrect ? t.primarySoft : t.dangerSoft) : t.surface }]}>
              <Text style={[styles.optionText, { color: t.text }]}>{option}</Text>
              {show ? <Icon name={isCorrect ? 'check-circle' : 'close-circle'} color={color} /> : null}
            </Pressable>
          );
        })}
      </>
    );
    // A wrong pick brings the same question back a few steps later.
    footer = picked !== null ? <Btn title={tr('next')} onPress={() => next(picked === correct ? undefined : current)} /> : null;
  } else if (mode === 'cards') {
    const preview = previewDue(entry.card ?? newCard(Date.now()), Date.now(), settings.retention);
    const ratings = settings.detailedGrading ? DETAILED : SIMPLE;
    hint = koreanFirst ? tr('recallHint') : tr('recallHintReverse');
    content = (
      <Card style={styles.card}>
        {koreanFirst ? koreanBlock : meaningBlock}
        {revealed ? (
          <>
            {divider}
            {koreanFirst ? meaningBlock : koreanBlock}
            {extras}
          </>
        ) : null}
      </Card>
    );
    footer = !revealed ? (
      <Btn title={tr('showAnswer')} onPress={() => setRevealed(true)} />
    ) : (
      <Row style={styles.ratings}>
        {ratings.map((r) => (
          <RatingBtn key={r.grade} label={tr(r.key)} hint={tr('nextIn', { t: interval(preview[r.grade] - Date.now()) })} tone={r.tone} disabled={saving} onPress={() => rate(r.grade)} />
        ))}
      </Row>
    );
  } else {
    hint = tr('typeKorean');
    content = (
      <>
        <Card style={styles.card}>
          {meaningBlock}
          {answered ? (
            <>
              {divider}
              {koreanBlock}
              {extras}
            </>
          ) : null}
        </Card>
        {!result ? (
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
        ) : (
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
        )}
      </>
    );
    footer = !result ? <Btn title={tr('check')} disabled={typed.trim() === ''} onPress={submitTyped} /> : <Btn title={tr('next')} disabled={saving} onPress={() => next(retryStep.current)} />;
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.flex, { backgroundColor: t.bg }]}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <Text style={[styles.hint, { color: t.textDim }]}>{hint}</Text>
        {content}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>{footer}</View>
    </KeyboardAvoidingView>
  );
}

function RatingBtn({ label, hint, tone, disabled, onPress }: { label: string; hint: string; tone: Tone; disabled: boolean; onPress: () => void }) {
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
      <Text style={[styles.ratingHint, { color: fg }]} numberOfLines={1} adjustsFontSizeToFit>
        {hint}
      </Text>
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
  body: { flex: 1, justifyContent: 'center', paddingHorizontal: space.lg },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.md },
  hint: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
  card: { alignItems: 'center', paddingVertical: space.xxl, gap: space.lg, borderRadius: radius.lg },
  centered: { alignItems: 'center', gap: 4 },
  korean: { fontSize: 40, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  reading: { fontSize: 15 },
  meaning: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  example: { fontSize: 18, textAlign: 'center' },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  badge: { paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '700' },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, minHeight: 56, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md, borderWidth: 1.5, overflow: 'hidden' },
  optionText: { fontSize: 18, fontWeight: '500', flex: 1 },
  typeInput: { fontSize: 26, textAlign: 'center', borderWidth: 1, borderRadius: radius.md, paddingVertical: space.lg, paddingHorizontal: space.md },
  verdict: { fontSize: 20, fontWeight: '700' },
  diffLabel: { fontSize: 12, fontWeight: '600', marginTop: 4 },
  diffLine: { fontSize: 26 },
  footer: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm, minHeight: 60 },
  ratings: { gap: space.sm, alignItems: 'stretch' },
  rating: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: space.sm, paddingHorizontal: 6, borderRadius: radius.md, overflow: 'hidden', minHeight: 60 },
  ratingLabel: { fontSize: 16, fontWeight: '700' },
  ratingHint: { fontSize: 12, fontWeight: '500' },
  summary: { gap: space.md, alignItems: 'stretch' },
  summaryTile: { flex: 1, alignItems: 'center', padding: space.md },
  summaryValue: { fontSize: 22, fontWeight: '700' },
  summaryLabel: { fontSize: 12, fontWeight: '600' },
});
