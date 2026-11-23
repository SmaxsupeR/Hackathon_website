/// <reference types="node" />
// Migration v3 and backup compatibility, checked on fixtures made with the v2 code
// (src/db/fixtures: a real v2 database file and v1/v2 backups of the same data).
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FSRS_CONFIG } from '../core/fsrsConfig';
import * as repo from './repo';
import { migrate, MIGRATIONS, TABLES, type Db } from './schema';
import { openFileDb, openTestDb } from './testing';

const FIXTURES = join(__dirname, 'fixtures');
const LATER = new Date(2026, 9, 6, 12).getTime();

function copyOfV2(): Db {
  const dir = mkdtempSync(join(tmpdir(), 'namu-migration-'));
  const path = join(dir, 'v2.sqlite');
  copyFileSync(join(FIXTURES, 'v2.sqlite'), path);
  return openFileDb(path);
}

async function fresh(): Promise<Db> {
  const db = openTestDb();
  await migrate(db);
  return db;
}

const backup = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

async function snapshot(db: Db, tables = ['dictionaries', 'entries', 'entry_meanings', 'entry_examples', 'entry_tags', 'review_cards', 'review_history', 'practice_sessions']) {
  const out: Record<string, unknown[]> = {};
  for (const t of tables) {
    const cols = TABLES[t].filter((c) => c !== 'event_id' && c !== 'kind');
    out[t] = await db.getAllAsync(`SELECT ${cols.join(', ')} FROM ${t} ORDER BY ${cols[0]}${t === 'entry_tags' ? ', tag' : ''}`, []);
  }
  return out;
}

const count = async (db: Db, sql: string) => (await db.getFirstAsync<{ n: number }>(sql, []))?.n ?? 0;

describe('migration v2 → v3 on a real v2 database', () => {
  it('keeps every word, card, FSRS state and history row', async () => {
    const db = copyOfV2();
    const before = await snapshot(db);
    const attemptsBefore = await db.getAllAsync<{ id: string; mode: string; is_correct: number }>('SELECT id, mode, is_correct FROM practice_attempts ORDER BY id', []);
    expect(await db.getFirstAsync('PRAGMA user_version', [])).toEqual({ user_version: 2 });

    expect(await migrate(db)).toBe(MIGRATIONS.length);
    expect(await db.getFirstAsync('PRAGMA user_version', [])).toEqual({ user_version: 3 });
    expect(await snapshot(db)).toEqual(before);
    const attemptsAfter = await db.getAllAsync<{ id: string; mode: string; is_correct: number }>('SELECT id, mode, is_correct FROM practice_attempts ORDER BY id', []);
    expect(attemptsAfter).toEqual(attemptsBefore);
  });

  it('fills the new attempt fields from the old data', async () => {
    const db = copyOfV2();
    await migrate(db);
    const rows = await db.getAllAsync<{ mode: string; method: string; learning_skill: string; session_kind: string; typo_corrected: number }>(
      'SELECT DISTINCT mode, method, learning_skill, session_kind, typo_corrected FROM practice_attempts ORDER BY mode',
      [],
    );
    expect(rows).toEqual([
      { mode: 'acquisition', method: 'keyboard', learning_skill: 'recall', session_kind: 'scheduled', typo_corrected: 0 },
      { mode: 'recognition', method: 'choice', learning_skill: 'recognition', session_kind: 'scheduled', typo_corrected: 0 },
      { mode: 'relearn', method: 'keyboard', learning_skill: 'recall', session_kind: 'scheduled', typo_corrected: 0 },
      { mode: 'review', method: 'keyboard', learning_skill: 'recall', session_kind: 'scheduled', typo_corrected: 0 },
    ]);
    expect(await count(db, 'SELECT COUNT(*) AS n FROM review_history WHERE event_id IS NOT NULL')).toBe(0);
    expect(await db.getAllAsync('SELECT DISTINCT kind FROM practice_sessions', [])).toEqual([{ kind: 'scheduled' }]);
    expect(await repo.ensureFsrsConfig(db)).toBe(FSRS_CONFIG.id);
  });

  it('adds the constraint that a card is never in training and scheduled at once', async () => {
    const db = copyOfV2();
    await migrate(db);
    const card = (await db.getFirstAsync<{ entry_id: string; skill: string }>('SELECT entry_id, skill FROM review_cards LIMIT 1', [])) as { entry_id: string; skill: string };
    await expect(db.runAsync("INSERT INTO acquisition (entry_id, direction, phase, errors, updated_at) VALUES (?, ?, 'recall', 0, 1)", [card.entry_id, card.skill])).rejects.toThrow(
      'card_already_scheduled',
    );
    // A card entering FSRS ends its training row.
    const parked = (await db.getFirstAsync<{ entry_id: string; direction: string }>("SELECT entry_id, direction FROM acquisition WHERE direction = 'ko_ru'", [])) as { entry_id: string; direction: string };
    await db.runAsync(
      "INSERT INTO review_cards (id, entry_id, skill, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review) VALUES ('x', ?, ?, 1, 1, 5, 0, 1, 0, 1, 0, 2, 1)",
      [parked.entry_id, parked.direction],
    );
    expect(await count(db, `SELECT COUNT(*) AS n FROM acquisition WHERE entry_id = '${parked.entry_id}' AND direction = '${parked.direction}'`)).toBe(0);
  });

  it('plans study on migrated data exactly as before', async () => {
    const db = copyOfV2();
    const opts = { dictionaryIds: [], directions: ['ko_ru', 'ru_ko'] as ('ko_ru' | 'ru_ko')[], now: LATER, newPerDay: 6, maxReviews: 100 };
    // v2 code path is gone, so compare against what the v2 fixture's own data implies: same plan before and after.
    await migrate(db, MIGRATIONS.slice(0, 2));
    const beforePlan = await repo.planSession(db, opts);
    await migrate(db);
    expect(await repo.planSession(db, opts)).toEqual(beforePlan);
    expect(beforePlan.reviews.length + beforePlan.learning.length).toBeGreaterThan(0);
  });
});

describe('backups across versions', () => {
  it('restores a version 1 backup', async () => {
    const db = await fresh();
    const n = await repo.restoreBackup(db, repo.parseBackup(backup('backup-v1.json')));
    expect(n).toBeGreaterThan(50);
    expect(await db.getAllAsync('SELECT DISTINCT skill FROM review_cards ORDER BY skill', [])).toEqual([{ skill: 'ko_ru' }, { skill: 'ru_ko' }]);
    expect(await db.getAllAsync('SELECT DISTINCT method FROM practice_attempts ORDER BY method', [])).toEqual([{ method: 'keyboard' }]);
    // v1 had no "shown" marker: words with a scheduled card count as shown.
    expect(await count(db, 'SELECT COUNT(*) AS n FROM entries WHERE introduced_at IS NULL AND EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id = entries.id)')).toBe(0);
  });

  it('restores a version 2 backup to the same data as migrating the v2 database', async () => {
    const restored = await fresh();
    await repo.restoreBackup(restored, repo.parseBackup(backup('backup-v2.json')));
    const migrated = copyOfV2();
    await migrate(migrated);
    expect(await snapshot(restored, [...Object.keys(TABLES)].filter((t) => t !== 'user_preferences'))).toEqual(await snapshot(migrated, [...Object.keys(TABLES)].filter((t) => t !== 'user_preferences')));
  });

  it('exports version 3 and restores it into an empty database unchanged', async () => {
    const db = copyOfV2();
    await migrate(db);
    const json = JSON.stringify(await repo.exportBackup(db, LATER));
    expect(JSON.parse(json).version).toBe(3);
    const other = await fresh();
    await repo.restoreBackup(other, repo.parseBackup(json));
    expect(JSON.stringify(await repo.exportBackup(other, LATER))).toBe(json);
  });

  it('restoring the same backup twice creates no duplicates', async () => {
    const db = await fresh();
    for (const name of ['backup-v2.json', 'backup-v2.json', 'backup-v1.json']) await repo.restoreBackup(db, repo.parseBackup(backup(name)));
    const once = await fresh();
    await repo.restoreBackup(once, repo.parseBackup(backup('backup-v2.json')));
    for (const t of ['entries', 'review_cards', 'review_history', 'practice_attempts', 'acquisition', 'entry_meanings']) {
      expect(await count(db, `SELECT COUNT(*) AS n FROM ${t}`)).toBe(await count(once, `SELECT COUNT(*) AS n FROM ${t}`));
    }
  });

  it('restoring an old backup over newer progress never puts a scheduled card back into training', async () => {
    const db = copyOfV2();
    await migrate(db);
    const parked = (await db.getFirstAsync<{ entry_id: string }>("SELECT entry_id FROM acquisition WHERE direction = 'ko_ru'", [])) as { entry_id: string };
    await repo.recordReview(db, { entryId: parked.entry_id, skill: 'ko_ru', mode: 'review', rating: 3, now: LATER, retention: 0.9 });
    await repo.restoreBackup(db, repo.parseBackup(backup('backup-v2.json')));
    expect(await count(db, `SELECT COUNT(*) AS n FROM acquisition WHERE entry_id = '${parked.entry_id}' AND direction = 'ko_ru'`)).toBe(0);
    expect(await repo.getCard(db, parked.entry_id, 'ko_ru')).not.toBeNull();
  });

  it('refuses incompatible files without touching the data', async () => {
    const db = copyOfV2();
    await migrate(db);
    const before = await snapshot(db);
    const v2 = JSON.parse(backup('backup-v2.json'));
    for (const version of [0, 4, 99, '2', null]) {
      expect(() => repo.parseBackup(JSON.stringify({ ...v2, version }))).toThrow('unsupported_version');
    }
    expect(() => repo.parseBackup(JSON.stringify({ ...v2, format: 'other' }))).toThrow('not_backup');
    expect(() => repo.parseBackup('{')).toThrow('not_json');
    expect(await snapshot(db)).toEqual(before);
  });
});
