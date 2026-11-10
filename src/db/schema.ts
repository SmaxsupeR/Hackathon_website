// Database schema. Change it only by appending a new migration.

export interface Db {
  execAsync(sql: string): Promise<void>;
  runAsync(sql: string, params: (string | number | null)[]): Promise<unknown>;
  getAllAsync<T>(sql: string, params: (string | number | null)[]): Promise<T[]>;
  getFirstAsync<T>(sql: string, params: (string | number | null)[]): Promise<T | null>;
  withTransactionAsync(task: () => Promise<void>): Promise<void>;
}

export const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE folders (
    id TEXT PRIMARY KEY NOT NULL,
    parent_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE dictionaries (
    id TEXT PRIMARY KEY NOT NULL,
    folder_id TEXT REFERENCES folders(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT,
    color TEXT NOT NULL,
    icon TEXT,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    is_archived INTEGER NOT NULL DEFAULT 0,
    is_paused INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  CREATE TABLE media_assets (
    id TEXT PRIMARY KEY NOT NULL,
    kind TEXT NOT NULL,
    uri TEXT NOT NULL,
    mime TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE entries (
    id TEXT PRIMARY KEY NOT NULL,
    dictionary_id TEXT NOT NULL REFERENCES dictionaries(id) ON DELETE CASCADE,
    kind TEXT NOT NULL DEFAULT 'word',
    korean TEXT NOT NULL,
    korean_norm TEXT NOT NULL,
    romanization TEXT,
    transcription TEXT,
    part_of_speech TEXT,
    grammar_notes TEXT,
    notes TEXT,
    image_asset_id TEXT REFERENCES media_assets(id) ON DELETE SET NULL,
    is_favorite INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX idx_entries_dictionary ON entries(dictionary_id);
  CREATE INDEX idx_entries_norm ON entries(korean_norm);
  CREATE TABLE entry_meanings (
    id TEXT PRIMARY KEY NOT NULL,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_meanings_entry ON entry_meanings(entry_id);
  CREATE TABLE entry_examples (
    id TEXT PRIMARY KEY NOT NULL,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    korean TEXT NOT NULL,
    translation TEXT,
    position INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_examples_entry ON entry_examples(entry_id);
  CREATE TABLE entry_tags (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
  );
  CREATE TABLE review_cards (
    id TEXT PRIMARY KEY NOT NULL,
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    skill TEXT NOT NULL,
    due INTEGER NOT NULL,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days REAL NOT NULL,
    scheduled_days REAL NOT NULL,
    learning_steps INTEGER NOT NULL,
    reps INTEGER NOT NULL,
    lapses INTEGER NOT NULL,
    state INTEGER NOT NULL,
    last_review INTEGER,
    UNIQUE (entry_id, skill)
  );
  CREATE INDEX idx_cards_due ON review_cards(skill, due);
  CREATE TABLE practice_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    mode TEXT NOT NULL,
    dictionary_ids TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    total INTEGER NOT NULL DEFAULT 0,
    correct INTEGER NOT NULL DEFAULT 0
  );
  -- Review history is kept apart from dictionary content: it has no foreign
  -- keys, so statistics survive when a word or dictionary is deleted.
  CREATE TABLE review_history (
    id TEXT PRIMARY KEY NOT NULL,
    entry_id TEXT NOT NULL,
    skill TEXT NOT NULL,
    session_id TEXT,
    rating INTEGER NOT NULL,
    state INTEGER NOT NULL,
    due INTEGER NOT NULL,
    stability REAL NOT NULL,
    difficulty REAL NOT NULL,
    elapsed_days REAL NOT NULL,
    scheduled_days REAL NOT NULL,
    reviewed_at INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_history_time ON review_history(reviewed_at);
  CREATE INDEX idx_history_entry ON review_history(entry_id);
  CREATE TABLE practice_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT,
    entry_id TEXT NOT NULL,
    skill TEXT NOT NULL,
    mode TEXT NOT NULL,
    is_correct INTEGER NOT NULL,
    rating INTEGER,
    answer_given TEXT,
    hints_used INTEGER NOT NULL DEFAULT 0,
    duration_ms INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_attempts_session ON practice_attempts(session_id);
  CREATE TABLE user_preferences (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  );
  `,
  // v2: training before spaced repetition, one card per direction.
  `
  ALTER TABLE entries ADD COLUMN introduced_at INTEGER;
  -- Cards that are still in training. A card gets an FSRS row in review_cards only
  -- when training ends, and its row here is deleted at the same moment.
  CREATE TABLE acquisition (
    entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    direction TEXT NOT NULL,
    phase TEXT NOT NULL,
    errors INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (entry_id, direction)
  );
  ALTER TABLE practice_attempts ADD COLUMN self_accepted INTEGER NOT NULL DEFAULT 0;
  -- Old skills become directions: flashcards were Korean → meaning, typing was meaning → Korean.
  UPDATE review_cards SET skill = 'ko_ru' WHERE skill = 'recall';
  UPDATE review_cards SET skill = 'ru_ko' WHERE skill = 'typing';
  UPDATE review_history SET skill = 'ko_ru' WHERE skill = 'recall';
  UPDATE review_history SET skill = 'ru_ko' WHERE skill = 'typing';
  UPDATE practice_attempts SET skill = 'ko_ru' WHERE skill = 'recall';
  UPDATE practice_attempts SET skill = 'ru_ko' WHERE skill = 'typing';
  UPDATE practice_attempts SET mode = 'review' WHERE mode IN ('cards', 'typing');
  UPDATE entries SET introduced_at = (SELECT MIN(reviewed_at) FROM review_history h WHERE h.entry_id = entries.id)
    WHERE introduced_at IS NULL AND EXISTS (SELECT 1 FROM review_cards c WHERE c.entry_id = entries.id);
  CREATE INDEX idx_entries_introduced ON entries(introduced_at);
  CREATE INDEX idx_attempts_time ON practice_attempts(created_at);
  `,
];

/** Columns of every table, in backup order (parents before children). */
export const TABLES: Record<string, string[]> = {
  folders: ['id', 'parent_id', 'name', 'position', 'created_at', 'updated_at'],
  dictionaries: ['id', 'folder_id', 'name', 'description', 'color', 'icon', 'is_favorite', 'is_archived', 'is_paused', 'created_at', 'updated_at', 'last_used_at'],
  media_assets: ['id', 'kind', 'uri', 'mime', 'created_at'],
  entries: ['id', 'dictionary_id', 'kind', 'korean', 'korean_norm', 'romanization', 'transcription', 'part_of_speech', 'grammar_notes', 'notes', 'image_asset_id', 'is_favorite', 'created_at', 'updated_at', 'introduced_at'],
  entry_meanings: ['id', 'entry_id', 'text', 'position'],
  entry_examples: ['id', 'entry_id', 'korean', 'translation', 'position'],
  entry_tags: ['entry_id', 'tag'],
  acquisition: ['entry_id', 'direction', 'phase', 'errors', 'updated_at'],
  review_cards: ['id', 'entry_id', 'skill', 'due', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'learning_steps', 'reps', 'lapses', 'state', 'last_review'],
  practice_sessions: ['id', 'mode', 'dictionary_ids', 'started_at', 'finished_at', 'total', 'correct'],
  review_history: ['id', 'entry_id', 'skill', 'session_id', 'rating', 'state', 'due', 'stability', 'difficulty', 'elapsed_days', 'scheduled_days', 'reviewed_at', 'duration_ms'],
  practice_attempts: ['id', 'session_id', 'entry_id', 'skill', 'mode', 'is_correct', 'rating', 'answer_given', 'hints_used', 'duration_ms', 'created_at', 'self_accepted'],
  user_preferences: ['key', 'value'],
};

/** Applies pending migrations. Each one runs in its own transaction. */
export async function migrate(db: Db, migrations: string[] = MIGRATIONS): Promise<number> {
  await db.execAsync('PRAGMA foreign_keys = ON;');
  const row = await db.getFirstAsync<{ user_version: number }>('PRAGMA user_version', []);
  let version = row?.user_version ?? 0;
  while (version < migrations.length) {
    const sql = migrations[version];
    const next = version + 1;
    await db.withTransactionAsync(async () => {
      await db.execAsync(sql);
      await db.execAsync(`PRAGMA user_version = ${next}`);
    });
    version = next;
  }
  return version;
}
