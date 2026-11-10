// Answer checking for typed (and later handwritten) input.
import { normalizeHangul } from './hangul';

export interface CompareOptions {
  /** Treat "안녕 하세요" and "안녕하세요" as equal. */
  ignoreSpaces: boolean;
  /** Ignore punctuation such as . , ! ? ~ */
  ignorePunctuation: boolean;
}

// ASCII, Latin-1, general, CJK and fullwidth punctuation. Written as explicit ranges
// because not every JavaScript engine supports \p{P} in regular expressions.
const PUNCTUATION = /[!-\/:-@\[-`{-~\u00a1-\u00bf\u2010-\u205e\u3001-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]/g;

export const DEFAULT_COMPARE: CompareOptions = { ignoreSpaces: true, ignorePunctuation: true };

export function canonical(text: string, opts: CompareOptions = DEFAULT_COMPARE): string {
  let s = normalizeHangul(text).toLowerCase();
  if (opts.ignorePunctuation) s = s.replace(PUNCTUATION, '');
  s = s.replace(/\s+/g, opts.ignoreSpaces ? '' : ' ').trim();
  return s;
}

export type DiffKind = 'same' | 'missing' | 'extra';
export interface DiffPart {
  kind: DiffKind;
  text: string;
}

/**
 * Character diff between what the user typed and the expected answer.
 * 'missing' = in the expected answer only, 'extra' = typed but not expected.
 */
export function diffAnswer(given: string, expected: string): DiffPart[] {
  const a = Array.from(normalizeHangul(given));
  const b = Array.from(normalizeHangul(expected));
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  const push = (kind: DiffKind, text: string) => {
    const last = parts[parts.length - 1];
    if (last && last.kind === kind) last.text += text;
    else parts.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push('same', a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push('extra', a[i++]);
    } else {
      push('missing', b[j++]);
    }
  }
  while (i < n) push('extra', a[i++]);
  while (j < m) push('missing', b[j++]);
  return parts;
}

export interface CheckResult {
  correct: boolean;
  /** The accepted answer the input matched, or the closest one to show on a mistake. */
  expected: string;
  diff: DiffPart[];
}

/** Checks input against every acceptable answer. */
export function checkAnswer(given: string, accepted: string[], opts: CompareOptions = DEFAULT_COMPARE): CheckResult {
  const g = canonical(given, opts);
  const candidates = accepted.filter((x) => x.trim() !== '');
  for (const exp of candidates) {
    if (g !== '' && canonical(exp, opts) === g) {
      return { correct: true, expected: exp, diff: [{ kind: 'same', text: normalizeHangul(exp) }] };
    }
  }
  let best = candidates[0] ?? '';
  let bestDiff = diffAnswer(given, best);
  let bestScore = score(bestDiff);
  for (const exp of candidates.slice(1)) {
    const d = diffAnswer(given, exp);
    if (score(d) > bestScore) {
      best = exp;
      bestDiff = d;
      bestScore = score(d);
    }
  }
  return { correct: false, expected: best, diff: bestDiff };
}

function score(diff: DiffPart[]): number {
  return diff.reduce((n, p) => n + (p.kind === 'same' ? p.text.length : -p.text.length), 0);
}

// ---------- Translation answers (Korean → meaning) ----------

function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(PUNCTUATION, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * All the ways one stored meaning may be written: "идти (пешком)" also accepts
 * "идти"; "to go" also accepts "go"; "дом, жилище", "дом; жилище" and "дом / жилище" accept each part.
 */
export function meaningVariants(meaning: string): string[] {
  const out = new Set<string>();
  const add = (v: string) => {
    const p = plain(v);
    if (p === '') return;
    out.add(p);
    if (p.startsWith('to ')) out.add(p.slice(3));
  };
  const withoutBrackets = meaning.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  for (const source of [meaning, withoutBrackets]) {
    add(source);
    for (const part of source.split(/[,/;]/)) add(part);
  }
  return [...out];
}

/** Edit distance where swapping two neighbouring letters counts as one edit. */
export function editDistance(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[x.length][y.length];
}

export interface MeaningResult {
  correct: boolean;
  /** Accepted with one typo; the right spelling should be shown. */
  typo: boolean;
  /** The stored meaning that matched, or the first one on a mistake. */
  expected: string;
}

/** Words of this length or longer may contain one typo and still count. */
export const TYPO_MIN_LENGTH = 5;

/** Checks a typed translation against every stored meaning. */
export function checkMeaning(given: string, meanings: string[]): MeaningResult {
  const g = plain(given);
  const list = meanings.filter((m) => m.trim() !== '');
  const fallback = { correct: false, typo: false, expected: list[0] ?? '' };
  if (g === '') return fallback;
  for (const m of list) if (meaningVariants(m).includes(g)) return { correct: true, typo: false, expected: m };
  if (Array.from(g).length >= TYPO_MIN_LENGTH) {
    for (const m of list) if (meaningVariants(m).some((v) => editDistance(v, g) === 1)) return { correct: true, typo: true, expected: m };
  }
  return fallback;
}
