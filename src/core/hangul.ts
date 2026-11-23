// Hangul text utilities: normalization, decomposition, approximate romanization.

const S_BASE = 0xac00;
const S_END = 0xd7a3;
const V_COUNT = 21;
const T_COUNT = 28;

// Compatibility jamo (the ones an Android IME produces for lone letters).
const INITIALS = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const VOWELS = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const FINALS = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

export function isHangulSyllable(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return c >= S_BASE && c <= S_END;
}

export function containsHangul(text: string): boolean {
  return /[ᄀ-ᇿ㄰-㆏가-힣]/.test(text);
}

// Lone conjoining jamo (U+11xx) look identical to compatibility jamo (U+31xx)
// but are different code points. Map them to the compatibility form.
function conjoiningToCompat(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x1100 && c <= 0x1112) return INITIALS[c - 0x1100];
  if (c >= 0x1161 && c <= 0x1175) return VOWELS[c - 0x1161];
  if (c >= 0x11a8 && c <= 0x11c2) return FINALS[c - 0x11a7];
  return ch;
}

/**
 * Brings Korean text to one canonical Unicode form, so that visually identical
 * strings compare equal: decomposed syllables are composed (NFC), halfwidth and
 * lone conjoining jamo become compatibility jamo.
 */
export function normalizeHangul(text: string): string {
  let out = '';
  for (const ch of text.normalize('NFC')) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0xffa0 && c <= 0xffdc) out += conjoiningToCompat(ch.normalize('NFKC'));
    else if (c >= 0x1100 && c <= 0x11ff) out += conjoiningToCompat(ch);
    else out += ch;
  }
  return out;
}

export interface SyllableParts {
  initial: number;
  vowel: number;
  final: number;
}

export function decomposeSyllable(ch: string): SyllableParts | null {
  if (!isHangulSyllable(ch)) return null;
  const idx = (ch.codePointAt(0) as number) - S_BASE;
  return {
    initial: Math.floor(idx / (V_COUNT * T_COUNT)),
    vowel: Math.floor((idx % (V_COUNT * T_COUNT)) / T_COUNT),
    final: idx % T_COUNT,
  };
}

/** Splits text into compatibility jamo: 한 → ㅎㅏㄴ. Other characters stay as is. */
export function toJamo(text: string): string {
  let out = '';
  for (const ch of normalizeHangul(text)) {
    const p = decomposeSyllable(ch);
    out += p ? INITIALS[p.initial] + VOWELS[p.vowel] + FINALS[p.final] : ch;
  }
  return out;
}

export function countSyllables(text: string): number {
  let n = 0;
  for (const ch of normalizeHangul(text)) if (isHangulSyllable(ch)) n++;
  return n;
}

const R_INITIAL = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const R_VOWEL = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo', 'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const R_FINAL = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'k', 'm', 'l', 'l', 'l', 'p', 'l', 'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];
// A single final consonant moves to the next syllable when it starts with ㅇ.
const R_FINAL_LINKED: Record<number, string> = { 1: 'g', 2: 'kk', 4: 'n', 7: 'd', 8: 'r', 16: 'm', 17: 'b', 19: 's', 20: 'ss', 22: 'j', 23: 'ch', 24: 'k', 25: 't', 26: 'p', 27: '' };

/**
 * Approximate Revised Romanization. Handles linking (음악 → eumak) and ㄹㄹ → ll,
 * but not the other sound-change rules, so it is a reading aid, not exact phonetics.
 */
export function romanize(text: string): string {
  const chars = Array.from(normalizeHangul(text));
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const p = decomposeSyllable(chars[i]);
    if (!p) {
      out += chars[i];
      continue;
    }
    const next = i + 1 < chars.length ? decomposeSyllable(chars[i + 1]) : null;
    const prev = i > 0 ? decomposeSyllable(chars[i - 1]) : null;
    const initial = p.initial === 5 && prev?.final === 8 ? 'l' : R_INITIAL[p.initial];
    let final = R_FINAL[p.final];
    if (next && next.initial === 11 && p.final in R_FINAL_LINKED) final = R_FINAL_LINKED[p.final];
    out += initial + R_VOWEL[p.vowel] + final;
  }
  return out;
}
