import { describe, expect, it } from 'vitest';
import { canonical, checkAnswer, checkMeaning, diffAnswer, editDistance } from './answer';
import { pickOptions, sameSyllableCount } from './options';
import { countSyllables, normalizeHangul, romanize, toJamo } from './hangul';
import { detectDelimiter, parseDelimited, parseWordList, serializeWordList } from './importer';
import { formatInterval, mastery, newCard, previewDue, Rating, recallProbability, reviewCard, State } from './scheduler';

describe('hangul normalization', () => {
  it('composes decomposed syllables', () => {
    const decomposed = '나무'; // 나무 as conjoining jamo
    expect(decomposed).not.toBe('나무');
    expect(normalizeHangul(decomposed)).toBe('나무');
  });
  it('maps lone conjoining and halfwidth jamo to compatibility jamo', () => {
    expect(normalizeHangul('ᄀ')).toBe('ㄱ');
    expect(normalizeHangul('ᅡ')).toBe('ㅏ');
    expect(normalizeHangul('ᆫ')).toBe('ㄴ');
    expect(normalizeHangul('ﾡ')).toBe('ㄱ');
  });
  it('keeps separately typed letters separate', () => {
    expect(normalizeHangul('ㄱㅏ')).toBe('ㄱㅏ');
  });
  it('decomposes and counts', () => {
    expect(toJamo('한글')).toBe('ㅎㅏㄴㄱㅡㄹ');
    expect(toJamo('값')).toBe('ㄱㅏㅄ');
    expect(countSyllables('안녕하세요!')).toBe(5);
  });
  it('romanizes approximately', () => {
    expect(romanize('나무')).toBe('namu');
    expect(romanize('한국어')).toBe('hangugeo');
    expect(romanize('음악')).toBe('eumak');
    expect(romanize('빨리')).toBe('ppalli');
    expect(romanize('안녕하세요')).toBe('annyeonghaseyo');
  });
});

describe('answer checking', () => {
  it('accepts different unicode forms of the same text', () => {
    expect(checkAnswer('나무', ['나무']).correct).toBe(true);
  });
  it('handles spaces and punctuation by options', () => {
    expect(checkAnswer('안녕 하세요', ['안녕하세요!']).correct).toBe(true);
    expect(checkAnswer('안녕 하세요', ['안녕하세요'], { ignoreSpaces: false, ignorePunctuation: true }).correct).toBe(false);
    expect(canonical('  감사합니다.  ')).toBe('감사합니다');
  });
  it('accepts any of several answers and rejects empty input', () => {
    expect(checkAnswer('Tree', ['дерево', 'tree']).correct).toBe(true);
    expect(checkAnswer('', ['나무']).correct).toBe(false);
    expect(checkAnswer('  ', ['']).correct).toBe(false);
  });
  it('shows a diff against the closest answer', () => {
    const r = checkAnswer('나므', ['사과', '나무']);
    expect(r.correct).toBe(false);
    expect(r.expected).toBe('나무');
    expect(r.diff).toEqual([
      { kind: 'same', text: '나' },
      { kind: 'extra', text: '므' },
      { kind: 'missing', text: '무' },
    ]);
    expect(diffAnswer('학교', '학교에')).toEqual([
      { kind: 'same', text: '학교' },
      { kind: 'missing', text: '에' },
    ]);
  });
});

describe('import and export', () => {
  it('parses quoted csv', () => {
    expect(parseDelimited('a,"b, c","d ""e"""\r\nf,g,h', ',')).toEqual([
      ['a', 'b, c', 'd "e"'],
      ['f', 'g', 'h'],
    ]);
  });
  it('detects delimiters', () => {
    expect(detectDelimiter('나무\tдерево\n물\tвода')).toBe('\t');
    expect(detectDelimiter('나무 - дерево\n물 - вода')).toBe(' - ');
    expect(detectDelimiter('나무;дерево\n물;вода')).toBe(';');
  });
  it('parses a pasted list, skips header, reports bad lines', () => {
    const r = parseWordList('korean,translation\n나무,дерево; tree\n물\n,пусто\n사과,яблоко,sagwa,사과를 먹어요,Я ем яблоко');
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ korean: '나무', meanings: ['дерево', 'tree'] });
    expect(r.rows[1]).toMatchObject({ transcription: 'sagwa', example: '사과를 먹어요', exampleTranslation: 'Я ем яблоко' });
    expect(r.errors.map((e) => [e.line, e.reason])).toEqual([
      [3, 'too_few_columns'],
      [4, 'empty_field'],
    ]);
  });
  it('swaps columns when korean comes second', () => {
    const r = parseWordList('дерево - 나무\nвода - 물');
    expect(r.rows.map((x) => x.korean)).toEqual(['나무', '물']);
    expect(r.rows[0].meanings).toEqual(['дерево']);
  });
  it('round-trips through csv and tsv', () => {
    const rows = [
      { korean: '나무', meanings: ['дерево', 'tree'], transcription: 'namu', example: '나무가 커요, 정말', exampleTranslation: 'Дерево "большое"' },
      { korean: '물', meanings: ['вода'] },
    ];
    for (const d of [',', '\t'] as const) {
      const back = parseWordList(serializeWordList(rows, d), d);
      expect(back.errors).toEqual([]);
      expect(back.rows).toEqual([rows[0], { korean: '물', meanings: ['вода'], transcription: undefined, example: undefined, exampleTranslation: undefined }]);
    }
  });
});

describe('scheduler', () => {
  const now = Date.UTC(2026, 0, 1);
  it('starts new and moves forward on good answers', () => {
    let card = newCard(now);
    expect(card.state).toBe(State.New);
    expect(mastery(card)).toBe('new');
    let t = now;
    for (let i = 0; i < 6; i++) {
      const out = reviewCard(card, Rating.Good, t, 0.9);
      expect(out.card.due).toBeGreaterThan(t);
      expect(out.log.reviewed_at).toBe(t);
      card = out.card;
      t = card.due;
    }
    expect(card.state).toBe(State.Review);
    expect(card.reps).toBe(6);
    expect(mastery(card)).toBe('stable');
  });
  it('orders intervals by rating and counts lapses', () => {
    let card = newCard(now);
    card = reviewCard(card, Rating.Easy, now, 0.9).card;
    const later = card.due;
    const p = previewDue(card, later, 0.9);
    expect(p[Rating.Again]).toBeLessThan(p[Rating.Hard]);
    expect(p[Rating.Hard]).toBeLessThanOrEqual(p[Rating.Good]);
    expect(p[Rating.Good]).toBeLessThanOrEqual(p[Rating.Easy]);
    const failed = reviewCard(card, Rating.Again, later, 0.9).card;
    expect(failed.lapses).toBe(1);
    expect(mastery(failed)).toBe('learning');
  });
  it('higher desired retention means shorter intervals', () => {
    const card = reviewCard(newCard(now), Rating.Easy, now, 0.9).card;
    const strict = reviewCard(card, Rating.Good, card.due, 0.95).card.scheduled_days;
    const relaxed = reviewCard(card, Rating.Good, card.due, 0.8).card.scheduled_days;
    expect(strict).toBeLessThan(relaxed);
  });
  it('estimates recall probability', () => {
    const card = reviewCard(newCard(now), Rating.Easy, now, 0.9).card;
    expect(recallProbability(newCard(now), now)).toBe(0);
    const soon = recallProbability(card, now + 3600_000);
    const late = recallProbability(card, now + 200 * 86400_000);
    expect(soon).toBeGreaterThan(0.95);
    expect(late).toBeLessThan(soon);
  });
  it('formats intervals', () => {
    expect([formatInterval(60_000), formatInterval(3 * 3600_000), formatInterval(4 * 86400_000), formatInterval(90 * 86400_000)]).toEqual(['1m', '3h', '4d', '3mo']);
  });
});

describe('punctuation handling', () => {
  it('ignores ascii, korean and fullwidth punctuation but keeps letters and digits', () => {
    expect(canonical('안녕하세요?!')).toBe('안녕하세요');
    expect(canonical('네, 맞아요。')).toBe('네맞아요');
    expect(canonical('“집”…(home)')).toBe('집home');
    expect(canonical('3시！')).toBe('3시');
    expect(canonical('é ñ ü')).toBe('éñü');
  });
});

describe('translation answers (Korean → meaning)', () => {
  it('accepts any stored meaning, its parts and forms without brackets', () => {
    const m = ['дерево', 'древесина (материал)', 'to grow, to raise'];
    for (const ok of ['Дерево', ' дерево. ', 'древесина', 'древесина (материал)', 'grow', 'to raise', 'raise']) {
      expect(checkMeaning(ok, m)).toMatchObject({ correct: true, typo: false });
    }
    expect(checkMeaning('ёлка', ['елка'])).toMatchObject({ correct: true, typo: false });
  });
  it('accepts one typo in longer words and says so', () => {
    expect(checkMeaning('шокла', ['школа'])).toMatchObject({ correct: true, typo: true, expected: 'школа' });
    expect(checkMeaning('яблокл', ['яблоко'])).toMatchObject({ correct: true, typo: true });
  });
  it('does not accept typos in short words, two typos, or a different word', () => {
    expect(checkMeaning('дон', ['дом']).correct).toBe(false);
    expect(checkMeaning('шкала', ['школа']).correct).toBe(true); // one substitution
    expect(checkMeaning('шкалаа', ['школа']).correct).toBe(false);
    expect(checkMeaning('вода', ['дерево']).correct).toBe(false);
    expect(checkMeaning('', ['дерево'])).toEqual({ correct: false, typo: false, expected: 'дерево' });
  });
  it('measures edit distance with swaps', () => {
    expect(editDistance('школа', 'шкoла'.replace('o', 'о'))).toBe(0);
    expect(editDistance('школа', 'шокла')).toBe(1);
    expect(editDistance('дом', 'домик')).toBe(2);
  });
});

describe('multiple-choice options', () => {
  it('gives the right answer plus distinct wrong ones, never another form of the right answer', () => {
    const o = pickOptions({ correct: 'дерево', alsoRight: ['дерево', 'tree'], pool: ['вода', 'Дерево', 'tree', 'школа', 'вода ', 'дом', ''], count: 4 }) as string[];
    expect([...o].sort()).toEqual(['вода', 'дерево', 'дом', 'школа'].sort());
  });
  it('returns null when the pool is too small', () => {
    expect(pickOptions({ correct: 'дерево', alsoRight: [], pool: ['вода', 'вода'], count: 4 })).toBeNull();
  });
  it('prefers Korean words of the same length', () => {
    for (let i = 0; i < 20; i++) {
      const o = pickOptions({ correct: '나무', alsoRight: ['나무'], pool: ['고양이', '물', '학교', '사과', '선생님', '집', '우유'], count: 4, similar: sameSyllableCount('나무') }) as string[];
      expect([...o].sort()).toEqual(['나무', '사과', '우유', '학교'].sort());
    }
  });
});
