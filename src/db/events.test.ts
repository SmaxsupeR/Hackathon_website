// FSRS events: idempotency, validation right before writing, atomicity, and mixed training.
import { beforeEach, describe, expect, it } from 'vitest';
import type { Outcome } from '../core/attempt';
import { answer, completeIntro, createFreeSession, createSession, currentTask, GRADE, type Direction, type Effect, type Session } from '../core/learning';
import type { SelfGrade } from '../core/model';
import { Rating } from '../core/scheduler';
import * as repo from './repo';
import { migrate, type Db } from './schema';
import { openTestDb } from './testing';

const NOW = new Date(2026, 5, 15, 9, 0, 0).getTime();
const DAY = 86400000;
const BOTH: Direction[] = ['ko_ru', 'ru_ko'];
let db: Db;
let ids: string[];

const WORDS: [string, string][] = [['나무', 'дерево'], ['물', 'вода'], ['학교', 'школа'], ['사과', 'яблоко'], ['집', 'дом'], ['책', 'книга']];

beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
  const dict = await repo.createDictionary(db, { name: 'D' }, NOW - DAY);
  ids = [];
  for (let i = 0; i < WORDS.length; i++) ids.push(await repo.createEntry(db, dict, { korean: WORDS[i][0], meanings: [WORDS[i][1]] }, NOW - DAY + i));
});

/** Everything that defines the schedule and the training state. */
async function scheduleState() {
  return {
    cards: await db.getAllAsync('SELECT entry_id, skill, due, stability, difficulty, reps, lapses, state, last_review FROM review_cards ORDER BY entry_id, skill', []),
    history: await db.getAllAsync('SELECT entry_id, skill, rating, reviewed_at FROM review_history ORDER BY reviewed_at, entry_id, skill', []),
    training: await db.getAllAsync('SELECT entry_id, direction, phase, errors FROM acquisition ORDER BY entry_id, direction', []),
    shown: await db.getAllAsync('SELECT id, introduced_at FROM entries ORDER BY id', []),
  };
}

async function schedule(entryId: string, direction: Direction, at: number) {
  await repo.recordReview(db, { entryId, skill: direction, mode: 'review', rating: Rating.Good, now: at, retention: 0.9 });
}

async function save(effects: Effect[], now: number) {
  return repo.applyEvent(db, effects, { now, retention: 0.9 });
}

const count = async (sql: string, p: (string | number)[] = []) => (await db.getFirstAsync<{ n: number }>(sql, p))?.n ?? 0;

describe('idempotent events', () => {
  it('saving the same event twice changes nothing the second time', async () => {
    await schedule(ids[0], 'ko_ru', NOW);
    const due = (await repo.getCard(db, ids[0], 'ko_ru'))!.due;
    const s = createSession({ reviews: [{ entryId: ids[0], direction: 'ko_ru' }], learning: [], fresh: [], directions: ['ko_ru'], hasChoice: () => false });
    const r = answer(s, { correct: true, at: due, attemptId: 'event-1' });
    const first = await save(r.effects, due);
    expect(first).toMatchObject({ duplicate: false, rejected: [] });
    const after = await scheduleState();
    const second = await save(r.effects, due);
    expect(second).toEqual({ card: null, duplicate: true, rejected: [] });
    expect(await scheduleState()).toEqual(after);
    expect(await count('SELECT COUNT(*) AS n FROM practice_attempts WHERE id = ?', ['event-1'])).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM review_history WHERE event_id = 'event-1'")).toBe(1);
  });

  it('one FSRS event id can never be written twice, even past the attempt check', async () => {
    await schedule(ids[0], 'ko_ru', NOW);
    const history = (await db.getFirstAsync<{ event_id: string }>('SELECT event_id FROM review_history', []))!;
    await expect(
      db.runAsync(
        'INSERT INTO review_history (id, entry_id, skill, rating, state, due, stability, difficulty, elapsed_days, scheduled_days, reviewed_at, event_id) VALUES (?, ?, ?, 3, 2, 1, 1, 1, 0, 1, 1, ?)',
        ['x', ids[0], 'ko_ru', history.event_id],
      ),
    ).rejects.toThrow();
  });

  it('graduating an already scheduled card is refused: no second card, no new history', async () => {
    await schedule(ids[0], 'ko_ru', NOW);
    const before = await scheduleState();
    const r = await save(
      [
        { type: 'attempt', entryId: ids[0], direction: 'ko_ru', mode: 'acquisition', correct: true },
        { type: 'graduate', entryId: ids[0], direction: 'ko_ru', grade: GRADE.good },
      ],
      NOW + 1000,
    );
    expect(r.rejected).toEqual([{ type: 'graduate', reason: 'already_scheduled' }]);
    expect(await scheduleState()).toEqual(before);
    expect(await count('SELECT COUNT(*) AS n FROM practice_attempts')).toBe(2); // the answer itself is kept in statistics
  });

  it('reviews only cards that exist and are due, checked right before writing', async () => {
    const notScheduled = await save([{ type: 'review', entryId: ids[1], direction: 'ko_ru', grade: GRADE.good }], NOW);
    expect(notScheduled.rejected).toEqual([{ type: 'review', reason: 'not_scheduled' }]);
    await schedule(ids[1], 'ko_ru', NOW);
    const before = await scheduleState();
    const early = await save([{ type: 'review', entryId: ids[1], direction: 'ko_ru', grade: GRADE.again }], NOW + 1000);
    expect(early.rejected).toEqual([{ type: 'review', reason: 'not_due' }]);
    expect(await scheduleState()).toEqual(before);
  });

  it('a training stage for a scheduled card is refused (no invalid state transition)', async () => {
    await schedule(ids[2], 'ru_ko', NOW);
    const r = await save([{ type: 'phase', entryId: ids[2], direction: 'ru_ko', phase: 'recognition', errors: 1 }], NOW + 1);
    expect(r.rejected).toEqual([{ type: 'phase', reason: 'already_scheduled' }]);
    expect(await count('SELECT COUNT(*) AS n FROM acquisition')).toBe(0);
  });

  it('there is no ban on several valid reviews of one card in a calendar day', async () => {
    await schedule(ids[3], 'ko_ru', NOW - 3 * DAY);
    // Due in the morning; reviewed; then (e.g. restored from a backup) due again in the evening.
    const morning = NOW;
    expect((await save([{ type: 'review', entryId: ids[3], direction: 'ko_ru', grade: GRADE.again }], morning)).rejected).toEqual([]);
    await db.runAsync('UPDATE review_cards SET due = ? WHERE entry_id = ? AND skill = ?', [morning + 8 * 3600000, ids[3], 'ko_ru']);
    expect((await save([{ type: 'review', entryId: ids[3], direction: 'ko_ru', grade: GRADE.good }], morning + 9 * 3600000)).rejected).toEqual([]);
    expect(await count("SELECT COUNT(*) AS n FROM review_history WHERE entry_id = ? AND skill = 'ko_ru' AND reviewed_at >= ?", [ids[3], morning])).toBe(2);
  });

  it('is atomic: a failure in the middle of an event leaves nothing behind', async () => {
    await schedule(ids[4], 'ko_ru', NOW - 3 * DAY);
    const before = await scheduleState();
    const attempts = await count('SELECT COUNT(*) AS n FROM practice_attempts');
    // The database itself refuses training rows for a scheduled card (trigger), even if a check were skipped.
    await expect(db.runAsync("INSERT INTO acquisition (entry_id, direction, phase, errors, updated_at) VALUES (?, 'ko_ru', 'recall', 0, 1)", [ids[4]])).rejects.toThrow('card_already_scheduled');
    // An event whose last write fails rolls back its FSRS review.
    const s = createSession({ reviews: [{ entryId: ids[4], direction: 'ko_ru' }], learning: [], fresh: [], directions: ['ko_ru'], hasChoice: () => false });
    const r = answer(s, { correct: true, attemptId: 'dup', at: NOW });
    await db.runAsync("INSERT INTO practice_sessions (id, mode, dictionary_ids, started_at) VALUES ('blocker', 'x', '[]', 1)", []);
    await db.runAsync("INSERT INTO review_history (id, entry_id, skill, rating, state, due, stability, difficulty, elapsed_days, scheduled_days, reviewed_at, event_id) VALUES ('h', ?, 'ru_ko', 3, 2, 1, 1, 1, 0, 1, 1, 'dup')", [ids[5]]);
    await expect(save(r.effects, NOW)).rejects.toThrow();
    const after = await scheduleState();
    expect(after.cards).toEqual(before.cards);
    expect(after.training).toEqual(before.training);
    expect(await count('SELECT COUNT(*) AS n FROM practice_attempts')).toBe(attempts);
  });
});

describe('free practice and the schedule', () => {
  async function runFree(method: 'choice' | 'keyboard' | 'self_grade', countAsReview: boolean, answerFn: (n: number) => boolean, at = NOW + 30 * DAY, source: repo.FreeSource = { kind: 'dictionaries', ids: [] }) {
    const seeds = await repo.planFreePractice(db, { source, directions: BOTH, now: at, limit: 50 });
    const sessionId = await repo.startSession(db, 'practice', [], at, 'free');
    let s = createFreeSession({ cards: seeds, method, countAsReview, maxFails: 3, hasChoice: () => true, sessionId });
    let n = 0;
    let t = at;
    while (currentTask(s)) {
      t += 1000;
      if (currentTask(s)!.kind === 'intro') {
        const r = completeIntro(s);
        await repo.applyEvent(db, r.effects, { now: t, retention: 0.9 });
        s = r.session;
        continue;
      }
      const correct = answerFn(n++);
      const r = answer(s, { correct, at: t, selfGrade: method === 'self_grade' ? (correct ? 'good' : 'again') : undefined });
      await repo.applyEvent(db, r.effects, { now: t, retention: 0.9 });
      s = r.session;
      expect(n).toBeLessThan(500);
    }
    return { seeds, sessionId, answers: n };
  }

  it('by default changes neither FSRS nor training stages nor the "shown" marks, whatever the answers', async () => {
    await schedule(ids[0], 'ko_ru', NOW);
    await schedule(ids[1], 'ru_ko', NOW);
    await repo.applyEvent(db, [{ type: 'introduce', entryId: ids[2], directions: BOTH }], { now: NOW, retention: 0.9 });
    const before = await scheduleState();
    for (const method of ['choice', 'keyboard', 'self_grade'] as const) {
      for (const p of [() => true, () => false, (n: number) => n % 3 === 0]) {
        await runFree(method, false, p);
        expect(await scheduleState()).toEqual(before);
      }
    }
    expect(await count("SELECT COUNT(*) AS n FROM practice_attempts WHERE session_kind = 'free'")).toBeGreaterThan(50);
    expect(await count("SELECT COUNT(*) AS n FROM practice_attempts WHERE session_kind = 'free' AND rating IS NOT NULL")).toBe(0);
  });

  it('keeps its own statistics, separate from planned study', async () => {
    await runFree('keyboard', false, (n) => n % 2 === 0);
    expect(await repo.getAccuracy(db)).toEqual([]);
    const free = await repo.getAccuracy(db, { sessionKind: 'free' });
    expect(free.map((a) => a.kind)).toEqual(['ko_ru', 'ru_ko']);
    expect(free.reduce((n, a) => n + a.total, 0)).toBeGreaterThan(0);
  });

  it('"count as the planned review" rates only due cards, once each, and not when nothing is due', async () => {
    await schedule(ids[0], 'ko_ru', NOW);
    await schedule(ids[1], 'ko_ru', NOW + 20 * DAY);
    const at = NOW + 10 * DAY; // ids[0] due, ids[1] not
    const before = (await scheduleState()).history.length;
    await runFree('keyboard', true, () => false, at);
    const rated = await db.getAllAsync<{ entry_id: string; rating: number }>(
      "SELECT h.entry_id, h.rating FROM review_history h JOIN practice_attempts p ON p.id = h.event_id WHERE p.session_kind = 'free'",
      [],
    );
    expect(rated).toEqual([{ entry_id: ids[0], rating: GRADE.again }]);
    expect((await scheduleState()).history.length).toBe(before + 1);
    // Running it again the same day: nothing is due any more.
    await runFree('keyboard', true, () => true, at + 3600000);
    expect((await scheduleState()).history.length).toBe(before + 1);
  });
});

describe('difficult words', () => {
  it('come from frequent mistakes, forgotten reviews and parked training', async () => {
    // Mistakes in free practice on 나무.
    const mistakes = createFreeSession({ cards: [{ entryId: ids[0], direction: 'ko_ru', status: 'new', due: false, introduced: true }], method: 'keyboard', maxFails: 2 });
    let s: Session = mistakes;
    while (currentTask(s)) {
      const r = answer(s, { correct: false, at: NOW });
      await repo.applyEvent(db, r.effects, { now: NOW, retention: 0.9 });
      s = r.session;
    }
    // 물 forgotten at a review.
    await schedule(ids[1], 'ko_ru', NOW - 10 * DAY);
    await save([{ type: 'review', entryId: ids[1], direction: 'ko_ru', grade: GRADE.again }], NOW);
    // 학교 parked in training.
    await save([{ type: 'phase', entryId: ids[2], direction: 'ru_ko', phase: 'recognition', errors: 4 }], NOW);
    const hard = await repo.getDifficultWords(db, { limit: 10, now: NOW + 1000 });
    expect(hard.map((w) => w.korean).sort()).toEqual(['나무', '물', '학교'].sort());
    expect(hard.find((w) => w.korean === '나무')).toMatchObject({ mistakes: 2, lapses: 0, parked: false });
    expect(hard.find((w) => w.korean === '물')).toMatchObject({ lapses: 1 });
    expect(hard.find((w) => w.korean === '학교')).toMatchObject({ parked: true });
    const seeds = await repo.planFreePractice(db, { source: { kind: 'hard', dictionaryIds: [] }, directions: ['ko_ru'], now: NOW + 1000, limit: 10 });
    expect(seeds.map((x) => x.entryId).sort()).toEqual([ids[0], ids[1], ids[2]].sort());
    expect(seeds.find((x) => x.entryId === ids[1])).toMatchObject({ status: 'scheduled' });
  });

  it('training them with a higher attempt limit does not touch the schedule', async () => {
    await schedule(ids[1], 'ko_ru', NOW - 10 * DAY);
    await save([{ type: 'review', entryId: ids[1], direction: 'ko_ru', grade: GRADE.again }], NOW);
    const before = await scheduleState();
    const seeds = await repo.planFreePractice(db, { source: { kind: 'hard', dictionaryIds: [] }, directions: BOTH, now: NOW + DAY * 3, limit: 10 });
    let s = createFreeSession({ cards: seeds, method: 'keyboard', maxFails: 6 });
    let n = 0;
    while (currentTask(s)) {
      const r = answer(s, { correct: n++ > 8, at: NOW + 3 * DAY });
      await repo.applyEvent(db, r.effects, { now: NOW + 3 * DAY, retention: 0.9 });
      s = r.session;
    }
    expect(n).toBeGreaterThan(seeds.length);
    expect(await scheduleState()).toEqual(before);
  });
});

describe('no double FSRS events in mixed training', () => {
  /** Seeded random numbers, so a failing run can be reproduced. */
  function rng(seed: number) {
    let x = seed;
    return () => (x = (x * 48271) % 2147483647) / 2147483647;
  }

  it('planned sessions with every answer method, free practice and repeats, over several days', async () => {
    for (const seed of [1, 7, 42, 2026]) {
      db = openTestDb();
      await migrate(db);
      const dict = await repo.createDictionary(db, { name: 'D' }, NOW - DAY);
      ids = [];
      for (let i = 0; i < WORDS.length; i++) ids.push(await repo.createEntry(db, dict, { korean: WORDS[i][0], meanings: [WORDS[i][1]] }, NOW - DAY + i));
      const random = rng(seed);
      const methods = ['keyboard', 'self_grade'] as const;
      const grades: SelfGrade[] = ['again', 'hard', 'good', 'easy'];
      for (let day = 0; day < 12; day++) {
        // Several sessions a day, mixing planned study and free practice, sometimes quitting early,
        // sometimes saving an event twice (double tap, retry after a crash).
        for (let k = 0; k < 3; k++) {
          const at = NOW + day * DAY + k * 3 * 3600000;
          const free = random() < 0.4;
          let s: Session;
          if (free) {
            const seeds = await repo.planFreePractice(db, { source: { kind: 'dictionaries', ids: [] }, directions: BOTH, now: at, limit: 4 });
            s = createFreeSession({ cards: seeds, method: (['choice', 'keyboard', 'self_grade'] as const)[Math.floor(random() * 3)], countAsReview: random() < 0.5, hasChoice: () => random() < 0.8 });
          } else {
            const p = await repo.planSession(db, { dictionaryIds: [], directions: BOTH, now: at, newPerDay: 3, maxReviews: 50 });
            s = createSession({ ...p, directions: BOTH, hasChoice: () => random() < 0.8, method: methods[Math.floor(random() * 2)] });
          }
          const quitAfter = random() < 0.3 ? Math.floor(random() * 6) : Infinity;
          let t = at;
          for (let step = 0; currentTask(s) && step < quitAfter; step++) {
            t += 1000;
            const task = currentTask(s)!;
            const r =
              task.kind === 'intro'
                ? completeIntro(s)
                : (() => {
                    const g = grades[Math.floor(random() * 4)];
                    const correct = random() < 0.7;
                    const o: Outcome = { correct, at: t, selfGrade: g === 'again' ? 'again' : correct ? g : 'again' };
                    if (o.selfGrade === 'again') o.correct = false;
                    return answer(s, o);
                  })();
            await repo.applyEvent(db, r.effects, { now: t, retention: 0.9 });
            if (random() < 0.15) await repo.applyEvent(db, r.effects, { now: t, retention: 0.9 }); // the same event again
            s = r.session;
          }
        }
      }
      // Every FSRS rating has its own event and its own answer.
      const history = await db.getAllAsync<{ event_id: string; entry_id: string; skill: string; reviewed_at: number }>('SELECT event_id, entry_id, skill, reviewed_at FROM review_history', []);
      expect(history.length).toBeGreaterThan(5);
      expect(new Set(history.map((h) => h.event_id)).size).toBe(history.length);
      const linked = await count('SELECT COUNT(*) AS n FROM review_history h JOIN practice_attempts p ON p.id = h.event_id AND p.rating IS NOT NULL');
      expect(linked).toBe(history.length);
      // No two ratings of the same card in one session.
      const perSession = await db.getAllAsync<{ n: number }>('SELECT COUNT(*) AS n FROM review_history WHERE session_id IS NOT NULL GROUP BY session_id, entry_id, skill HAVING n > 1', []);
      expect(perSession).toEqual([]);
      // Each review after the first came only once the card was due.
      const rows = await db.getAllAsync<{ entry_id: string; skill: string; reviewed_at: number; due: number }>('SELECT entry_id, skill, reviewed_at, due FROM review_history ORDER BY entry_id, skill, reviewed_at', []);
      for (let i = 1; i < rows.length; i++) {
        if (rows[i].entry_id === rows[i - 1].entry_id && rows[i].skill === rows[i - 1].skill) expect(rows[i].reviewed_at).toBeGreaterThanOrEqual(rows[i - 1].due);
      }
      // Recognition and free practice without the option never rated anything.
      expect(await count("SELECT COUNT(*) AS n FROM practice_attempts WHERE rating IS NOT NULL AND (method = 'choice' OR mode IN ('recognition', 'relearn'))")).toBe(0);
      // A card is never both in training and scheduled.
      expect(await count('SELECT COUNT(*) AS n FROM acquisition a JOIN review_cards c ON c.entry_id = a.entry_id AND c.skill = a.direction')).toBe(0);
    }
  });
});
