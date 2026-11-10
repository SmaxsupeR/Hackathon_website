// Multiple-choice options for recognition questions.
import { countSyllables } from './hangul';

export function shuffle<T>(list: T[], random: () => number = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export interface OptionsInput {
  correct: string;
  /** Other forms of the right answer; none of them may appear as a wrong option. */
  alsoRight: string[];
  pool: string[];
  count: number;
  /** Prefer wrong options that look similar (for Korean: same number of syllables). */
  similar?: (candidate: string) => boolean;
  random?: () => number;
}

/** The right answer plus count − 1 different wrong ones, shuffled. Null if the pool is too small. */
export function pickOptions({ correct, alsoRight, pool, count, similar, random = Math.random }: OptionsInput): string[] | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const taken = new Set([norm(correct), ...alsoRight.map(norm)]);
  const candidates = shuffle(pool, random);
  if (similar) candidates.sort((a, b) => Number(similar(b)) - Number(similar(a)));
  const wrong: string[] = [];
  for (const c of candidates) {
    const key = norm(c);
    if (key === '' || taken.has(key)) continue;
    taken.add(key);
    wrong.push(c.trim());
    if (wrong.length === count - 1) break;
  }
  if (wrong.length < count - 1) return null;
  return shuffle([correct, ...wrong], random);
}

export const sameSyllableCount = (word: string) => (candidate: string) => countSyllables(candidate) === countSyllables(word);
