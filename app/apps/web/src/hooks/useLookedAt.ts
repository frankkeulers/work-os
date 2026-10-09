import { useEffect, type RefObject } from 'react';
import { usePrefs } from '../store/prefs';

// The New dot clears once Frank has looked (cockpit CK-1.3): the row was in view for 2 s while the
// window had focus. Opening the item clears it too (the Inbox does that), and it lapses after 30 min.

export const LOOK_MS = 2_000;

/** Watches the rows of `ids` inside `root` and clears each one's New dot once it has been looked at. */
export function useLookedAt(root: RefObject<HTMLElement | null>, ids: readonly string[]) {
  const clearNew = usePrefs((s) => s.clearNew);
  const key = ids.join('\n');
  useEffect(() => {
    const el = root.current;
    if (!el || !key || typeof IntersectionObserver === 'undefined') return;
    const timers = new Map<Element, ReturnType<typeof setTimeout>>();
    const inView = new Set<Element>();
    const focused = () => document.hasFocus() && document.visibilityState === 'visible';
    const start = (t: Element) => {
      if (timers.has(t) || !focused()) return;
      timers.set(
        t,
        setTimeout(() => {
          timers.delete(t);
          if (inView.has(t) && focused()) clearNew((t as HTMLElement).dataset.row!);
        }, LOOK_MS),
      );
    };
    const stop = (t: Element) => {
      clearTimeout(timers.get(t));
      timers.delete(t);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            inView.add(e.target);
            start(e.target);
          } else {
            inView.delete(e.target);
            stop(e.target);
          }
        }
      },
      { root: el, threshold: 0.6 },
    );
    for (const id of key.split('\n')) {
      const row = el.querySelector(`[data-row="${CSS.escape(id)}"]`);
      if (row) io.observe(row);
    }
    const onFocus = () => inView.forEach(start);
    const onBlur = () => [...timers.keys()].forEach(stop);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      io.disconnect();
      timers.forEach(clearTimeout);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [root, key, clearNew]);
}
