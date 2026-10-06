import { create } from 'zustand';
import { persist } from 'zustand/middleware';

// Client preferences: not part of settings.json, never emit settings.changed.
export type Theme = 'system' | 'light' | 'dark';
export type Scope = 'mvp' | 'full';

interface Prefs {
  theme: Theme;
  panelOpen: boolean; // the Inbox item panel opens on the first item until it's closed
  scope: Scope;
  navCollapsed: boolean; // the sidebar shows icons only
  setTheme: (t: Theme) => void;
  setPanelOpen: (open: boolean) => void;
  setScope: (s: Scope) => void;
  setNavCollapsed: (collapsed: boolean) => void;
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      theme: 'light',
      panelOpen: true,
      scope: 'mvp',
      navCollapsed: false,
      setTheme: (theme) => set({ theme }),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setScope: (scope) => set({ scope }),
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
    }),
    { name: 'workos.prefs' },
  ),
);
