import { Settings as SettingsSchema, type SourceId } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import type { SourceAdapter } from '../sources/types';
import { Scheduler } from './scheduler';

// "Poll now" walks the sources one at a time; the sidebar shows which is polling and which wait (FR-2.6).

const source = (id: SourceId): SourceAdapter => ({ id, deps: [], needsNetwork: false, fetchSince: async () => ({ items: [], nextCursor: '' }), probe: async () => 'ok' });

describe('Scheduler', () => {
  it('says which source is polling and which are queued, and tells each change', async () => {
    const sources = [source('slack'), source('outlook'), source('wispr')];
    const seen: { polling?: SourceId; queued: SourceId[] }[] = [];
    let release!: () => void;
    const s: Scheduler = new Scheduler({
      clock: { now: () => new Date('2026-10-06T08:00:00Z'), mono: () => 0 },
      sources: () => sources,
      settings: () => SettingsSchema.parse({}),
      lastPollAt: () => undefined,
      canPoll: (src) => src.id !== 'outlook', // e.g. its breaker is open
      poll: (src) => (src.id === 'slack' ? new Promise<void>((r) => (release = r)) : Promise.resolve()),
      onChange: () => seen.push({ polling: s.current?.id, queued: s.queued() }),
    });

    s.request('manual');
    expect(s.current?.id).toBe('slack');
    expect(s.queued()).toEqual(['outlook', 'wispr']);

    release();
    await s.idle();
    expect(s.current).toBeUndefined();
    expect(s.queued()).toEqual([]);
    // Outlook is skipped, not polled; the last change leaves nothing polling.
    expect(seen.filter((c) => c.polling).map((c) => c.polling)).toEqual(['slack', 'wispr']);
    expect(seen.at(-1)).toEqual({ polling: undefined, queued: [] });
  });
});
