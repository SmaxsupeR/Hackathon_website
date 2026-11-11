// The FSRS rating policy: a pure function that decides what one attempt may change.
// The learning engine decides what to ask next; this module decides whether the answer
// touches the schedule. Keeping them apart means a new exercise cannot change FSRS by accident.
import type { AttemptResult } from './attempt';
import { GRADE, type AppGrade, type SessionKind } from './model';

export interface RatingContext {
  sessionKind: SessionKind;
  /** The step the attempt answered. */
  step: 'recognition' | 'acquisition' | 'review' | 'relearn' | 'practice';
  /** Stored state of the card before the attempt. */
  status: 'new' | 'training' | 'scheduled';
  /** For a scheduled card: is a review due now? */
  due: boolean;
  /** Mistakes made in training so far (before this attempt). */
  trainingErrors: number;
  /** Free practice only: the learner asked to count it as the planned review. */
  countAsReview: boolean;
  /** This card already got an FSRS rating in this session. */
  ratedInSession: boolean;
}

export type Decision =
  /** Only statistics are saved. */
  | { kind: 'log_only'; reason: LogOnlyReason }
  /** The training stage changes; FSRS is not touched. */
  | { kind: 'training' }
  /** Training is finished: the card enters FSRS with this first rating. */
  | { kind: 'graduate'; grade: AppGrade }
  /** A due card is reviewed. */
  | { kind: 'review'; grade: AppGrade };

export type LogOnlyReason = 'free_practice' | 'not_due' | 'already_rated' | 'relearning' | 'skill_not_scheduled' | 'recognition_in_free_practice';

/** Rating for a successful answer. Automatic checks give Good (Hard with hints); self-grades are used as given. */
export function successGrade(r: Pick<AttemptResult, 'method' | 'selfGrade' | 'hintsUsed'>): AppGrade {
  if (r.method === 'self_grade' && r.selfGrade) return GRADE[r.selfGrade];
  return r.hintsUsed > 0 ? GRADE.hard : GRADE.good;
}

export function decideRating(ctx: RatingContext, r: Pick<AttemptResult, 'skill' | 'method' | 'correct' | 'selfGrade' | 'hintsUsed'>): Decision {
  // Listening is logged only until there is a pedagogical reason to schedule it separately.
  if (r.skill === 'listening') return { kind: 'log_only', reason: 'skill_not_scheduled' };

  // Recognition (choosing from options) never rates FSRS: a guess must not count as knowing.
  if (r.skill === 'recognition') {
    if (ctx.sessionKind === 'scheduled' && ctx.step === 'recognition') return { kind: 'training' };
    return { kind: 'log_only', reason: ctx.sessionKind === 'free' ? 'recognition_in_free_practice' : 'skill_not_scheduled' };
  }

  if (ctx.ratedInSession) return { kind: 'log_only', reason: 'already_rated' };

  if (ctx.sessionKind === 'free') {
    if (ctx.countAsReview && ctx.status === 'scheduled' && ctx.due) return { kind: 'review', grade: r.correct ? successGrade(r) : GRADE.again };
    return { kind: 'log_only', reason: ctx.countAsReview ? 'not_due' : 'free_practice' };
  }

  switch (ctx.step) {
    case 'relearn':
      return { kind: 'log_only', reason: 'relearning' };
    case 'acquisition': {
      if (!r.correct) return { kind: 'training' };
      // A word just learned never starts with Easy; mistakes in training lower it to Hard.
      const capped = Math.min(successGrade(r), ctx.trainingErrors > 0 ? GRADE.hard : GRADE.good) as AppGrade;
      return { kind: 'graduate', grade: capped };
    }
    case 'review':
      if (ctx.status !== 'scheduled' || !ctx.due) return { kind: 'log_only', reason: 'not_due' };
      return { kind: 'review', grade: r.correct ? successGrade(r) : GRADE.again };
    default:
      return { kind: 'log_only', reason: 'skill_not_scheduled' };
  }
}
