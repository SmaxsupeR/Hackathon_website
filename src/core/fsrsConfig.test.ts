import { default_w, generatorParameters } from 'ts-fsrs';
import { describe, expect, it } from 'vitest';
import { clampRetention, FSRS_CONFIG } from './fsrsConfig';
import { GRADE } from './model';
import { newCard, reviewCard, schedulerParams } from './scheduler';

const T = new Date(2026, 0, 1, 12).getTime();
const DAY = 86400000;

describe('FSRS configuration', () => {
  it('is built only from the frozen config, not from library defaults', () => {
    const p = schedulerParams(0.9);
    expect(p.w).toEqual([...FSRS_CONFIG.w]);
    expect(p.learning_steps).toEqual([]);
    expect(p.relearning_steps).toEqual([]);
    expect(p.enable_fuzz).toBe(FSRS_CONFIG.enableFuzz);
    expect(p.maximum_interval).toBe(FSRS_CONFIG.maximumInterval);
    expect(Object.isFrozen(FSRS_CONFIG) && Object.isFrozen(FSRS_CONFIG.w)).toBe(true);
  });

  it('still matches the pinned library version (if this fails after an upgrade, keep the frozen weights and review)', () => {
    expect([...default_w]).toEqual([...FSRS_CONFIG.w]);
  });

  it('a different weight vector would give different intervals, so freezing them matters', () => {
    const changed = generatorParameters({ ...schedulerParams(0.9), w: FSRS_CONFIG.w.map((x, i) => (i === 2 ? x * 3 : x)) });
    expect(changed.w[2]).not.toBe(FSRS_CONFIG.w[2]);
  });

  it('clamps retention to the configured range', () => {
    expect(clampRetention(0.5)).toBe(0.7);
    expect(clampRetention(0.99)).toBe(0.97);
    expect(clampRetention(Number.NaN)).toBe(0.9);
  });

  it('intervals come from the algorithm: ordered by rating, at least a day, longer with lower retention', () => {
    const due = (g: 1 | 2 | 3 | 4, r = 0.9) => reviewCard(newCard(T), g, T, r).card.due - T;
    expect(due(GRADE.again)).toBeGreaterThanOrEqual(DAY - 1);
    expect(due(GRADE.again)).toBeLessThanOrEqual(due(GRADE.hard));
    expect(due(GRADE.hard)).toBeLessThan(due(GRADE.good));
    expect(due(GRADE.good)).toBeLessThan(due(GRADE.easy));
    const c = reviewCard(newCard(T), GRADE.easy, T, 0.9).card;
    const strict = reviewCard(c, GRADE.good, c.due, 0.95).card.scheduled_days;
    const relaxed = reviewCard(c, GRADE.good, c.due, 0.8).card.scheduled_days;
    expect(strict).toBeLessThan(relaxed);
  });
});
