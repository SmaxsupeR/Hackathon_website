// Order of steps inside one study session. Pure logic, no UI.
//
// A word the learner has never seen is taught before it is tested:
//   intro (word and translation shown together) → choice (pick the translation) → test (recall).
// New words go in small batches so the intro is still fresh when the questions come.

export type StepKind = 'intro' | 'choice' | 'test';

export interface Step<T> {
  kind: StepKind;
  item: T;
}

export interface BuildOptions<T> {
  batchSize: number;
  /** Whether a multiple-choice question can be made for this item. */
  hasChoice: (item: T) => boolean;
}

export function buildSteps<T extends { isNew: boolean }>(items: T[], opts: BuildOptions<T>): Step<T>[] {
  const steps: Step<T>[] = items.filter((i) => !i.isNew).map((item) => ({ kind: 'test', item }));
  const fresh = items.filter((i) => i.isNew);
  for (let i = 0; i < fresh.length; i += opts.batchSize) {
    const batch = fresh.slice(i, i + opts.batchSize);
    for (const item of batch) steps.push({ kind: 'intro', item });
    for (const item of batch) if (opts.hasChoice(item)) steps.push({ kind: 'choice', item });
    for (const item of batch) steps.push({ kind: 'test', item });
  }
  return steps;
}

/** Puts a step back into the queue so it comes up again after `gap` other steps. */
export function insertAfter<T>(queue: Step<T>[], step: Step<T>, gap: number): Step<T>[] {
  const at = Math.min(gap, queue.length);
  return [...queue.slice(0, at), step, ...queue.slice(at)];
}

/**
 * Answer options for a multiple-choice question: the correct answer plus
 * `count - 1` different wrong ones, shuffled. Returns null if the pool is too small.
 */
export function pickOptions(correct: string, own: string[], pool: string[], count: number, random: () => number = Math.random): string[] | null {
  const norm = (s: string) => s.trim().toLowerCase();
  const taken = new Set([norm(correct), ...own.map(norm)]);
  const wrong: string[] = [];
  for (const candidate of shuffle(pool, random)) {
    const key = norm(candidate);
    if (key === '' || taken.has(key)) continue;
    taken.add(key);
    wrong.push(candidate.trim());
    if (wrong.length === count - 1) break;
  }
  if (wrong.length < count - 1) return null;
  return shuffle([correct, ...wrong], random);
}

export function shuffle<T>(list: T[], random: () => number = Math.random): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
