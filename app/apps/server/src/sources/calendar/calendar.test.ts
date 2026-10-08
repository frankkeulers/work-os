import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataDir, paths } from '../../config/dataDir';
import { DEFAULT_RULES, defaultSettings } from '../../config/defaults';
import { CursorFile } from '../../pipeline/cursors';
import { pollSource } from '../../pipeline/poll';
import { ItemFiles } from '../../store/items';
import { Store } from '../../store/store';
import { SourceError } from '../errors';
import { FakeMs365, fakeEvent } from '../ms365/fakeMs365';
import type { EventDetail } from '../ms365/types';
import type { MeInfo } from '../outlook/normalise';
import { CalendarAdapter, MAX_READS } from './adapter';
import { inviteBody, inviteItemId, responseOf, snapFromRow } from './normalise';
import { CalendarStore } from './store';
import { wallToUtc, whenText } from './time';

// The Outlook calendar source (R2.8) against the in-memory connector. All events are synthetic.
// NOW is Thursday 8 October 2026, 13:00 in London (BST).

const NOW = new Date('2026-10-08T12:00:00.000Z');
const HOUR = 3_600_000;
const at = (hours: number) => new Date(NOW.getTime() + hours * HOUR).toISOString();
const wall = (iso: string) => ({ dateTime: iso.replace('Z', '0000'), timeZone: 'UTC' });

const FRANK = { name: 'Frank Keulers', address: 'frank.keulers@example.com' };
const DANA = { name: 'Dana Lee', address: 'dana.lee@customer.example' };
const SAM = { name: 'Sam Ray', address: 'sam.ray@example.com' };
const ME: MeInfo = { id: FRANK.address, name: FRANK.name, aliases: [FRANK.address] };

const TEAMS = '<p>________________________________________________________________________________</p><p>Microsoft Teams meeting</p><p><a href="https://teams.microsoft.com/l/meetup-join/abc">Join the meeting now</a></p><p>Meeting ID: 123 456 789</p><p>Passcode: AbC123</p>';
const invite = (over: Partial<Parameters<typeof fakeEvent>[0]> = {}) =>
  fakeEvent({ subject: 'Q4 roadmap review', organizer: DANA, attendees: [{ ...FRANK }, { ...SAM, type: 'optional' }], start: at(26), end: at(27), created: at(-1), html: `<p>Can we agree the Q4 priorities?</p>${TEAMS}`, ...over });

describe('calendar times', () => {
  it('reads the connector’s UTC times, IANA and Windows zones, and offsets', () => {
    expect(wallToUtc({ dateTime: '2026-10-09T14:00:00.0000000', timeZone: 'UTC' })).toBe('2026-10-09T14:00:00.000Z');
    expect(wallToUtc({ dateTime: '2026-10-09T15:00:00', timeZone: 'Europe/London' })).toBe('2026-10-09T14:00:00.000Z');
    expect(wallToUtc({ dateTime: '2026-11-09T15:00:00', timeZone: 'GMT Standard Time' })).toBe('2026-11-09T15:00:00.000Z');
    expect(wallToUtc({ dateTime: '2026-10-09T09:00:00', timeZone: 'Pacific Standard Time' })).toBe('2026-10-09T16:00:00.000Z');
    expect(wallToUtc({ dateTime: '2026-10-09T15:00:00+02:00' })).toBe('2026-10-09T13:00:00.000Z');
    // Across the clock change: 01:30 on 25 October is BST's last half hour, 02:30 is GMT.
    expect(wallToUtc({ dateTime: '2026-10-25T02:30:00', timeZone: 'Europe/London' })).toBe('2026-10-25T02:30:00.000Z');
    expect(wallToUtc({ dateTime: '2026-10-09T14:00:00', timeZone: 'Atlantis Standard Time' })).toBe('2026-10-09T14:00:00.000Z'); // unknown: UTC
    expect(wallToUtc({ dateTime: 'tomorrow', timeZone: 'UTC' })).toBeUndefined();
  });

  it('says when in London time, and an all-day event by its days', () => {
    expect(whenText(at(26), at(27))).toBe('Fri 9 Oct, 15:00–16:00');
    expect(whenText(at(26), at(26 + 24))).toBe('Fri 9 Oct, 15:00 to Sat 10 Oct, 15:00');
    expect(whenText('2026-10-12T00:00:00.000Z', '2026-10-13T00:00:00.000Z', true)).toBe('Mon 12 Oct, all day');
    expect(whenText('2026-10-12T00:00:00.000Z', '2026-10-14T00:00:00.000Z', true)).toBe('Mon 12 Oct to Tue 13 Oct, all day');
    expect(whenText('2026-10-11T23:00:00.000Z', '2026-10-12T23:00:00.000Z', true)).toBe('Mon 12 Oct, all day'); // London's midnights, in UTC
  });
});

describe('calendar normalise', () => {
  it('keeps what the organiser wrote and cuts the Teams block: link, meeting ID and passcode', () => {
    const body = inviteBody({ contentType: 'html', content: `<p>Agenda:</p><ul><li>Fleet coverage</li></ul>${TEAMS}` });
    expect(body).toContain('Fleet coverage');
    expect(body).not.toMatch(/Teams|Passcode|Meeting ID|teams\.microsoft|___/);
    expect(inviteBody({ contentType: 'html', content: TEAMS })).toBe('');
  });

  it('finds Frank’s answer in his own attendee entry', () => {
    const e = (responseStatus: string, address = FRANK.address): EventDetail => ({ ...invite(), attendees: [{ name: 'Frank', address: address.toUpperCase(), type: 'required', responseStatus }] });
    expect(responseOf(e('none'), ME)).toBe('none');
    expect(responseOf(e('tentativelyAccepted'), ME)).toBe('tentativelyAccepted');
    expect(responseOf(e('accepted', 'all-staff@example.com'), ME)).toBe('notListed');
  });

  it('puts the same organiser and subject in one invite item, whatever its Re: prefix', () => {
    const row = (subject: string, organizer = DANA.address) => snapFromRow({ uri: 'u', id: 'x', subject, organizer, attendees: [], start: wall(at(1)), end: wall(at(2)) }, ME)!;
    expect(inviteItemId(row('Weekly sync'))).toBe(inviteItemId(row('RE: Weekly sync')));
    expect(inviteItemId(row('Weekly sync'))).not.toBe(inviteItemId(row('Weekly sync', SAM.address)));
    expect(inviteItemId(row('Weekly sync'))).toMatch(/^calendar:[0-9a-f]{20}$/);
  });
});

describe('the calendar adapter', () => {
  let box: FakeMs365;
  let store: CalendarStore;
  const account = { name: FRANK.name, address: FRANK.address };
  const adapter = (acc: typeof account | undefined = account) => new CalendarAdapter({ api: box, store, account: () => acc });
  const fetch = (now = NOW) => adapter().fetchSince(undefined, { signal: new AbortController().signal, now, reason: 'scheduled' });
  /** A poll whose items were saved: the snapshot is published. */
  const poll = async (now = NOW) => {
    const r = await fetch(now);
    await r.commit?.();
    return r;
  };
  const uri = (e: { id: string }) => FakeMs365.eventUri(e.id);
  const move = (e: EventDetail, hours: number) => Object.assign(e, { start: wall(at(hours)), end: wall(at(hours + 1)) });

  beforeEach(() => {
    box = new FakeMs365({ me: { displayName: FRANK.name, mail: FRANK.address, userPrincipalName: FRANK.address } });
    store = CalendarStore.memory();
  });

  it('searches yesterday to two weeks ahead, London time, reads only meetings Frank may owe an answer to, and opens an invite item', async () => {
    const q4 = invite();
    const accepted = invite({ subject: 'Ops sync', attendees: [{ ...FRANK, response: 'accepted' }], start: at(3), end: at(4) });
    box.calendar.push(
      q4,
      accepted,
      invite({ subject: 'Own meeting', organizer: FRANK, attendees: [{ ...DANA }] }),
      invite({ subject: 'Cancelled', cancelled: true }),
      invite({ subject: 'This morning', start: at(-3), end: at(-2) }),
      invite({ subject: 'Focus time', attendees: [] }),
    );
    const r = await fetch();
    expect(box.eventSearches).toEqual([[{ after: '2026-10-06T23:00:00.000Z', before: '2026-10-22T23:00:00.000Z', offset: 0 }]]);
    expect(box.eventReads).toEqual([[uri(accepted), uri(q4)]]); // soonest first
    expect(r.resolved).toEqual([]);
    expect(r.items).toHaveLength(1);
    const item = r.items[0];
    expect(item).toMatchObject({
      id: inviteItemId(snapFromRow({ uri: 'u', id: q4.id, subject: 'Q4 roadmap review', organizer: DANA.address, start: q4.start, end: q4.end }, ME)!),
      source: 'calendar',
      kind: 'event',
      title: 'Q4 roadmap review',
      permalink: q4.webLink,
      meeting: { start: at(26), end: at(27), calendar: { eventId: q4.id, title: 'Q4 roadmap review', organizer: { id: DANA.address, name: DANA.name }, invitees: [{ id: FRANK.address, name: FRANK.name }, { id: SAM.address, name: SAM.name }] } },
    });
    expect(item.participants.map((p) => p.id)).toEqual([FRANK.address, DANA.address, SAM.address]);
    expect(item.messages).toEqual([{ id: `invite:${q4.id}:${at(26)}`, authorId: DANA.address, ts: at(-1), text: 'Invitation: Q4 roadmap review\nWhen: Fri 9 Oct, 15:00–16:00\nOrganiser: Dana Lee\nRequired: you\nOptional: Sam Ray\n\nCan we agree the Q4 priorities?' }]);
    // The snapshot waits for the poll's items to be saved.
    expect(store.snapshot).toBeUndefined();
    await r.commit!();
    expect(store.snapshot?.events).toHaveLength(6);
    expect(store.snapshot?.invites).toEqual([{ itemId: item.id, eventIds: [q4.id] }]);
  });

  it('keeps no body, Teams text or join link in the snapshot', async () => {
    box.calendar.push(invite());
    await poll();
    const saved = JSON.stringify(store.snapshot);
    expect(saved).toContain('Q4 roadmap review');
    expect(saved).not.toMatch(/priorities|Passcode|Meeting ID|teams\.microsoft/);
  });

  it('reads an open invite again each poll, and closes it once Frank answers in Outlook', async () => {
    const q4 = invite();
    const seen = invite({ subject: 'Ops sync', attendees: [{ ...FRANK, response: 'accepted' }] });
    box.calendar.push(q4, seen);
    const first = await poll();
    const again = await poll();
    expect(again.items).toEqual([]);
    expect(box.eventReads.at(-1)).toEqual([uri(q4)]); // the accepted one isn't read again

    box.answer(q4.id, 'accepted');
    const answered = await poll();
    expect(answered.resolved).toEqual([{ itemId: first.items[0].id, reason: 'You accepted it in Outlook.' }]);
    expect(answered.items).toEqual([]);
    const reads = box.eventReads.length;
    expect((await poll()).resolved).toEqual([]);
    expect(box.eventReads).toHaveLength(reads); // nothing open, nothing changed: nothing read
  });

  it('adds a message when an open invite moves, and opens it again when a reschedule clears Frank’s answer', async () => {
    const q4 = invite();
    box.calendar.push(q4);
    const first = await poll();
    move(q4, 50);
    const moved = await poll();
    expect(moved.items).toHaveLength(1);
    expect(moved.items[0].messages).toEqual([{ id: `moved:${q4.id}:${at(50)}`, authorId: DANA.address, ts: NOW.toISOString(), text: 'Moved to Sat 10 Oct, 15:00–16:00 (was Fri 9 Oct, 15:00–16:00).' }]);
    expect(moved.items[0].meeting?.start).toBe(at(50));
    expect((await poll()).items).toEqual([]); // moved once, said once

    box.answer(q4.id, 'declined');
    expect((await poll()).resolved).toEqual([{ itemId: first.items[0].id, reason: 'You declined it in Outlook.' }]);
    move(q4, 74);
    box.answer(q4.id, 'none');
    const reopened = await poll();
    expect(reopened.items.map((i) => i.id)).toEqual([first.items[0].id]);
    expect(reopened.items[0].messages.map((m) => m.id)).toEqual([`invite:${q4.id}:${at(74)}`]);
  });

  it('closes an invite that was cancelled, deleted or has started, saying why', async () => {
    const cancelled = invite({ subject: 'Cancelled later' });
    const deleted = invite({ subject: 'Deleted later' });
    const soon = invite({ subject: 'Starting soon', start: at(1), end: at(2) });
    box.calendar.push(cancelled, deleted, soon);
    const first = await poll();
    const id = (subject: string) => first.items.find((i) => i.title === subject)!.id;
    cancelled.isCancelled = true;
    box.calendar.splice(box.calendar.indexOf(deleted), 1);
    const r = await poll(new Date(NOW.getTime() + 2 * HOUR));
    expect(r.resolved).toEqual(
      expect.arrayContaining([
        { itemId: id('Cancelled later'), reason: 'The organiser cancelled it.' },
        { itemId: id('Deleted later'), reason: 'It is no longer on your calendar.' },
        { itemId: id('Starting soon'), reason: 'It has started.' },
      ]),
    );
    expect(r.resolved).toHaveLength(3);
    expect(r.items).toEqual([]);
  });

  it('follows an open invite moved beyond the window by reading it', async () => {
    const q4 = invite();
    box.calendar.push(q4);
    await poll();
    move(q4, 24 * 20);
    const r = await poll();
    expect(r.resolved).toEqual([]);
    expect(r.items[0].messages[0].id).toBe(`moved:${q4.id}:${at(24 * 20)}`);
    expect(store.snapshot?.invites[0].eventIds).toEqual([q4.id]);
  });

  it('asks once for a series: one item for the soonest occurrence, the others listed', async () => {
    const a = invite({ subject: 'Weekly sync' });
    const b = invite({ subject: 'Weekly sync', start: at(26 + 168), end: at(27 + 168) });
    box.calendar.push(b, a);
    const r = await poll();
    expect(r.items).toHaveLength(1);
    expect(r.items[0].meeting?.calendar?.eventId).toBe(a.id);
    expect(r.items[0].messages[0].text).toContain('When: Fri 9 Oct, 15:00–16:00\nAlso: Fri 16 Oct, 15:00–16:00\n');
    expect(store.snapshot?.invites).toEqual([{ itemId: r.items[0].id, eventIds: [a.id, b.id] }]);
  });

  it(`reads at most ${MAX_READS} a poll, new ones before open ones, so the rest come next poll`, async () => {
    const all = Array.from({ length: 20 }, (_, i) => invite({ subject: `Invite ${i}`, start: at(24 + i), end: at(25 + i) }));
    box.calendar.push(...all);
    expect((await poll()).items).toHaveLength(MAX_READS);
    const second = await poll();
    expect(second.items.map((i) => i.title)).toEqual(['Invite 15', 'Invite 16', 'Invite 17', 'Invite 18', 'Invite 19']);
    expect(box.eventReads[1].slice(0, 5)).toEqual(all.slice(15).map(uri));
    expect(box.eventReads[1]).toHaveLength(MAX_READS);
  });

  it('pages a busy window: the first page alone, the rest in one run', async () => {
    box.calendar.push(...Array.from({ length: 60 }, (_, i) => invite({ subject: `Own ${i}`, organizer: FRANK, attendees: [{ ...DANA }], start: at(2 + i), end: at(3 + i) })));
    await poll();
    expect(box.eventSearches.map((run) => run.map((c) => c.offset))).toEqual([[0], [25, 50]]);
    expect(store.snapshot?.events).toHaveLength(60);
    expect(box.eventReads).toEqual([]); // Frank's own meetings aren't read
  });

  it('makes no item for an invite that reached Frank only through a list, or that he organised', async () => {
    box.calendar.push(invite({ attendees: [{ name: 'All staff', address: 'all-staff@example.com' }] }), invite({ subject: 'Mine', organizer: FRANK }));
    expect((await poll()).items).toEqual([]);
  });

  it('says it is not connected without an account', async () => {
    const none = new CalendarAdapter({ api: box, store, account: () => undefined });
    await expect(none.fetchSince(undefined, { signal: new AbortController().signal, now: NOW, reason: 'scheduled' })).rejects.toBeInstanceOf(SourceError);
    expect(adapter().identity()).toEqual({ id: FRANK.address, name: FRANK.name });
  });

  it('keeps an open invite whose read failed as it was, and reads it next poll', async () => {
    const q4 = invite();
    box.calendar.push(q4);
    await poll();
    box.readFaults.set(uri(q4), 'Service unavailable');
    box.answer(q4.id, 'accepted');
    expect(await poll()).toMatchObject({ items: [], resolved: [] });
    box.readFaults.delete(uri(q4));
    expect((await poll()).resolved).toHaveLength(1);
  });
});

describe('the calendar through the poll (R2.8)', () => {
  let dir: string;
  let st: Store;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-calendar-'));
    await initDataDir(dir, { settings: defaultSettings(dir), rules: DEFAULT_RULES });
    ({ store: st } = await Store.open({ dataDir: dir, now: () => NOW }));
  });
  afterEach(async () => {
    await st.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('an invite becomes an open item, closes when Frank accepts, and is triaged again when a reschedule clears his answer', async () => {
    const box = new FakeMs365({ me: { displayName: FRANK.name, mail: FRANK.address, userPrincipalName: FRANK.address } });
    const cal = await CalendarStore.open(paths(dir).calendar);
    const source = new CalendarAdapter({ api: box, store: cal, account: () => ({ name: FRANK.name, address: FRANK.address }) });
    const d = { store: st, items: new ItemFiles(join(dir, 'items')), cursors: await CursorFile.open(paths(dir).cursors), now: () => NOW };
    const poll = () => pollSource(d, source, 'scheduled', new AbortController().signal);
    const q4 = invite();
    box.calendar.push(q4);

    await poll();
    const [id] = Object.keys(st.projection.items);
    expect(st.projection.items[id]).toMatchObject({ source: 'calendar', kind: 'event', status: 'open', revision: 1 });
    expect((await d.items.read('calendar', id))?.item.meeting?.start).toBe(at(26));
    // The snapshot is on disk once the poll is saved, and survives a restart.
    expect((await CalendarStore.open(paths(dir).calendar)).snapshot?.invites).toEqual([{ itemId: id, eventIds: [q4.id] }]);
    expect(await readFile(paths(dir).calendar, 'utf8')).not.toMatch(/Passcode|priorities/);

    box.answer(q4.id, 'accepted');
    expect(await poll()).toMatchObject({ resolved: 1 });
    expect(st.projection.items[id].status).toBe('done');

    // New content: triage looks again, and its decision brings the item back (as for any done item).
    move(q4, 50);
    box.answer(q4.id, 'none');
    await poll();
    expect(st.projection.items[id]).toMatchObject({ revision: 2, triageState: 'pending', newReplies: true });
  });
});

function move(e: EventDetail, hours: number) {
  Object.assign(e, { start: wall(at(hours)), end: wall(at(hours + 1)) });
}
