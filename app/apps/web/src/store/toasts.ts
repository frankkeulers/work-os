import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  tone?: 'default' | 'success' | 'error';
  action?: { label: string; run: () => void };
  ttl?: number;
  /** A toast with the same key replaces the visible one instead of stacking. */
  key?: string;
}

export interface OsNotification {
  id: number;
  itemId: string;
  title: string;
  summary: string;
}

interface ToastStore {
  toasts: Toast[];
  notifications: OsNotification[];
  push: (t: Omit<Toast, 'id'>) => number;
  dismiss: (id: number) => void;
  notify: (n: Omit<OsNotification, 'id'>) => void;
  dismissNotification: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastStore>()((set) => ({
  toasts: [],
  notifications: [],
  push: (t) => {
    const id = next++;
    set((s) => {
      const i = t.key ? s.toasts.findIndex((x) => x.key === t.key) : -1;
      if (i >= 0) return { toasts: s.toasts.map((x, j) => (j === i ? { ...t, id } : x)) };
      return { toasts: [...s.toasts.slice(-3), { ...t, id }] };
    });
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  notify: (n) => set((s) => ({ notifications: [...s.notifications.slice(-2), { ...n, id: next++ }] })),
  dismissNotification: (id) => set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
}));

export const toast = (message: string, extra: Omit<Toast, 'id' | 'message'> = {}) => useToasts.getState().push({ message, ...extra });

export const errorToast = (e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong.', { tone: 'error', ttl: 7000 });
