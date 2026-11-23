// End-to-end learning scenario on a real word list: two weeks of daily sessions,
// played through the same state machine, answer checks and database code the app uses.
import { describe, expect, it } from 'vitest';
import { checkAnswer, checkMeaning } from '../core/answer';
import { answer, cardKey, completeIntro, createSession, currentTask, MAX_FAILS, type Direction, type Session } from '../core/learning';
import { State } from '../core/scheduler';
import * as repo from './repo';
import { migrate, type Db } from './schema';
import { openTestDb } from './testing';

const WORDS: [string, string][] = [
  ['나무', 'дерево'], ['물', 'вода'], ['학교', 'школа'], ['사과', 'яблоко'], ['집', 'дом'], ['고양이', 'кошка'],
  ['개', 'собака'], ['책', 'книга'], ['친구', 'друг'], ['가족', 'семья'], ['시간', 'время'], ['오늘', 'сегодня'],
  ['내일', 'завтра'], ['먹다', 'есть; кушать'], ['마시다', 'пить'], ['가다', 'идти; ехать'], ['오다', 'приходить'], ['보다', 'смотреть; видеть'],
  ['크다', 'большой'], ['작다', 'маленький'], ['좋다', 'хороший'], ['비싸다', 'дорогой'], ['사랑', 'любовь'], ['학생', 'студент'],
];
const DAY = 86400000;
const START = new Date(2026, 8, 1, 19, 0, 0).getTime();
const BOTH: Direction[] = ['ko_ru', 'ru_ko'];

/**
 * A scripted learner. Answers are typed strings checked by the app's real checkers.
 * - 고양이: picks a wrong option the first time.
 * - 마시다: forgets the translation once during training.
 * - 비싸다: misspells it in Korean three times in a row (the card is parked), then gets it right.
 * - 학교: forgets it at the first review of the meaning.
 * - 집: answers "жилище", which the dictionary does not list.
 */
function learner(day: number, firstReviewDone: Set<string>, seen: Map<string, number>) {
  return (s: Session, korean: string, meaning: string[]): { correct: boolean; given: string } => {
    void day;
    const task = currentTask(s);
    if (!task || task.kind === 'intro') throw new Error('not a question');
    const card = s.cards[task.key];
    const key = `${korean}:${card.direction}:${task.kind}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);

    if (task.kind === 'recognize') return { correct: !(korean === '고양이' && n === 1), given: '' };

    let given: string;
    if (card.direction === 'ko_ru') {
      given = meaning[0];
      if (korean === '마시다' && task.purpose === 'acquisition' && n === 1) given = 'есть';
      if (korean === '학교' && task.purpose === 'review' && !firstReviewDone.has('학교')) given = '';
      if (korean === '집') given = 'жилище';
      if (task.purpose === 'review') firstReviewDone.add(korean);
      return { correct: checkMeaning(given, meaning).correct, given };
    }
    given = korean;
    if (korean === '비싸다' && n <= MAX_FAILS) given = '비사다';
    return { correct: checkAnswer(given, [korean]).correct, given };
  };
}

async function runDay(db: Db, day: number, opts: { quitAfter?: number; firstReviewDone: Set<string>; seen: Map<string, number> }) {
  const now = START + day * DAY;
  const p = await repo.planSession(db, { dictionaryIds: [], directions: BOTH, now, newPerDay: 8, maxReviews: 100 });
  const ids = [...new Set([...p.reviews.map((r) => r.entryId), ...p.learning.map((l) => l.entryId), ...p.fresh])];
  const entries = await repo.getEntries(db, ids);
  let s = createSession({ ...p, directions: BOTH, hasChoice: () => true });
  const answerFor = learner(day, opts.firstReviewDone, opts.seen);
  const log = { steps: 0, intros: 0, ratings: new Map<string, number>(), quit: false };
  let t = now;
  while (currentTask(s)) {
    if (opts.quitAfter !== undefined && log.steps >= opts.quitAfter) {
      log.quit = true;
      break;
    }
    const task = currentTask(s);
    t += 7000;
    if (task?.kind === 'intro') {
      const r = completeIntro(s);
      await repo.applyEffects(db, r.effects, { now: t, retention: 0.9 });
      s = r.session;
      log.intros += task.repeat ? 0 : 1;
    } else if (task) {
      const e = entries.get(s.cards[task.key].entryId) as repo.Entry;
      const a = answerFor(s, e.korean, e.meanings);
      // The learner insists "жилище" is right: the screen lets them accept their own translation.
      const selfAccepted = !a.correct && e.korean === '집' && s.cards[task.key].direction === 'ko_ru';
      const r = answer(s, a.correct || selfAccepted);
      await repo.applyEffects(db, r.effects, { now: t, retention: 0.9, answerGiven: a.given, selfAccepted });
      for (const ef of r.effects) if (ef.type === 'graduate' || ef.type === 'review') log.ratings.set(cardKey(ef.entryId, ef.direction), (log.ratings.get(cardKey(ef.entryId, ef.direction)) ?? 0) + 1);
      s = r.session;
    }
    log.steps++;
    expect(log.steps).toBeLessThan(400);
  }
  return { log, session: s, plan: p };
}

describe('two weeks with a real word list', () => {
  it('teaches, tests, schedules and reviews every word under the rules of the state machine', async () => {
    const db = openTestDb();
    await migrate(db);
    const dict = await repo.createDictionary(db, { name: 'TOPIK I — базовые слова' }, START - DAY);
    const ids = new Map<string, string>();
    for (let i = 0; i < WORDS.length; i++) ids.set(WORDS[i][0], await repo.createEntry(db, dict, { korean: WORDS[i][0], meanings: [WORDS[i][1]] }, START - DAY + i));
    const firstReviewDone = new Set<string>();
    const seen = new Map<string, number>();
    const days: string[] = [];
    let sawParked = false;

    for (let day = 0; day < 14; day++) {
      const shownBefore = await db.getAllAsync<{ id: string }>('SELECT id FROM entries WHERE introduced_at IS NOT NULL', []);
      // Day 1: the learner closes the app after 10 steps; day 5 is skipped.
      if (day === 5) continue;
      const { log, session, plan } = await runDay(db, day, { quitAfter: day === 1 ? 10 : undefined, firstReviewDone, seen });

      // New words: only never-shown ones, within the daily limit.
      expect(plan.fresh.length).toBeLessThanOrEqual(8);
      for (const id of plan.fresh) expect(shownBefore.map((x) => x.id)).not.toContain(id);
      // FSRS: at most one rating per card per session.
      for (const n of log.ratings.values()) expect(n).toBe(1);
      // No card is scheduled without a correct recall: every FSRS card's first rating is Good or Hard, never Easy.
      const firsts = await db.getAllAsync<{ rating: number }>('SELECT rating FROM review_history h WHERE reviewed_at = (SELECT MIN(reviewed_at) FROM review_history x WHERE x.entry_id = h.entry_id AND x.skill = h.skill)', []);
      for (const f of firsts) expect([2, 3]).toContain(f.rating);
      // A parked card left the session after MAX_FAILS mistakes.
      for (const c of Object.values(session.cards)) expect(c.fails).toBeLessThanOrEqual(MAX_FAILS);
      days.push(`day ${day}: ${log.steps} steps, ${log.intros} new, ${log.ratings.size} rated${log.quit ? ', quit early' : ''}`);
      // After quitting early, the next day continues the words left in training without showing them as new.
      if (day === 2) {
        expect(plan.learning.length).toBeGreaterThan(0);
        for (const l of plan.learning) expect(plan.fresh).not.toContain(l.entryId);
      }
      // 비싸다 is parked after three misspellings, and is not asked a fourth time that day.
      const parked = Object.values(session.cards).find((c) => c.entryId === ids.get('비싸다') && c.direction === 'ru_ko' && c.stage === 'parked');
      if (parked) {
        expect(parked.fails).toBe(MAX_FAILS);
        sawParked = true;
      }
    }

    const card = (korean: string, d: Direction) => repo.getCard(db, ids.get(korean) as string, d);

    // Every word was shown, and every word reached the schedule in the meaning direction.
    expect(await db.getAllAsync('SELECT id FROM entries WHERE introduced_at IS NULL', [])).toEqual([]);
    for (const [korean] of WORDS) expect(await card(korean, 'ko_ru')).not.toBeNull();
    // Almost every word can also be written; 비싸다 was parked while misspelt, then learned.
    for (const [korean] of WORDS) expect(await card(korean, 'ru_ko')).not.toBeNull();
    const pricey = await db.getAllAsync<{ mode: string; is_correct: number; answer_given: string }>(
      "SELECT mode, is_correct, answer_given FROM practice_attempts WHERE entry_id = ? AND skill = 'ru_ko' AND mode != 'recognition' ORDER BY created_at",
      [ids.get('비싸다') as string],
    );
    expect(sawParked).toBe(true);
    expect(pricey.filter((p) => p.answer_given === '비사다').map((p) => p.is_correct)).toEqual([0, 0, 0]);
    expect(pricey.at(-1)).toMatchObject({ is_correct: 1, answer_given: '비싸다' });

    // 고양이 and 마시다 made training errors, so their first rating was Hard; 나무 had none, so Good.
    const firstRating = async (korean: string) =>
      (await db.getFirstAsync<{ rating: number }>("SELECT rating FROM review_history WHERE entry_id = ? AND skill = 'ko_ru' ORDER BY reviewed_at LIMIT 1", [ids.get(korean) as string]))?.rating;
    expect(await firstRating('고양이')).toBe(2);
    expect(await firstRating('마시다')).toBe(2);
    expect(await firstRating('나무')).toBe(3);

    // 학교 was forgotten at its first review: one Again in FSRS, then relearned in the session.
    const school = await db.getAllAsync<{ rating: number }>("SELECT rating FROM review_history WHERE entry_id = ? AND skill = 'ko_ru' ORDER BY reviewed_at", [ids.get('학교') as string]);
    expect(school.map((h) => h.rating)).toContain(1);
    expect((await card('학교', 'ko_ru'))?.lapses).toBe(1);

    // "жилище" for 집 was accepted by the learner and logged as such.
    const accepted = await db.getAllAsync<{ is_correct: number; answer_given: string }>(
      'SELECT is_correct, answer_given FROM practice_attempts WHERE entry_id = ? AND self_accepted = 1',
      [ids.get('집') as string],
    );
    expect(accepted.length).toBeGreaterThan(0);
    for (const a of accepted) expect(a).toEqual({ is_correct: 1, answer_given: 'жилище' });

    // Recognition never wrote to FSRS history.
    const recognitionInHistory = await db.getFirstAsync<{ n: number }>(
      "SELECT COUNT(*) AS n FROM review_history h WHERE NOT EXISTS (SELECT 1 FROM practice_attempts p WHERE p.entry_id = h.entry_id AND p.skill = h.skill AND p.created_at = h.reviewed_at AND p.mode != 'recognition')",
      [],
    );
    expect(recognitionInHistory?.n).toBe(0);

    // Intervals grow for words answered right: 나무 meaning direction is in Review with an interval of days.
    const tree = await card('나무', 'ko_ru');
    expect(tree?.state).toBe(State.Review);
    expect(tree?.scheduled_days).toBeGreaterThan(5);

    // Statistics keep recognition and recall apart.
    const acc = await repo.getAccuracy(db);
    expect(acc.map((a) => a.kind)).toEqual(['recognition', 'ko_ru', 'ru_ko']);
    const overview = await repo.getOverview(db, START + 14 * DAY);
    expect(overview.newWords).toBe(0);
    expect(overview.learningWords + overview.stableWords).toBe(WORDS.length);

    console.log(days.join('\n'));
    console.log('accuracy', acc.map((a) => `${a.kind} ${a.correct}/${a.total}`).join(', '));
    console.log('overview', overview);
  });
});
