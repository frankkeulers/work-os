import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, WorkEvent } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataDir, paths } from '../config/dataDir';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { bestEvent, scoreEvent, type MeetingFacts } from '../sources/calendar/match';
import type { CalendarSnapshot, SnapEvent } from '../sources/calendar/store';
import type { MeInfo } from '../sources/outlook/normalise';
import type { SourceAdapter } from '../sources/types';
import { ItemFiles } from '../store/items';
import { readLog } from '../store/recover';
import { Store } from '../store/store';
import { CursorFile } from './cursors';
import { relinkMeetings, withCalendar } from './meetings';
import { pollSource, type PollDeps } from './poll';

// Wispr Flow meetings joined to their calendar events (R2.8). All synthetic.

const NOW = new Date('2026-10-08T12:00:00.000Z');
const at = (mins: number) => new Date(NOW.getTime() + mins * 60_000).toISOString();
const ME: MeInfo = { id: 'frank@example.com', name: 'Frank Keulers', aliases: ['frank@example.com'] };

const ev = (id: string, subject: string, from: number, to: number, over: Partial<SnapEvent> = {}): SnapEvent => ({
  id,
  uri: `calendar:///events/${id}`,
  subject,
  organizer: { name: 'Dana Lee', address: 'dana.lee@customer.example' },
  attendees: [
    { name: 'Frank Keulers', address: 'frank@example.com', type: 'required' },
    { name: 'Sam Okafor', address: 'sam.okafor@example.com', type: 'required' },
  ],
  start: at(from),
  end: at(to),
  allDay: false,
  cancelled: false,
  isOrganizer: false,
  response: 'accepted',
  link: `https://outlook.office365.com/owa/?itemid=${id}`,
  ...over,
});
const snap = (events: SnapEvent[]): CalendarSnapshot => ({ schemaVersion: 1, polledAt: NOW.toISOString(), from: at(-36 * 60), to: at(14 * 24 * 60), events, invites: [] });
const facts = (over: Partial<MeetingFacts> = {}): MeetingFacts => ({ title: 'Launch readiness', start: at(-58), end: at(-5), people: ['Sam Okafor'], ...over });

describe('which event a meeting was', () => {
  it('takes the event the recording ran in, though Wispr started late and ran over', () => {
    const e = ev('e1', 'MVI V2 launch readiness', -60, -15);
    expect(scoreEvent(facts(), e)).toBeGreaterThan(0.9);
    expect(bestEvent(facts(), [ev('e0', 'Stand-up', -180, -165), e, ev('e2', 'Later', 60, 90)])?.id).toBe('e1');
  });

  it('links nothing for a recording no event overlaps, or a clash it can’t tell apart', () => {
    expect(bestEvent(facts({ start: at(-300), end: at(-240) }), [ev('e1', 'Launch readiness', -60, -15)])).toBeUndefined();
    const clash = [ev('a', 'Weekly sync', -60, -15, { attendees: [] }), ev('b', 'Office hours', -60, -15, { attendees: [] })];
    expect(bestEvent(facts({ title: 'Untitled meeting', people: [] }), clash)).toBeUndefined();
  });

  it('lets the title and people pick between overlapping events', () => {
    const clash = [ev('a', 'Office hours', -60, -15, { attendees: [], organizer: { name: 'Legal counsel' } }), ev('b', 'MVI V2 launch readiness', -60, -15)];
    expect(bestEvent(facts(), clash)?.id).toBe('b');
    // People alone, by the name an address gives: sam.okafor@… is Sam Okafor.
    const byPeople = [ev('a', 'Catch-up', -60, -15, { attendees: [{ address: 'sam.okafor@example.com' }] }), ev('b', 'Catch-up', -60, -15, { attendees: [{ address: 'legal@example.com' }], organizer: undefined })];
    expect(bestEvent(facts({ title: 'Untitled meeting' }), byPeople)?.id).toBe('a');
  });

  it('never takes a cancelled, declined or all-day event', () => {
    for (const over of [{ cancelled: true }, { response: 'declined' }, { allDay: true }]) expect(bestEvent(facts(), [ev('e1', 'Launch readiness', -60, -15, over)])).toBeUndefined();
  });
});

const wispr = (over: Partial<Item> = {}): Item => ({
  id: 'wispr:m1',
  source: 'wispr',
  kind: 'meeting',
  title: 'Launch readiness',
  permalink: 'https://wisprflow.ai/m/1',
  participants: [
    { id: 'wispr:me', name: 'Frank Keulers' },
    { id: 'wispr:name:sam okafor', name: 'Sam Okafor' },
  ],
  messages: [{ id: 'summary', authorId: 'Wispr Flow summary', ts: at(-4), text: '### Next Steps\n- Frank to confirm the rollback owner.' }],
  messageCount: 1,
  lastActivityAt: at(-4),
  revision: 1,
  schemaVersion: 1,
  meeting: { start: at(-58), end: at(-5) },
  ...over,
});

describe('joining a meeting to its event', () => {
  it('puts the event’s title, organiser and invitees on the meeting', () => {
    const joined = withCalendar(wispr(), snap([ev('e1', 'MVI V2 launch readiness', -60, -15)]), ME);
    expect(joined.meeting).toEqual({
      start: at(-58),
      end: at(-5),
      calendar: {
        eventId: 'e1',
        title: 'MVI V2 launch readiness',
        organizer: { id: 'dana.lee@customer.example', name: 'Dana Lee' },
        invitees: [
          { id: ME.id, name: 'Frank Keulers' },
          { id: 'sam.okafor@example.com', name: 'Sam Okafor' },
        ],
        link: 'https://outlook.office365.com/owa/?itemid=e1',
      },
    });
  });

  it('names the people of an event known only by address, as search gives one that was never read', () => {
    const unread = ev('e1', 'MVI V2 launch readiness', -60, -15, { organizer: { address: 'dana.lee@customer.example' }, attendees: [{ address: 'frank@example.com' }, { address: 'sam.okafor@example.com' }], response: undefined });
    expect(withCalendar(wispr(), snap([unread]), ME).meeting?.calendar).toMatchObject({
      organizer: { id: 'dana.lee@customer.example', name: 'Dana Lee' },
      invitees: [
        { id: ME.id, name: 'Frank Keulers' },
        { id: 'sam.okafor@example.com', name: 'Sam Okafor' },
      ],
    });
  });

  it('leaves alone what isn’t a timed Wispr meeting, or has no event', () => {
    const s = snap([ev('e1', 'Launch readiness', -60, -15)]);
    const slack = wispr({ source: 'slack', id: 'slack:x' });
    expect(withCalendar(slack, s, ME)).toBe(slack);
    const untimed = wispr({ meeting: undefined });
    expect(withCalendar(untimed, s, ME)).toBe(untimed);
    const elsewhere = wispr();
    expect(withCalendar(elsewhere, snap([]), ME)).toBe(elsewhere);
  });
});

describe('joining in the pipeline', () => {
  let dir: string;
  let store: Store;
  let d: PollDeps;
  let fetched: Item[];
  const source: SourceAdapter = { id: 'wispr', deps: ['wisprMcp'], needsNetwork: true, fetchSince: async () => ({ items: structuredClone(fetched), nextCursor: 'c' }), probe: async () => 'ok' };
  const events = async () => {
    const out: WorkEvent[] = [];
    await readLog(paths(dir).events, { afterSeq: 0, repair: false, onEvent: (e) => void out.push(e) });
    return out;
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-meetings-'));
    await initDataDir(dir, { settings: defaultSettings(dir), rules: DEFAULT_RULES });
    ({ store } = await Store.open({ dataDir: dir, now: () => NOW }));
    d = { store, items: new ItemFiles(join(dir, 'items')), cursors: await CursorFile.open(paths(dir).cursors), now: () => NOW };
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('joins a meeting as Wispr reads it, and keeps the join when Wispr sends it again with more', async () => {
    const s = snap([ev('e1', 'MVI V2 launch readiness', -60, -15)]);
    d.enrich = (items) => items.map((i) => withCalendar(i, s, ME));
    fetched = [wispr()];
    await pollSource(d, source, 'scheduled', new AbortController().signal);
    expect((await d.items.read('wispr', 'wispr:m1'))?.item.meeting?.calendar?.eventId).toBe('e1');

    // Days later the calendar no longer has it, and Wispr sends the meeting again with Frank's notes.
    d.enrich = (items) => items.map((i) => withCalendar(i, snap([]), ME));
    fetched = [wispr({ messages: [...wispr().messages, { id: 'notes', authorId: 'wispr:me', ts: at(-3), text: 'Ask Legal.' }], messageCount: 2 })];
    await pollSource(d, source, 'scheduled', new AbortController().signal);
    const stored = await d.items.read('wispr', 'wispr:m1');
    expect(stored?.item).toMatchObject({ revision: 2, meeting: { calendar: { eventId: 'e1' } } });
  });

  it('joins a meeting after the calendar poll that first has its event: the file only, not triaged again', async () => {
    fetched = [wispr()];
    await pollSource(d, source, 'scheduled', new AbortController().signal);
    const logged = (await events()).length;
    expect(await relinkMeetings(d, snap([]), ME)).toBe(0);

    expect(await relinkMeetings(d, snap([ev('e1', 'MVI V2 launch readiness', -60, -15)]), ME)).toBe(1);
    const stored = await d.items.read('wispr', 'wispr:m1');
    expect(stored?.item).toMatchObject({ revision: 1, meeting: { calendar: { eventId: 'e1' } } });
    expect(await events()).toHaveLength(logged);
    expect(store.projection.items['wispr:m1'].triageState).toBe('pending'); // as before: one triage
    expect(await relinkMeetings(d, snap([ev('e2', 'Other', -60, -15)]), ME)).toBe(0); // joined once
  });
});
