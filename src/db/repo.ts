// All database reads and writes. No UI code here; every function takes the database handle.
import { splitMeanings, type ImportRow } from '../core/importer';
import { normalizeHangul, romanize } from '../core/hangul';
import { newId } from '../core/id';
import { type AttemptMode, type Direction, type Effect, type LearningSeed, type ReviewSeed } from '../core/learning';
import { newCard, reviewCard, STABLE_DAYS, State, type CardState, type Mastery, type Skill } from '../core/scheduler';
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
       (SELECT COUNT(DISTINCT e.id) FROM entries e JOIN review_cards c ON c.entry_id = e.id
          WHERE e.dictionary_id = d.id AND c.due <= ?) AS due_count,
       (SELECT COUNT(*) FROM entries e WHERE e.dictionary_id = d.id AND e.introduced_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id = e.id)) AS new_count
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
  introduced_at: number | null;
  meanings: string[];
  example: string | null;
  exampleTranslation: string | null;
  tags: string[];
  mastery: Mastery;
}

interface EntryRow {
  id: string;
  dictionary_id: string;
  korean: string;
  romanization: string | null;
  transcription: string | null;
  part_of_speech: string | null;
  notes: string | null;
  created_at: number;
  introduced_at: number | null;
  meanings: string | null;
  example: string | null;
  example_translation: string | null;
  tags: string | null;
  training: number;
  cards: number;
  stable_cards: number;
}

const STABLE_CARD = `c.state = ${State.Review} AND c.stability >= ${STABLE_DAYS}`;

const ENTRY_SELECT = `
  SELECT e.id, e.dictionary_id, e.korean, e.romanization, e.transcription, e.part_of_speech, e.notes, e.created_at, e.introduced_at,
    (SELECT group_concat(text, char(31)) FROM (SELECT text FROM entry_meanings WHERE entry_id = e.id ORDER BY position)) AS meanings,
    (SELECT korean FROM entry_examples WHERE entry_id = e.id ORDER BY position LIMIT 1) AS example,
    (SELECT translation FROM entry_examples WHERE entry_id = e.id ORDER BY position LIMIT 1) AS example_translation,
    (SELECT group_concat(tag, char(31)) FROM entry_tags WHERE entry_id = e.id) AS tags,
    (SELECT COUNT(*) FROM acquisition a WHERE a.entry_id = e.id) AS training,
    (SELECT COUNT(*) FROM review_cards c WHERE c.entry_id = e.id) AS cards,
    (SELECT COUNT(*) FROM review_cards c WHERE c.entry_id = e.id AND ${STABLE_CARD}) AS stable_cards
  FROM entries e
  JOIN dictionaries d ON d.id = e.dictionary_id`;

/**
 * new: never shown. stable: every scheduled card has a long memory interval and
 * nothing is in training. Anything in between is learning.
 */
function entryMastery(r: Pick<EntryRow, 'introduced_at' | 'training' | 'cards' | 'stable_cards'>): Mastery {
  if (r.introduced_at === null && r.cards === 0) return 'new';
  if (r.training === 0 && r.cards > 0 && r.stable_cards === r.cards) return 'stable';
  return 'learning';
}

function rowToEntry(r: EntryRow): Entry {
  return {
    id: r.id,
    dictionary_id: r.dictionary_id,
    korean: r.korean,
    romanization: r.romanization,
    transcription: r.transcription,
    part_of_speech: r.part_of_speech,
    notes: r.notes,
    created_at: r.created_at,
    introduced_at: r.introduced_at,
    meanings: r.meanings ? r.meanings.split(SEP) : [],
    example: r.example,
    exampleTranslation: r.example_translation,
    tags: r.tags ? r.tags.split(SEP) : [],
    mastery: entryMastery(r),
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

export async function listEntries(db: Db, opts: { dictionaryId: string; search?: string }): Promise<Entry[]> {
  const params: (string | number)[] = [opts.dictionaryId];
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

export async function getEntry(db: Db, id: string): Promise<Entry | null> {
  const row = await db.getFirstAsync<EntryRow>(`${ENTRY_SELECT} WHERE e.id = ?`, [id]);
  return row ? rowToEntry(row) : null;
}

export async function getEntries(db: Db, ids: string[]): Promise<Map<string, Entry>> {
  const out = new Map<string, Entry>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const rows = await db.getAllAsync<EntryRow>(`${ENTRY_SELECT} WHERE e.id IN (${placeholders(chunk.length)})`, chunk);
    rows.forEach((r) => out.set(r.id, rowToEntry(r)));
  }
  return out;
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


// ---------- Study plan ----------

export interface PlanOptions {
  /** Empty means every active (not archived, not paused) dictionary. */
  dictionaryIds: string[];
  directions: Direction[];
  now: number;
  newPerDay: number;
  maxReviews: number;
}

/** Words in training resumed per session, so a backlog cannot make a session endless. */
export const MAX_TRAINING_WORDS = 20;
/** A word in training that was not touched for this long is shown again before questions. */
export const REINTRODUCE_AFTER = DAY;

export interface PlanIds {
  reviews: ReviewSeed[];
  learning: LearningSeed[];
  fresh: string[];
}

function scope(dictionaryIds: string[]): { sql: string; params: string[] } {
  if (dictionaryIds.length === 0) return { sql: 'd.is_archived = 0 AND d.is_paused = 0', params: [] };
  return { sql: `d.id IN (${placeholders(dictionaryIds.length)})`, params: dictionaryIds };
}

export async function introducedToday(db: Db, now: number): Promise<number> {
  const row = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM entries WHERE introduced_at >= ?', [startOfDay(now)]);
  return row?.n ?? 0;
}

/** What a session started now would contain. */
export async function planSession(db: Db, opts: PlanOptions): Promise<PlanIds> {
  const s = scope(opts.dictionaryIds);
  const dirs = opts.directions;
  if (dirs.length === 0) return { reviews: [], learning: [], fresh: [] };
  const dirIn = placeholders(dirs.length);

  // Due reviews, earliest first. Only one direction per word per session, so one
  // direction cannot give away the answer to the other (the sibling waits a day).
  const due = await db.getAllAsync<{ entry_id: string; skill: Direction }>(
    `SELECT c.entry_id, c.skill FROM review_cards c JOIN entries e ON e.id = c.entry_id JOIN dictionaries d ON d.id = e.dictionary_id
     WHERE ${s.sql} AND c.skill IN (${dirIn}) AND c.due <= ? ORDER BY c.due, c.entry_id`,
    [...s.params, ...dirs, opts.now],
  );
  const reviews: ReviewSeed[] = [];
  const reviewed = new Set<string>();
  for (const r of due) {
    if (reviews.length >= opts.maxReviews) break;
    if (reviewed.has(r.entry_id)) continue;
    reviewed.add(r.entry_id);
    reviews.push({ entryId: r.entry_id, direction: r.skill });
  }

  // Words already shown that still have a direction in training (or never started one).
  const words = await db.getAllAsync<{ id: string; introduced_at: number }>(
    `SELECT e.id, e.introduced_at FROM entries e JOIN dictionaries d ON d.id = e.dictionary_id
     WHERE ${s.sql} AND e.introduced_at IS NOT NULL AND (
       SELECT COUNT(*) FROM review_cards c WHERE c.entry_id = e.id AND c.skill IN (${dirIn})) < ?
     ORDER BY e.introduced_at, e.created_at, e.rowid`,
    [...s.params, ...dirs, dirs.length],
  );
  const learning: LearningSeed[] = [];
  let taken = 0;
  for (const w of words) {
    if (taken >= MAX_TRAINING_WORDS) break;
    const rows = await db.getAllAsync<{ direction: Direction; phase: 'recognition' | 'recall'; errors: number; updated_at: number }>(
      'SELECT direction, phase, errors, updated_at FROM acquisition WHERE entry_id = ?',
      [w.id],
    );
    const cards = await db.getAllAsync<{ skill: string }>('SELECT skill FROM review_cards WHERE entry_id = ?', [w.id]);
    const scheduled = new Set(cards.map((c) => c.skill));
    const lastTouched = Math.max(w.introduced_at, ...rows.map((r) => r.updated_at));
    const reintroduce = opts.now - lastTouched > REINTRODUCE_AFTER;
    let added = false;
    for (const d of dirs) {
      if (scheduled.has(d) || reviewed.has(w.id)) continue;
      const row = rows.find((r) => r.direction === d);
      learning.push({ entryId: w.id, direction: d, phase: row?.phase ?? 'recognition', errors: row?.errors ?? 0, reintroduce });
      added = true;
    }
    if (added) taken++;
  }

  const left = Math.max(0, opts.newPerDay - (await introducedToday(db, opts.now)));
  const fresh =
    left === 0
      ? []
      : (
          await db.getAllAsync<{ id: string }>(
            `SELECT e.id FROM entries e JOIN dictionaries d ON d.id = e.dictionary_id
             WHERE ${s.sql} AND e.introduced_at IS NULL AND NOT EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id = e.id)
             ORDER BY e.created_at, e.rowid LIMIT ?`,
            [...s.params, left],
          )
        ).map((r) => r.id);

  return { reviews, learning, fresh };
}

export interface PlanCounts {
  /** Due reviews. */
  due: number;
  /** Words in training. */
  learning: number;
  /** New words that can be introduced today. */
  fresh: number;
}

export async function getPlanCounts(db: Db, opts: PlanOptions): Promise<PlanCounts> {
  const p = await planSession(db, opts);
  return { due: p.reviews.length, learning: new Set(p.learning.map((l) => l.entryId)).size, fresh: p.fresh.length };
}

export interface Distractor {
  korean: string;
  meaning: string;
}

/** Random words from the whole collection, used as wrong options in multiple-choice questions. */
export async function getDistractorPool(db: Db, limit: number): Promise<Distractor[]> {
  return db.getAllAsync<Distractor>(
    `SELECT e.korean, m.text AS meaning FROM entries e JOIN entry_meanings m ON m.entry_id = e.id AND m.position = 0
     ORDER BY RANDOM() LIMIT ?`,
    [limit],
  );
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

// ---------- Saving answers ----------

interface CardColumns {
  card_id: string;
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: number;
  last_review: number | null;
}

function rowToCard(r: CardColumns): CardState {
  return {
    due: r.due,
    stability: r.stability,
    difficulty: r.difficulty,
    elapsed_days: r.elapsed_days,
    scheduled_days: r.scheduled_days,
    learning_steps: r.learning_steps,
    reps: r.reps,
    lapses: r.lapses,
    state: r.state as State,
    last_review: r.last_review,
  };
}

export async function getCard(db: Db, entryId: string, skill: Skill): Promise<CardState | null> {
  const row = await db.getFirstAsync<CardColumns>(
    'SELECT id AS card_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review FROM review_cards WHERE entry_id = ? AND skill = ?',
    [entryId, skill],
  );
  return row ? rowToCard(row) : null;
}

/** Applies one FSRS rating and logs it. Must run inside a transaction. */
async function writeReview(db: Db, entryId: string, skill: Skill, rating: number, now: number, retention: number, sessionId: string | null, durationMs: number): Promise<CardState> {
  const row = await db.getFirstAsync<CardColumns>(
    'SELECT id AS card_id, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review FROM review_cards WHERE entry_id = ? AND skill = ?',
    [entryId, skill],
  );
  const before = row ? rowToCard(row) : newCard(now);
  const { card, log } = reviewCard(before, rating as Grade, now, retention);
  const values = [card.due, card.stability, card.difficulty, card.elapsed_days, card.scheduled_days, card.learning_steps, card.reps, card.lapses, card.state, card.last_review];
  if (row) {
    await db.runAsync(
      'UPDATE review_cards SET due = ?, stability = ?, difficulty = ?, elapsed_days = ?, scheduled_days = ?, learning_steps = ?, reps = ?, lapses = ?, state = ?, last_review = ? WHERE id = ?',
      [...values, row.card_id],
    );
  } else {
    await db.runAsync(
      'INSERT INTO review_cards (due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, id, entry_id, skill) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [...values, newId(), entryId, skill],
    );
  }
  await db.runAsync(
    `INSERT INTO review_history (id, entry_id, skill, session_id, rating, state, due, stability, difficulty, elapsed_days, scheduled_days, reviewed_at, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [newId(), entryId, skill, sessionId, log.rating, log.state, log.due, log.stability, log.difficulty, log.elapsed_days, log.scheduled_days, log.reviewed_at, durationMs],
  );
  return card;
}

export interface AnswerMeta {
  now: number;
  retention: number;
  sessionId?: string | null;
  durationMs?: number;
  answerGiven?: string | null;
  /** The learner overrode the automatic check ("my answer is also right"). */
  selfAccepted?: boolean;
}

/**
 * Saves the effects of one step of the learning state machine in one transaction,
 * so leaving the session at any moment keeps everything answered so far.
 * Returns the FSRS card if this step rated one.
 */
export async function applyEffects(db: Db, effects: Effect[], meta: AnswerMeta): Promise<CardState | null> {
  let scheduled: CardState | null = null;
  const sessionId = meta.sessionId ?? null;
  const duration = Math.max(0, Math.round(meta.durationMs ?? 0));
  await db.withTransactionAsync(async () => {
    const rating = effects.find((e) => e.type === 'graduate' || e.type === 'review');
    for (const e of effects) {
      switch (e.type) {
        case 'introduce':
          await db.runAsync('UPDATE entries SET introduced_at = COALESCE(introduced_at, ?) WHERE id = ?', [meta.now, e.entryId]);
          for (const d of e.directions) {
            await db.runAsync(
              `INSERT INTO acquisition (entry_id, direction, phase, errors, updated_at)
               SELECT ?, ?, 'recognition', 0, ? WHERE NOT EXISTS (SELECT 1 FROM review_cards WHERE entry_id = ? AND skill = ?)
               ON CONFLICT(entry_id, direction) DO NOTHING`,
              [e.entryId, d, meta.now, e.entryId, d],
            );
          }
          break;
        case 'phase':
          await db.runAsync(
            `INSERT INTO acquisition (entry_id, direction, phase, errors, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(entry_id, direction) DO UPDATE SET phase = excluded.phase, errors = excluded.errors, updated_at = excluded.updated_at`,
            [e.entryId, e.direction, e.phase, e.errors, meta.now],
          );
          await db.runAsync('UPDATE entries SET introduced_at = COALESCE(introduced_at, ?) WHERE id = ?', [meta.now, e.entryId]);
          break;
        case 'graduate':
          scheduled = await writeReview(db, e.entryId, e.direction, e.grade, meta.now, meta.retention, sessionId, duration);
          await db.runAsync('DELETE FROM acquisition WHERE entry_id = ? AND direction = ?', [e.entryId, e.direction]);
          break;
        case 'review':
          scheduled = await writeReview(db, e.entryId, e.direction, e.grade, meta.now, meta.retention, sessionId, duration);
          break;
        case 'attempt':
          await db.runAsync(
            `INSERT INTO practice_attempts (id, session_id, entry_id, skill, mode, is_correct, rating, answer_given, hints_used, duration_ms, created_at, self_accepted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
            [newId(), sessionId, e.entryId, e.direction, e.mode, e.correct ? 1 : 0, rating ? rating.grade : null, meta.answerGiven ?? null, duration, meta.now, meta.selfAccepted ? 1 : 0],
          );
          break;
      }
    }
  });
  return scheduled;
}

export interface ReviewInput {
  entryId: string;
  skill: Skill;
  mode: AttemptMode;
  rating: Grade;
  now: number;
  retention: number;
  sessionId?: string | null;
  durationMs?: number;
  answerGiven?: string | null;
}

/** Rates a card directly (outside the state machine) and logs the attempt. */
export async function recordReview(db: Db, input: ReviewInput): Promise<CardState> {
  let result: CardState | null = null;
  await db.withTransactionAsync(async () => {
    result = await writeReview(db, input.entryId, input.skill, input.rating, input.now, input.retention, input.sessionId ?? null, input.durationMs ?? 0);
    await db.runAsync('DELETE FROM acquisition WHERE entry_id = ? AND direction = ?', [input.entryId, input.skill]);
    await db.runAsync('UPDATE entries SET introduced_at = COALESCE(introduced_at, ?) WHERE id = ?', [input.now, input.entryId]);
    await db.runAsync(
      `INSERT INTO practice_attempts (id, session_id, entry_id, skill, mode, is_correct, rating, answer_given, hints_used, duration_ms, created_at, self_accepted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, 0)`,
      [newId(), input.sessionId ?? null, input.entryId, input.skill, input.mode, input.rating > 1 ? 1 : 0, input.rating, input.answerGiven ?? null, input.durationMs ?? 0, input.now],
    );
  });
  return result as unknown as CardState;
}

// ---------- Statistics ----------

export interface Overview {
  totalWords: number;
  newWords: number;
  learningWords: number;
  stableWords: number;
  /** Due FSRS cards in active dictionaries. */
  dueNow: number;
  /** Answers today, every kind of question. */
  answersToday: number;
  /** Words shown for the first time today. */
  newToday: number;
  msToday: number;
  totalAnswers: number;
  totalMs: number;
  streakDays: number;
}

export async function getOverview(db: Db, now: number): Promise<Overview> {
  const today = startOfDay(now);
  const words = await db.getFirstAsync<{ total: number; fresh: number; stable: number }>(
    `SELECT COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN e.introduced_at IS NULL AND NOT EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id = e.id) THEN 1 ELSE 0 END), 0) AS fresh,
       COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM acquisition a WHERE a.entry_id = e.id)
         AND EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id = e.id)
         AND NOT EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id = e.id AND NOT (${STABLE_CARD})) THEN 1 ELSE 0 END), 0) AS stable
     FROM entries e`,
    [],
  );
  const due = await db.getFirstAsync<{ n: number }>(
    `SELECT COUNT(*) AS n FROM review_cards c JOIN entries e ON e.id = c.entry_id JOIN dictionaries d ON d.id = e.dictionary_id
     WHERE c.due <= ? AND d.is_archived = 0 AND d.is_paused = 0`,
    [now],
  );
  const day = await db.getFirstAsync<{ n: number; ms: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM practice_attempts WHERE created_at >= ?', [today]);
  const all = await db.getFirstAsync<{ n: number; ms: number }>('SELECT COUNT(*) AS n, COALESCE(SUM(duration_ms), 0) AS ms FROM practice_attempts', []);
  const total = words?.total ?? 0;
  const fresh = words?.fresh ?? 0;
  const stable = words?.stable ?? 0;
  return {
    totalWords: total,
    newWords: fresh,
    learningWords: total - fresh - stable,
    stableWords: stable,
    dueNow: due?.n ?? 0,
    answersToday: day?.n ?? 0,
    newToday: await introducedToday(db, now),
    msToday: day?.ms ?? 0,
    totalAnswers: all?.n ?? 0,
    totalMs: all?.ms ?? 0,
    streakDays: await getStreak(db, now),
  };
}

/** Days in a row with at least one answer, counting today or yesterday as the latest. */
export async function getStreak(db: Db, now: number): Promise<number> {
  const rows = await db.getAllAsync<{ created_at: number }>('SELECT created_at FROM practice_attempts WHERE created_at >= ?', [startOfDay(now) - 400 * DAY]);
  const days = new Set(rows.map((r) => startOfDay(r.created_at)));
  const cursor = new Date(startOfDay(now));
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
  answers: number;
  correct: number;
}

export async function getDailyActivity(db: Db, now: number, days: number): Promise<DayActivity[]> {
  const out: DayActivity[] = [];
  const cursor = new Date(startOfDay(now));
  cursor.setDate(cursor.getDate() - (days - 1));
  const from = cursor.getTime();
  for (let i = 0; i < days; i++) {
    out.push({ day: cursor.getTime(), answers: 0, correct: 0 });
    cursor.setDate(cursor.getDate() + 1);
  }
  const index = new Map(out.map((d) => [d.day, d]));
  const rows = await db.getAllAsync<{ created_at: number; is_correct: number }>('SELECT created_at, is_correct FROM practice_attempts WHERE created_at >= ?', [from]);
  for (const r of rows) {
    const d = index.get(startOfDay(r.created_at));
    if (!d) continue;
    d.answers++;
    d.correct += r.is_correct;
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
     WHERE c.due < ? AND d.is_archived = 0 AND d.is_paused = 0`,
    [cursor.getTime()],
  );
  const index = new Map(out.map((d) => [d.day, d]));
  for (const r of rows) {
    const slot = index.get(Math.max(out[0].day, startOfDay(r.due)));
    if (slot) slot.count++;
  }
  return out;
}

/**
 * Accuracy kept apart by kind of knowledge: recognition (choosing from options)
 * and recall in each direction (typing the answer). They are never merged into one score.
 */
export type AccuracyKind = 'recognition' | 'ko_ru' | 'ru_ko';

export interface Accuracy {
  kind: AccuracyKind;
  total: number;
  correct: number;
}

export async function getAccuracy(db: Db): Promise<Accuracy[]> {
  const rows = await db.getAllAsync<{ kind: string; total: number; correct: number }>(
    `SELECT CASE WHEN mode = 'recognition' THEN 'recognition' ELSE skill END AS kind, COUNT(*) AS total, SUM(is_correct) AS correct
     FROM practice_attempts GROUP BY kind`,
    [],
  );
  const order: AccuracyKind[] = ['recognition', 'ko_ru', 'ru_ko'];
  return order.flatMap((kind) => {
    const r = rows.find((x) => x.kind === kind);
    return r ? [{ kind, total: r.total, correct: r.correct }] : [];
  });
}

export interface HardWord {
  id: string;
  korean: string;
  meaning: string | null;
  mistakes: number;
  answers: number;
}

/** Words with the most wrong answers, across every kind of question. */
export async function getHardestWords(db: Db, limit: number): Promise<HardWord[]> {
  return db.getAllAsync<HardWord>(
    `SELECT e.id, e.korean, (SELECT text FROM entry_meanings WHERE entry_id = e.id ORDER BY position LIMIT 1) AS meaning,
       SUM(1 - p.is_correct) AS mistakes, COUNT(*) AS answers
     FROM practice_attempts p JOIN entries e ON e.id = p.entry_id
     GROUP BY e.id HAVING mistakes > 0 ORDER BY mistakes DESC, answers DESC LIMIT ?`,
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

export const BACKUP_VERSION = 2;

export interface Backup {
  format: 'namu-backup';
  version: number;
  exportedAt: number;
  tables: Record<string, Record<string, string | number | null>[]>;
}

const PRIMARY_KEYS: Record<string, string[]> = { entry_tags: ['entry_id', 'tag'], user_preferences: ['key'], acquisition: ['entry_id', 'direction'] };
/** Values for NOT NULL columns that older backups do not have. */
const COLUMN_DEFAULTS: Record<string, string | number> = { self_accepted: 0 };

export async function exportBackup(db: Db, now = Date.now()): Promise<Backup> {
  const tables: Backup['tables'] = {};
  for (const [name, columns] of Object.entries(TABLES)) {
    tables[name] = await db.getAllAsync(`SELECT ${columns.join(', ')} FROM ${name}`, []);
  }
  return { format: 'namu-backup', version: BACKUP_VERSION, exportedAt: now, tables };
}

/** Version 1 used the skill names of flashcards and typing. */
function upgradeBackup(b: Backup): Backup {
  if (b.version >= 2) return b;
  const skill: Record<string, string> = { recall: 'ko_ru', typing: 'ru_ko' };
  const mode: Record<string, string> = { cards: 'review', typing: 'review' };
  const tables = { ...b.tables };
  for (const name of ['review_cards', 'review_history', 'practice_attempts']) {
    tables[name] = (tables[name] ?? []).map((r) => {
      const row = { ...r };
      if (typeof row.skill === 'string' && skill[row.skill]) row.skill = skill[row.skill];
      if (name === 'practice_attempts' && typeof row.mode === 'string' && mode[row.mode]) row.mode = mode[row.mode];
      return row;
    });
  }
  return { ...b, version: BACKUP_VERSION, tables };
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
  if (b.version !== 1 && b.version !== 2) throw new Error('unsupported_version');
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
  return upgradeBackup(b as Backup);
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
        await db.runAsync(sql, columns.map((c) => row[c] ?? COLUMN_DEFAULTS[c] ?? null));
        count++;
      }
    }
    // A scheduled card means the word was shown, even if an old backup did not record it.
    await db.runAsync(
      `UPDATE entries SET introduced_at = (SELECT MIN(reviewed_at) FROM review_history h WHERE h.entry_id = entries.id)
       WHERE introduced_at IS NULL AND EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id = entries.id)`,
      [],
    );
    // A card cannot be both in training and scheduled.
    await db.runAsync('DELETE FROM acquisition WHERE EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id = acquisition.entry_id AND c.skill = acquisition.direction)', []);
  });
  return count;
}

