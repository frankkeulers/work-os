import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { SourceId } from '@work-os/shared';
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
  navCollapsedWide: boolean; // the same on the three-zone cockpit, where the rail is the default (CK-3.1)
  inboxSort: InboxSort;
  groupByChannel: boolean; // the Inbox lists Slack items under their channel
  avatar?: string; // the profile picture, a small square data: URL (lib/avatar.ts); initials or a person icon until set
  /** Meetings dismissed from the sidebar (R2.8), by meetingKey, each kept until its meeting ends. */
  dismissedMeetings: Record<string, string>;
  /** Items that entered Needs you or To file since Frank last looked (cockpit CK-1.3): id → when. */
  newItems: Record<string, string>;
  /** The panel's Triage details row is open (CK-1.6). */
  triageDetailsOpen: boolean;
  /** States hidden on each source's history (cockpit CK-5.8); unset, the default (Done hidden on the lists). */
  sourceHidden: Partial<Record<SourceId, string[]>>;
  /** The cockpit's time column is folded to a rail. */
  timeCollapsed: boolean;
  /** The cockpit's time column width in px, dragged at its right edge (TIME_WIDTH bounds it). */
  timeWidth: number;
  /** The cockpit's Later column width in px, dragged at its left edge (LATER_WIDTH bounds it). */
  laterWidth: number;
  /** When Frank last opened the bell (FR-11.5): entries since then count as new. Server time. */
  bellSeenAt?: string;
  setTheme: (t: Theme) => void;
  setPanelOpen: (open: boolean) => void;
  setScope: (s: Scope) => void;
  setNavCollapsed: (collapsed: boolean) => void;
  setNavCollapsedWide: (collapsed: boolean) => void;
  setInboxSort: (s: InboxSort) => void;
  setGroupByChannel: (on: boolean) => void;
  setAvatar: (dataUrl: string | undefined) => void;
  setProfile: (patch: Profile) => void;
  /** Hides a meeting from the sidebar until it ends; dismissals of meetings that have ended are dropped. */
  dismissMeeting: (m: { id: string; start: string; end: string }, now: Date) => void;
  undismissMeeting: (m: { id: string; start: string }) => void;
  markNew: (ids: string[], at: Date) => void;
  clearNew: (id: string) => void;
  setTriageDetailsOpen: (open: boolean) => void;
  setSourceHidden: (source: SourceId, hidden: string[]) => void;
  setTimeCollapsed: (collapsed: boolean) => void;
  setTimeWidth: (px: number) => void;
  setLaterWidth: (px: number) => void;
  setBellSeenAt: (at: string) => void;
}

/** The cockpit's resizable columns: their width to begin with, and how far they drag. */
export const TIME_WIDTH = { default: 400, min: 360, max: 600 } as const;
export const LATER_WIDTH = { default: 440, min: 360, max: 600 } as const;

/** How long the New dot lasts without being looked at (CK-1.3). */
export const NEW_FOR_MS = 30 * 60_000;

/** One occurrence of a meeting: moved to another time, it is a new one and shows again. */
export const meetingKey = (m: { id: string; start: string }) => `${m.id}@${m.start}`;

export const usePrefs = create<Prefs>()(
  persist(
    (set) => ({
      theme: 'light',
      panelOpen: true,
      scope: 'mvp',
      navCollapsed: false,
      navCollapsedWide: true,
      // Cockpit CK-1.1: Priority order and no channel groups by default. A choice already saved in
      // this browser is kept (persist merges it over these).
      inboxSort: 'priority',
      groupByChannel: false,
      dismissedMeetings: {},
      newItems: {},
      triageDetailsOpen: false,
      sourceHidden: {},
      timeCollapsed: false,
      timeWidth: TIME_WIDTH.default,
      laterWidth: LATER_WIDTH.default,
      setTheme: (theme) => set({ theme }),
      setPanelOpen: (panelOpen) => set({ panelOpen }),
      setScope: (scope) => set({ scope }),
      setNavCollapsed: (navCollapsed) => set({ navCollapsed }),
      setNavCollapsedWide: (navCollapsedWide) => set({ navCollapsedWide }),
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
      markNew: (ids, at) =>
        set((s) => ({
          newItems: {
            ...Object.fromEntries(Object.entries(s.newItems).filter(([, when]) => at.getTime() - Date.parse(when) < NEW_FOR_MS)),
            ...Object.fromEntries(ids.map((id) => [id, at.toISOString()])),
          },
        })),
      clearNew: (id) =>
        set((s) => {
          if (!(id in s.newItems)) return s;
          const { [id]: _seen, ...rest } = s.newItems;
          return { newItems: rest };
        }),
      setTriageDetailsOpen: (triageDetailsOpen) => set({ triageDetailsOpen }),
      setSourceHidden: (source, hidden) => set((s) => ({ sourceHidden: { ...s.sourceHidden, [source]: hidden } })),
      setTimeCollapsed: (timeCollapsed) => set({ timeCollapsed }),
      setTimeWidth: (timeWidth) => set({ timeWidth }),
      setLaterWidth: (laterWidth) => set({ laterWidth }),
      setBellSeenAt: (bellSeenAt) => set({ bellSeenAt }),
    }),
    { name: 'workos.prefs' },
  ),
);
