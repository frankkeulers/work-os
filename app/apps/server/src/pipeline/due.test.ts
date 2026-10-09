import { describe, expect, it, vi } from 'vitest';
import { newDayWatcher } from './due';

describe('newDayWatcher (cockpit CK-3.10)', () => {
  it('fires once when the London date changes, not on the first tick', () => {
    const onNewDay = vi.fn();
    const tick = newDayWatcher(onNewDay);
    tick(new Date('2026-10-08T22:58:00Z')); // Thu 23:58 London
    tick(new Date('2026-10-08T22:59:30Z'));
    expect(onNewDay).not.toHaveBeenCalled();
    tick(new Date('2026-10-08T23:00:05Z')); // Fri 00:00 London (BST), though still Thursday in UTC
    expect(onNewDay).toHaveBeenCalledTimes(1);
    tick(new Date('2026-10-08T23:01:00Z'));
    expect(onNewDay).toHaveBeenCalledTimes(1);
  });

  it('fires after a sleep across midnight', () => {
    const onNewDay = vi.fn();
    const tick = newDayWatcher(onNewDay);
    tick(new Date('2026-10-08T17:00:00Z'));
    tick(new Date('2026-10-09T07:00:00Z'));
    expect(onNewDay).toHaveBeenCalledTimes(1);
  });
});
