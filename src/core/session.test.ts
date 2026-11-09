import { describe, expect, it } from 'vitest';
import { buildSteps, insertAfter, pickOptions } from './session';

const item = (id: string, isNew: boolean) => ({ id, isNew });
const show = (steps: { kind: string; item: { id: string } }[]) => steps.map((s) => `${s.kind}:${s.item.id}`);

describe('session steps', () => {
  it('teaches new words before testing them, in batches, after the reviews', () => {
    const items = [item('n1', true), item('r1', false), item('n2', true), item('n3', true)];
    const steps = buildSteps(items, { batchSize: 2, hasChoice: () => true });
    expect(show(steps)).toEqual([
      'test:r1',
      'intro:n1', 'intro:n2', 'choice:n1', 'choice:n2', 'test:n1', 'test:n2',
      'intro:n3', 'choice:n3', 'test:n3',
    ]);
  });
  it('never tests a new word before its intro, and reviews get no intro', () => {
    const items = [item('a', true), item('b', false), item('c', true), item('d', true), item('e', true), item('f', true)];
    const steps = buildSteps(items, { batchSize: 4, hasChoice: (i) => i.id !== 'c' });
    for (const it of items) {
      const kinds = steps.filter((s) => s.item.id === it.id).map((s) => s.kind);
      if (!it.isNew) expect(kinds).toEqual(['test']);
      else expect(kinds).toEqual(it.id === 'c' ? ['intro', 'test'] : ['intro', 'choice', 'test']);
    }
  });
  it('requeues a step after a gap or at the end', () => {
    const q = buildSteps([item('a', false), item('b', false), item('c', false)], { batchSize: 4, hasChoice: () => false });
    const again = { kind: 'test' as const, item: item('x', false) };
    expect(show(insertAfter(q, again, 2))).toEqual(['test:a', 'test:b', 'test:x', 'test:c']);
    expect(show(insertAfter(q, again, 10))).toEqual(['test:a', 'test:b', 'test:c', 'test:x']);
    expect(show(insertAfter([], again, 3))).toEqual(['test:x']);
  });
});

describe('answer options', () => {
  it('returns the correct answer with distinct wrong ones', () => {
    const opts = pickOptions('дерево; tree', ['дерево', 'tree'], ['вода', 'Дерево', 'tree', 'школа', 'вода ', 'дом', ''], 4) as string[];
    expect(opts).toHaveLength(4);
    expect(opts).toContain('дерево; tree');
    expect([...opts].sort()).toEqual(['вода', 'дерево; tree', 'дом', 'школа'].sort());
  });
  it('returns null when there are not enough wrong answers', () => {
    expect(pickOptions('дерево', ['дерево'], ['вода', 'дерево', 'вода'], 4)).toBeNull();
  });
});
