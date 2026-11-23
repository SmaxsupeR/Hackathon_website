// Exercise types and their answer checks. Screens only collect the answer and show the
// result; deciding whether it is right lives here, so every exercise is testable without UI.
import { checkAnswer, checkMeaning, type DiffPart } from './answer';
import type { AnswerMethod, Direction, LearningSkill, SelfGrade } from './model';
import { pickOptions, sameSyllableCount } from './options';

export interface ExerciseWord {
  korean: string;
  meanings: string[];
}

/** How a prompt is presented. Audio prompts turn an exercise into listening. */
export type PromptMode = 'text' | 'audio';

export interface ExerciseSpec {
  method: AnswerMethod;
  /** Skill exercised with a text prompt. */
  skill: LearningSkill;
  /** Directions the method can answer. */
  directions: Direction[];
  /** Checked by the app, or graded by the learner. */
  grading: 'auto' | 'self';
  /** Ready in this version. */
  available: boolean;
}

/**
 * The registry of answer methods. Adding listening or handwriting means adding an entry
 * and a check function; the engine, the rating policy and storage stay the same.
 * All methods feed the same FSRS card of their direction: there is no separate
 * scheduler per answer method.
 */
export const EXERCISES: Record<AnswerMethod, ExerciseSpec> = {
  choice: { method: 'choice', skill: 'recognition', directions: ['ko_ru', 'ru_ko'], grading: 'auto', available: true },
  keyboard: { method: 'keyboard', skill: 'recall', directions: ['ko_ru', 'ru_ko'], grading: 'auto', available: true },
  self_grade: { method: 'self_grade', skill: 'recall', directions: ['ko_ru', 'ru_ko'], grading: 'self', available: true },
  // Writing Korean by hand answers the meaning → Korean direction. Needs a recogniser (stage after TTS).
  handwriting: { method: 'handwriting', skill: 'writing', directions: ['ru_ko'], grading: 'auto', available: false },
};

/** Skill of an attempt, taking the prompt into account: an audio prompt makes it listening. */
export function attemptSkill(method: AnswerMethod, prompt: PromptMode = 'text'): LearningSkill {
  return prompt === 'audio' ? 'listening' : EXERCISES[method].skill;
}

export interface CheckedAnswer {
  correct: boolean;
  /** Accepted with a small typo; show the right spelling. */
  typo: boolean;
  /** Character diff for Korean answers. */
  diff: DiffPart[] | null;
  /** The right answer to show. */
  expected: string;
  /**
   * A wrong translation the learner may still claim as right (a synonym the dictionary
   * does not list). Only for Korean → meaning answers typed on the keyboard.
   */
  canSelfAccept: boolean;
}

export interface CheckOptions {
  /** Count spaces in Korean answers. */
  strictSpacing: boolean;
}

/** The option that is right in a multiple-choice question for this direction. */
export function isRightOption(word: ExerciseWord, direction: Direction, option: string): boolean {
  if (direction === 'ru_ko') return option === word.korean;
  const o = option.trim().toLowerCase();
  return word.meanings.some((m) => m.trim().toLowerCase() === o);
}

export function checkChoice(word: ExerciseWord, direction: Direction, option: string): CheckedAnswer {
  const correct = isRightOption(word, direction, option);
  return { correct, typo: false, diff: null, expected: direction === 'ru_ko' ? word.korean : (word.meanings[0] ?? ''), canSelfAccept: false };
}

/** A typed answer. Korean must match exactly (after Unicode normalisation); a meaning may match any listed sense. */
export function checkKeyboard(word: ExerciseWord, direction: Direction, given: string, opts: CheckOptions): CheckedAnswer {
  if (direction === 'ru_ko') {
    const r = checkAnswer(given, [word.korean], { ignoreSpaces: !opts.strictSpacing, ignorePunctuation: true });
    return { correct: r.correct, typo: false, diff: given.trim() === '' ? null : r.diff, expected: word.korean, canSelfAccept: false };
  }
  const r = checkMeaning(given, word.meanings);
  return { correct: r.correct, typo: r.typo, diff: null, expected: r.expected, canSelfAccept: !r.correct && given.trim() !== '' };
}

/** Handwriting is checked on the text the recogniser returns, with the same rules as typed Korean. */
export function checkHandwriting(word: ExerciseWord, recognized: string, opts: CheckOptions): CheckedAnswer {
  return checkKeyboard(word, 'ru_ko', recognized, opts);
}

export function checkSelfGrade(grade: SelfGrade): { correct: boolean } {
  return { correct: grade !== 'again' };
}

export interface PoolWord {
  korean: string;
  meaning: string;
}

/** Four options for a multiple-choice question, or null if there are not enough other words. */
export function buildChoiceOptions(word: ExerciseWord, direction: Direction, pool: PoolWord[], random: () => number = Math.random): string[] | null {
  if (direction === 'ko_ru') return pickOptions({ correct: word.meanings[0] ?? '', alsoRight: word.meanings, pool: pool.map((p) => p.meaning), count: 4, random });
  return pickOptions({ correct: word.korean, alsoRight: [word.korean], pool: pool.map((p) => p.korean), count: 4, similar: sameSyllableCount(word.korean), random });
}
