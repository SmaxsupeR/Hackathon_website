// The one result format every exercise produces. Statistics, the FSRS rating policy and
// storage all read this, so a new exercise (listening, handwriting) only has to fill it in.
import type { AnswerMethod, Direction, LearningSkill, SelfGrade, SessionKind } from './model';

export interface AttemptResult {
  /** Unique id of this attempt; also the id of the FSRS event it may cause (idempotency key). */
  attemptId: string;
  sessionId: string | null;
  sessionKind: SessionKind;
  entryId: string;
  /** Learning card: word × direction. */
  cardKey: string;
  direction: Direction;
  skill: LearningSkill;
  method: AnswerMethod;
  correct: boolean;
  /** Set for self-assessed flashcards. */
  selfGrade: SelfGrade | null;
  hintsUsed: number;
  /** Accepted although it contained a small typo. */
  typoCorrected: boolean;
  /** The learner overrode the automatic check ("my answer is also right"). */
  selfAccepted: boolean;
  given: string | null;
  durationMs: number;
  /** When the answer was given (ms since epoch). */
  at: number;
}

/** What an exercise screen reports; the engine fills in the rest from the current task. */
export interface Outcome {
  correct: boolean;
  method?: AnswerMethod;
  skill?: LearningSkill;
  selfGrade?: SelfGrade | null;
  hintsUsed?: number;
  typoCorrected?: boolean;
  selfAccepted?: boolean;
  given?: string | null;
  durationMs?: number;
  at?: number;
  attemptId?: string;
}

/** The skill an answer method exercises unless the prompt says otherwise (e.g. audio prompt → listening). */
export function skillOf(method: AnswerMethod): LearningSkill {
  switch (method) {
    case 'choice':
      return 'recognition';
    case 'handwriting':
      return 'writing';
    default:
      return 'recall';
  }
}

/** Checks that a result is internally consistent. Returns the list of problems (empty when valid). */
export function validateAttempt(r: AttemptResult): string[] {
  const problems: string[] = [];
  if (!r.attemptId) problems.push('attemptId is empty');
  if (r.cardKey !== `${r.entryId}:${r.direction}`) problems.push('cardKey does not match entry and direction');
  if (r.method === 'self_grade' && r.selfGrade === null) problems.push('self-grade without a grade');
  if (r.method !== 'self_grade' && r.selfGrade !== null) problems.push('grade without self-grade method');
  if (r.method === 'self_grade' && r.selfGrade !== null && r.correct !== (r.selfGrade !== 'again')) problems.push('self-grade and correctness disagree');
  if (r.method === 'choice' && r.skill !== 'recognition' && r.skill !== 'listening') problems.push('choice answers are recognition or listening');
  if (r.typoCorrected && !r.correct) problems.push('a corrected typo means the answer was accepted');
  if (r.hintsUsed < 0 || !Number.isFinite(r.durationMs) || r.durationMs < 0) problems.push('negative hints or duration');
  return problems;
}
