import { beforeEach, describe, expect, it } from 'vitest';
import { answer, completeIntro, createSession, currentTask, GRADE, type Direction, type Session } from '../core/learning';
import { newCard, Rating, reviewCard, State } from '../core/scheduler';
import * as repo from './repo';
import { migrate, MIGRATIONS, TABLES, type Db } from './schema';
import { openTestDb } from './testing';

const NOW = new Date(2026, 5, 15, 12, 0, 0).getTime();
const DAY = 86400000;
let db: Db;

beforeEach(async () => {
  db = openTestDb();
  await migrate(db);
});

async function seed(words: [string, string][] = [['나무', 'дерево'], ['물', 'вода'], ['사과', 'яблоко']]) {
  const dict = await repo.createDictionary(db, { name: 'Урок 5' }, NOW);
  const ids: string[] = [];
  for (let i = 0; i < words.length; i++) ids.push(await repo.createEntry(db, dict, { korean: words[i][0], meanings: [words[i][1]] }, NOW + i));
  return { dict, ids };
}

const BOTH: Direction[] = ['ko_ru', 'ru_ko'];
const plan = (now = NOW, opts: Partial<repo.PlanOptions> = {}) =>
  repo.planSession(db, { dictionaryIds: [], directions: BOTH, now, newPerDay: 20, maxReviews: 100, ...opts });

async function startFromPlan(now: number, opts: Partial<repo.PlanOptions> = {}): Promise<Session> {
  const p = await plan(now, opts);
  return createSession({ ...p, directions: opts.directions ?? BOTH, hasChoice: () => true });
}

/** Answers the current step and saves it, as the study screen does. */
async function step(s: Session, correct: boolean, now: number): Promise<Session> {
  const task = currentTask(s);
  if (!task) throw new Error('no task');
  const r = task.kind === 'intro' ? completeIntro(s) : answer(s, correct);
  await repo.applyEffects(db, r.effects, { now, retention: 0.9 });
  return r.session;
}

const count = async (sql: string, params: (string | number)[] = []) => (await db.getFirstAsync<{ n: number }>(sql, params))?.n ?? 0;

describe('schema', () => {
  it('migrates once and is idempotent', async () => {
    expect(await migrate(db)).toBe(MIGRATIONS.length);
    const tables = await db.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'", []);
    for (const t of Object.keys(TABLES)) expect(tables.map((x) => x.name)).toContain(t);
  });
  it('lists exactly the real columns of each table', async () => {
    for (const [t, cols] of Object.entries(TABLES)) {
      const info = await db.getAllAsync<{ name: string }>(`PRAGMA table_info(${t})`, []);
      expect(info.map((c) => c.name).sort()).toEqual([...cols].sort());
    }
  });
  it('applies a later migration on top of existing data', async () => {
    const { dict } = await seed();
    const v = await migrate(db, [...MIGRATIONS, 'ALTER TABLE dictionaries ADD COLUMN test_col TEXT;']);
    expect(v).toBe(MIGRATIONS.length + 1);
    expect((await repo.listEntries(db, { dictionaryId: dict })).length).toBe(3);
  });
  it('rolls back a failing migration', async () => {
    await seed();
    await expect(migrate(db, [...MIGRATIONS, 'CREATE TABLE x (id TEXT); THIS IS NOT SQL;'])).rejects.toThrow();
    expect(await migrate(db)).toBe(MIGRATIONS.length);
    expect(await db.getAllAsync("SELECT name FROM sqlite_master WHERE name = 'x'", [])).toEqual([]);
  });
  it('upgrades version 1 data: old skills become directions, studied words count as shown', async () => {
    const old = openTestDb();
    await migrate(old, MIGRATIONS.slice(0, 1));
    await old.runAsync("INSERT INTO dictionaries (id, name, color, created_at, updated_at) VALUES ('d', 'D', '#000', 1, 1)", []);
    for (const id of ['a', 'b']) {
      await old.runAsync("INSERT INTO entries (id, dictionary_id, korean, korean_norm, created_at, updated_at) VALUES (?, 'd', ?, ?, 1, 1)", [id, id, id]);
    }
    await old.runAsync("INSERT INTO review_cards (id, entry_id, skill, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review) VALUES ('c1', 'a', 'recall', 5, 3, 5, 0, 3, 0, 1, 0, 2, 2)", []);
    await old.runAsync("INSERT INTO review_cards (id, entry_id, skill, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review) VALUES ('c2', 'a', 'typing', 5, 3, 5, 0, 3, 0, 1, 0, 2, 2)", []);
    await old.runAsync("INSERT INTO review_history (id, entry_id, skill, rating, state, due, stability, difficulty, elapsed_days, scheduled_days, reviewed_at) VALUES ('h', 'a', 'recall', 3, 0, 5, 3, 5, 0, 3, 1234)", []);
    await old.runAsync("INSERT INTO practice_attempts (id, entry_id, skill, mode, is_correct, created_at) VALUES ('p', 'a', 'typing', 'typing', 1, 1234)", []);
    expect(await migrate(old)).toBe(MIGRATIONS.length);
    expect(await old.getAllAsync('SELECT skill FROM review_cards ORDER BY id', [])).toEqual([{ skill: 'ko_ru' }, { skill: 'ru_ko' }]);
    expect(await old.getAllAsync('SELECT skill FROM review_history', [])).toEqual([{ skill: 'ko_ru' }]);
    expect(await old.getAllAsync('SELECT skill, mode, self_accepted FROM practice_attempts', [])).toEqual([{ skill: 'ru_ko', mode: 'review', self_accepted: 0 }]);
    expect(await old.getAllAsync('SELECT id, introduced_at FROM entries ORDER BY id', [])).toEqual([
      { id: 'a', introduced_at: 1234 },
      { id: 'b', introduced_at: null },
    ]);
  });
});

describe('dictionaries and entries', () => {
  it('creates, reads, updates and deletes', async () => {
    const { dict, ids } = await seed();
    const id = await repo.createEntry(db, dict, {
      korean: '학교', // 학교, decomposed
      meanings: ['школа; school'],
      example: '학교에 가요',
      exampleTranslation: 'Иду в школу',
      tags: ['места', 'места', ' '],
      notes: ' заметка ',
    }, NOW + 10);
    const e = await repo.getEntry(db, id);
    expect(e).toMatchObject({ korean: '학교', meanings: ['школа', 'school'], romanization: 'hakgyo', example: '학교에 가요', exampleTranslation: 'Иду в школу', tags: ['места'], notes: 'заметка', mastery: 'new', introduced_at: null });
    await repo.updateEntry(db, id, { korean: '학교', meanings: ['школа'], transcription: 'хаккё' });
    expect(await repo.getEntry(db, id)).toMatchObject({ meanings: ['школа'], transcription: 'хаккё', example: null, tags: [] });
    const list = await repo.listEntries(db, { dictionaryId: dict });
    expect(list.map((x) => x.korean)).toEqual(['나무', '물', '사과', '학교']);
    await repo.deleteEntry(db, ids[0]);
    expect((await repo.listEntries(db, { dictionaryId: dict })).length).toBe(3);
    const left = await db.getAllAsync('SELECT * FROM entry_meanings WHERE entry_id = ?', [ids[0]]);
    expect(left).toEqual([]);
  });
  it('rejects entries without the two required fields', async () => {
    const { dict } = await seed([]);
    await expect(repo.createEntry(db, dict, { korean: ' ', meanings: ['x'] })).rejects.toThrow();
    await expect(repo.createEntry(db, dict, { korean: '물', meanings: [' ; '] })).rejects.toThrow();
    expect(await repo.listEntries(db, { dictionaryId: dict })).toEqual([]);
  });
  it('searches by korean, translation and romanization', async () => {
    const { dict } = await seed();
    const find = async (search: string) => (await repo.listEntries(db, { dictionaryId: dict, search })).map((e) => e.korean);
    expect(await find('나')).toEqual(['나무']);
    expect(await find('ябл')).toEqual(['사과']);
    expect(await find('mul')).toEqual(['물']);
    expect(await find('zzz')).toEqual([]);
  });
  it('finds duplicates regardless of unicode form', async () => {
    const { dict } = await seed();
    const dup = await repo.findDuplicates(db, dict, ['나무', '집']);
    expect([...dup]).toEqual(['나무']);
    expect(dup.has(repo.duplicateKey(' 나무 '))).toBe(true);
  });
  it('summarises, duplicates and cascades on delete', async () => {
    const { dict, ids } = await seed();
    await repo.recordReview(db, { entryId: ids[0], skill: 'ko_ru', mode: 'review', rating: Rating.Good, now: NOW, retention: 0.9 });
    const copy = (await repo.duplicateDictionary(db, dict, 'Копия', NOW + 5)) as string;
    const list = await repo.listDictionaries(db, NOW + DAY * 2);
    expect(list.find((d) => d.id === dict)).toMatchObject({ entry_count: 3, due_count: 1, new_count: 2 });
    expect(list.find((d) => d.id === copy)).toMatchObject({ name: 'Копия', entry_count: 3, due_count: 0, new_count: 3 });
    expect((await repo.listEntries(db, { dictionaryId: copy })).map((e) => e.korean)).toEqual(['나무', '물', '사과']);
    await repo.updateDictionary(db, copy, { is_archived: 1 });
    expect((await repo.listDictionaries(db, NOW)).map((d) => d.id)).toEqual([dict]);
    await repo.deleteDictionary(db, dict);
    const rows = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM entries WHERE dictionary_id = ?', [dict]);
    expect(rows?.n).toBe(0);
    const cards = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM review_cards', []);
    expect(cards?.n).toBe(0);
    const history = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM review_history', []);
    expect(history?.n).toBe(1); // history outlives the content
  });
  it('imports in file order and exports the same rows', async () => {
    const { dict } = await seed([]);
    const rows = [
      { korean: '하나', meanings: ['один'] },
      { korean: '둘', meanings: ['два', 'two'], transcription: 'dul', example: '둘이에요', exampleTranslation: 'Это два' },
    ];
    expect(await repo.importEntries(db, dict, rows, NOW)).toBe(2);
    expect((await repo.listEntries(db, { dictionaryId: dict })).map((e) => e.korean)).toEqual(['하나', '둘']);
    const out = await repo.exportRows(db, dict);
    expect(out.map((r) => r.korean)).toEqual(['하나', '둘']);
    expect((await plan(NOW, { dictionaryIds: [dict] })).fresh).toEqual(await (async () => (await repo.listEntries(db, { dictionaryId: dict })).map((e) => e.id))());
    expect(out.find((r) => r.korean === '둘')).toEqual(rows[1]);
  });
  it('import is all-or-nothing', async () => {
    const { dict } = await seed([]);
    await expect(repo.importEntries(db, dict, [{ korean: '하나', meanings: ['один'] }, { korean: '', meanings: [] }], NOW)).rejects.toThrow();
    expect(await repo.listEntries(db, { dictionaryId: dict })).toEqual([]);
  });
});

describe('study plan', () => {
  it('offers new words within the daily limit, counted by words shown today', async () => {
    const { ids } = await seed();
    expect((await plan(NOW, { newPerDay: 2 })).fresh).toEqual(ids.slice(0, 2));
    let s = await startFromPlan(NOW, { newPerDay: 2 });
    s = await step(s, true, NOW); // intro of the first word
    expect((await plan(NOW + 1000, { newPerDay: 2 })).fresh).toEqual([ids[1]]);
    expect(await repo.introducedToday(db, NOW)).toBe(1);
    expect((await plan(NOW + DAY, { newPerDay: 2 })).fresh).toEqual(ids.slice(1, 3));
    expect(s.queue.length).toBeGreaterThan(0);
  });

  it('a shown word is not new any more, but is not learned either', async () => {
    const { ids } = await seed();
    let s = await startFromPlan(NOW);
    s = await step(s, true, NOW);
    const e = await repo.getEntry(db, ids[0]);
    expect(e?.mastery).toBe('learning');
    expect(await count('SELECT COUNT(*) AS n FROM review_cards')).toBe(0);
    expect(await db.getAllAsync('SELECT direction, phase, errors FROM acquisition ORDER BY direction', [])).toEqual([
      { direction: 'ko_ru', phase: 'recognition', errors: 0 },
      { direction: 'ru_ko', phase: 'recognition', errors: 0 },
    ]);
    const o = await repo.getOverview(db, NOW);
    expect(o).toMatchObject({ newWords: 2, learningWords: 1, stableWords: 0, newToday: 1 });
  });

  it('puts a card into FSRS only when training ends, with the first rating from the training errors', async () => {
    const { ids } = await seed([['나무', 'дерево']]);
    let s = await startFromPlan(NOW, { directions: ['ko_ru'] });
    s = await step(s, true, NOW); // intro
    s = await step(s, false, NOW + 1000); // wrong choice
    expect(await count('SELECT COUNT(*) AS n FROM review_cards')).toBe(0);
    s = await step(s, true, NOW + 2000); // right choice
    expect(await count('SELECT COUNT(*) AS n FROM review_cards')).toBe(0);
    s = await step(s, true, NOW + 3000); // right recall: graduates with Hard
    const card = await repo.getCard(db, ids[0], 'ko_ru');
    expect(card).not.toBeNull();
    expect(card?.state).toBe(State.Review);
    expect(await db.getAllAsync('SELECT rating, skill FROM review_history', [])).toEqual([{ rating: GRADE.hard, skill: 'ko_ru' }]);
    expect(await count('SELECT COUNT(*) AS n FROM acquisition')).toBe(0);
    // The interval is the algorithm's: the same as FSRS gives a new card rated Hard at that moment.
    expect(card?.due).toBe(reviewCard(newCard(NOW + 3000), GRADE.hard, NOW + 3000, 0.9).card.due);
    expect((card?.due ?? 0) - (NOW + 3000)).toBeGreaterThanOrEqual(DAY);
    expect(s.queue).toEqual([]);
  });

  it('a training without errors schedules the first review later than one with errors', async () => {
    const { ids } = await seed([['나무', 'дерево'], ['물', 'вода']]);
    let s = await startFromPlan(NOW, { directions: ['ko_ru'] });
    let missed = false;
    while (currentTask(s)) {
      const task = currentTask(s);
      const wrong = !missed && task?.kind === 'recognize' && s.cards[task.key].entryId === ids[1];
      if (wrong) missed = true;
      s = await step(s, !wrong, NOW + 5000);
    }
    const days = async (id: string) => Math.round((((await repo.getCard(db, id, 'ko_ru'))?.due ?? 0) - NOW) / DAY);
    expect(await days(ids[0])).toBeGreaterThan(await days(ids[1])); // Good comes back later than Hard
    expect(await days(ids[1])).toBeGreaterThanOrEqual(1); // no minute-level steps
  });

  it('leaving in the middle keeps every step; the next session continues from the same stage', async () => {
    const { ids } = await seed([['나무', 'дерево']]);
    let s = await startFromPlan(NOW, { directions: ['ko_ru'] });
    s = await step(s, true, NOW); // intro
    s = await step(s, true, NOW + 1000); // recognition passed → recall is next
    // The learner closes the app here.
    const p = await plan(NOW + 60000, { directions: ['ko_ru'] });
    expect(p.fresh).toEqual([]);
    expect(p.learning).toEqual([{ entryId: ids[0], direction: 'ko_ru', phase: 'recall', errors: 0, reintroduce: false }]);
    const resumed = createSession({ ...p, directions: ['ko_ru'], hasChoice: () => true });
    const task = currentTask(resumed);
    expect(task?.kind === 'recall' && task.purpose).toBe('acquisition');
  });

  it('shows a word again when its training was interrupted more than a day ago', async () => {
    await seed([['나무', 'дерево']]);
    let s = await startFromPlan(NOW, { directions: ['ko_ru'] });
    s = await step(s, true, NOW);
    expect((await plan(NOW + 2 * DAY, { directions: ['ko_ru'] })).learning[0].reintroduce).toBe(true);
  });

  it('reviews only one direction of a word per session and keeps paused dictionaries out', async () => {
    const { dict, ids } = await seed([['나무', 'дерево']]);
    for (const d of BOTH) await repo.recordReview(db, { entryId: ids[0], skill: d, mode: 'review', rating: Rating.Good, now: NOW, retention: 0.9 });
    const later = NOW + 30 * DAY;
    const p = await plan(later);
    expect(p.reviews).toHaveLength(1);
    expect(p.learning).toEqual([]);
    expect(await repo.getPlanCounts(db, { dictionaryIds: [], directions: BOTH, now: later, newPerDay: 20, maxReviews: 100 })).toEqual({ due: 1, learning: 0, fresh: 0 });
    await repo.updateDictionary(db, dict, { is_paused: 1 });
    expect((await plan(later)).reviews).toEqual([]);
    expect((await plan(later, { dictionaryIds: [dict] })).reviews).toHaveLength(1);
  });

  it('after one direction of a word was reviewed today, the other waits until tomorrow', async () => {
    const { ids } = await seed([['나무', 'дерево']]);
    for (const d of BOTH) await repo.recordReview(db, { entryId: ids[0], skill: d, mode: 'review', rating: Rating.Good, now: NOW, retention: 0.9 });
    const later = NOW + 30 * DAY;
    let s = await startFromPlan(later);
    expect(s.queue).toHaveLength(1);
    s = await step(s, true, later + 1000);
    expect((await plan(later + 2000)).reviews).toEqual([]);
    expect((await plan(later + DAY)).reviews).toHaveLength(1);
  });

  it('starts the second direction for a word whose first direction is already scheduled', async () => {
    const { ids } = await seed([['나무', 'дерево']]);
    await repo.recordReview(db, { entryId: ids[0], skill: 'ko_ru', mode: 'review', rating: Rating.Good, now: NOW, retention: 0.9 });
    const p = await plan(NOW + 1000);
    expect(p.learning).toEqual([{ entryId: ids[0], direction: 'ru_ko', phase: 'recognition', errors: 0, reintroduce: false }]);
    expect((await plan(NOW + 1000, { directions: ['ko_ru'] })).learning).toEqual([]);
  });

  it('a wrong review is rated once in FSRS; relearning in the same session is only logged', async () => {
    const { ids } = await seed([['나무', 'дерево']]);
    await repo.recordReview(db, { entryId: ids[0], skill: 'ko_ru', mode: 'review', rating: Rating.Good, now: NOW, retention: 0.9 });
    const later = NOW + 10 * DAY;
    const before = (await repo.getCard(db, ids[0], 'ko_ru')) as NonNullable<Awaited<ReturnType<typeof repo.getCard>>>;
    let s = await startFromPlan(later, { directions: ['ko_ru'] });
    s = await step(s, false, later);
    s = await step(s, false, later + 1000);
    s = await step(s, true, later + 2000);
    expect(s.queue).toEqual([]);
    const history = await db.getAllAsync<{ rating: number }>('SELECT rating FROM review_history ORDER BY reviewed_at', []);
    expect(history.map((h) => h.rating)).toEqual([Rating.Good, Rating.Again]);
    expect(await db.getAllAsync('SELECT mode, is_correct, rating FROM practice_attempts ORDER BY created_at', [])).toEqual([
      { mode: 'review', is_correct: 1, rating: Rating.Good },
      { mode: 'review', is_correct: 0, rating: Rating.Again },
      { mode: 'relearn', is_correct: 0, rating: null },
      { mode: 'relearn', is_correct: 1, rating: null },
    ]);
    const card = await repo.getCard(db, ids[0], 'ko_ru');
    expect(card?.lapses).toBe(1);
    // The new interval is exactly the algorithm's answer to Again, and shorter than the time that passed.
    expect(card?.due).toBe(reviewCard(before, GRADE.again, later, 0.9).card.due);
    expect((card?.due ?? 0) - later).toBeLessThan(later - NOW);
  });

  it('applyEffects is atomic', async () => {
    const { ids } = await seed([['나무', 'дерево']]);
    await expect(
      repo.applyEffects(
        db,
        [
          { type: 'introduce', entryId: ids[0], directions: ['ko_ru'] },
          { type: 'phase', entryId: 'missing-entry', direction: 'ko_ru', phase: 'recall', errors: 0 },
        ],
        { now: NOW, retention: 0.9 },
      ),
    ).rejects.toThrow();
    expect((await repo.getEntry(db, ids[0]))?.introduced_at).toBeNull();
  });
});

describe('statistics', () => {
  it('keeps recognition and recall apart and counts every answer', async () => {
    await seed([['나무', 'дерево'], ['물', 'вода']]);
    let s = await startFromPlan(NOW, { directions: ['ko_ru'] });
    let n = 0;
    while (currentTask(s)) s = await step(s, currentTask(s)?.kind === 'intro' || n++ !== 0, NOW + n * 1000);
    expect(await repo.getAccuracy(db)).toEqual([
      { kind: 'recognition', total: 3, correct: 2 },
      { kind: 'ko_ru', total: 2, correct: 2 },
    ]);
    const o = await repo.getOverview(db, NOW + DAY / 4);
    expect(o).toMatchObject({ totalWords: 2, newWords: 0, learningWords: 2, stableWords: 0, answersToday: 5, newToday: 2, totalAnswers: 5, streakDays: 1 });
    const hardest = await repo.getHardestWords(db, 5);
    expect(hardest).toHaveLength(1);
    expect(hardest[0]).toMatchObject({ mistakes: 1, answers: 3 });
    const act = await repo.getDailyActivity(db, NOW, 3);
    expect(act.map((d) => [d.answers, d.correct])).toEqual([[0, 0], [0, 0], [5, 4]]);
    const forecast = await repo.getForecast(db, NOW, 4);
    expect(forecast.reduce((a, d) => a + d.count, 0)).toBe(2);
    expect(forecast[0].count).toBe(0);
  });

  it('counts a word as stable only when every scheduled direction has a long interval', async () => {
    const { ids } = await seed([['나무', 'дерево']]);
    let t = NOW;
    for (let i = 0; i < 6; i++) {
      const c = await repo.recordReview(db, { entryId: ids[0], skill: 'ko_ru', mode: 'review', rating: Rating.Good, now: t, retention: 0.9 });
      t = c.due;
    }
    expect((await repo.getEntry(db, ids[0]))?.mastery).toBe('stable');
    await repo.applyEffects(db, [{ type: 'phase', entryId: ids[0], direction: 'ru_ko', phase: 'recognition', errors: 0 }], { now: t, retention: 0.9 });
    expect((await repo.getEntry(db, ids[0]))?.mastery).toBe('learning');
    expect((await repo.getOverview(db, t)).stableWords).toBe(0);
  });

  it('counts the streak from answers', async () => {
    const { ids } = await seed([['나무', 'дерево']]);
    for (const d of [2, 1, 0]) await repo.recordReview(db, { entryId: ids[0], skill: 'ko_ru', mode: 'review', rating: Rating.Good, now: NOW - d * DAY, retention: 0.9 });
    expect(await repo.getStreak(db, NOW)).toBe(3);
    expect(await repo.getStreak(db, NOW + DAY)).toBe(3);
    expect(await repo.getStreak(db, NOW + 2 * DAY)).toBe(0);
  });
});

describe('preferences and backup', () => {
  it('stores preferences', async () => {
    await repo.savePreference(db, 'language', 'ru');
    await repo.savePreference(db, 'language', 'en');
    // Migration v3 also stores the FSRS configuration id here.
    expect(await repo.loadPreferences(db)).toEqual({ language: 'en', fsrsConfigId: '"namu-fsrs-1"' });
  });

  it('restores dictionaries, training stages and review history into an empty database', async () => {
    const { ids } = await seed();
    let s = await startFromPlan(NOW);
    for (let i = 0; i < 6; i++) s = await step(s, true, NOW + i * 1000);
    await repo.recordReview(db, { entryId: ids[2], skill: 'ko_ru', mode: 'review', rating: Rating.Good, now: NOW, retention: 0.9 });
    await repo.savePreference(db, 'newPerDay', '15');
    const json = JSON.stringify(await repo.exportBackup(db, NOW));
    expect(JSON.parse(json).tables.acquisition.length).toBeGreaterThan(0);

    const fresh = openTestDb();
    await migrate(fresh);
    expect(await repo.restoreBackup(fresh, repo.parseBackup(json))).toBeGreaterThan(10);
    expect(JSON.stringify(await repo.exportBackup(fresh, NOW))).toBe(json);
  });

  it('reads version 1 backups', async () => {
    const { ids } = await seed([['나무', 'дерево']]);
    await repo.recordReview(db, { entryId: ids[0], skill: 'ko_ru', mode: 'review', rating: Rating.Good, now: NOW, retention: 0.9 });
    const b = await repo.exportBackup(db, NOW);
    const v1 = {
      ...b,
      version: 1,
      tables: {
        ...b.tables,
        acquisition: undefined,
        entries: b.tables.entries.map(({ introduced_at, ...rest }) => rest),
        review_cards: b.tables.review_cards.map((r) => ({ ...r, skill: 'recall' })),
        review_history: b.tables.review_history.map((r) => ({ ...r, skill: 'recall' })),
        practice_attempts: b.tables.practice_attempts.map(({ self_accepted, ...r }) => ({ ...r, skill: 'recall', mode: 'cards' })),
      },
    };
    const fresh = openTestDb();
    await migrate(fresh);
    await repo.restoreBackup(fresh, repo.parseBackup(JSON.stringify(v1)));
    expect(await repo.getCard(fresh, ids[0], 'ko_ru')).not.toBeNull();
    expect((await repo.getEntry(fresh, ids[0]))?.introduced_at).toBe(NOW);
    expect(await fresh.getAllAsync('SELECT skill, mode, self_accepted FROM practice_attempts', [])).toEqual([{ skill: 'ko_ru', mode: 'review', self_accepted: 0 }]);
  });

  it('merges without losing newer data', async () => {
    const { dict, ids } = await seed();
    const backup = await repo.exportBackup(db, NOW);
    const added = await repo.createEntry(db, dict, { korean: '집', meanings: ['дом'] }, NOW + 50);
    await repo.recordReview(db, { entryId: ids[0], skill: 'ko_ru', mode: 'review', rating: Rating.Good, now: NOW, retention: 0.9 });
    await repo.deleteEntry(db, ids[2]);
    await repo.restoreBackup(db, repo.parseBackup(JSON.stringify(backup)));
    const words = (await repo.listEntries(db, { dictionaryId: dict })).map((e) => e.korean).sort();
    expect(words).toEqual(['나무', '물', '사과', '집'].sort());
    expect(await repo.getEntry(db, added)).not.toBeNull();
    expect((await repo.getCard(db, ids[0], 'ko_ru'))?.reps).toBe(1);
  });

  it('rejects files that are not backups and leaves data untouched on a broken one', async () => {
    const { dict } = await seed();
    expect(() => repo.parseBackup('hello')).toThrow('not_json');
    expect(() => repo.parseBackup('{"a":1}')).toThrow('not_backup');
    expect(() => repo.parseBackup('{"format":"namu-backup","version":9,"tables":{}}')).toThrow('unsupported_version');
    expect(() => repo.parseBackup('{"format":"namu-backup","version":1,"tables":{"entries":[{"id":{"x":1}}]}}')).toThrow('not_backup');
    const broken = repo.parseBackup(JSON.stringify({ format: 'namu-backup', version: 1, tables: { dictionaries: [{ id: 'd2', name: 'X', color: '#000', created_at: 1, updated_at: 1 }], entries: [{ id: 'e9', dictionary_id: 'missing' }] } }));
    await expect(repo.restoreBackup(db, broken)).rejects.toThrow();
    expect((await repo.listDictionaries(db, NOW)).map((d) => d.id)).toEqual([dict]);
  });
});
