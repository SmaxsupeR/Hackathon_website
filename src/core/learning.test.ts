import { describe, expect, it } from 'vitest';
import {
  answer,
  BATCH,
  completeIntro,
  createFreeSession,
  createSession,
  currentTask,
  GRADE,
  isFinished,
  MAX_FAILS,
  progress,
  type Effect,
  type Session,
  type SessionInput,
  type Task,
} from './learning';

const both: SessionInput['directions'] = ['ko_ru', 'ru_ko'];
const choice = () => true;

function make(input: Partial<SessionInput>): Session {
  return createSession({ reviews: [], learning: [], fresh: [], directions: both, hasChoice: choice, ...input });
}

const describeTask = (s: Session, t: Task) =>
  t.kind === 'intro'
    ? `intro:${t.entryId}${t.repeat ? '*' : ''}`
    : `${t.kind === 'recognize' ? (s.cards[t.key].stage === 'practice' ? 'practice-choice' : 'recognize') : t.purpose}:${s.cards[t.key].entryId}:${s.cards[t.key].direction}`;

/**
 * Plays a session to the end. `decide` returns whether the learner answers the current question right.
 * Returns the visited steps and all effects.
 */
function play(s: Session, decide: (step: string, n: number) => boolean = () => true, limit = 500) {
  const steps: string[] = [];
  const effects: Effect[] = [];
  let session = s;
  for (let n = 0; !isFinished(session); n++) {
    if (n > limit) throw new Error('session did not end');
    const task = currentTask(session) as Task;
    const name = describeTask(session, task);
    steps.push(name);
    const before = progress(session);
    if (task.kind === 'intro') {
      const r = completeIntro(session);
      session = r.session;
      effects.push(...r.effects);
    } else {
      const r = answer(session, decide(name, n));
      session = r.session;
      effects.push(...r.effects);
    }
    expect(progress(session)).toBeGreaterThanOrEqual(before);
  }
  expect(progress(session)).toBe(1);
  return { steps, effects, session };
}

const ofType = <T extends Effect['type']>(effects: Effect[], type: T) => effects.filter((e): e is Extract<Effect, { type: T }> => e.type === type);

describe('new word: intro → recognition → recall → graduation', () => {
  it('teaches before testing and only then schedules, one direction after the other', () => {
    const { steps, effects } = play(make({ fresh: ['a'] }));
    expect(steps).toEqual(['intro:a', 'recognize:a:ko_ru', 'acquisition:a:ko_ru', 'recognize:a:ru_ko', 'acquisition:a:ru_ko']);
    expect(effects[0]).toEqual({ type: 'introduce', entryId: 'a', directions: ['ko_ru', 'ru_ko'] });
    expect(ofType(effects, 'graduate')).toEqual([
      { type: 'graduate', entryId: 'a', direction: 'ko_ru', grade: GRADE.good },
      { type: 'graduate', entryId: 'a', direction: 'ru_ko', grade: GRADE.good },
    ]);
  });

  it('the intro alone never counts as learning the word', () => {
    const s = make({ fresh: ['a'] });
    const r = completeIntro(s);
    expect(r.effects.map((e) => e.type)).toEqual(['introduce']);
    expect(progress(r.session)).toBe(0);
  });

  it('recognition never produces an FSRS rating, even when right', () => {
    let s = completeIntro(make({ fresh: ['a'] })).session;
    const r = answer(s, true);
    expect(r.effects.map((e) => e.type)).toEqual(['attempt', 'phase']);
    expect(r.effects[0]).toMatchObject({ mode: 'recognition', correct: true });
    expect(r.effects[1]).toMatchObject({ phase: 'recall', errors: 0 });
    s = r.session;
    expect(describeTask(s, currentTask(s) as Task)).toBe('acquisition:a:ko_ru');
  });

  it('introduces new words in batches: all intros of a batch before its questions', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { steps } = play(make({ fresh: ids, directions: ['ko_ru'] }));
    const firstQuestion = steps.findIndex((x) => !x.startsWith('intro'));
    expect(steps.slice(0, firstQuestion)).toEqual(ids.slice(0, BATCH).map((id) => `intro:${id}`));
    for (const id of ids) {
      const intro = steps.indexOf(`intro:${id}`);
      const firstAsked = steps.findIndex((x) => x.includes(`:${id}:`));
      expect(intro).toBeGreaterThanOrEqual(0);
      expect(intro).toBeLessThan(firstAsked);
    }
  });

  it('spaces the steps of one word apart', () => {
    const { steps } = play(make({ fresh: ['a', 'b', 'c', 'd'], directions: ['ko_ru'] }));
    for (const id of ['a', 'b', 'c', 'd']) {
      expect(steps.indexOf(`acquisition:${id}:ko_ru`) - steps.indexOf(`recognize:${id}:ko_ru`)).toBeGreaterThan(1);
    }
  });

  it('skips recognition when no options can be built', () => {
    const { steps } = play(make({ fresh: ['a'], directions: ['ko_ru'], hasChoice: () => false }));
    expect(steps).toEqual(['intro:a', 'acquisition:a:ko_ru']);
  });

  it('trains only the chosen direction', () => {
    const { steps, effects } = play(make({ fresh: ['a'], directions: ['ru_ko'] }));
    expect(steps).toEqual(['intro:a', 'recognize:a:ru_ko', 'acquisition:a:ru_ko']);
    expect(ofType(effects, 'introduce')[0].directions).toEqual(['ru_ko']);
  });
});

describe('mistakes during training', () => {
  it('a wrong choice repeats recognition later and lowers the first FSRS rating to Hard', () => {
    let wrongOnce = true;
    const { steps, effects } = play(make({ fresh: ['a', 'b', 'c', 'd'], directions: ['ko_ru'] }), (step) => {
      if (step === 'recognize:a:ko_ru' && wrongOnce) {
        wrongOnce = false;
        return false;
      }
      return true;
    });
    expect(steps.filter((x) => x === 'recognize:a:ko_ru')).toHaveLength(2);
    // Not asked again immediately.
    const first = steps.indexOf('recognize:a:ko_ru');
    expect(steps.indexOf('recognize:a:ko_ru', first + 1) - first).toBeGreaterThan(1);
    const grades = Object.fromEntries(ofType(effects, 'graduate').map((g) => [g.entryId, g.grade]));
    expect(grades).toEqual({ a: GRADE.hard, b: GRADE.good, c: GRADE.good, d: GRADE.good });
  });

  it('a failed recall shows the answer and sends the card back to recognition, not to the schedule', () => {
    let failed = false;
    const { steps, effects } = play(make({ fresh: ['a'], directions: ['ko_ru'] }), (step) => {
      if (step === 'acquisition:a:ko_ru' && !failed) {
        failed = true;
        return false;
      }
      return true;
    });
    expect(steps).toEqual(['intro:a', 'recognize:a:ko_ru', 'acquisition:a:ko_ru', 'recognize:a:ko_ru', 'acquisition:a:ko_ru']);
    const phases = ofType(effects, 'phase').map((p) => `${p.phase}/${p.errors}`);
    expect(phases).toEqual(['recall/0', 'recognition/1', 'recall/1']);
    expect(ofType(effects, 'graduate')).toEqual([{ type: 'graduate', entryId: 'a', direction: 'ko_ru', grade: GRADE.hard }]);
  });

  it('a failing card is parked after MAX_FAILS mistakes: no endless loop, no graduation, later direction stays closed', () => {
    const { steps, effects, session } = play(make({ fresh: ['a'] }), () => false);
    const asked = steps.filter((x) => !x.startsWith('intro'));
    expect(asked).toHaveLength(MAX_FAILS);
    expect(ofType(effects, 'graduate')).toEqual([]);
    expect(ofType(effects, 'review')).toEqual([]);
    expect(session.cards['a:ko_ru'].stage).toBe('parked');
    expect(session.cards['a:ru_ko'].stage).toBe('locked');
    expect(steps.some((x) => x.includes('ru_ko'))).toBe(false);
  });

  it('every session ends, whatever the answers', () => {
    const fresh = Array.from({ length: 10 }, (_, i) => `w${i}`);
    const reviews = Array.from({ length: 10 }, (_, i) => ({ entryId: `r${i}`, direction: (i % 2 ? 'ko_ru' : 'ru_ko') as 'ko_ru' | 'ru_ko' }));
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (const p of [0, 0.3, 0.6, 1]) {
      const { steps } = play(make({ fresh, reviews }), () => random() >= p);
      // Bound: per card at most MAX_FAILS failures, each followed by a bounded number of steps.
      expect(steps.length).toBeLessThanOrEqual(fresh.length * (1 + 2 * 2 * MAX_FAILS) + reviews.length * (1 + MAX_FAILS));
    }
  });
});

describe('scheduled reviews', () => {
  it('a right review rates Good; FSRS gets exactly one rating per card', () => {
    const { steps, effects } = play(make({ reviews: [{ entryId: 'r', direction: 'ko_ru' }] }));
    expect(steps).toEqual(['review:r:ko_ru']);
    expect(ofType(effects, 'review')).toEqual([{ type: 'review', entryId: 'r', direction: 'ko_ru', grade: GRADE.good }]);
  });

  it('a wrong review rates Again once, then relearns in the session without more FSRS ratings', () => {
    let n = 0;
    const { steps, effects } = play(make({ reviews: [{ entryId: 'r', direction: 'ru_ko' }] }), () => n++ >= 2);
    expect(steps).toEqual(['review:r:ru_ko', 'relearn:r:ru_ko', 'relearn:r:ru_ko']);
    expect(ofType(effects, 'review')).toEqual([{ type: 'review', entryId: 'r', direction: 'ru_ko', grade: GRADE.again }]);
    expect(ofType(effects, 'attempt').map((a) => `${a.mode}:${a.correct}`)).toEqual(['review:false', 'relearn:false', 'relearn:true']);
  });

  it('relearning stops after MAX_FAILS mistakes', () => {
    const { steps } = play(make({ reviews: [{ entryId: 'r', direction: 'ko_ru' }] }), () => false);
    expect(steps).toHaveLength(MAX_FAILS);
  });

  it('reviews come before training and new words; never Easy', () => {
    const { steps, effects } = play(
      make({ reviews: [{ entryId: 'r', direction: 'ko_ru' }], learning: [{ entryId: 'l', direction: 'ko_ru', phase: 'recall', errors: 0 }], fresh: ['n'], directions: ['ko_ru'] }),
    );
    expect(steps[0]).toBe('review:r:ko_ru');
    expect(steps.indexOf('acquisition:l:ko_ru')).toBeLessThan(steps.indexOf('intro:n'));
    const grades = [...ofType(effects, 'review'), ...ofType(effects, 'graduate')].map((e) => e.grade);
    expect(grades.every((g) => g === GRADE.again || g === GRADE.hard || g === GRADE.good)).toBe(true);
  });
});

describe('resuming training from an earlier session', () => {
  it('continues at the saved stage without a new intro and keeps the error count', () => {
    const { steps, effects } = play(make({ learning: [{ entryId: 'a', direction: 'ko_ru', phase: 'recall', errors: 2 }], directions: ['ko_ru'] }));
    expect(steps).toEqual(['acquisition:a:ko_ru']);
    expect(ofType(effects, 'introduce')).toEqual([]);
    expect(ofType(effects, 'graduate')[0].grade).toBe(GRADE.hard);
  });

  it('shows the word again first when training was long ago; the repeat is not saved as a new intro', () => {
    const { steps, effects } = play(make({ learning: [{ entryId: 'a', direction: 'ko_ru', phase: 'recognition', errors: 0, reintroduce: true }], directions: ['ko_ru'] }));
    expect(steps).toEqual(['intro:a*', 'recognize:a:ko_ru', 'acquisition:a:ko_ru']);
    expect(ofType(effects, 'introduce')).toEqual([]);
  });

  it('keeps the production direction closed until the meaning direction graduates', () => {
    const { steps } = play(
      make({
        learning: [
          { entryId: 'a', direction: 'ko_ru', phase: 'recall', errors: 0 },
          { entryId: 'a', direction: 'ru_ko', phase: 'recognition', errors: 0 },
        ],
      }),
    );
    expect(steps).toEqual(['acquisition:a:ko_ru', 'recognize:a:ru_ko', 'acquisition:a:ru_ko']);
  });

  it('opens the production direction at once when the meaning direction is already scheduled', () => {
    const { steps } = play(make({ learning: [{ entryId: 'a', direction: 'ru_ko', phase: 'recall', errors: 1 }] }));
    expect(steps).toEqual(['acquisition:a:ru_ko']);
  });

  it('ignores directions the learner turned off', () => {
    const s = make({ reviews: [{ entryId: 'r', direction: 'ru_ko' }], learning: [{ entryId: 'l', direction: 'ru_ko', phase: 'recall', errors: 0 }], directions: ['ko_ru'] });
    expect(s.queue).toEqual([]);
  });
});

describe('session summary', () => {
  it('counts learned words once, even when both directions finish', () => {
    const { session } = play(make({ fresh: ['a', 'b'] }));
    expect(session.stats).toMatchObject({ introduced: 2, graduated: 4, learnedWords: ['a', 'b'], answers: 8, correct: 8 });
  });
});

describe('free practice sessions', () => {
  const seed = (entryId: string, direction: 'ko_ru' | 'ru_ko', status: 'new' | 'training' | 'scheduled' = 'scheduled', due = false, introduced = true) => ({ entryId, direction, status, due, introduced });

  it('trains any direction at once, without unlocking, and changes nothing but statistics', () => {
    const s = createFreeSession({ cards: [seed('a', 'ru_ko', 'new', false, false), seed('b', 'ru_ko', 'training')], method: 'keyboard' });
    const { steps, effects } = play(s);
    expect(steps).toEqual(['intro:a*', 'practice:a:ru_ko', 'practice:b:ru_ko']);
    expect(effects.map((e) => e.type)).toEqual(['attempt', 'attempt']);
    expect(ofType(effects, 'attempt').every((a) => a.mode === 'practice' && a.result?.sessionKind === 'free')).toBe(true);
  });

  it('asks a wrong card again later, up to the attempt limit', () => {
    const cards = ['a', 'b', 'c', 'd'].map((id) => seed(id, 'ko_ru'));
    const { steps } = play(createFreeSession({ cards, method: 'keyboard', maxFails: 5 }), (step) => !step.includes(':a:'));
    expect(steps.filter((x) => x === 'practice:a:ko_ru')).toHaveLength(5);
    const first = steps.indexOf('practice:a:ko_ru');
    expect(steps[first + 1]).not.toBe('practice:a:ko_ru');
  });

  it('uses multiple choice when options exist and falls back to typing when they do not', () => {
    const s = createFreeSession({ cards: [seed('a', 'ko_ru'), seed('b', 'ko_ru')], method: 'choice', hasChoice: (id) => id === 'a' });
    expect(s.queue.map((t) => t.kind)).toEqual(['recognize', 'recall']);
    const r = answer(s, true);
    expect(r.result).toMatchObject({ method: 'choice', skill: 'recognition', sessionKind: 'free' });
  });

  it('counts a due review only when asked, only once, and never for recognition', () => {
    const cards = [seed('due', 'ko_ru', 'scheduled', true), seed('later', 'ko_ru', 'scheduled', false), seed('t', 'ko_ru', 'training')];
    const off = play(createFreeSession({ cards, method: 'keyboard' }));
    expect(ofType(off.effects, 'review')).toEqual([]);
    let n = 0;
    const on = play(createFreeSession({ cards, method: 'keyboard', countAsReview: true }), () => n++ !== 0);
    expect(ofType(on.effects, 'review')).toEqual([{ type: 'review', entryId: 'due', direction: 'ko_ru', grade: GRADE.again }]);
    const choice = play(createFreeSession({ cards, method: 'choice', countAsReview: true, hasChoice: () => true }));
    expect(ofType(choice.effects, 'review')).toEqual([]);
  });

  it('never produces training-stage or graduation effects', () => {
    const cards = [seed('n', 'ko_ru', 'new', false, false), seed('t', 'ru_ko', 'training'), seed('s', 'ko_ru', 'scheduled', true)];
    for (const method of ['keyboard', 'self_grade', 'choice'] as const) {
      const { effects } = play(createFreeSession({ cards, method, hasChoice: () => true, countAsReview: false }), () => false);
      expect(effects.every((e) => e.type === 'attempt')).toBe(true);
    }
  });
});
