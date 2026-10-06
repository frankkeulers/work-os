import { describe, expect, it } from 'vitest';
import type { ItemSummary } from '../api';
import { dueInfo, needLabel, nextDeadline, openLabel, shownStep, suggestedSnooze } from './next';

// Mon 5 Oct 2026, 09:45 London (BST).
const now = new Date('2026-10-05T08:45:00.000Z');
const london = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h - 1, m)).toISOString();
};

const item = (over: Partial<ItemSummary>): ItemSummary => ({
  id: 'i',
  source: 'slack',
  kind: 'thread',
  title: '#x',
  permalink: 'https://example.com',
  lastActivityAt: '2026-10-05T08:00:00.000Z',
  revision: 1,
  lane: 'now',
  status: 'open',
  triageState: 'triaged',
  summary: 's',
  reason: 'Because.',
  triage: { attention: 'now', confluence: false, vault: false, by: 'model' },
  containsPeopleObservations: false,
  targetHints: {},
  actions: {},
  newReplies: false,
  backFromSnooze: false,
  modelPaused: false,
  ...over,
});

describe('dueInfo', () => {
  it('reads a close deadline today as Now, with the time left', () => {
    expect(dueInfo({ need: 'approve', step: 's', why: 'w', dueAt: london(5, '12:00') }, now)).toEqual({ text: '12:00 · in 2 h 15 min', tone: 'now' });
  });
  it('reads later today as Today and another day as later', () => {
    expect(dueInfo({ need: 'decide', step: 's', why: 'w', dueAt: london(5, '16:00'), dueLabel: 'planning' }, now)).toEqual({ text: '16:00 planning', tone: 'today' });
    expect(dueInfo({ need: 'decide', step: 's', why: 'w', dueAt: london(8, '09:00') }, now)).toEqual({ text: 'Thu 09:00', tone: 'later' });
  });
  it('marks a missed deadline overdue', () => {
    expect(dueInfo({ need: 'reply', step: 's', why: 'w', dueAt: london(5, '09:00') }, now)).toEqual({ text: '09:00 · overdue', tone: 'now' });
  });
  it('uses the label alone when there is no exact time', () => {
    expect(dueInfo({ need: 'reply', step: 's', why: 'w', dueLabel: 'this week' }, now)).toEqual({ text: 'this week', tone: 'later' });
  });
});

describe('next step', () => {
  it('counts meeting action items', () => {
    expect(needLabel({ need: 'actions', actionItems: ['a', 'b'] })).toBe('2 actions');
    expect(needLabel({ need: 'approve' })).toBe('Approve');
  });
  it('falls back to a reply for Now and Today items without a model next step', () => {
    expect(shownStep(item({ kind: 'dm', title: 'Matt M.' }), false, now)).toMatchObject({ need: 'Reply', step: 'Reply to Matt M.', primary: { kind: 'open', label: 'Open DM in Slack' } });
  });
  it('makes the filing draft the primary action in To file', () => {
    const s = shownStep(item({ lane: 'file', triage: { attention: 'none', confluence: true, vault: false, by: 'model' } }), false, now);
    expect(s).toMatchObject({ need: 'File', step: 'Draft the Confluence entry', primary: { kind: 'draft' } });
  });
  it('has no next step for items that need nothing', () => {
    expect(shownStep(item({ lane: 'else' }), false, now)).toBeUndefined();
    expect(shownStep(item({ status: 'done', lane: 'done' }), false, now)).toBeUndefined();
  });
  it('names the right app for each source', () => {
    expect(openLabel({ source: 'outlook', kind: 'email' })).toBe('Reply in Outlook');
    expect(openLabel({ source: 'teams', kind: 'meeting' })).toBe('Open transcript in Teams');
    expect(openLabel({ source: 'slack', kind: 'thread' })).toBe('Open thread in Slack');
  });
  it('finds the next deadline still ahead', () => {
    const items = [
      item({ next: { need: 'reply', step: 's', why: 'w', dueAt: london(5, '09:00') } }),
      item({ id: 'b', next: { need: 'reply', step: 's', why: 'w', dueAt: london(5, '14:00') } }),
      item({ id: 'c', lane: 'done', next: { need: 'reply', step: 's', why: 'w', dueAt: london(5, '10:00') } }),
    ];
    expect(nextDeadline(items, now)).toBe('14:00');
  });
});

describe('suggestedSnooze', () => {
  it('snoozes to 30 minutes before a deadline today', () => {
    expect(suggestedSnooze(item({ next: { need: 'approve', step: 's', why: 'w', dueAt: london(5, '12:00') } }), now)).toEqual({ label: 'Snooze until 11:30', until: london(5, '11:30') });
  });
  it('snoozes to tomorrow morning for a later deadline, and an hour otherwise', () => {
    expect(suggestedSnooze(item({ next: { need: 'decide', step: 's', why: 'w', dueAt: london(8, '09:00') } }), now).label).toBe('Snooze until tomorrow 09:00');
    expect(suggestedSnooze(item({}), now).label).toBe('Snooze 1 hour');
  });
  it('holds filing until the end of the day', () => {
    expect(suggestedSnooze(item({ lane: 'file' }), now)).toEqual({ label: 'Snooze until 17:30', until: london(5, '17:30') });
  });
});
