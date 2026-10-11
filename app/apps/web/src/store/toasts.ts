import { create } from 'zustand';

export interface Toast {
  id: number;
  message: string;
  /** One line of detail under the message. */
  description?: string;
  tone?: 'default' | 'success' | 'error';
  action?: { label: string; run: () => void };
  ttl?: number;
  /** A toast with the same key replaces the visible one instead of stacking. */
  key?: string;
}

/** An Undo a toast offered, kept after the toast goes so `z` can still run it (UX-1). */
export interface UndoEntry {
  id: number;
  message: string;
  run: () => void;
}

/** How many Undos `z` can walk back through. */
const UNDO_MAX = 20;

export interface OsNotification {
  id: number;
  itemId: string;
  title: string;
  summary: string;
}

interface ToastStore {
  toasts: Toast[];
  notifications: OsNotification[];
  /** Newest last. */
  undos: UndoEntry[];
  push: (t: Omit<Toast, 'id'>) => number;
  /** Runs the newest Undo still open, and closes its toast. */
  undo: () => UndoEntry | undefined;
  dismiss: (id: number) => void;
  notify: (n: Omit<OsNotification, 'id'>) => void;
  dismissNotification: (id: number) => void;
}

let next = 1;

export const useToasts = create<ToastStore>()((set, get) => ({
  toasts: [],
  notifications: [],
  undos: [],
  push: (t) => {
    const id = next++;
    const undo = t.action?.label === 'Undo' ? t.action.run : undefined;
    // Undone from the toast: it leaves the stack too, so `z` doesn't run it twice.
    const action = undo ? { label: 'Undo', run: () => (set((s) => ({ undos: s.undos.filter((u) => u.id !== id) })), undo()) } : t.action;
    set((s) => {
      const undos = undo ? [...s.undos.slice(-(UNDO_MAX - 1)), { id, message: t.message, run: undo }] : s.undos;
      const i = t.key ? s.toasts.findIndex((x) => x.key === t.key) : -1;
      if (i >= 0) return { undos, toasts: s.toasts.map((x, j) => (j === i ? { ...t, action, id } : x)) };
      return { undos, toasts: [...s.toasts.slice(-3), { ...t, action, id }] };
    });
    return id;
  },
  undo: () => {
    const u = get().undos.at(-1);
    if (!u) return undefined;
    set((s) => ({ undos: s.undos.slice(0, -1), toasts: s.toasts.filter((t) => t.id !== u.id) }));
    u.run();
    return u;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  notify: (n) => set((s) => ({ notifications: [...s.notifications.slice(-2), { ...n, id: next++ }] })),
  dismissNotification: (id) => set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
}));

export const toast = (message: string, extra: Omit<Toast, 'id' | 'message'> = {}) => useToasts.getState().push({ message, ...extra });

export const errorToast = (e: unknown) => toast(e instanceof Error ? e.message : 'Something went wrong.', { tone: 'error', ttl: 7000 });
