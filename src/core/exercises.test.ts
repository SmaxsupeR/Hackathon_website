import { describe, expect, it } from 'vitest';
import { validateAttempt, type AttemptResult } from './attempt';
import { attemptSkill, buildChoiceOptions, checkChoice, checkHandwriting, checkKeyboard, checkSelfGrade, EXERCISES } from './exercises';
import { answer, createFreeSession, createSession, currentTask } from './learning';

const tree = { korean: '나무', meanings: ['дерево', 'древесина (материал)'] };
const strict = { strictSpacing: false };

describe('answer checks (moved out of the screens)', () => {
  it('multiple choice', () => {
    expect(checkChoice(tree, 'ko_ru', 'Дерево').correct).toBe(true);
    expect(checkChoice(tree, 'ko_ru', 'вода').correct).toBe(false);
    expect(checkChoice(tree, 'ru_ko', '나무')).toMatchObject({ correct: true, expected: '나무' });
    expect(checkChoice(tree, 'ru_ko', '나비').correct).toBe(false);
  });
  it('keyboard: Korean strictly with a diff, meanings leniently with a typo flag and the option to self-accept', () => {
    expect(checkKeyboard(tree, 'ru_ko', '나무', strict)).toMatchObject({ correct: true, typo: false });
    const wrong = checkKeyboard(tree, 'ru_ko', '나므', strict);
    expect(wrong).toMatchObject({ correct: false, canSelfAccept: false });
    expect(wrong.diff?.length).toBeGreaterThan(0);
    expect(checkKeyboard(tree, 'ko_ru', 'древесина', strict)).toMatchObject({ correct: true, typo: false });
    expect(checkKeyboard(tree, 'ko_ru', 'дерев0', strict)).toMatchObject({ correct: true, typo: true });
    expect(checkKeyboard(tree, 'ko_ru', 'лес', strict)).toMatchObject({ correct: false, canSelfAccept: true });
    expect(checkKeyboard(tree, 'ko_ru', '', strict)).toMatchObject({ correct: false, canSelfAccept: false });
  });
  it('self-grade and handwriting', () => {
    expect(checkSelfGrade('again').correct).toBe(false);
    expect(checkSelfGrade('hard').correct).toBe(true);
    expect(checkHandwriting(tree, '나무', strict).correct).toBe(true);
    expect(checkHandwriting(tree, '니무', strict).correct).toBe(false);
  });
  it('registry: every method has a skill; handwriting writes Korean and is not available yet; audio prompts mean listening', () => {
    expect(EXERCISES.handwriting).toMatchObject({ skill: 'writing', directions: ['ru_ko'], available: false });
    expect(EXERCISES.self_grade.grading).toBe('self');
    expect(attemptSkill('keyboard')).toBe('recall');
    expect(attemptSkill('choice', 'audio')).toBe('listening');
  });
  it('builds four options without a second right answer', () => {
    const pool = [{ korean: '물', meaning: 'вода' }, { korean: '사과', meaning: 'яблоко' }, { korean: '학교', meaning: 'школа' }, { korean: '나무', meaning: 'древесина' }];
    const ko = buildChoiceOptions(tree, 'ko_ru', pool) as string[];
    expect(ko).toHaveLength(4);
    expect(ko.filter((o) => checkChoice(tree, 'ko_ru', o).correct)).toEqual(['дерево']);
    const ru = buildChoiceOptions(tree, 'ru_ko', pool.slice(0, 3).concat([{ korean: '우유', meaning: 'молоко' }])) as string[];
    expect(ru.filter((o) => o === '나무')).toHaveLength(1);
  });
});

describe('AttemptResult from the engine', () => {
  const at = 1_800_000_000_000;
  it('fills every field from the task and the outcome', () => {
    let s = createSession({ reviews: [{ entryId: 'e', direction: 'ru_ko' }], learning: [], fresh: [], directions: ['ru_ko'], hasChoice: () => true, sessionId: 'S1' });
    expect(currentTask(s)).toMatchObject({ kind: 'recall', purpose: 'review' });
    const r = answer(s, { correct: true, method: 'keyboard', given: '나무', durationMs: 3200.4, at, attemptId: 'A1', hintsUsed: 0 });
    const expected: AttemptResult = {
      attemptId: 'A1', sessionId: 'S1', sessionKind: 'scheduled', entryId: 'e', cardKey: 'e:ru_ko', direction: 'ru_ko',
      skill: 'recall', method: 'keyboard', correct: true, selfGrade: null, hintsUsed: 0, typoCorrected: false,
      selfAccepted: false, given: '나무', durationMs: 3200, at,
    };
    expect(r.result).toEqual(expected);
    expect(validateAttempt(r.result)).toEqual([]);
    expect(r.effects[0]).toMatchObject({ type: 'attempt', mode: 'review', correct: true, result: expected });
    s = r.session;
  });
  it('recognition questions are always choices; self-grades keep the grade; old boolean calls still work', () => {
    const fresh = createSession({ reviews: [], learning: [{ entryId: 'e', direction: 'ko_ru', phase: 'recognition', errors: 0 }], fresh: [], directions: ['ko_ru'], hasChoice: () => true, method: 'self_grade' });
    const r1 = answer(fresh, true);
    expect(r1.result).toMatchObject({ method: 'choice', skill: 'recognition', selfGrade: null });
    expect(validateAttempt(r1.result)).toEqual([]);
    const r2 = answer(r1.session, { correct: true, selfGrade: 'hard' });
    expect(r2.result).toMatchObject({ method: 'self_grade', skill: 'recall', selfGrade: 'hard' });
    expect(r2.effects.find((e) => e.type === 'graduate')).toMatchObject({ grade: 2 });
    const free = createFreeSession({ cards: [{ entryId: 'e', direction: 'ko_ru', status: 'scheduled', due: false, introduced: true }], method: 'keyboard', sessionId: 'F' });
    expect(answer(free, { correct: true, typoCorrected: true }).result).toMatchObject({ sessionKind: 'free', typoCorrected: true, sessionId: 'F' });
  });
  it('flags inconsistent results', () => {
    const base = answer(createSession({ reviews: [{ entryId: 'e', direction: 'ko_ru' }], learning: [], fresh: [], directions: ['ko_ru'], hasChoice: () => false }), true).result;
    expect(validateAttempt({ ...base, cardKey: 'x' })).toContain('cardKey does not match entry and direction');
    expect(validateAttempt({ ...base, method: 'self_grade', selfGrade: null })).toContain('self-grade without a grade');
    expect(validateAttempt({ ...base, correct: false, typoCorrected: true })).toContain('a corrected typo means the answer was accepted');
  });
});
