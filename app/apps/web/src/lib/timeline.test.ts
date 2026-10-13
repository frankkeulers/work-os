import { describe, expect, it } from 'vitest';
import type { AgendaEvent } from '@work-os/shared';
import type { ItemSummary } from '../api';
import { dayPins, dayStart, dueBefore, hourHeight, minuteOf, nextMeeting, placeMeetings, shortTitle, timelineSpan, workSpan } from './timeline';

// Fri 9 Oct 2026, 13:48 London (BST, UTC+1).
const now = new Date('2026-10-09T12:48:00.000Z');
const at = (hhmm: string, day = 9) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h - 1, m)).toISOString();
};
const ev = (id: string, start: string, end: string, over: Partial<AgendaEvent> = {}): AgendaEvent => ({ id, title: id, start: at(start), end: at(end), allDay: false, response: 'accepted', ...over });
const item = (id: string, lane: ItemSummary['lane'], dueAt?: string, over: Partial<ItemSummary> = {}): ItemSummary =>
  ({
    id,
    source: 'slack',
    kind: 'thread',
    title: id,
    permalink: '',
    lastActivityAt: at('09:00'),
    revision: 1,
    lane,
    status: 'open',
    triageState: 'triaged',
    summary: `Summary of ${id}`,
    next: { need: 'reply', step: `Step for ${id}`, why: '', ...(dueAt && { dueAt }) },
    containsPeopleObservations: false,
    targetHints: {},
    actions: {},
    newReplies: false,
    backFromSnooze: false,
    modelPaused: false,
    pieces: 1,
    asksDone: [],
    ...over,
  }) as ItemSummary;

describe('the timeline’s range and scale (CK-3.6)', () => {
  it('reads work hours, falling back as isWorkHours does', () => {
    expect(workSpan('Mon–Fri 08:00–18:00')).toEqual({ from: 480, to: 1080 });
    expect(workSpan('nonsense')).toEqual({ from: 480, to: 1110 });
  });

  it('widens to the first and last meeting or pin, in whole hours', () => {
    expect(timelineSpan({ from: 480, to: 1080 }, [450, 1110])).toEqual({ from: 420, to: 1140 });
    expect(timelineSpan({ from: 480, to: 1110 }, [])).toEqual({ from: 480, to: 1140 });
  });

  it('is 72 px an hour when the day fits, down to 48, then scrolls', () => {
    const span = { from: 480, to: 1080 }; // 10 hours
    expect(hourHeight(800, span)).toBe(72);
    expect(hourHeight(600, span)).toBe(60);
    expect(hourHeight(300, span)).toBe(48);
    expect(hourHeight(0, span)).toBe(72);
  });
});

describe('placeMeetings', () => {
  it('puts overlapping meetings side by side, and marks past ones', () => {
    const start = dayStart(now, 'today');
    const placed = placeMeetings([ev('a', '09:00', '09:30'), ev('b', '14:00', '15:00'), ev('c', '14:30', '15:30'), ev('d', '16:00', '16:05'), ev('all', '00:00', '00:00', { allDay: true })], start, now);
    expect(placed.map((m) => [m.event.id, m.from, m.to, m.col, m.cols, m.past])).toEqual([
      ['a', 540, 570, 0, 1, true],
      ['b', 840, 900, 0, 2, false],
      ['c', 870, 930, 1, 2, false],
      ['d', 960, 975, 0, 1, false], // at least 15 minutes tall
    ]);
  });
});

describe('dayPins (CK-3.6)', () => {
  it('pins Needs you items due today, coloured by time: orange within 4 h, blue later, red when overdue', () => {
    const pins = dayPins([item('soon', 'now', at('14:00')), item('later', 'today', at('18:15')), item('late', 'today', at('11:00')), item('none', 'today'), item('week', 'week', at('17:00', 10))], now, 'today');
    expect(pins.map((p) => [p.label, p.tone, p.at])).toEqual([
      ['Overdue · Step for late', 'late', minuteOf(now.getTime(), dayStart(now, 'today'))],
      ['14:00 Step for soon', 'now', 14 * 60],
      ['18:15 Step for later', 'today', 18 * 60 + 15],
    ]);
  });

  it('stacks pins within 30 minutes, taking the most urgent colour', () => {
    const pins = dayPins([item('a', 'today', at('18:00')), item('b', 'today', at('18:15')), item('c', 'now', at('16:00'))], now, 'today');
    expect(pins.map((p) => [p.label, p.items.length, p.tone])).toEqual([
      ['16:00 Step for c', 1, 'now'], // within 4 h of 13:48
      ['2 due 18:00', 2, 'today'],
    ]);
    const stacked = dayPins([item('a', 'today', at('15:00')), item('b', 'today', at('17:30')), item('c', 'today', at('15:20'))], now, 'today');
    expect(stacked[0]).toMatchObject({ label: '2 due 15:00', tone: 'now' });
  });

  it('leaves out done, To file and This week items today, and shows This week items due tomorrow on Tomorrow', () => {
    const items = [item('done', 'today', at('15:00'), { status: 'done' }), item('file', 'file', at('15:00')), item('wk', 'week', at('10:00', 10)), item('wk2', 'week', at('10:00', 12))];
    expect(dayPins(items, now, 'today')).toEqual([]);
    expect(dayPins(items, now, 'tomorrow').map((p) => p.label)).toEqual(['10:00 Step for wk']);
  });

  it('steps to any day, as the day bar does: 1 is tomorrow, a later day has its own, a day gone by none (CK-3.4)', () => {
    const items = [item('wk', 'week', at('10:00', 10)), item('wk2', 'week', at('10:00', 12)), item('late', 'today', at('11:00'))];
    expect(dayPins(items, now, 1)).toEqual(dayPins(items, now, 'tomorrow'));
    expect(dayPins(items, now, 3).map((p) => p.label)).toEqual(['10:00 Step for wk2']);
    expect(dayPins(items, now, -1)).toEqual([]);
    expect(dayStart(now, 3)).toBe('2026-10-11T23:00:00.000Z'); // Mon 12 Oct, 00:00 in London
  });

  it('cuts a short title at 28 characters', () => {
    expect(shortTitle({ summary: 's', next: { need: 'reply', step: 'Confirm the data-licensing wording in the doc', why: '' } })).toBe('Confirm the data-licensing…');
  });
});

describe('nextMeeting (CK-3.5)', () => {
  it('is the first meeting today Frank is going to that hasn’t ended', () => {
    const events = [ev('standup', '09:00', '09:15'), ev('renewal', '14:00', '14:30'), ev('free', '13:50', '14:20', { showAs: 'free' }), ev('declined', '13:55', '14:10', { response: 'declined' })];
    expect(nextMeeting(events, now)).toMatchObject({ kind: 'meeting', event: { id: 'renewal' }, phase: 'next', minutes: 12, imminent: false, also: [] });
  });

  it('is on now until it ends, and lists one at the same time', () => {
    const events = [ev('call', '13:30', '14:30'), ev('clash', '14:00', '14:30', { response: 'tentativelyAccepted' })];
    expect(nextMeeting(events, now)).toMatchObject({ kind: 'meeting', event: { id: 'call' }, phase: 'now', also: [{ id: 'clash' }] });
  });

  it('turns imminent in the last 2 minutes', () => {
    expect(nextMeeting([ev('x', '13:50', '14:00')], now)).toMatchObject({ minutes: 2, imminent: true });
  });

  it('with nothing left today, gives the first meeting tomorrow', () => {
    const tomorrow = { ...ev('t', '10:00', '11:00'), start: at('10:00', 10), end: at('11:00', 10) };
    expect(nextMeeting([ev('done', '09:00', '10:00'), tomorrow], now)).toEqual({ kind: 'none', tomorrow });
    expect(nextMeeting([], now)).toEqual({ kind: 'none', tomorrow: undefined });
  });
});

describe('dueBefore', () => {
  it('lists open Needs you items due on or before the meeting starts', () => {
    const items = [item('go', 'now', at('14:00')), item('late', 'today', at('11:00')), item('after', 'today', at('14:01')), item('wk', 'week', at('10:00'))];
    expect(dueBefore(items, at('14:00')).map((i) => i.id)).toEqual(['late', 'go']);
  });
});
