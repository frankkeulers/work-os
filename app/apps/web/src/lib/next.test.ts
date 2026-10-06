import { describe, expect, it } from 'vitest';
import type { ItemSummary } from '../api';
import { dueInfo, needLabel, needsYouOrder, nextDeadline, groupByChannel, openLabel, shownStep, sortItems, suggestedSnooze } from './next';

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

describe('needsYouOrder (FR-8.1)', () => {
  const step = (over: object) => ({ need: 'reply' as const, step: 's', why: 'w', ...over });
  it('puts Now first, then failed triage, then Today by deadline', () => {
    const items = [
      item({ id: 'undated', lane: 'today' }),
      item({ id: 'week', lane: 'today', next: step({ dueLabel: 'this week' }) }),
      item({ id: 'thu', lane: 'today', next: step({ dueAt: london(8, '09:00') }) }),
      item({ id: 'today', lane: 'today', next: step({ dueLabel: 'today' }) }),
      item({ id: 'at16', lane: 'today', next: step({ dueAt: london(5, '16:00') }) }),
      item({ id: 'failed', lane: 'failed', triageState: 'failed', triage: undefined }),
      item({ id: 'now', lane: 'now' }),
    ];
    expect(needsYouOrder(items, now).map((i) => i.id)).toEqual(['now', 'failed', 'at16', 'today', 'thu', 'week', 'undated']);
  });
  it('leaves out filing, low priority, waiting, snoozed and done', () => {
    const lanes = ['file', 'else', 'waiting', 'snoozed', 'done'] as const;
    expect(needsYouOrder(lanes.map((lane) => item({ id: lane, lane })), now)).toEqual([]);
  });
  it('breaks ties with the newest activity', () => {
    const items = [item({ id: 'old', lastActivityAt: '2026-10-05T06:00:00.000Z' }), item({ id: 'new', lastActivityAt: '2026-10-05T08:00:00.000Z' })];
    expect(needsYouOrder(items, now).map((i) => i.id)).toEqual(['new', 'old']);
  });
});

describe('sortItems', () => {
  const items = [
    item({ id: 'mid', lane: 'now', lastActivityAt: '2026-10-05T07:00:00.000Z' }),
    item({ id: 'new', lane: 'today', lastActivityAt: '2026-10-05T08:30:00.000Z' }),
    item({ id: 'old', lane: 'failed', lastActivityAt: '2026-10-04T16:00:00.000Z' }),
  ];
  it('sorts by last activity, newest or oldest first, whatever the lane', () => {
    expect(sortItems(items, 'newest', true, now).map((i) => i.id)).toEqual(['new', 'mid', 'old']);
    expect(sortItems(items, 'oldest', true, now).map((i) => i.id)).toEqual(['old', 'mid', 'new']);
  });
  it('uses the FR-8.1 order for Needs you under Priority, and keeps other groups as they came', () => {
    expect(sortItems(items, 'priority', true, now).map((i) => i.id)).toEqual(['mid', 'old', 'new']);
    expect(sortItems(items, 'priority', false, now).map((i) => i.id)).toEqual(['mid', 'new', 'old']);
  });
  it('keeps Needs you to its lanes in every order', () => {
    const file = item({ id: 'file', lane: 'file' });
    expect(sortItems([file], 'newest', true, now)).toEqual([]);
    expect(sortItems([file], 'newest', false, now)).toEqual([file]);
  });
  it('does not change the list it was given', () => {
    const copy = [...items];
    sortItems(items, 'newest', false, now);
    expect(items).toEqual(copy);
  });
});

describe('groupByChannel', () => {
  const at = (id: string, over: Partial<ItemSummary> = {}) => item({ id, ...over });
  it('brings each channel together where its first item was, keeping the order inside it', () => {
    const items = [at('slack:C1:3'), at('slack:C2:1'), at('slack:C1:2'), at('slack:D9:1'), at('slack:C2:5'), at('slack:C1:1')];
    expect(groupByChannel(items).map((i) => i.id)).toEqual(['slack:C1:3', 'slack:C1:2', 'slack:C1:1', 'slack:C2:1', 'slack:C2:5', 'slack:D9:1']);
  });
  it('leaves other sources where they were, ungrouped', () => {
    const items = [at('outlook:a', { source: 'outlook' }), at('slack:C1:1'), at('teams:b', { source: 'teams' }), at('slack:C1:2')];
    expect(groupByChannel(items).map((i) => i.id)).toEqual(['outlook:a', 'slack:C1:1', 'slack:C1:2', 'teams:b']);
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
