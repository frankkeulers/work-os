import { useSyncExternalStore } from 'react';

// The cockpit's layout (CK-3.1): three zones from 1600 px wide; below that, the Inbox as it was,
// with the agenda strip and This week in the footer, so nothing is lost on a smaller window.

export const WIDE_MIN_PX = 1600;

const query = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(`(min-width: ${WIDE_MIN_PX}px)`) : undefined;

const subscribe = (onChange: () => void) => {
  query?.addEventListener('change', onChange);
  return () => query?.removeEventListener('change', onChange);
};

/** Whether the window is wide enough for the three-zone cockpit. */
export function useWideLayout(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => !!query?.matches,
    () => false,
  );
}
