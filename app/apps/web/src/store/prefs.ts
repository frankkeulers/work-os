import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Client preferences: not part of settings.json, never emit settings.changed.
export type Theme = 'system' | 'light' | 'dark';
export type View = 'board' | 'list';
export type Scope = 'mvp' | 'full';

interface Prefs {
  theme: Theme;
  view: View;
  scope: Scope;
  setTheme: (t: Theme) => void;
  setView: (v: View) => void;
  setScope: (s: Scope) => void;
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      theme: 'light',
      view: 'board',
      scope: 'mvp',
      setTheme: (theme) => set({ theme }),
      setView: (view) => set({ view }),
      setScope: (scope) => set({ scope }),
    }),
    { name: 'workos.prefs' },
  ),
);
