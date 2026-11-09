// All database reads and writes. No UI code here; every function takes the database handle.
import { splitMeanings, type ImportRow } from '../core/importer';
import { normalizeHangul, romanize } from '../core/hangul';
import { newId } from '../core/id';
import { mastery, newCard, reviewCard, STABLE_DAYS, State, type CardState, type Mastery, type Skill } from '../core/scheduler';
import type { Grade } from 'ts-fsrs';
import { TABLES, type Db } from './schema';

const SEP = String.fromCharCode(31);
const DAY = 86400000;

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

// ---------- Dictionaries ----------

export interface Dictionary {
  id: string;
  name: string;
  description: string | null;
  color: string;
  is_favorite: number;
  is_archived: number;
  is_paused: number;
  created_at: number;
  last_used_at: number | null;
}

export interface DictionarySummary extends Dictionary {
  entry_count: number;
  due_count: number;
  new_count: number;
}

export const DICTIONARY_COLORS = ['#2F9E6E', '#3B82F6', '#F59E0B', '#EF5DA8', '#8B5CF6', '#14B8A6', '#F97316', '#64748B'];

export async function listDictionaries(db: Db, now: number, archived = false): Promise<DictionarySummary[]> {
  return db.getAllAsync<DictionarySummary>(
    `SELECT d.*,
       (SELECT COUNT(*) FROM entries e WHERE e.dictionary_id = d.id) AS entry_count,
       (SELECT COUNT(*) FROM entries e JOIN review_cards c ON c.entry_id = e.id AND c.skill = 'recall'
          WHERE e.dictionary_id = d.id AND c.state != 0 AND c.due <= ?) AS due_count,
       (SELECT COUNT(*) FROM entries e LEFT JOIN review_cards c ON c.entry_id = e.id AND c.skill = 'recall'
          WHERE e.dictionary_id = d.id AND (c.id IS NULL OR c.state = 0)) AS new_count
     FROM dictionaries d WHERE d.is_archived = ?
     ORDER BY d.is_favorite DESC, COALESCE(d.last_used_at, d.created_at) DESC`,
    [now, archived ? 1 : 0],
  );
}

export async function getDictionary(db: Db, id: string): Promise<Dictionary | null> {
  return db.getFirstAsync<Dictionary>('SELECT * FROM dictionaries WHERE id = ?', [id]);
}

export async function createDictionary(db: Db, input: { name: string; color?: string; description?: string }, now = Date.now()): Promise<string> {
  const id = newId();
  await db.runAsync(
    'INSERT INTO dictionaries (id, name, description, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, input.name.trim(), input.description?.trim() || null, input.color ?? DICTIONARY_COLORS[0], now, now],
  );
  return id;
}

export async function updateDictionary(
  db: Db,
  id: string,
  patch: Partial<Pick<Dictionary, 'name' | 'description' | 'color' | 'is_favorite' | 'is_archived' | 'is_paused' | 'last_used_at'>>,
  now = Date.now(),
): Promise<void> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  if (keys.length === 0) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  await db.runAsync(`UPDATE dictionaries SET ${sets}, updated_at = ? WHERE id = ?`, [...keys.map((k) => patch[k] ?? null), now, id]);
}

export async function deleteDictionary(db: Db, id: string): Promise<void> {
  await db.runAsync('DELETE FROM dictionaries WHERE id = ?', [id]);
}

/** Copies a dictionary with its words. Learning progress is not copied. */
export async function duplicateDictionary(db: Db, id: string, name: string, now = Date.now()): Promise<string | null> {
  const src = await getDictionary(db, id);
  if (!src) return null;
  const entries = await listEntries(db, { dictionaryId: id });
  let copyId = '';
  await db.withTransactionAsync(async () => {
    copyId = await createDictionary(db, { name, color: src.color, description: src.description ?? undefined }, now);
    for (const e of entries) await insertEntry(db, copyId, entryToInput(e), e.created_at);
  });
  return copyId;
}

// ---------- Entries ----------

export interface EntryInput {
  korean: string;
  meanings: string[];
  transcription?: string | null;
  romanization?: string | null;
  example?: string | null;
  exampleTranslation?: string | null;
  partOfSpeech?: string | null;
  notes?: string | null;
  tags?: string[];
}

export interface Entry {
  id: string;
  dictionary_id: string;
  korean: string;
  romanization: string | null;
  transcription: string | null;
  part_of_speech: string | null;
  notes: string | null;
  created_at: number;
  meanings: string[];
  example: string | null;
  exampleTranslation: string | null;
  tags: string[];
  card: CardState | null;
  mastery: Mastery;
}

interface EntryRow extends CardColumns {
  id: string;
  dictionary_id: string;
  korean: string;
  romanization: string | null;
  transcription: string | null;
  part_of_speech: string | null;
  notes: string | null;
  created_at: number;
  meanings: string | null;
  example: string | null;
  example_translation: string | null;
  tags: string | null;
  card_id: string | null;
}

interface CardColumns {
  due: number | null;
  stability: number | null;
  difficulty: number | null;
  elapsed_days: number | null;
  scheduled_days: number | null;
  learning_steps: number | null;
  reps: number | null;
  lapses: number | null;
  state: number | null;
  last_review: number | null;
}

const ENTRY_SELECT = `
  SELECT e.id, e.dictionary_id, e.korean, e.romanization, e.transcription, e.part_of_speech, e.notes, e.created_at,
    (SELECT group_concat(text, char(31)) FROM (SELECT text FROM entry_meanings WHERE entry_id = e.id ORDER BY position)) AS meanings,
    (SELECT korean FROM entry_examples WHERE entry_id = e.id ORDER BY position LIMIT 1) AS example,
    (SELECT translation FROM entry_examples WHERE entry_id = e.id ORDER BY position LIMIT 1) AS example_translation,
    (SELECT group_concat(tag, char(31)) FROM entry_tags WHERE entry_id = e.id) AS tags,
    c.id AS card_id, c.due, c.stability, c.difficulty, c.elapsed_days, c.scheduled_days, c.learning_steps, c.reps, c.lapses, c.state, c.last_review
  FROM entries e
  JOIN dictionaries d ON d.id = e.dictionary_id
  LEFT JOIN review_cards c ON c.entry_id = e.id AND c.skill = ?`;

function rowToCard(r: CardColumns & { card_id: string | null }): CardState | null {
  if (!r.card_id) return null;
  return {
    due: r.due as number,
    stability: r.stability as number,
    difficulty: r.difficulty as number,
    elapsed_days: r.elapsed_days as number,
    scheduled_days: r.scheduled_days as number,
    learning_steps: r.learning_steps as number,
    reps: r.reps as number,
    lapses: r.lapses as number,
    state: r.state as State,
    last_review: r.last_review,
  };
}

function rowToEntry(r: EntryRow): Entry {
  const card = rowToCard(r);
  return {
    id: r.id,
    dictionary_id: r.dictionary_id,
    korean: r.korean,
    romanization: r.romanization,
    transcription: r.transcription,
    part_of_speech: r.part_of_speech,
    notes: r.notes,
    created_at: r.created_at,
    meanings: r.meanings ? r.meanings.split(SEP) : [],
    example: r.example,
    exampleTranslation: r.example_translation,
    tags: r.tags ? r.tags.split(SEP) : [],
    card,
    mastery: mastery(card),
  };
}

function entryToInput(e: Entry): EntryInput {
  return {
    korean: e.korean,
    meanings: e.meanings,
    transcription: e.transcription,
    romanization: e.romanization,
    example: e.example,
    exampleTranslation: e.exampleTranslation,
    partOfSpeech: e.part_of_speech,
    notes: e.notes,
    tags: e.tags,
  };
}

export async function listEntries(db: Db, opts: { dictionaryId: string; search?: string; skill?: Skill }): Promise<Entry[]> {
  const params: (string | number)[] = [opts.skill ?? 'recall', opts.dictionaryId];
  let where = 'WHERE e.dictionary_id = ?';
  const q = opts.search?.trim();
  if (q) {
    where += ` AND (e.korean_norm LIKE ? OR e.romanization LIKE ? OR e.transcription LIKE ?
      OR EXISTS (SELECT 1 FROM entry_meanings m WHERE m.entry_id = e.id AND m.text LIKE ?))`;
    const like = `%${normalizeHangul(q)}%`;
    params.push(like, like, like, like);
  }
  const rows = await db.getAllAsync<EntryRow>(`${ENTRY_SELECT} ${where} ORDER BY e.created_at, e.rowid`, params);
  return rows.map(rowToEntry);
}

export async function getEntry(db: Db, id: string, skill: Skill = 'recall'): Promise<Entry | null> {
  const row = await db.getFirstAsync<EntryRow>(`${ENTRY_SELECT} WHERE e.id = ?`, [skill, id]);
  return row ? rowToEntry(row) : null;
}

function cleanInput(input: EntryInput): EntryInput {
  const korean = normalizeHangul(input.korean).trim();
  const meanings = input.meanings.flatMap(splitMeanings);
  if (korean === '' || meanings.length === 0) throw new Error('Entry needs a Korean word and a translation');
  return { ...input, korean, meanings };
}

async function writeEntryDetails(db: Db, id: string, input: EntryInput): Promise<void> {
  await db.runAsync('DELETE FROM entry_meanings WHERE entry_id = ?', [id]);
  await db.runAsync('DELETE FROM entry_examples WHERE entry_id = ?', [id]);
  await db.runAsync('DELETE FROM entry_tags WHERE entry_id = ?', [id]);
  for (let i = 0; i < input.meanings.length; i++) {
    await db.runAsync('INSERT INTO entry_meanings (id, entry_id, text, position) VALUES (?, ?, ?, ?)', [newId(), id, input.meanings[i], i]);
  }
  if (input.example?.trim()) {
    await db.runAsync('INSERT INTO entry_examples (id, entry_id, korean, translation, position) VALUES (?, ?, ?, ?, 0)', [
      newId(),
      id,
      normalizeHangul(input.example).trim(),
      input.exampleTranslation?.trim() || null,
    ]);
  }
  for (const tag of new Set((input.tags ?? []).map((t) => t.trim()).filter(Boolean))) {
    await db.runAsync('INSERT INTO entry_tags (entry_id, tag) VALUES (?, ?)', [id, tag]);
  }
}

async function insertEntry(db: Db, dictionaryId: string, raw: EntryInput, now: number): Promise<string> {
  const input = cleanInput(raw);
  const id = newId();
  await db.runAsync(
    `INSERT INTO entries (id, dictionary_id, korean, korean_norm, romanization, transcription, part_of_speech, notes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      dictionaryId,
      input.korean,
      input.korean.toLowerCase(),
      input.romanization?.trim() || romanize(input.korean),
      input.transcription?.trim() || null,
      input.partOfSpeech?.trim() || null,
      input.notes?.trim() || null,
      now,
      now,
    ],
  );
  await writeEntryDetails(db, id, input);
  return id;
}

export async function createEntry(db: Db, dictionaryId: string, input: EntryInput, now = Date.now()): Promise<string> {
  let id = '';
  await db.withTransactionAsync(async () => {
    id = await insertEntry(db, dictionaryId, input, now);
  });
  return id;
}

export async function updateEntry(db: Db, id: string, raw: EntryInput, now = Date.now()): Promise<void> {
  const input = cleanInput(raw);
  await db.withTransactionAsync(async () => {
    await db.runAsync(
      `UPDATE entries SET korean = ?, korean_norm = ?, romanization = ?, transcription = ?, part_of_speech = ?, notes = ?, updated_at = ? WHERE id = ?`,
      [
        input.korean,
        input.korean.toLowerCase(),
        input.romanization?.trim() || romanize(input.korean),
        input.transcription?.trim() || null,
        input.partOfSpeech?.trim() || null,
        input.notes?.trim() || null,
        now,
        id,
      ],
    );
    await writeEntryDetails(db, id, input);
  });
}

export async function deleteEntry(db: Db, id: string): Promise<void> {
  await db.runAsync('DELETE FROM entries WHERE id = ?', [id]);
}

/** Returns which of the given words already exist in the dictionary. */
export async function findDuplicates(db: Db, dictionaryId: string, words: string[]): Promise<Set<string>> {
  const norms = [...new Set(words.map((w) => normalizeHangul(w).trim().toLowerCase()))];
  const found = new Set<string>();
  for (let i = 0; i < norms.length; i += 200) {
    const chunk = norms.slice(i, i + 200);
    const rows = await db.getAllAsync<{ korean_norm: string }>(
      `SELECT DISTINCT korean_norm FROM entries WHERE dictionary_id = ? AND korean_norm IN (${placeholders(chunk.length)})`,
      [dictionaryId, ...chunk],
    );
    rows.forEach((r) => found.add(r.korean_norm));
  }
  return found;
}

export function duplicateKey(korean: string): string {
  return normalizeHangul(korean).trim().toLowerCase();
}

export async function importEntries(db: Db, dictionaryId: string, rows: ImportRow[], now = Date.now()): Promise<number> {
  let n = 0;
  await db.withTransactionAsync(async () => {
    // Each row gets a later timestamp so the list and the study order follow the file.
    for (let i = 0; i < rows.length; i++) {
      await insertEntry(db, dictionaryId, rows[i], now + i);
      n++;
    }
  });
  return n;
}

export async function exportRows(db: Db, dictionaryId: string): Promise<ImportRow[]> {
  const entries = await listEntries(db, { dictionaryId });
  return entries.map((e) => ({
    korean: e.korean,
    meanings: e.meanings,
    transcription: e.transcription ?? undefined,
    example: e.example ?? undefined,
    exampleTranslation: e.exampleTranslation ?? undefined,
  }));
}

// ---------- Study ----------

export interface StudyItem {
  entry: Entry;
  isNew: boolean;
}

export interface QueueOptions {
  dictionaryIds: string[];
  skill: Skill;
  now: number;
  newPerDay: number;
  maxReviews: number;
}

export interface QueueCounts {
  due: number;
  fresh: number;
}

async function newIntroducedToday(db: Db, skill: Skill, now: number): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(DISTINCT entry_id) AS n FROM review_history WHERE skill = ? AND state = 0 AND reviewed_at >= ?',
    [skill, startOfDay(now)],
  );
  return row?.n ?? 0;
}

function scope(dictionaryIds: string[]): { sql: string; params: string[] } {
  if (dictionaryIds.length === 0) return { sql: 'd.is_archived = 0 AND d.is_paused = 0', params: [] };
  return { sql: `d.id IN (${placeholders(dictionaryIds.length)})`, params: dictionaryIds };
}

/** Words to study now: due reviews first, then new words within the daily limit. */
export async function getStudyQueue(db: Db, opts: QueueOptions): Promise<StudyItem[]> {
  const s = scope(opts.dictionaryIds);
  const due = await db.getAllAsync<EntryRow>(
    `${ENTRY_SELECT} WHERE ${s.sql} AND c.state != 0 AND c.due <= ? ORDER BY c.due LIMIT ?`,
    [opts.skill, ...s.params, opts.now, opts.maxReviews],
  );
  const left = Math.max(0, opts.newPerDay - (await newIntroducedToday(db, opts.skill, opts.now)));
  const fresh =
    left === 0
      ? []
      : await db.getAllAsync<EntryRow>(
          `${ENTRY_SELECT} WHERE ${s.sql} AND (c.id IS NULL OR c.state = 0) ORDER BY e.created_at, e.rowid LIMIT ?`,
          [opts.skill, ...s.params, left],
        );
  return [...due.map((r) => ({ entry: rowToEntry(r), isNew: false })), ...fresh.map((r) => ({ entry: rowToEntry(r), isNew: true }))];
}

export async function getQueueCounts(db: Db, opts: QueueOptions): Promise<QueueCounts> {
  const s = scope(opts.dictionaryIds);
  const base = `FROM entries e JOIN dictionaries d ON d.id = e.dictionary_id LEFT JOIN review_cards c ON c.entry_id = e.id AND c.skill = ? WHERE ${s.sql}`;
  const due = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n ${base} AND c.state != 0 AND c.due <= ?`, [opts.skill, ...s.params, opts.now]);
  const fresh = await db.getFirstAsync<{ n: number }>(`SELECT COUNT(*) AS n ${base} AND (c.id IS NULL OR c.state = 0)`, [opts.skill, ...s.params]);
  const left = Math.max(0, opts.newPerDay - (await newIntroducedToday(db, opts.skill, opts.now)));
  return { due: Math.min(due?.n ?? 0, opts.maxReviews), fresh: Math.min(fresh?.n ?? 0, left) };
}

export async function startSession(db: Db, mode: string, dictionaryIds: string[], now = Date.now()): Promise<string> {
  const id = newId();
  await db.runAsync('INSERT INTO practice_sessions (id, mode, dictionary_ids, started_at) VALUES (?, ?, ?, ?)', [id, mode, JSON.stringify(dictionaryIds), now]);
  for (const d of dictionaryIds) await updateDictionary(db, d, { last_used_at: now }, now);
  return id;
}

export async function finishSession(db: Db, id: string, now = Date.now()): Promise<void> {
  await db.runAsync(
    `UPDATE practice_sessions SET finished_at = ?,
       total = (SELECT COUNT(*) FROM practice_attempts WHERE session_id = ?),
       correct = (SELECT COUNT(*) FROM practice_attempts WHERE session_id = ? AND is_correct = 1)
     WHERE id = ?`,
    [now, id, id, id],
  );
}

export interface ReviewInput {
  entryId: string;
  skill: Skill;
  mode: string;
  rating: Grade;
  now: number;
  retention: number;
  sessionId?: string | null;
  durationMs?: number;
  answerGiven?: string | null;
  hintsUsed?: number;
}

/** Saves one answer: updates the card's schedule and appends to the history, atomically. */
export async function recordReview(db: Db, input: ReviewInput): Promise<CardState> {
  let result: CardState | null = null;
  await db.withTransactionAsync(async () => {
    const row = await db.getFirstAsync<CardColumns & { card_id: string }>(
      'SELECT id AS card_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review FROM review_cards WHERE entry_id = ? AND skill = ?',
      [input.entryId, input.skill],
    );
    const before = (row && rowToCard(row)) ?? newCard(input.now);
    const { card, log } = reviewCard(before, input.rating, input.now, input.retention);
    const values = [card.due, card.stability, card.difficulty, card.elapsed_days, card.scheduled_days, card.learning_steps, card.reps, card.lapses, card.state, card.last_review];
    if (row) {
      await db.runAsync(
        'UPDATE review_cards SET due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?, reps = ?, lapses = ?, state = ?, last_review = ? WHERE id = ?',
        [...values, row.card_id],
      );
    } else {
      await db.runAsync(
        'INSERT INTO review_cards (due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, id, entry_id, skill) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [...values, newId(), input.entryId, input.skill],
      );
    }
    await db.runAsync(
      `INSERT INTO review_history (id, entry_id, skill, session_id, rating, state, due, stability, difficulty, elapsed_days, scheduled_days, reviewed_at, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), input.entryId, input.skill, input.sessionId ?? null, log.rating, log.state, log.due, log.stability, log.difficulty, log.elapsed_days, log.scheduled_days, log.reviewed_at, input.durationMs ?? 0],
    );
    await db.runAsync(
      `INSERT INTO practice_attempts (id, session_id, entry_id, skill, mode, is_correct, rating, answer_given, hints_used, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId(), input.sessionId ?? null, input.entryId, input.skill, input.mode, input.rating > 1 ? 1 : 0, input.rating, input.answerGiven ?? null, input.hintsUsed ?? 0, input.durationMs ?? 0, input.now],
    );
    result = card;
  });
  return result as unknown as CardState;
}

// ---------- Statistics ----------

export interface Overview {
  totalWords: number;
  newWords: number;
  learningWords: number;
  stableWords: number;
  dueNow: number;
  reviewsToday: number;
  newToday: number;
  msToday: number;
  totalReviews: number;
  totalMs: number;
  streakDays: number;
}

export async function getOverview(db: Db, now: number): Promise<Overview> {
  const today = startOfDay(now);
  const words = await db.getFirstAsync<{ total: number; learning: number; stable: number; due: number }>(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN c.state IS NOT NULL AND c.state != 0 AND NOT (c.state = 2 AND c.stability >= ${STABLE_DAYS}) THEN 1 ELSE 0 END), 0) AS learning,
       COALESCE(SUM(CASE WHEN c.state = 2 AND c.stability >= ${STABLE_DAYS} THEN 1 ELSE 0 END), 0) AS stable,
       COALESCE(SUM(CASE WHEN c.state != 0 AND c.due <= ? AND d.is_archived = 0 AND d.is_paused = 0 THEN 1 ELSE 0 END), 0) AS due
     FROM entries e JOIN dictionaries d ON d.id = e.dictionary_id
     LEFT JOIN review_cards c ON c.entry_id = e.id AND c.skill = 'recall'`,
    [now],
  );
  const day = await db.getFirstAsync<{ n: number; fresh: number; ms: number }>(
    `SELECT COUNT(*) AS n, COUNT(DISTINCT CASE WHEN state = 0 THEN entry_id END) AS fresh, COALESCE(SUM(duration_ms), 0) AS ms
     FROM review_history WHERE reviewed_at >= ?`,
    [today],
  );
  const all = await db.getFirstAsync<{ n: number; ms: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM review_history', []);
  const total = words?.total ?? 0;
  const learning = words?.learning ?? 0;
  const stable = words?.stable ?? 0;
  return {
    totalWords: total,
    newWords: total - learning - stable,
    learningWords: learning,
    stableWords: stable,
    dueNow: words?.due ?? 0,
    reviewsToday: day?.n ?? 0,
    newToday: day?.fresh ?? 0,
    msToday: day?.ms ?? 0,
    totalReviews: all?.n ?? 0,
    totalMs: all?.ms ?? 0,
    streakDays: await getStreak(db, now),
  };
}

/** Days in a row with at least one review, counting today or yesterday as the latest. */
export async function getStreak(db: Db, now: number): Promise<number> {
  const rows = await db.getAllAsync<{ reviewed_at: number }>('SELECT reviewed_at FROM review_history WHERE reviewed_at >= ? ORDER BY reviewed_at DESC', [
    startOfDay(now) - 400 * DAY,
  ]);
  const days = new Set(rows.map((r) => startOfDay(r.reviewed_at)));
  let cursor = new Date(startOfDay(now));
  if (!days.has(cursor.getTime())) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(cursor.getTime())) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

export interface DayActivity {
  day: number;
  reviews: number;
  correct: number;
}

export async function getDailyActivity(db: Db, now: number, days: number): Promise<DayActivity[]> {
  const out: DayActivity[] = [];
  const cursor = new Date(startOfDay(now));
  cursor.setDate(cursor.getDate() - (days - 1));
  const from = cursor.getTime();
  for (let i = 0; i < days; i++) {
    out.push({ day: cursor.getTime(), reviews: 0, correct: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  const index = new Map(out.map((d) => [d.day, d]));
  const rows = await db.getAllAsync<{ reviewed_at: number; rating: number }>('SELECT reviewed_at, rating FROM review_history WHERE reviewed_at >= ?', [from]);
  for (const r of rows) {
    const d = index.get(startOfDay(r.reviewed_at));
    if (!d) continue;
    d.reviews++;
    if (r.rating > 1) d.correct++;
  }
  return out;
}

/** How many reviews fall due on each of the next days. Overdue cards count for today. */
export async function getForecast(db: Db, now: number, days: number): Promise<{ day: number; count: number }[]> {
  const out: { day: number; count: number }[] = [];
  const cursor = new Date(startOfDay(now));
  for (let i = 0; i < days; i++) {
    out.push({ day: cursor.getTime(), count: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  const rows = await db.getAllAsync<{ due: number }>(
    `SELECT c.due FROM review_cards c JOIN entries e ON e.id = c.entry_id JOIN dictionaries d ON d.id = e.dictionary_id
     WHERE c.skill = 'recall' AND c.state != 0 AND c.due < ? AND d.is_archived = 0 AND d.is_paused = 0`,
    [cursor.getTime()],
  );
  for (const r of rows) {
    const day = Math.max(out[0].day, startOfDay(r.due));
    const slot = out.find((d) => d.day === day);
    if (slot) slot.count++;
  }
  return out;
}

export interface SkillAccuracy {
  skill: Skill;
  total: number;
  correct: number;
}

export async function getAccuracyBySkill(db: Db): Promise<SkillAccuracy[]> {
  return db.getAllAsync<SkillAccuracy>(
    'SELECT skill, COUNT(*) AS total, SUM(CASE WHEN rating > 1 THEN 1 ELSE 0 END) AS correct FROM review_history GROUP BY skill ORDER BY total DESC',
    [],
  );
}

export interface HardWord {
  id: string;
  korean: string;
  meaning: string | null;
  lapses: number;
  reps: number;
}

/** Words with the most "forgot" answers, across all practice modes. */
export async function getHardestWords(db: Db, limit: number): Promise<HardWord[]> {
  return db.getAllAsync<HardWord>(
    `SELECT e.id, e.korean, (SELECT text FROM entry_meanings WHERE entry_id = e.id ORDER BY position LIMIT 1) AS meaning,
       SUM(CASE WHEN h.rating = 1 THEN 1 ELSE 0 END) AS lapses, COUNT(*) AS reps
     FROM review_history h JOIN entries e ON e.id = h.entry_id
     GROUP BY e.id HAVING lapses > 0 ORDER BY lapses DESC, reps DESC LIMIT ?`,
    [limit],
  );
}

// ---------- Preferences ----------

export async function loadPreferences(db: Db): Promise<Record<string, string>> {
  const rows = await db.getAllAsync<{ key: string; value: string }>('SELECT key, value FROM user_preferences', []);
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

export async function savePreference(db: Db, key: string, value: string): Promise<void> {
  await db.runAsync('INSERT INTO user_preferences (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, value]);
}

// ---------- Backup ----------

export interface Backup {
  format: 'namu-backup';
  version: 1;
  exportedAt: number;
  tables: Record<string, Record<string, string | number | null>[]>;
}

const PRIMARY_KEYS: Record<string, string[]> = { entry_tags: ['entry_id', 'tag'], user_preferences: ['key'] };

export async function exportBackup(db: Db, now = Date.now()): Promise<Backup> {
  const tables: Backup['tables'] = {};
  for (const [name, columns] of Object.entries(TABLES)) {
    tables[name] = await db.getAllAsync(`SELECT ${columns.join(', ')} FROM ${name}`, []);
  }
  return { format: 'namu-backup', version: 1, exportedAt: now, tables };
}

export function parseBackup(json: string): Backup {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error('not_json');
  }
  const b = data as Partial<Backup> | null;
  if (!b || b.format !== 'namu-backup' || typeof b.tables !== 'object' || b.tables === null) throw new Error('not_backup');
  if (b.version !== 1) throw new Error('unsupported_version');
  for (const [name, rows] of Object.entries(b.tables)) {
    if (!Array.isArray(rows)) throw new Error('not_backup');
    if (!(name in TABLES)) continue;
    for (const row of rows) {
      if (typeof row !== 'object' || row === null) throw new Error('not_backup');
      for (const col of TABLES[name]) {
        const v = (row as Record<string, unknown>)[col];
        if (v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') throw new Error('not_backup');
      }
    }
  }
  return b as Backup;
}

/**
 * Restores a backup by merging: records with the same id are overwritten, others
 * are added, nothing is deleted. Runs in one transaction, so a broken file
 * leaves the data untouched.
 */
export async function restoreBackup(db: Db, backup: Backup): Promise<number> {
  let count = 0;
  await db.withTransactionAsync(async () => {
    for (const [name, columns] of Object.entries(TABLES)) {
      const rows = backup.tables[name] ?? [];
      // Upsert rather than REPLACE: replacing a parent row would cascade-delete its children.
      const key = PRIMARY_KEYS[name] ?? ['id'];
      const rest = columns.filter((c) => !key.includes(c));
      const action = rest.length > 0 ? `DO UPDATE SET ${rest.map((c) => `${c} = excluded.${c}`).join(', ')}` : 'DO NOTHING';
      const sql = `INSERT INTO ${name} (${columns.join(', ')}) VALUES (${placeholders(columns.length)}) ON CONFLICT(${key.join(', ')}) ${action}`;
      for (const row of rows) {
        if (name === 'review_cards') {
          await db.runAsync('DELETE FROM review_cards WHERE entry_id = ? AND skill = ? AND id != ?', [row.entry_id ?? null, row.skill ?? null, row.id ?? null]);
        }
        await db.runAsync(sql, columns.map((c) => row[c] ?? null));
        count++;
      }
    }
  });
  return count;
}
