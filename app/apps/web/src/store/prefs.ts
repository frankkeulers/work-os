import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { InboxSort } from '../lib/next';
import type { Profile } from '../lib/profile';

// Client preferences: not part of settings.json, never emit settings.changed.
export type Theme = 'system' | 'light' | 'dark';
export type Scope = 'mvp' | 'full';

interface Prefs extends Profile {
  theme: Theme;
  panelOpen: boolean; // the Inbox item panel opens on the first item until it's closed
  scope: Scope;
  navCollapsed: boolean; // the sidebar shows icons only
  inboxSort: InboxSort;
  groupByChannel: boolean; // the Inbox lists Slack items under their channel
  avatar?: string; // the profile picture, a small square data: URL (lib/avatar.ts); initials or a person icon until set
  setTheme: (t: Theme) => void;
  setPanelOpen: (open: boolean) => void;
  setScope: (s: Scope) => void;
  setNavCollapsed: (collapsed: boolean) => void;
  setInboxSort: (s: InboxSort) => void;
  setGroupByChannel: (on: boolean) => void;
  setAvatar: (dataUrl: string | undefined) => void;
  setProfile: (patch: Profile) => void;
}

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      theme: 'light',
      panelOpen: true,
      scope: 'mvp',
      navCollapsed: false,
      inboxSort: 'newest',
      groupByChannel: true,
      setTheme: (theme) => set({ theme }),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setScope: (scope) => set({ scope }),
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      setInboxSort: (inboxSort) => set({ inboxSort }),
      setGroupByChannel: (groupByChannel) => set({ groupByChannel }),
      setAvatar: (avatar) => set({ avatar }),
      setProfile: (patch) => set(patch),
    }),
    { name: 'workos.prefs' },
  ),
);
