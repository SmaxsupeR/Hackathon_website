// Types shared by the learning engine, answer checks and the FSRS rating policy.

/** ko_ru: see the Korean word, produce the meaning. ru_ko: see the meaning, produce the Korean word. */
export type Direction = 'ko_ru' | 'ru_ko';
export const DIRECTIONS: Direction[] = ['ko_ru', 'ru_ko'];

/** Training stage saved between sessions for a card that has not graduated yet. */
export type Phase = 'recognition' | 'recall';

/** FSRS ratings. Automatic checks never produce Easy; only the learner's own grade can. */
export const GRADE = { again: 1, hard: 2, good: 3, easy: 4 } as const;
export type AppGrade = (typeof GRADE)[keyof typeof GRADE];

/** What kind of knowledge an attempt exercises. */
export type LearningSkill = 'recognition' | 'recall' | 'listening' | 'writing';

/** How the learner answered. */
export type AnswerMethod = 'choice' | 'keyboard' | 'self_grade' | 'handwriting';

/** Planned sessions follow the FSRS schedule; free practice does not change it by default. */
export type SessionKind = 'scheduled' | 'free';

/** The learner's own grade in self-assessed flashcards. */
export type SelfGrade = 'again' | 'hard' | 'good' | 'easy';

export const cardKey = (entryId: string, direction: Direction) => `${entryId}:${direction}`;
