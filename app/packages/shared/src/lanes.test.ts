import { describe, expect, it } from 'vitest';
import { effectiveTriage, laneFor } from './lanes';
import type { TriageCorrection, TriageDecision } from './schemas';

const decision = (over: Partial<TriageDecision> = {}): TriageDecision => ({
  itemId: 'slack:C1:1',
  itemRevision: 1,
  attention: 'none',
  confluence: { suggested: false },
  vault: { suggested: false },
  containsPeopleObservations: false,
  summary: 's',
  reason: 'r',
  decidedBy: 'model',
  decidedAt: '2026-10-05T08:00:00.000Z',
  ...over,
});
const correction = (over: Partial<TriageCorrection> = {}): TriageCorrection => ({
  itemId: 'slack:C1:1',
  itemRevision: 1,
  attention: 'today',
  confluence: false,
  vault: false,
  correctedAt: '2026-10-05T08:10:00.000Z',
  ...over,
});

describe('laneFor', () => {
  it.each([
    ['now', {}, 'now'],
    ['today', {}, 'today'],
    ['none', { confluence: { suggested: true } }, 'file'],
    ['none', { vault: { suggested: true } }, 'file'],
    ['none', {}, 'else'],
  ] as const)('attention %s maps to its lane', (attention, extra, lane) => {
    expect(laneFor({ status: 'open', triageState: 'triaged', decision: decision({ attention, ...extra }) })).toBe(lane);
  });

  it('puts untriaged items in waiting, or failed when triage failed (CL-7)', () => {
    expect(laneFor({ status: 'open', triageState: 'pending' })).toBe('waiting');
    expect(laneFor({ status: 'open', triageState: 'failed' })).toBe('failed');
  });

  it('keeps the previous lane while a re-triage is pending', () => {
    expect(laneFor({ status: 'open', triageState: 'pending', decision: decision({ attention: 'today' }) })).toBe('today');
  });

  it('takes done and snoozed items out of the lanes (FR-8.3)', () => {
    expect(laneFor({ status: 'done', triageState: 'triaged', decision: decision({ attention: 'now' }) })).toBe('done');
    expect(laneFor({ status: 'snoozed', triageState: 'triaged', decision: decision({ attention: 'now' }) })).toBe('snoozed');
  });
});

describe('effectiveTriage', () => {
  it('lets a correction override the decision for the same revision (FR-6.2)', () => {
    const eff = effectiveTriage(decision({ attention: 'none' }), correction({ attention: 'today', vault: true }));
    expect(eff).toEqual({ attention: 'today', confluence: false, vault: true, by: 'user' });
  });

  it('lets a re-triage on a newer revision override an older correction', () => {
    const eff = effectiveTriage(decision({ itemRevision: 2, attention: 'now' }), correction({ itemRevision: 1 }));
    expect(eff?.attention).toBe('now');
    expect(eff?.by).toBe('model');
  });

  it('returns undefined when there is nothing to act on', () => {
    expect(effectiveTriage(undefined, undefined)).toBeUndefined();
  });
});
