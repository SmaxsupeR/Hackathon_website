// The one place where the FSRS scheduler is configured.
//
// The weights are copied here instead of taken from the library's defaults, so that
// updating ts-fsrs cannot silently move every learner's schedule. Changing anything in
// this object means a new `id`, and stored cards were scheduled with the id recorded in
// the database (user_preferences key `fsrsConfigId`).

export const FSRS_CONFIG = Object.freeze({
  id: 'namu-fsrs-1',
  algorithm: 'FSRS-6',
  /** Library the weights were taken from. package.json pins this exact version. */
  library: 'ts-fsrs 5.4.2',
  /** FSRS-6 default weights of ts-fsrs 5.4.2. */
  w: Object.freeze([0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542]),
  /**
   * No minute-level steps: the app trains new and forgotten words inside a session, so
   * every FSRS rating moves a card by days and all intervals come from the algorithm.
   */
  learningSteps: Object.freeze([] as string[]),
  relearningSteps: Object.freeze([] as string[]),
  enableShortTerm: true,
  enableFuzz: true,
  maximumInterval: 36500,
  retention: Object.freeze({ min: 0.7, max: 0.97, default: 0.9 }),
});

export const FSRS_CONFIG_PREF_KEY = 'fsrsConfigId';

export function clampRetention(r: number): number {
  const { min, max, default: d } = FSRS_CONFIG.retention;
  if (!Number.isFinite(r)) return d;
  return Math.min(max, Math.max(min, r));
}
