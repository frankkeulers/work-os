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
  /** Meetings dismissed from the sidebar (R2.8), by meetingKey, each kept until its meeting ends. */
  dismissedMeetings: Record<string, string>;
  setTheme: (t: Theme) => void;
  setPanelOpen: (open: boolean) => void;
  setScope: (s: Scope) => void;
  setNavCollapsed: (collapsed: boolean) => void;
  setInboxSort: (s: InboxSort) => void;
  setGroupByChannel: (on: boolean) => void;
  setAvatar: (dataUrl: string | undefined) => void;
  setProfile: (patch: Profile) => void;
  /** Hides a meeting from the sidebar until it ends; dismissals of meetings that have ended are dropped. */
  dismissMeeting: (m: { id: string; start: string; end: string }, now: Date) => void;
  undismissMeeting: (m: { id: string; start: string }) => void;
}

/** One occurrence of a meeting: moved to another time, it is a new one and shows again. */
export const meetingKey = (m: { id: string; start: string }) => `${m.id}@${m.start}`;

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      theme: 'light',
      panelOpen: true,
      scope: 'mvp',
      navCollapsed: false,
      inboxSort: 'newest',
      groupByChannel: true,
      dismissedMeetings: {},
      setTheme: (theme) => set({ theme }),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setScope: (scope) => set({ scope }),
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      setInboxSort: (inboxSort) => set({ inboxSort }),
      setGroupByChannel: (groupByChannel) => set({ groupByChannel }),
      setAvatar: (avatar) => set({ avatar }),
      setProfile: (patch) => set(patch),
      dismissMeeting: (m, now) =>
        set((s) => ({
          dismissedMeetings: { ...Object.fromEntries(Object.entries(s.dismissedMeetings).filter(([, end]) => Date.parse(end) > now.getTime())), [meetingKey(m)]: m.end },
        })),
      undismissMeeting: (m) =>
        set((s) => {
          const { [meetingKey(m)]: _gone, ...rest } = s.dismissedMeetings;
          return { dismissedMeetings: rest };
        }),
    }),
    { name: 'workos.prefs' },
  ),
);
