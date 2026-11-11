// Spaced repetition on top of FSRS. Pure logic: no database, no UI.
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade } from 'ts-fsrs';
import { clampRetention, FSRS_CONFIG } from './fsrsConfig';

export { Rating, State };

/**
 * Each skill is scheduled separately. ko_ru: recall the meaning of a Korean word;
 * ru_ko: produce the Korean word. Listening and handwriting are planned.
 */
export type Skill = 'ko_ru' | 'ru_ko' | 'listening' | 'handwriting';

export interface CardState {
  due: number;
  stability: number;
  difficulty: number;
  elapsed_days: number;
  scheduled_days: number;
  learning_steps: number;
  reps: number;
  lapses: number;
  state: State;
  last_review: number | null;
}

export interface ReviewOutcome {
  card: CardState;
  log: {
    rating: Rating;
    state: State;
    due: number;
    stability: number;
    difficulty: number;
    elapsed_days: number;
    scheduled_days: number;
    reviewed_at: number;
  };
}

export const GRADES: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

/** A card counts as firmly remembered once its memory stability reaches this many days. */
export const STABLE_DAYS = 21;

/** FSRS parameters for a retention target, built only from FSRS_CONFIG (never from library defaults). */
export function schedulerParams(retention: number) {
  return generatorParameters({
    request_retention: clampRetention(retention),
    w: [...FSRS_CONFIG.w],
    learning_steps: [...FSRS_CONFIG.learningSteps] as never[],
    relearning_steps: [...FSRS_CONFIG.relearningSteps] as never[],
    enable_short_term: FSRS_CONFIG.enableShortTerm,
    enable_fuzz: FSRS_CONFIG.enableFuzz,
    maximum_interval: FSRS_CONFIG.maximumInterval,
  });
}

// One scheduler per retention value; building one is not free.
const schedulers = new Map<number, ReturnType<typeof fsrs>>();
function scheduler(retention: number) {
  const r = clampRetention(retention);
  let s = schedulers.get(r);
  if (!s) {
    s = fsrs(schedulerParams(r));
    schedulers.set(r, s);
  }
  return s;
}

function toFsrs(c: CardState): Card {
  return { ...c, due: new Date(c.due), last_review: c.last_review ? new Date(c.last_review) : undefined };
}

function fromFsrs(c: Card): CardState {
  return {
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    elapsed_days: c.elapsed_days,
    scheduled_days: c.scheduled_days,
    learning_steps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state,
    last_review: c.last_review ? c.last_review.getTime() : null,
  };
}

export function newCard(now: number): CardState {
  return fromFsrs(createEmptyCard(new Date(now)));
}

export function reviewCard(card: CardState, rating: Grade, now: number, retention: number): ReviewOutcome {
  const { card: next, log } = scheduler(retention).next(toFsrs(card), new Date(now), rating);
  return {
    card: fromFsrs(next),
    log: {
      rating: log.rating,
      state: log.state,
      due: log.due.getTime(),
      stability: log.stability,
      difficulty: log.difficulty,
      elapsed_days: log.elapsed_days,
      scheduled_days: log.scheduled_days,
      reviewed_at: now,
    },
  };
}

/** When the card would come back for each possible rating. */
export function previewDue(card: CardState, now: number, retention: number): Record<Grade, number> {
  const f = scheduler(retention);
  const out = {} as Record<Grade, number>;
  for (const g of GRADES) out[g] = f.next(toFsrs(card), new Date(now), g).card.due.getTime();
  return out;
}

/** Estimated probability (0..1) that the word is remembered right now. */
export function recallProbability(card: CardState, now: number): number {
  if (card.state === State.New) return 0;
  return scheduler(0.9).get_retrievability(toFsrs(card), new Date(now), false);
}

export type Mastery = 'new' | 'learning' | 'stable';

export function mastery(card: Pick<CardState, 'state' | 'stability'> | null): Mastery {
  if (!card || card.state === State.New) return 'new';
  return card.state === State.Review && card.stability >= STABLE_DAYS ? 'stable' : 'learning';
}

/** Short interval label: 5m, 3h, 4d, 2mo, 1.5y */
export function formatInterval(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${Math.round((d / 365) * 10) / 10}y`;
}
