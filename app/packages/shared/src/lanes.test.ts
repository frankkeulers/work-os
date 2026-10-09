import { describe, expect, it } from 'vitest';
import { dueAfterToday, effectiveTriage, laneFor, viewLane } from './lanes';
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

describe('Later › This week (cockpit CK-3.10)', () => {
  const tue = '2026-10-06T13:00:00Z'; // Tue 14:00 London
  const fri = '2026-10-09T08:00:00Z'; // Fri 09:00 London

  it('moves a Today item due after today, and keeps one due today', () => {
    expect(viewLane('today', { dueAt: '2026-10-09T16:00:00Z' }, tue)).toBe('week'); // Fri 17:00
    expect(viewLane('today', { dueAt: '2026-10-06T23:00:00Z' }, tue)).toBe('week'); // midnight on
    expect(viewLane('today', { dueAt: '2026-10-06T22:59:00Z' }, tue)).toBe('today'); // 23:59 tonight
    expect(viewLane('today', { dueAt: '2026-10-06T10:00:00Z' }, tue)).toBe('today'); // overdue
    expect(viewLane('today', undefined, tue)).toBe('today');
    // After this Friday: This week too (9 Oct decision), the chip carries the date.
    expect(viewLane('today', { dueAt: '2026-10-14T16:00:00Z' }, tue)).toBe('week');
  });

  it('rolls into Needs you on the day it falls due', () => {
    expect(viewLane('today', { dueAt: '2026-10-09T16:00:00Z' }, fri)).toBe('today');
  });

  it('leaves Now alone, so a correction to Now always wins', () => {
    expect(viewLane('now', { dueAt: '2026-10-09T16:00:00Z' }, tue)).toBe('now');
    expect(viewLane('file', { dueAt: '2026-10-09T16:00:00Z' }, tue)).toBe('file');
  });

  it('reads a label when there is no dueAt: next week always, this week until Thursday', () => {
    expect(dueAfterToday({ dueLabel: 'this week' }, tue)).toBe(true);
    expect(dueAfterToday({ dueLabel: 'By Friday' }, tue)).toBe(true);
    expect(dueAfterToday({ dueLabel: 'next week' }, fri)).toBe(true);
    expect(dueAfterToday({ dueLabel: 'this week' }, fri)).toBe(false);
    expect(dueAfterToday({ dueLabel: 'today' }, tue)).toBe(false);
    expect(dueAfterToday({ dueLabel: 'Thu 09:00' }, tue)).toBe(false); // a label alone with a day isn't enough
  });
});
