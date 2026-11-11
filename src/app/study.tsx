import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, BackHandler, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DiffPart } from '../core/answer';
import type { Outcome as AttemptOutcome } from '../core/attempt';
import { buildChoiceOptions, checkChoice, checkKeyboard, checkSelfGrade } from '../core/exercises';
import { answer, cardKey, completeIntro, createFreeSession, createSession, currentTask, progress, type Card as LearnCard, type Direction, type Effect, type RecallMethod, type Session, type Task } from '../core/learning';
import type { SelfGrade } from '../core/model';
import { getDb } from '../db';
import { applyEvent, finishSession, getDistractorPool, getEntries, planFreePractice, planSession, startSession, type Entry, type FreeSource } from '../db/repo';
import { speakKorean } from '../services/speech';
import { directionList, useApp } from '../state/store';
import { Bar, Body, Btn, Card, Empty, Icon, IconBtn, Row } from '../ui/components';
import { useInterval, useT } from '../ui/i18n';
import { radius, space, useTheme } from '../ui/theme';

/** What the learner sees after answering, before tapping "Next". */
interface Feedback {
  correct: boolean;
  typo?: boolean;
  dontKnow?: boolean;
  given?: string;
  picked?: string;
  diff?: DiffPart[];
  /** Days until the next FSRS review, if this answer rated the card. */
  nextDueMs?: number;
  /** Stage of the card after the answer: requeued, parked, done. */
  after?: LearnCard['stage'];
  graduated?: boolean;
  /** A wrong translation that the learner may still claim as right. Not saved yet. */
  pendingWrong?: boolean;
  /** Answered with the learner's own grade (no right/wrong verdict to show). */
  selfGraded?: boolean;
}

const meaningText = (e: Entry) => e.meanings.join('; ');

/** Free-practice parameters passed in the route. */
type StudyParams = {
  dicts?: string;
  /** 'free' for free practice; planned study otherwise. */
  kind?: string;
  /** Free practice: 'dicts' | 'entries' | 'hard'. */
  source?: string;
  ids?: string;
  /** Free practice: 'both' | 'ko_ru' | 'ru_ko'. */
  dirs?: string;
  /** Free practice: 'choice' | 'keyboard' | 'self_grade'. */
  method?: string;
  limit?: string;
  fails?: string;
  /** Free practice: '1' to count due reviews in FSRS. */
  count?: string;
};

const SELF_GRADES_SIMPLE: SelfGrade[] = ['again', 'good'];
const SELF_GRADES_DETAILED: SelfGrade[] = ['again', 'hard', 'good', 'easy'];

export default function Study() {
  const params = useLocalSearchParams<StudyParams>();
  const dicts = (params.dicts ?? '').split(',').filter(Boolean);
  const free = params.kind === 'free';

  const t = useTheme();
  const tr = useT();
  const interval = useInterval();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const settings = useApp((s) => s.settings);
  const touch = useApp((s) => s.touch);

  const [session, setSession] = useState<Session | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [typed, setTyped] = useState('');
  /** Self-assessed card: the answer is shown, waiting for the learner's grade. */
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);
  const entries = useRef(new Map<string, Entry>());
  const options = useRef(new Map<string, string[]>());
  const sessionId = useRef<string | null>(null);
  const startedAt = useRef(Date.now());
  const shownAt = useRef(Date.now());
  const pending = useRef<{ session: Session; given: string } | null>(null);

  // Build the session once, when the screen opens.
  useEffect(() => {
    (async () => {
      const db = await getDb();
      const now = Date.now();
      const loadOptions = async (ids: string[]) => {
        entries.current = await getEntries(db, ids);
        const pool = [...entries.current.values()].map((e) => ({ korean: e.korean, meaning: e.meanings[0] ?? '' }));
        pool.push(...(await getDistractorPool(db, 80)));
        for (const e of entries.current.values()) {
          for (const d of ['ko_ru', 'ru_ko'] as const) {
            const o = buildChoiceOptions(e, d, pool);
            if (o) options.current.set(cardKey(e.id, d), o);
          }
        }
      };
      const hasChoice = (id: string, d: Direction) => options.current.has(cardKey(id, d));
      let s: Session;
      if (free) {
        const directions: Direction[] = params.dirs === 'ko_ru' || params.dirs === 'ru_ko' ? [params.dirs] : ['ko_ru', 'ru_ko'];
        const ids = (params.ids ?? '').split(',').filter(Boolean);
        const source: FreeSource = params.source === 'entries' ? { kind: 'entries', ids } : params.source === 'hard' ? { kind: 'hard', dictionaryIds: dicts } : { kind: 'dictionaries', ids: dicts };
        const seeds = await planFreePractice(db, { source, directions, now, limit: Math.max(1, Number(params.limit) || 20) });
        await loadOptions([...new Set(seeds.map((x) => x.entryId))]);
        if (seeds.length > 0) sessionId.current = await startSession(db, params.source === 'hard' ? 'hard_words' : 'practice', dicts, now, 'free');
        const method = params.method === 'choice' || params.method === 'self_grade' ? params.method : 'keyboard';
        s = createFreeSession({ cards: seeds, method, countAsReview: params.count === '1', maxFails: Number(params.fails) || settings.practiceAttempts, hasChoice, sessionId: sessionId.current });
      } else {
        const directions = directionList(settings.directions);
        const plan = await planSession(db, { dictionaryIds: dicts, directions, now, newPerDay: settings.newPerDay, maxReviews: settings.maxReviews });
        await loadOptions([...new Set([...plan.reviews.map((r) => r.entryId), ...plan.learning.map((l) => l.entryId), ...plan.fresh])]);
        if (plan.reviews.length + plan.learning.length + plan.fresh.length > 0) sessionId.current = await startSession(db, 'learn', dicts, now);
        s = createSession({ ...plan, directions, hasChoice, method: settings.answerMethod, sessionId: sessionId.current });
      }
      shownAt.current = Date.now();
      setSession(s);
    })().catch((e: unknown) => Alert.alert(tr('error'), e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const task = session ? currentTask(session) : null;
  const entry = task ? entries.current.get(task.kind === 'intro' ? task.entryId : (session as Session).cards[task.key].entryId) : undefined;
  const card = task && task.kind !== 'intro' ? (session as Session).cards[task.key] : undefined;

  const speak = useCallback(
    async (text: string, quiet = false) => {
      const ok = await speakKorean(text);
      if (!ok && !quiet) Alert.alert(tr('noVoiceTitle'), tr('noVoiceText'));
    },
    [tr],
  );

  // Pronounce a new word as soon as it is shown.
  useEffect(() => {
    if (task?.kind === 'intro' && entry && settings.autoSpeak) speak(entry.korean, true);
  }, [task, entry, settings.autoSpeak, speak]);

  /** Saves one event. `now` must be the same moment as the attempt's `at`. */
  const save = async (effects: Effect[], now = Date.now()) => {
    const r = await applyEvent(await getDb(), effects, { now, retention: settings.retention, sessionId: sessionId.current });
    return r.card;
  };

  const fail = (e: unknown) => Alert.alert(tr('error'), e instanceof Error ? e.message : String(e));

  /** Runs one step of the state machine and saves it. The screen keeps showing this question until "Next". */
  const commit = async (outcome: Omit<AttemptOutcome, 'at' | 'durationMs'>, view: Feedback) => {
    if (!session) return;
    setBusy(true);
    try {
      const at = Date.now();
      const step = answer(pending.current?.session ?? session, { ...outcome, at, durationMs: Math.min(at - shownAt.current, 120000) });
      const scheduled = await save(step.effects, at);
      const graduated = step.effects.some((e) => e.type === 'graduate');
      pending.current = null;
      setFeedback({ ...view, correct: outcome.correct, after: step.card.stage, graduated, nextDueMs: scheduled ? scheduled.due - at : undefined, pendingWrong: false });
      setSession(step.session);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // The question on screen stays until "Next", even though the session already moved on.
  const [shown, setShown] = useState<{ task: Task; entry: Entry; card?: LearnCard } | null>(null);
  useEffect(() => {
    if (!feedback && task && entry) setShown({ task, entry, card });
  }, [feedback, task, entry, card]);

  const goNext = async () => {
    // A wrong translation not claimed as right is saved now.
    if (feedback?.pendingWrong && pending.current) {
      await commit({ correct: false, method: 'keyboard', given: pending.current.given }, { ...feedback, pendingWrong: false });
    }
    setFeedback(null);
    setTyped('');
    setRevealed(false);
    shownAt.current = Date.now();
  };

  const finishIntro = async () => {
    if (!session) return;
    setBusy(true);
    try {
      const step = completeIntro(session);
      await save(step.effects, Date.now());
      setSession(step.session);
      shownAt.current = Date.now();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const choose = (option: string) => {
    if (!shown || !card || feedback || busy) return;
    const e = shown.entry;
    const right = checkChoice(e, card.direction, option).correct;
    commit({ correct: right, method: 'choice', given: option }, { correct: right, picked: option });
    if (settings.autoSpeak) speak(e.korean, true);
  };

  const submit = (dontKnow = false) => {
    if (!shown || !card || feedback || busy) return;
    const e = shown.entry;
    const given = dontKnow ? '' : typed;
    if (!dontKnow && given.trim() === '') return;
    if (settings.autoSpeak) speak(e.korean, true);
    const r = checkKeyboard(e, card.direction, given, { strictSpacing: settings.strictSpacing });
    if (r.correct || dontKnow || !r.canSelfAccept) {
      commit({ correct: r.correct, method: 'keyboard', typoCorrected: r.typo, given }, { correct: r.correct, typo: r.typo, dontKnow, given, diff: dontKnow ? undefined : (r.diff ?? undefined) });
      return;
    }
    // A translation can be right in words the dictionary does not list: let the learner say so before saving.
    pending.current = { session: session as Session, given };
    setFeedback({ correct: false, given, pendingWrong: true });
  };

  const acceptMine = () => {
    if (!feedback?.pendingWrong || !pending.current) return;
    const given = pending.current.given;
    commit({ correct: true, method: 'keyboard', given, selfAccepted: true }, { correct: true, given });
  };

  /** Self-assessed card: show the answer, then the learner grades how well they knew it. */
  const reveal = () => {
    if (!card || feedback || busy) return;
    setRevealed(true);
    if (settings.autoSpeak && shown) speak(shown.entry.korean, true);
  };

  const grade = (g: SelfGrade) => {
    if (!revealed || feedback || busy) return;
    const ok = checkSelfGrade(g).correct;
    commit({ correct: ok, method: 'self_grade', selfGrade: g }, { correct: ok, selfGraded: true });
  };

  const close = useCallback(async () => {
    try {
      const db = await getDb();
      if (pending.current && session) {
        // Leaving with an unconfirmed wrong translation counts it as wrong.
        const at = Date.now();
        const step = answer(pending.current.session, { correct: false, method: 'keyboard', given: pending.current.given, at });
        await applyEvent(db, step.effects, { now: at, retention: settings.retention, sessionId: sessionId.current });
        pending.current = null;
      }
      if (sessionId.current) await finishSession(db, sessionId.current);
    } catch {
      // Everything answered before this point is already saved.
    } finally {
      touch();
      router.back();
    }
  }, [router, touch, session, settings.retention]);

  const askLeave = useCallback(() => {
    if (!session || session.queue.length === 0 || session.stats.answers + session.stats.introduced === 0) {
      close();
      return true;
    }
    Alert.alert(tr('leaveTitle'), tr('leaveText'), [
      { text: tr('stay'), style: 'cancel' },
      { text: tr('leave'), onPress: close },
    ]);
    return true;
  }, [session, close, tr]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', askLeave);
    return () => sub.remove();
  }, [askLeave]);

  const header = (
    <Row style={[styles.header, { paddingTop: insets.top + space.sm }]}>
      <IconBtn name="close" label={tr('leave')} onPress={askLeave} />
      <View style={styles.flex}>
        <Bar value={session ? progress(session) : 0} />
      </View>
    </Row>
  );

  if (!session) return <View style={[styles.flex, { backgroundColor: t.bg }]}>{header}</View>;

  // ---------- Finished ----------
  if (!task && !feedback) {
    const st = session.stats;
    const minutes = Math.max(1, Math.round((Date.now() - startedAt.current) / 60000));
    const empty = st.answers === 0 && st.introduced === 0;
    return (
      <View style={[styles.flex, { backgroundColor: t.bg, paddingBottom: insets.bottom + space.lg }]}>
        {header}
        <ScrollView contentContainerStyle={styles.body}>
          {empty ? <Empty icon="calendar-check" title={tr('nothingToStudy')} text={tr('nothingToStudyText')} /> : <Empty icon="party-popper" title={tr('sessionDone')} />}
          {!empty ? (
            <View style={styles.summary}>
              {session.kind === 'free' ? (
                <Body dim style={styles.center}>
                  {st.reviewed > 0 ? tr('freeCountedNote', { n: st.reviewed }) : tr('freeNoScheduleNote')}
                </Body>
              ) : (
                <Row style={styles.summaryRow}>
                  <Summary label={tr('sumIntroduced')} value={String(st.introduced)} />
                  <Summary label={tr('sumLearned')} value={String(st.learnedWords.length)} />
                  <Summary label={tr('sumReviewed')} value={st.reviewed > 0 ? `${st.reviewCorrect}/${st.reviewed}` : '0'} />
                </Row>
              )}
              <Row style={styles.summaryRow}>
                <Summary label={tr('sumAccuracy')} value={st.answers > 0 ? `${Math.round((st.correct / st.answers) * 100)}%` : '—'} />
                <Summary label={tr('sessionTime')} value={tr('minutes', { n: minutes })} />
              </Row>
            </View>
          ) : null}
        </ScrollView>
        <View style={styles.footer}>
          <Btn title={tr('finish')} onPress={close} />
        </View>
      </View>
    );
  }

  const view = feedback ? shown : task && entry ? { task, entry, card } : null;
  if (!view) return <View style={[styles.flex, { backgroundColor: t.bg }]}>{header}</View>;
  const e = view.entry;
  const reading = e.transcription || e.romanization;

  const korean = (big = true, listen = true) => (
    <View style={styles.centered}>
      <Row style={styles.wrapRow}>
        <Text style={[big ? styles.korean : styles.koreanSmall, { color: t.text }]}>{e.korean}</Text>
        {listen ? <IconBtn name="volume-high" label={tr('listen')} color={t.primary} onPress={() => speak(e.korean)} /> : null}
      </Row>
      {settings.showRomanization && reading ? <Text style={[styles.reading, { color: t.textDim }]}>{e.transcription ? reading : `≈ ${reading}`}</Text> : null}
    </View>
  );
  const meaning = <Text style={[styles.meaning, { color: t.text }]}>{meaningText(e)}</Text>;
  const divider = <View style={[styles.divider, { backgroundColor: t.border }]} />;
  const example = e.example ? (
    <View style={styles.centered}>
      <Text style={[styles.example, { color: t.text }]}>{e.example}</Text>
      {e.exampleTranslation ? <Body dim>{e.exampleTranslation}</Body> : null}
    </View>
  ) : null;

  let title = '';
  let badge: string | null = null;
  let content: ReactNode = null;
  let footer: ReactNode = null;

  // ---------- Intro ----------
  if (view.task.kind === 'intro') {
    title = view.task.repeat && e.introduced_at !== null ? tr('stepIntroAgain') : tr('stepIntro');
    content = (
      <>
        <Body dim style={styles.center}>
          {tr('introHint')}
        </Body>
        <Card style={styles.card}>
          {korean()}
          {!settings.showRomanization && reading ? <Text style={[styles.reading, { color: t.textDim }]}>{e.transcription ? reading : `≈ ${reading}`}</Text> : null}
          {divider}
          {meaning}
          {example}
          {e.notes ? <Body dim>{e.notes}</Body> : null}
        </Card>
      </>
    );
    footer = <Btn title={tr('next')} disabled={busy} onPress={finishIntro} />;
  } else {
    const c = view.card as LearnCard;
    const dir: Direction = c.direction;
    const purpose = view.task.kind === 'recall' ? view.task.purpose : null;
    if (purpose === 'review') badge = tr('stepReview');
    if (purpose === 'relearn') badge = tr('stepRelearn');
    if (session.kind === 'free') badge = tr('freeBadge');
    const recallMethod: RecallMethod = c.method && c.method !== 'choice' ? c.method : session.method;

    // ---------- Recognition ----------
    if (view.task.kind === 'recognize') {
      title = dir === 'ko_ru' ? tr('stepRecognizeKoRu') : tr('stepRecognizeRuKo');
      const list = options.current.get(c.key) ?? [];
      const isRight = (o: string) => (dir === 'ko_ru' ? e.meanings.includes(o) : o === e.korean);
      content = (
        <>
          <Card style={styles.card}>{dir === 'ko_ru' ? korean() : meaning}</Card>
          {list.map((o) => {
            const reveal = feedback && (isRight(o) || o === feedback.picked);
            const color = reveal ? (isRight(o) ? t.primary : t.danger) : t.border;
            return (
              <Pressable
                key={o}
                onPress={() => choose(o)}
                disabled={!!feedback || busy}
                accessibilityRole="button"
                accessibilityLabel={o}
                android_ripple={{ color: t.surfaceAlt }}
                style={[styles.option, { borderColor: color, backgroundColor: reveal ? (isRight(o) ? t.primarySoft : t.dangerSoft) : t.surface }]}>
                <Text style={[dir === 'ko_ru' ? styles.optionText : styles.optionKorean, { color: t.text }]}>{o}</Text>
                {reveal ? <Icon name={isRight(o) ? 'check-circle' : 'close-circle'} color={color} /> : null}
              </Pressable>
            );
          })}
          {feedback ? (
            <>
              {dir === 'ru_ko' ? <Card style={styles.card}>{korean(false)}</Card> : null}
              <Outcome feedback={feedback} interval={interval} />
            </>
          ) : null}
        </>
      );
      footer = feedback ? <Btn title={tr('next')} disabled={busy} onPress={goNext} /> : null;
    } else if (recallMethod === 'self_grade') {
      // ---------- Self-assessed card: recall, show the answer, grade yourself ----------
      title = dir === 'ko_ru' ? tr('stepSelfKoRu') : tr('stepSelfRuKo');
      const grades = settings.detailedGrading ? SELF_GRADES_DETAILED : SELF_GRADES_SIMPLE;
      content = (
        <>
          <Card style={styles.card}>
            {dir === 'ko_ru' ? korean() : meaning}
            {revealed || feedback ? (
              <>
                {divider}
                {dir === 'ko_ru' ? meaning : korean()}
                {example}
              </>
            ) : null}
          </Card>
          {feedback ? <Outcome feedback={feedback} interval={interval} /> : revealed ? <Body dim style={styles.center}>{tr('selfGradeHint')}</Body> : null}
        </>
      );
      footer = feedback ? (
        <Btn title={tr('next')} disabled={busy} onPress={goNext} />
      ) : !revealed ? (
        <Btn title={tr('showAnswer')} onPress={reveal} />
      ) : (
        <Row style={styles.buttons}>
          {grades.map((g) => (
            <GradeBtn key={g} grade={g} disabled={busy} onPress={() => grade(g)} />
          ))}
        </Row>
      );
    } else {
      // ---------- Recall (training, review or relearning) ----------
      title = dir === 'ko_ru' ? tr('stepRecallKoRu') : tr('stepRecallRuKo');
      content = (
        <>
          <Card style={styles.card}>
            {dir === 'ko_ru' ? korean() : meaning}
            {feedback ? (
              <>
                {divider}
                {dir === 'ko_ru' ? meaning : korean()}
                {example}
              </>
            ) : null}
          </Card>
          {!feedback ? (
            <TextInput
              value={typed}
              onChangeText={setTyped}
              onSubmitEditing={() => submit()}
              placeholder={dir === 'ko_ru' ? tr('answerPlaceholderKoRu') : tr('answerPlaceholderRuKo')}
              placeholderTextColor={t.textDim + '99'}
              accessibilityLabel={title}
              autoFocus
              autoCorrect={false}
              autoCapitalize="none"
              returnKeyType="done"
              submitBehavior="submit"
              style={[styles.typeInput, { color: t.text, backgroundColor: t.surface, borderColor: t.border }]}
            />
          ) : (
            <Outcome feedback={feedback} interval={interval} />
          )}
        </>
      );
      footer = !feedback ? (
        <Row style={styles.buttons}>
          <Btn style={styles.flex} kind="soft" title={tr('dontKnow')} disabled={busy} onPress={() => submit(true)} />
          <Btn style={styles.flex} title={tr('check')} disabled={busy || typed.trim() === ''} onPress={() => submit()} />
        </Row>
      ) : (
        <>
          {feedback.pendingWrong ? <Btn kind="soft" icon="check" title={tr('acceptMine')} disabled={busy} onPress={acceptMine} /> : null}
          <Btn title={tr('next')} disabled={busy} onPress={goNext} />
        </>
      );
    }
  }

  return (
    <KeyboardAvoidingView behavior="padding" style={[styles.flex, { backgroundColor: t.bg }]}>
      {header}
      <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
        <View style={styles.titleRow}>
          <Text style={[styles.title, { color: t.text }]} accessibilityRole="header">
            {title}
          </Text>
          {badge ? (
            <View style={[styles.badge, { backgroundColor: t.infoSoft }]}>
              <Text style={[styles.badgeText, { color: t.info }]}>{badge}</Text>
            </View>
          ) : null}
        </View>
        {content}
      </ScrollView>
      <View style={[styles.footer, { paddingBottom: insets.bottom + space.md }]}>{footer}</View>
    </KeyboardAvoidingView>
  );
}

function Outcome({ feedback: f, interval }: { feedback: Feedback; interval: (ms: number) => string }) {
  const t = useTheme();
  const tr = useT();
  const ok = f.correct;
  const heading = f.selfGraded ? (ok ? tr('selfGradedOk') : tr('dontKnowShown')) : ok ? (f.typo ? tr('correctTypo') : tr('correct')) : f.dontKnow ? tr('dontKnowShown') : tr('wrong');
  return (
    <Card style={{ backgroundColor: ok ? t.primarySoft : t.dangerSoft, borderColor: 'transparent' }}>
      <Row style={styles.between}>
        <Text style={[styles.verdict, { color: ok ? t.primary : t.danger }]} accessibilityLiveRegion="polite">
          {heading}
        </Text>
        {f.graduated ? (
          <View style={[styles.badge, { backgroundColor: t.primary }]}>
            <Text style={[styles.badgeText, { color: t.onPrimary }]}>{tr('learnedBadge')}</Text>
          </View>
        ) : null}
      </Row>
      {f.diff && !ok ? (
        <>
          <Text style={[styles.diffLabel, { color: t.textDim }]}>{tr('yourAnswer')}</Text>
          <Text style={styles.diffLine}>
            {f.diff
              .filter((p) => p.kind !== 'missing')
              .map((p, i) => (
                <Text key={i} style={p.kind === 'extra' ? { color: t.danger, textDecorationLine: 'line-through' } : { color: t.text }}>
                  {p.text}
                </Text>
              ))}
          </Text>
          <Text style={[styles.diffLabel, { color: t.textDim }]}>{tr('rightAnswer')}</Text>
          <Text style={styles.diffLine}>
            {f.diff
              .filter((p) => p.kind !== 'extra')
              .map((p, i) => (
                <Text key={i} style={p.kind === 'missing' ? { color: t.primary, fontWeight: '700', textDecorationLine: 'underline' } : { color: t.text }}>
                  {p.text}
                </Text>
              ))}
          </Text>
        </>
      ) : null}
      {!f.diff && f.given && !ok ? <Text style={[styles.given, { color: t.danger }]}>{`${tr('yourAnswer')}: ${f.given}`}</Text> : null}
      {f.typo && f.given ? <Body dim>{`${tr('yourAnswer')}: ${f.given}`}</Body> : null}
      {f.nextDueMs !== undefined && ok ? <Body dim>{tr('nextReview', { t: interval(f.nextDueMs) })}</Body> : null}
      {f.after === 'parked' ? <Body dim>{tr('parked')}</Body> : null}
      {!ok && !f.pendingWrong && f.after !== 'parked' && f.after !== 'done' ? <Body dim>{tr('willRepeat')}</Body> : null}
    </Card>
  );
}

const GRADE_STYLE: Record<SelfGrade, { key: 'again' | 'hard' | 'remember' | 'easy'; tone: 'danger' | 'warn' | 'primary' | 'info' }> = {
  again: { key: 'again', tone: 'danger' },
  hard: { key: 'hard', tone: 'warn' },
  good: { key: 'remember', tone: 'primary' },
  easy: { key: 'easy', tone: 'info' },
};

function GradeBtn({ grade, disabled, onPress }: { grade: SelfGrade; disabled: boolean; onPress: () => void }) {
  const t = useTheme();
  const tr = useT();
  const { key, tone } = GRADE_STYLE[grade];
  const bg = { danger: t.dangerSoft, warn: t.warnSoft, primary: t.primarySoft, info: t.infoSoft }[tone];
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={tr(key)} android_ripple={{ color: '#00000022' }} style={[styles.grade, { backgroundColor: bg }]}>
      <Text style={[styles.gradeText, { color: t[tone] }]} numberOfLines={1} adjustsFontSizeToFit>
        {tr(key)}
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
  center: { textAlign: 'center' },
  header: { paddingHorizontal: space.sm, paddingRight: space.lg, gap: space.sm },
  body: { flexGrow: 1, justifyContent: 'center', paddingHorizontal: space.lg, gap: space.md },
  scroll: { flexGrow: 1, justifyContent: 'center', padding: space.lg, gap: space.md },
  titleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.sm, flexWrap: 'wrap' },
  title: { fontSize: 18, fontWeight: '700', textAlign: 'center' },
  card: { alignItems: 'center', paddingVertical: space.xl, gap: space.md, borderRadius: radius.lg },
  centered: { alignItems: 'center', gap: 4 },
  wrapRow: { flexWrap: 'wrap', justifyContent: 'center' },
  korean: { fontSize: 40, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  koreanSmall: { fontSize: 28, fontWeight: '700', textAlign: 'center', flexShrink: 1 },
  reading: { fontSize: 15 },
  meaning: { fontSize: 24, fontWeight: '600', textAlign: 'center' },
  example: { fontSize: 18, textAlign: 'center' },
  divider: { height: StyleSheet.hairlineWidth, alignSelf: 'stretch' },
  badge: { paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontWeight: '700' },
  option: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.sm, minHeight: 56, paddingHorizontal: space.lg, paddingVertical: space.md, borderRadius: radius.md, borderWidth: 1.5, overflow: 'hidden' },
  optionText: { fontSize: 18, fontWeight: '500', flex: 1 },
  optionKorean: { fontSize: 24, fontWeight: '600', flex: 1 },
  typeInput: { fontSize: 24, textAlign: 'center', borderWidth: 1, borderRadius: radius.md, paddingVertical: space.lg, paddingHorizontal: space.md },
  between: { justifyContent: 'space-between' },
  verdict: { fontSize: 20, fontWeight: '700', flexShrink: 1 },
  given: { fontSize: 16 },
  diffLabel: { fontSize: 12, fontWeight: '600', marginTop: 4 },
  diffLine: { fontSize: 26 },
  footer: { paddingHorizontal: space.lg, paddingTop: space.sm, gap: space.sm, minHeight: 60 },
  buttons: { gap: space.sm },
  grade: { flex: 1, minHeight: 56, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, overflow: 'hidden' },
  gradeText: { fontSize: 16, fontWeight: '700' },
  summary: { gap: space.md },
  summaryRow: { gap: space.md, alignItems: 'stretch' },
  summaryTile: { flex: 1, alignItems: 'center', padding: space.md },
  summaryValue: { fontSize: 22, fontWeight: '700' },
  summaryLabel: { fontSize: 12, fontWeight: '600', textAlign: 'center' },
});
