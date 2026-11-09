import { beforeEach, describe, expect, it } from 'vitest';
import { Rating } from '../core/scheduler';
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

const queue = (dictionaryIds: string[], now = NOW, newPerDay = 20) => repo.getStudyQueue(db, { dictionaryIds, skill: 'recall', now, newPerDay, maxReviews: 100 });

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
    const t = await db.getAllAsync("SELECT name FROM sqlite_master WHERE name = 'x'", []);
    expect(t).toEqual([]);
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
    expect(e).toMatchObject({ korean: '학교', meanings: ['школа', 'school'], romanization: 'hakgyo', example: '학교에 가요', exampleTranslation: 'Иду в школу', tags: ['места'], notes: 'заметка', mastery: 'new', card: null });
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
    await repo.recordReview(db, { entryId: ids[0], skill: 'recall', mode: 'cards', rating: Rating.Good, now: NOW, retention: 0.9 });
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
    expect((await queue([dict])).map((i) => i.entry.korean)).toEqual(['하나', '둘']);
    expect(out.find((r) => r.korean === '둘')).toEqual(rows[1]);
  });
  it('import is all-or-nothing', async () => {
    const { dict } = await seed([]);
    await expect(repo.importEntries(db, dict, [{ korean: '하나', meanings: ['один'] }, { korean: '', meanings: [] }], NOW)).rejects.toThrow();
    expect(await repo.listEntries(db, { dictionaryId: dict })).toEqual([]);
  });
});

describe('study flow', () => {
  it('a newly added word can be studied right away and comes back later', async () => {
    const { dict, ids } = await seed();
    let q = await queue([dict]);
    expect(q.map((i) => [i.entry.korean, i.isNew])).toEqual([['나무', true], ['물', true], ['사과', true]]);
    const session = await repo.startSession(db, 'cards', [dict], NOW);
    const card = await repo.recordReview(db, { entryId: ids[0], skill: 'recall', mode: 'cards', rating: Rating.Good, now: NOW, retention: 0.9, sessionId: session, durationMs: 4000 });
    expect(card.due).toBeGreaterThan(NOW);
    await repo.recordReview(db, { entryId: ids[1], skill: 'recall', mode: 'cards', rating: Rating.Again, now: NOW + 1000, retention: 0.9, sessionId: session, durationMs: 2000 });
    await repo.finishSession(db, session, NOW + 5000);
    const s = await db.getFirstAsync<{ total: number; correct: number; finished_at: number }>('SELECT * FROM practice_sessions WHERE id = ?', [session]);
    expect(s).toMatchObject({ total: 2, correct: 1, finished_at: NOW + 5000 });

    q = await queue([dict], NOW + 2000);
    expect(q.map((i) => i.entry.korean)).toEqual(['사과']); // the others are scheduled for later
    q = await queue([dict], NOW + DAY);
    expect(q.map((i) => [i.entry.korean, i.isNew])).toEqual([['물', false], ['나무', false], ['사과', true]]);
    expect((await repo.getEntry(db, ids[0]))?.mastery).toBe('learning');
  });
  it('respects the daily limit of new words and resets next day', async () => {
    const { dict, ids } = await seed();
    expect((await queue([dict], NOW, 2)).length).toBe(2);
    await repo.recordReview(db, { entryId: ids[0], skill: 'recall', mode: 'cards', rating: Rating.Easy, now: NOW, retention: 0.9 });
    await repo.recordReview(db, { entryId: ids[1], skill: 'recall', mode: 'cards', rating: Rating.Easy, now: NOW, retention: 0.9 });
    expect(await queue([dict], NOW + 1000, 2)).toEqual([]);
    expect(await repo.getQueueCounts(db, { dictionaryIds: [dict], skill: 'recall', now: NOW + 1000, newPerDay: 2, maxReviews: 100 })).toEqual({ due: 0, fresh: 0 });
    const tomorrow = await repo.getQueueCounts(db, { dictionaryIds: [dict], skill: 'recall', now: NOW + DAY, newPerDay: 2, maxReviews: 100 });
    expect(tomorrow.fresh).toBe(1);
  });
  it('keeps skills separate', async () => {
    const { dict, ids } = await seed();
    await repo.recordReview(db, { entryId: ids[0], skill: 'typing', mode: 'typing', rating: Rating.Good, now: NOW, retention: 0.9, answerGiven: '나무' });
    expect((await repo.getEntry(db, ids[0], 'recall'))?.card).toBeNull();
    expect((await repo.getEntry(db, ids[0], 'typing'))?.card?.reps).toBe(1);
    expect((await queue([dict], NOW + 1000)).length).toBe(3);
  });
  it('skips paused and archived dictionaries in the common queue', async () => {
    const { dict } = await seed();
    expect((await queue([])).length).toBe(3);
    await repo.updateDictionary(db, dict, { is_paused: 1 });
    expect(await queue([])).toEqual([]);
    expect((await queue([dict])).length).toBe(3); // explicit choice still works
  });
});

describe('statistics', () => {
  it('reports overview, streak, activity, forecast and hardest words', async () => {
    const { ids } = await seed();
    const review = (i: number, rating: Rating, now: number) => repo.recordReview(db, { entryId: ids[i], skill: 'recall', mode: 'cards', rating: rating as 1 | 2 | 3 | 4, now, retention: 0.9, durationMs: 3000 });
    await review(0, Rating.Easy, NOW - 2 * DAY);
    await review(0, Rating.Again, NOW - DAY);
    await review(1, Rating.Good, NOW - DAY);
    await review(1, Rating.Good, NOW);
    const o = await repo.getOverview(db, NOW);
    expect(o).toMatchObject({ totalWords: 3, newWords: 1, learningWords: 2, stableWords: 0, reviewsToday: 1, newToday: 0, msToday: 3000, totalReviews: 4, totalMs: 12000, streakDays: 3 });
    expect(await repo.getStreak(db, NOW + DAY)).toBe(3);
    expect(await repo.getStreak(db, NOW + 2 * DAY)).toBe(0);
    const act = await repo.getDailyActivity(db, NOW, 7);
    expect(act.map((d) => d.reviews)).toEqual([0, 0, 0, 0, 1, 2, 1]);
    expect(act.map((d) => d.correct)).toEqual([0, 0, 0, 0, 1, 1, 1]);
    const forecast = await repo.getForecast(db, NOW, 7);
    expect(forecast.length).toBe(7);
    expect(forecast.reduce((n, d) => n + d.count, 0)).toBeGreaterThanOrEqual(1);
    expect(forecast[0].count).toBeGreaterThanOrEqual(1); // the lapsed card is overdue
    expect(await repo.getHardestWords(db, 5)).toEqual([{ id: ids[0], korean: '나무', meaning: 'дерево', lapses: 1, reps: 2 }]);
    expect(await repo.getAccuracyBySkill(db)).toEqual([{ skill: 'recall', total: 4, correct: 3 }]);
  });
});

describe('preferences and backup', () => {
  it('stores preferences', async () => {
    await repo.savePreference(db, 'language', 'ru');
    await repo.savePreference(db, 'language', 'en');
    expect(await repo.loadPreferences(db)).toEqual({ language: 'en' });
  });
  it('restores dictionaries and review history into an empty database', async () => {
    const { dict, ids } = await seed();
    await repo.createEntry(db, dict, { korean: '집', meanings: ['дом'], example: '집에 가요', tags: ['a'] }, NOW + 50);
    await repo.recordReview(db, { entryId: ids[0], skill: 'recall', mode: 'cards', rating: Rating.Good, now: NOW, retention: 0.9 });
    await repo.savePreference(db, 'newPerDay', '15');
    const json = JSON.stringify(await repo.exportBackup(db, NOW));

    const fresh = openTestDb();
    await migrate(fresh);
    const n = await repo.restoreBackup(fresh, repo.parseBackup(json));
    expect(n).toBeGreaterThan(10);
    expect(JSON.stringify(await repo.exportBackup(fresh, NOW))).toBe(json);
    expect((await repo.getEntry(fresh, ids[0]))?.card?.reps).toBe(1);
  });
  it('merges without losing newer data', async () => {
    const { dict, ids } = await seed();
    const backup = await repo.exportBackup(db, NOW);
    const added = await repo.createEntry(db, dict, { korean: '집', meanings: ['дом'] }, NOW + 50);
    await repo.recordReview(db, { entryId: ids[0], skill: 'recall', mode: 'cards', rating: Rating.Good, now: NOW, retention: 0.9 });
    await repo.deleteEntry(db, ids[2]);
    await repo.restoreBackup(db, repo.parseBackup(JSON.stringify(backup)));
    const words = (await repo.listEntries(db, { dictionaryId: dict })).map((e) => e.korean).sort();
    expect(words).toEqual(['나무', '물', '사과', '집'].sort());
    expect(await repo.getEntry(db, added)).not.toBeNull();
    expect((await repo.getEntry(db, ids[0]))?.card?.reps).toBe(1);
    expect((await repo.getEntry(db, ids[0]))?.meanings).toEqual(['дерево']);
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
