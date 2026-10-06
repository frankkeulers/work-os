import { describe, expect, it } from 'vitest';
import { EventPayloads, EventType, WorkEvent, toLoggedDecision } from './events';
import type { TriageDecision } from './schemas';

const at = '2026-10-06T09:00:00.000Z';
const base = { seq: 1, id: 'ev-1', at, schemaVersion: 1 as const };

const decision: TriageDecision = {
  itemId: 'slack:C1:1',
  itemRevision: 2,
  attention: 'today',
  confluence: { suggested: false },
  vault: { suggested: true },
  containsPeopleObservations: false,
  summary: 'Pricing question for the renewal',
  reason: 'Asks Frank directly',
  decidedBy: 'model',
  next: { need: 'reply', step: 'Confirm the renewal price', why: 'Dana is waiting', dueAt: at },
  decidedAt: at,
};

describe('WorkEvent', () => {
  it('parses each kind of payload', () => {
    const events = [
      {
        ...base,
        type: 'item.upserted',
        itemId: 'slack:C1:1',
        data: {
          source: 'slack',
          kind: 'thread',
          title: '#product',
          permalink: 'https://example.slack.com/archives/C1/p1',
          participants: [{ id: 'U1', name: 'Dana Lee' }],
          lastActivityAt: at,
          revision: 2,
          messageCount: 4,
          fromMeOnly: false,
        },
      },
      { ...base, type: 'triage.decided', itemId: 'slack:C1:1', data: { decision: toLoggedDecision(decision) } },
      { ...base, type: 'item.done', itemId: 'slack:C1:1' },
      { ...base, type: 'action.executing', actionId: 'a1', data: { attempt: 1, expectedHash: 'sha256:abc' } },
      { ...base, type: 'source.polled', data: { source: 'slack', reason: 'wake', fetched: 12, cursor: '1791288110.000100' } },
      { ...base, type: 'health.changed', data: { dep: 'network', state: 'offline', reason: 'captive_portal' } },
    ];
    for (const e of events) expect(WorkEvent.safeParse(e).success, e.type).toBe(true);
  });

  it('needs a positive seq so the log can be checked for gaps', () => {
    expect(WorkEvent.safeParse({ ...base, seq: undefined, type: 'item.done' }).success).toBe(false);
    expect(WorkEvent.safeParse({ ...base, seq: 0, type: 'item.done' }).success).toBe(false);
  });

  it('checks the payload against the event type', () => {
    expect(WorkEvent.safeParse({ ...base, type: 'item.snoozed', data: { until: 'tomorrow' } }).success).toBe(false);
    expect(WorkEvent.safeParse({ ...base, type: 'triage.decided', data: { attention: 'now' } }).success).toBe(false);
    expect(WorkEvent.safeParse({ ...base, type: 'item.done', data: { extra: true } }).success).toBe(false);
  });

  it('keeps decision text out of the log, since it paraphrases the messages', () => {
    const logged = toLoggedDecision(decision);
    expect(JSON.stringify(logged)).not.toMatch(/renewal|Dana/);
    expect(logged).toMatchObject({ attention: 'today', vault: { suggested: true }, next: { need: 'reply', dueAt: at } });
    expect(WorkEvent.safeParse({ ...base, type: 'triage.decided', data: { decision } }).success).toBe(false);
  });

  it('rejects unknown event types', () => {
    expect(WorkEvent.safeParse({ ...base, type: 'item.deleted' }).success).toBe(false);
  });

  it('has a payload schema for every event type', () => {
    expect(EventType.options.sort()).toEqual(Object.keys(EventPayloads).sort());
  });
});
