// App settings, kept in memory and saved to the user_preferences table.
import { create } from 'zustand';
import type { Direction } from '../core/learning';

export type Language = 'ru' | 'en';
/** Which directions are practised: both, or only one of them. */
export type DirectionSetting = 'both' | Direction;

export function directionList(setting: DirectionSetting): Direction[] {
  return setting === 'both' ? ['ko_ru', 'ru_ko'] : [setting];
}

export interface Settings {
  language: Language;
  newPerDay: number;
  maxReviews: number;
  retention: number;
  showRomanization: boolean;
  directions: DirectionSetting;
  strictSpacing: boolean;
  autoSpeak: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  language: 'ru',
  newPerDay: 10,
  maxReviews: 100,
  retention: 0.9,
  showRomanization: true,
  directions: 'both',
  strictSpacing: false,
  autoSpeak: true,
};

export function settingsFromPrefs(prefs: Record<string, string>): Settings {
  const out: Settings = { ...DEFAULT_SETTINGS };
  for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[]) {
    if (!(key in prefs)) continue;
    try {
      const value = JSON.parse(prefs[key]);
      if (typeof value !== typeof DEFAULT_SETTINGS[key]) continue;
      if (key === 'directions' && !['both', 'ko_ru', 'ru_ko'].includes(value)) continue;
      (out as unknown as Record<string, unknown>)[key] = value;
    } catch {
      // A damaged value falls back to the default.
    }
  }
  return out;
}

interface AppState {
  settings: Settings;
  /** Bumped after every write so open screens reload their data. */
  dataVersion: number;
  setSettings: (s: Settings) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  touch: () => void;
}

export const useApp = create<AppState>((set) => ({
  settings: DEFAULT_SETTINGS,
  dataVersion: 0,
  setSettings: (settings) => set({ settings }),
  patchSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),
  touch: () => set((s) => ({ dataVersion: s.dataVersion + 1 })),
}));
