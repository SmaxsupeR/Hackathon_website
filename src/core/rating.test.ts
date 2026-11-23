import { describe, expect, it } from 'vitest';
import { GRADE, type AnswerMethod, type LearningSkill, type SelfGrade } from './model';
import { decideRating, successGrade, type RatingContext } from './rating';

const ctx = (c: Partial<RatingContext>): RatingContext => ({
  sessionKind: 'scheduled',
  step: 'review',
  status: 'scheduled',
  due: true,
  trainingErrors: 0,
  countAsReview: false,
  ratedInSession: false,
  ...c,
});
const res = (r: Partial<{ skill: LearningSkill; method: AnswerMethod; correct: boolean; selfGrade: SelfGrade | null; hintsUsed: number }>) => ({
  skill: 'recall' as LearningSkill,
  method: 'keyboard' as AnswerMethod,
  correct: true,
  selfGrade: null,
  hintsUsed: 0,
  ...r,
});

describe('FSRS rating policy', () => {
  it('never rates recognition: training stage in planned study, statistics only elsewhere', () => {
    expect(decideRating(ctx({ step: 'recognition', status: 'training' }), res({ skill: 'recognition', method: 'choice' }))).toEqual({ kind: 'training' });
    expect(decideRating(ctx({ step: 'recognition', status: 'training' }), res({ skill: 'recognition', method: 'choice', correct: false }))).toEqual({ kind: 'training' });
    expect(decideRating(ctx({ sessionKind: 'free', step: 'practice', countAsReview: true }), res({ skill: 'recognition', method: 'choice' }))).toMatchObject({ kind: 'log_only' });
  });

  it('graduates a trained card on a correct recall: Good without training errors, Hard with them, never Easy', () => {
    expect(decideRating(ctx({ step: 'acquisition', status: 'training', due: false }), res({}))).toEqual({ kind: 'graduate', grade: GRADE.good });
    expect(decideRating(ctx({ step: 'acquisition', status: 'training', due: false, trainingErrors: 2 }), res({}))).toEqual({ kind: 'graduate', grade: GRADE.hard });
    expect(decideRating(ctx({ step: 'acquisition', status: 'new', due: false }), res({ method: 'self_grade', selfGrade: 'easy' }))).toEqual({ kind: 'graduate', grade: GRADE.good });
    expect(decideRating(ctx({ step: 'acquisition', status: 'training', due: false }), res({ method: 'self_grade', selfGrade: 'hard' }))).toEqual({ kind: 'graduate', grade: GRADE.hard });
    expect(decideRating(ctx({ step: 'acquisition', status: 'training', due: false }), res({ correct: false }))).toEqual({ kind: 'training' });
  });

  it('reviews a due card: automatic checks give Good or Again, hints lower to Hard, self-grades are used as given', () => {
    expect(decideRating(ctx({}), res({}))).toEqual({ kind: 'review', grade: GRADE.good });
    expect(decideRating(ctx({}), res({ correct: false }))).toEqual({ kind: 'review', grade: GRADE.again });
    expect(decideRating(ctx({}), res({ hintsUsed: 1 }))).toEqual({ kind: 'review', grade: GRADE.hard });
    for (const g of ['hard', 'good', 'easy'] as const) {
      expect(decideRating(ctx({}), res({ method: 'self_grade', selfGrade: g }))).toEqual({ kind: 'review', grade: GRADE[g] });
    }
    expect(decideRating(ctx({}), res({ method: 'self_grade', selfGrade: 'again', correct: false }))).toEqual({ kind: 'review', grade: GRADE.again });
  });

  it('refuses reviews that are not due, a second rating in the same session, and relearning steps', () => {
    expect(decideRating(ctx({ due: false }), res({}))).toEqual({ kind: 'log_only', reason: 'not_due' });
    expect(decideRating(ctx({ status: 'training' }), res({}))).toEqual({ kind: 'log_only', reason: 'not_due' });
    expect(decideRating(ctx({ ratedInSession: true }), res({}))).toEqual({ kind: 'log_only', reason: 'already_rated' });
    expect(decideRating(ctx({ step: 'relearn' }), res({ correct: false }))).toEqual({ kind: 'log_only', reason: 'relearning' });
  });

  it('free practice saves statistics only, unless a due review is explicitly counted', () => {
    const free = (c: Partial<RatingContext>) => ctx({ sessionKind: 'free', step: 'practice', ...c });
    expect(decideRating(free({}), res({}))).toEqual({ kind: 'log_only', reason: 'free_practice' });
    expect(decideRating(free({ status: 'training', due: false }), res({ correct: false }))).toEqual({ kind: 'log_only', reason: 'free_practice' });
    expect(decideRating(free({ countAsReview: true }), res({}))).toEqual({ kind: 'review', grade: GRADE.good });
    expect(decideRating(free({ countAsReview: true }), res({ correct: false }))).toEqual({ kind: 'review', grade: GRADE.again });
    expect(decideRating(free({ countAsReview: true, due: false }), res({}))).toEqual({ kind: 'log_only', reason: 'not_due' });
    expect(decideRating(free({ countAsReview: true, status: 'new', due: false }), res({}))).toEqual({ kind: 'log_only', reason: 'not_due' });
    expect(decideRating(free({ countAsReview: true, ratedInSession: true }), res({}))).toEqual({ kind: 'log_only', reason: 'already_rated' });
  });

  it('logs listening without scheduling it, and rates handwriting like typed recall', () => {
    expect(decideRating(ctx({}), res({ skill: 'listening' }))).toMatchObject({ kind: 'log_only', reason: 'skill_not_scheduled' });
    expect(decideRating(ctx({}), res({ skill: 'writing', method: 'handwriting' }))).toEqual({ kind: 'review', grade: GRADE.good });
  });

  it('success grades', () => {
    expect(successGrade({ method: 'keyboard', selfGrade: null, hintsUsed: 0 })).toBe(GRADE.good);
    expect(successGrade({ method: 'keyboard', selfGrade: null, hintsUsed: 2 })).toBe(GRADE.hard);
    expect(successGrade({ method: 'self_grade', selfGrade: 'easy', hintsUsed: 0 })).toBe(GRADE.easy);
  });
});
