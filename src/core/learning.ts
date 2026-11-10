// The learning state machine for one study session. Pure logic: no database, no UI.
//
// Every word has one card per direction:
//   ko_ru — see the Korean word, produce the translation (meaning recall)
//   ru_ko — see the translation, produce the Korean word (form recall)
//
// A card moves through these stages:
//
//   new ──intro──▶ recognition ──right──▶ recall ──right──▶ graduated (FSRS card created)
//                     ▲   │wrong              │wrong
//                     └───┘◀──────────────────┘   (the answer is shown, then training repeats)
//
//   review (FSRS due) ──right──▶ done (FSRS: Good)
//          │wrong
//          └──▶ FSRS: Again, then relearn ──right──▶ done
//                                  │wrong ──▶ relearn again (not sent to FSRS)
//
// - The intro is never counted as knowing the word.
// - Recognition (multiple choice) is scaffolding only: it never produces an FSRS rating,
//   so a lucky guess cannot mark a word as known.
// - Recall is checked before the answer is shown.
// - A card that fails MAX_FAILS times in one session is parked: it leaves the session and
//   keeps its stage for the next one, so a hard word cannot loop forever.
// - ru_ko training starts only after ko_ru has graduated (receptive before productive).
// - FSRS gets exactly one rating per card per session: at graduation or at the review.

export type Direction = 'ko_ru' | 'ru_ko';
export const DIRECTIONS: Direction[] = ['ko_ru', 'ru_ko'];

/** Training stage saved between sessions for a card that has not graduated yet. */
export type Phase = 'recognition' | 'recall';

/** FSRS ratings used by the app. Easy is never produced. */
export const GRADE = { again: 1, hard: 2, good: 3 } as const;
export type AppGrade = (typeof GRADE)[keyof typeof GRADE];

export const MAX_FAILS = 3;
export const RETRY_GAP = 3;
export const NEXT_GAP = 3;
export const BATCH = 4;

export type Stage = 'locked' | 'recognition' | 'recall' | 'review' | 'relearn' | 'done' | 'parked';
export type AttemptMode = 'recognition' | 'acquisition' | 'review' | 'relearn';

export interface ReviewSeed {
  entryId: string;
  direction: Direction;
}

export interface LearningSeed {
  entryId: string;
  direction: Direction;
  phase: Phase;
  /** Errors made during training so far, across sessions. */
  errors: number;
  /** Show the word again before testing (the last training was long ago). */
  reintroduce?: boolean;
}

export interface SessionInput {
  /** Due FSRS cards, at most one direction per word. */
  reviews: ReviewSeed[];
  /** Cards that are already in training. */
  learning: LearningSeed[];
  /** Words never shown before, in study order. */
  fresh: string[];
  /** Directions the learner practises, in any order. */
  directions: Direction[];
  /** Whether a multiple-choice question can be built for this card. */
  hasChoice: (entryId: string, direction: Direction) => boolean;
}

export interface Card {
  key: string;
  entryId: string;
  direction: Direction;
  stage: Stage;
  /** Training errors, persisted; decide the first FSRS rating. */
  errors: number;
  /** Failures in this session; reaching MAX_FAILS parks the card. */
  fails: number;
  hasChoice: boolean;
}

export type Task =
  | { kind: 'intro'; entryId: string; repeat: boolean }
  | { kind: 'recognize'; key: string }
  | { kind: 'recall'; key: string; purpose: 'acquisition' | 'review' | 'relearn' };

export type Effect =
  /** The word was shown: save it as introduced and start training for these directions. */
  | { type: 'introduce'; entryId: string; directions: Direction[] }
  /** Save the training stage of a card that has not graduated. */
  | { type: 'phase'; entryId: string; direction: Direction; phase: Phase; errors: number }
  /** Training finished: create the FSRS card with its first rating. */
  | { type: 'graduate'; entryId: string; direction: Direction; grade: AppGrade }
  /** A due FSRS card was answered. */
  | { type: 'review'; entryId: string; direction: Direction; grade: AppGrade }
  /** Every answer is logged; this is what statistics use. */
  | { type: 'attempt'; entryId: string; direction: Direction; mode: AttemptMode; correct: boolean };

export interface Session {
  cards: Record<string, Card>;
  queue: Task[];
  directions: Direction[];
  stats: {
    introduced: number;
    /** Cards (word × direction) that finished training. */
    graduated: number;
    /** Words with at least one direction that finished training. */
    learnedWords: string[];
    reviewed: number;
    reviewCorrect: number;
    answers: number;
    correct: number;
  };
}

export const cardKey = (entryId: string, direction: Direction) => `${entryId}:${direction}`;

/** Receptive direction first. */
function ordered(directions: Direction[]): Direction[] {
  return DIRECTIONS.filter((d) => directions.includes(d));
}

function insertAt<T>(queue: T[], item: T, gap: number): T[] {
  const at = Math.min(gap, queue.length);
  return [...queue.slice(0, at), item, ...queue.slice(at)];
}

function trainingStage(phase: Phase, hasChoice: boolean): Stage {
  return phase === 'recognition' && hasChoice ? 'recognition' : 'recall';
}

function taskFor(card: Card): Task | null {
  switch (card.stage) {
    case 'recognition':
      return { kind: 'recognize', key: card.key };
    case 'recall':
      return { kind: 'recall', key: card.key, purpose: 'acquisition' };
    case 'review':
      return { kind: 'recall', key: card.key, purpose: 'review' };
    case 'relearn':
      return { kind: 'recall', key: card.key, purpose: 'relearn' };
    default:
      return null;
  }
}

export function createSession(input: SessionInput): Session {
  const directions = ordered(input.directions);
  const cards: Record<string, Card> = {};
  const queue: Task[] = [];
  const add = (entryId: string, direction: Direction, stage: Stage, errors: number) => {
    const card: Card = { key: cardKey(entryId, direction), entryId, direction, stage, errors, fails: 0, hasChoice: input.hasChoice(entryId, direction) };
    if (card.stage === 'recognition' && !card.hasChoice) card.stage = 'recall';
    cards[card.key] = card;
    return card;
  };
  const push = (card: Card) => {
    const task = taskFor(card);
    if (task) queue.push(task);
  };

  // 1. Due reviews.
  for (const r of input.reviews) {
    if (!directions.includes(r.direction) || cards[cardKey(r.entryId, r.direction)]) continue;
    push(add(r.entryId, r.direction, 'review', 0));
  }

  // 2. Cards already in training. A later direction waits while an earlier one is still training.
  const learning = input.learning.filter((s) => directions.includes(s.direction) && !cards[cardKey(s.entryId, s.direction)]);
  const training = new Set(learning.map((s) => cardKey(s.entryId, s.direction)));
  const repeated = new Set<string>();
  for (const s of learning) {
    if (s.reintroduce && !repeated.has(s.entryId)) {
      repeated.add(s.entryId);
      queue.push({ kind: 'intro', entryId: s.entryId, repeat: true });
    }
  }
  for (const s of learning) {
    const blocked = directions.slice(0, directions.indexOf(s.direction)).some((d) => training.has(cardKey(s.entryId, d)));
    const card = add(s.entryId, s.direction, blocked ? 'locked' : trainingStage(s.phase, input.hasChoice(s.entryId, s.direction)), s.errors);
    if (!blocked) push(card);
  }

  // 3. New words in small batches: all intros of a batch, then its first-direction questions.
  for (let i = 0; i < input.fresh.length; i += BATCH) {
    const batch = input.fresh.slice(i, i + BATCH).filter((id) => directions.every((d) => !cards[cardKey(id, d)]));
    for (const entryId of batch) queue.push({ kind: 'intro', entryId, repeat: false });
    for (const entryId of batch) {
      directions.forEach((d, n) => {
        const card = add(entryId, d, n === 0 ? 'recognition' : 'locked', 0);
        if (n === 0) push(card);
      });
    }
  }

  return { cards, queue, directions, stats: { introduced: 0, graduated: 0, learnedWords: [], reviewed: 0, reviewCorrect: 0, answers: 0, correct: 0 } };
}

export function currentTask(s: Session): Task | null {
  return s.queue[0] ?? null;
}

/** Share of cards that have left the session (0..1). The card set is fixed, so it never decreases. */
export function progress(s: Session): number {
  const all = Object.values(s.cards);
  if (all.length === 0 || s.queue.length === 0) return 1;
  const resolved = all.filter((c) => {
    if (c.stage === 'done' || c.stage === 'parked') return true;
    if (c.stage !== 'locked') return false;
    // A locked card whose earlier direction was parked will not open in this session.
    return s.directions.some((d) => s.cards[cardKey(c.entryId, d)]?.stage === 'parked');
  });
  return resolved.length / all.length;
}

export function isFinished(s: Session): boolean {
  return s.queue.length === 0;
}

/** Marks the current intro as seen. */
export function completeIntro(s: Session): { session: Session; effects: Effect[] } {
  const task = s.queue[0];
  if (!task || task.kind !== 'intro') throw new Error('The current task is not an intro');
  const rest = s.queue.slice(1);
  if (task.repeat) return { session: { ...s, queue: rest }, effects: [] };
  const directions = s.directions.filter((d) => s.cards[cardKey(task.entryId, d)]);
  return {
    session: { ...s, queue: rest, stats: { ...s.stats, introduced: s.stats.introduced + 1 } },
    effects: [{ type: 'introduce', entryId: task.entryId, directions }],
  };
}

/** Applies the result of the current question. */
export function answer(s: Session, correct: boolean): { session: Session; effects: Effect[]; card: Card } {
  const task = s.queue[0];
  if (!task || task.kind === 'intro') throw new Error('The current task is not a question');
  const before = s.cards[task.key];
  const card: Card = { ...before };
  const cards = { ...s.cards, [card.key]: card };
  let queue = s.queue.slice(1);
  const effects: Effect[] = [];
  const stats = { ...s.stats, answers: s.stats.answers + 1, correct: s.stats.correct + (correct ? 1 : 0) };
  const { entryId, direction } = card;
  const mode: AttemptMode = task.kind === 'recognize' ? 'recognition' : task.purpose;
  effects.push({ type: 'attempt', entryId, direction, mode, correct });

  const fail = (next: Stage) => {
    card.fails += 1;
    card.stage = card.fails >= MAX_FAILS ? 'parked' : next;
    const t = taskFor(card);
    if (t) queue = insertAt(queue, t, RETRY_GAP);
  };

  if (task.kind === 'recognize') {
    if (correct) {
      card.stage = 'recall';
      queue = insertAt(queue, taskFor(card) as Task, NEXT_GAP);
      effects.push({ type: 'phase', entryId, direction, phase: 'recall', errors: card.errors });
    } else {
      card.errors += 1;
      fail('recognition');
      effects.push({ type: 'phase', entryId, direction, phase: 'recognition', errors: card.errors });
    }
  } else if (task.purpose === 'acquisition') {
    if (correct) {
      card.stage = 'done';
      stats.graduated += 1;
      if (!stats.learnedWords.includes(entryId)) stats.learnedWords = [...stats.learnedWords, entryId];
      effects.push({ type: 'graduate', entryId, direction, grade: card.errors === 0 ? GRADE.good : GRADE.hard });
      // Unlock the next direction of the same word.
      const nextDir = s.directions[s.directions.indexOf(direction) + 1];
      const next = nextDir ? cards[cardKey(entryId, nextDir)] : undefined;
      if (next && next.stage === 'locked') {
        const unlocked: Card = { ...next, stage: next.hasChoice ? 'recognition' : 'recall' };
        cards[unlocked.key] = unlocked;
        queue = insertAt(queue, taskFor(unlocked) as Task, NEXT_GAP);
      }
    } else {
      card.errors += 1;
      fail(card.hasChoice ? 'recognition' : 'recall');
      const phase: Phase = card.hasChoice ? 'recognition' : 'recall';
      effects.push({ type: 'phase', entryId, direction, phase, errors: card.errors });
    }
  } else if (task.purpose === 'review') {
    stats.reviewed += 1;
    if (correct) {
      stats.reviewCorrect += 1;
      card.stage = 'done';
      effects.push({ type: 'review', entryId, direction, grade: GRADE.good });
    } else {
      effects.push({ type: 'review', entryId, direction, grade: GRADE.again });
      fail('relearn');
    }
  } else {
    if (correct) card.stage = 'done';
    else fail('relearn');
  }

  return { session: { ...s, cards, queue, stats }, effects, card };
}
