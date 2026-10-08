import { newItemFlags, type Item, type ItemState, type Message } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { triageQueue } from './eligibility';
import { meFrom, ruleVerdict } from './rules';
import { BEFORE_MAX_CHARS, BEFORE_MAX_MESSAGES, EMAIL_MAX_CHARS, INVITEES_MAX, MEETING_MAX_CHARS, MESSAGE_MAX_CHARS, packBatches, threadForTriage, threadTokens } from './truncate';

const NOW = new Date('2026-10-06T09:00:00.000Z');
const ago = (mins: number) => new Date(NOW.getTime() - mins * 60_000).toISOString();

const state = (id: string, minsAgo: number, over: Partial<ItemState> = {}): ItemState => ({
  id,
  source: 'slack',
  kind: 'thread',
  title: '#product',
  permalink: 'https://polestar.slack.com/archives/C1/p1',
  participants: [],
  lastActivityAt: ago(minsAgo),
  revision: 1,
  messageCount: 1,
  ...newItemFlags(),
  ...over,
});

const msg = (i: number, text = `message ${i}`, authorId = 'U2'): Message => ({ id: String(i), authorId, ts: ago(100 - i), text });
const thread = (messages: Message[], over: Partial<Item> = {}): Item => ({
  id: 'slack:C1:1.000100',
  source: 'slack',
  kind: 'thread',
  title: '#product',
  permalink: 'https://polestar.slack.com/archives/C1/p1',
  participants: [
    { id: 'U2', name: 'Dana Lee' },
    { id: 'UFRANK', name: 'Frank' },
  ],
  messages,
  messageCount: messages.length,
  lastActivityAt: messages.at(-1)!.ts,
  revision: 1,
  schemaVersion: 1,
  ...over,
});

describe('quiet window and eligibility (§5.3)', () => {
  it('takes pending items quiet for quietMinutes, oldest first, and says when the next is due', () => {
    const q = triageQueue([state('a', 5), state('b', 30), state('c', 10), state('d', 60, { triageState: 'triaged' }), state('e', 8)], NOW, 10);
    expect(q.ready.map((i) => i.id)).toEqual(['b', 'c']);
    expect(q.nextReadyAt?.toISOString()).toBe(new Date(NOW.getTime() + 2 * 60_000).toISOString()); // e, quiet 2 min from now
  });

  it('has nothing to do when nothing waits', () => {
    expect(triageQueue([state('a', 30, { triageState: 'triaged' }), state('b', 30, { triageState: 'failed' })], NOW, 10)).toEqual({ ready: [] });
  });
});

describe('rule verdicts (FR-4.2, FR-4.3)', () => {
  const settings = defaultSettings('/tmp/x');
  settings.slack = { ...settings.slack, excludeChannels: ['#random'] };
  settings.people = { vips: ['Dana Lee'] };
  const me = meFrom({ id: 'UFRANK', name: 'frank' });

  it('maps the first matching rule to drop, a fixed level, or the model with a floor', () => {
    expect(ruleVerdict(thread([msg(1)], { kind: 'dm', title: 'Dana Lee' }), DEFAULT_RULES, settings, me)).toMatchObject({ kind: 'fixed', attention: 'now', rule: { id: 'vip-dm' } });
    expect(ruleVerdict(thread([msg(1)], { title: '#random' }), DEFAULT_RULES, settings, me)).toMatchObject({ kind: 'drop', rule: { id: 'exclude-channels' } });
    expect(ruleVerdict(thread([msg(1, 'Can @Frank look?')]), DEFAULT_RULES, settings, me)).toMatchObject({ kind: 'model', min: 'today', rule: { id: 'mention-me' } });
    expect(ruleVerdict(thread([msg(1)]), DEFAULT_RULES, settings, me)).toEqual({ kind: 'model' });
    const toFile = [{ id: 'signals', enabled: true, conditions: [{ type: 'channel_in' as const, values: ['#product'] }], outcome: { type: 'file' as const } }];
    expect(ruleVerdict(thread([msg(1)]), toFile, settings, me)).toMatchObject({ kind: 'model', file: true, rule: { id: 'signals' } });
  });

  it('builds "me" from the source identity, escaping the name', () => {
    expect(meFrom(undefined)).toEqual({ id: '' });
    const odd = meFrom({ id: 'U1', name: 'f.k (x)' });
    expect(odd.mentionRe?.test('hi @f.k (x)')).toBe(true);
    expect(odd.mentionRe?.test('hi @fXk (x)')).toBe(false);
  });
});

describe('truncation and batching (§5.3, CL-4)', () => {
  const me = meFrom({ id: 'UFRANK' });

  it('keeps the first message, the last N and any that mention Frank, and counts the rest', () => {
    const msgs = Array.from({ length: 20 }, (_, i) => msg(i + 1));
    msgs[6] = msg(7, 'Over to <@UFRANK> for the sign-off');
    msgs[18] = msg(19, 'Thanks', 'UFRANK');
    const t = threadForTriage(thread(msgs, { messageCount: 25 }), me, 3);
    expect(t.messages.map((m) => m.text)).toEqual(['message 1', 'Over to <@UFRANK> for the sign-off', 'message 18', 'Thanks', 'message 20']);
    expect(t.messages.map((m) => m.author)).toEqual(['Dana Lee', 'Dana Lee', 'Dana Lee', 'me', 'Dana Lee']);
    expect(t.omitted).toBe(20); // 25 in the thread, 5 sent
  });

  it('adds the last few messages before a DM, named, short, and leaves threads without', () => {
    const earlier = {
      messages: [...Array.from({ length: 7 }, (_, i) => msg(i + 1, `earlier ${i + 1}`, 'U9')), msg(8, 'y'.repeat(BEFORE_MAX_CHARS + 50), 'UFRANK')],
      people: [{ id: 'U9', name: 'Matt' }],
    };
    const t = threadForTriage(thread([msg(10)], { kind: 'dm' }), me, 3, earlier);
    expect(t.before?.map((m) => m.text.slice(0, 9))).toEqual(['earlier 4', 'earlier 5', 'earlier 6', 'earlier 7', 'yyyyyyyyy']);
    expect(t.before).toHaveLength(BEFORE_MAX_MESSAGES);
    expect(t.before?.map((m) => m.author)).toEqual(['Matt', 'Matt', 'Matt', 'Matt', 'me']);
    expect(t.before?.at(-1)?.text).toHaveLength(BEFORE_MAX_CHARS);
    expect(threadForTriage(thread([msg(10)]), me, 3, { messages: [], people: [] }).before).toBeUndefined();
  });

  it('sends a short thread whole and cuts a very long message', () => {
    const t = threadForTriage(thread([msg(1), msg(2, 'x'.repeat(MESSAGE_MAX_CHARS + 500))]), me, 8);
    expect(t.omitted).toBe(0);
    expect(t.messages[1].text).toHaveLength(MESSAGE_MAX_CHARS);
    expect(t.messages[1].text.endsWith('…')).toBe(true);
  });

  it('sends a meeting as a meeting: the whole summary, and Frank\'s notes as "me" (R2.3)', () => {
    const summary = `### Context\n${'Background. '.repeat(250)}\n### Next Steps\n- Frank to send the sample by Friday.`;
    const meeting = thread([{ id: 'summary', authorId: 'Wispr Flow summary', ts: ago(30), text: summary }, { id: 'notes', authorId: 'wispr:me', ts: ago(29), text: 'Ask about tanker coverage.' }], {
      id: 'wispr:0b9e7c2a',
      source: 'wispr',
      kind: 'meeting',
      title: 'Fleet data partner sync',
      participants: [{ id: 'wispr:me', name: 'Frank Keulers' }],
    });
    expect(summary.length).toBeGreaterThan(MESSAGE_MAX_CHARS);
    expect(summary.length).toBeLessThan(MEETING_MAX_CHARS);
    const t = threadForTriage(meeting, meFrom({ id: 'wispr:me', name: 'Frank Keulers' }), 3);
    expect(t).toMatchObject({ kind: 'meeting', title: 'Fleet data partner sync', omitted: 0 });
    expect(t.messages.map((m) => m.author)).toEqual(['Wispr Flow summary', 'me']);
    expect(t.messages[0].text).toContain('Frank to send the sample by Friday.');
    expect(t.meeting).toBeUndefined();
  });

  it('sends a meeting’s time and its calendar event: title, organiser, and invitees up to a cap (R2.8)', () => {
    const invitees = Array.from({ length: INVITEES_MAX + 3 }, (_, i) => ({ id: `p${i}@example.com`, name: `Person ${i}` }));
    const meeting = thread([{ id: 'summary', authorId: 'Wispr Flow summary', ts: ago(30), text: 'Summary' }], {
      id: 'wispr:m1',
      source: 'wispr',
      kind: 'meeting',
      title: 'Partner sync',
      participants: [{ id: 'wispr:me', name: 'Frank Keulers' }],
      meeting: { start: ago(90), end: ago(30), calendar: { eventId: 'e1', title: 'Fleet data partner sync', organizer: { id: 'dana@customer.example', name: 'Dana Lee' }, invitees } },
    });
    const t = threadForTriage(meeting, meFrom({ id: 'wispr:me', name: 'Frank Keulers' }), 3);
    expect(t.meeting).toEqual({ start: ago(90), end: ago(30), calendar: { title: 'Fleet data partner sync', organizer: 'Dana Lee', invitees: invitees.slice(0, INVITEES_MAX).map((p) => p.name), more: 3 } });
    // An invite: Frank is "me" wherever he is on it.
    const invite = { ...meeting, source: 'calendar' as const, kind: 'event' as const, meeting: { ...meeting.meeting!, calendar: { ...meeting.meeting!.calendar!, invitees: [{ id: 'frank@example.com', name: 'Frank Keulers' }] } } };
    expect(threadForTriage(invite, meFrom({ id: 'frank@example.com', name: 'Frank Keulers' }), 3).meeting?.calendar?.invitees).toEqual(['me']);
  });

  it('sends an email with who it went to, Frank as "me", and a longer cut than chat (Outlook)', () => {
    const ME = 'frank@example.com';
    const long = `Points for the renewal:\n${'- a point\n'.repeat(300)}`;
    const email = thread(
      [
        { id: '<a@x>', authorId: 'dana@customer.example', ts: ago(60), text: long, to: [ME], cc: ['sam@example.com'] },
        { id: '<b@x>', authorId: ME, ts: ago(30), text: 'Thanks, on it.', to: ['dana@customer.example'], cc: [] },
      ],
      {
        id: 'outlook:AAQkC1=',
        source: 'outlook',
        kind: 'email',
        title: 'Renewal terms',
        participants: [
          { id: ME, name: 'Frank Keulers' },
          { id: 'dana@customer.example', name: 'Dana Lee' },
          { id: 'sam@example.com', name: 'Sam Ray' },
        ],
      },
    );
    expect(long.length).toBeGreaterThan(MESSAGE_MAX_CHARS);
    const t = threadForTriage(email, meFrom({ id: ME, name: 'Frank Keulers' }), 3);
    expect(t.messages.map(({ author, to, cc }) => ({ author, to, cc }))).toEqual([
      { author: 'Dana Lee', to: ['me'], cc: ['Sam Ray'] },
      { author: 'me', to: ['Dana Lee'], cc: undefined },
    ]);
    expect(t.messages[0].text.length).toBe(Math.min(long.length, EMAIL_MAX_CHARS));
    // Chat messages carry neither.
    expect(threadForTriage(thread([msg(1)]), meFrom({ id: 'UFRANK' }), 3).messages[0]).not.toHaveProperty('to');
  });

  it('packs threads in order within the thread and token limits; an oversized one goes alone', () => {
    const sizes = [300, 300, 300, 2000, 100, 100, 100];
    const batches = packBatches(sizes, (n) => n, { maxThreads: 3, maxInputTokens: 1200, overheadTokens: 200 });
    expect(batches).toEqual([[300, 300, 300], [2000], [100, 100, 100]]);
    expect(packBatches([], (n: number) => n, { maxThreads: 25, maxInputTokens: 1000, overheadTokens: 0 })).toEqual([]);
    expect(threadTokens(threadForTriage(thread([msg(1)]), me, 8))).toBeGreaterThan(10);
  });
});
