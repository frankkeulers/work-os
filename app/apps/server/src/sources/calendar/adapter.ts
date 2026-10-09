import { londonAt, type DepState, type Item, type Message, type Ms365Connector, type Settings } from '@work-os/shared';
import type { Logger } from '../../log';
import { SourceError } from '../errors';
import type { EventSearchArgs, Ms365Api } from '../ms365/client';
import { PAGE_SIZE } from '../ms365/client';
import type { EventDetail, EventRow } from '../ms365/types';
import { meOf, type MeInfo } from '../outlook/normalise';
import { fixedTs } from '../time';
import type { FetchContext, FetchResult, SourceAdapter } from '../types';
import { inviteBody, inviteItem, inviteItemId, inviteMessage, isCandidate, movedMessage, rowHash, snapFromDetail, snapFromRow, wantsAnswer } from './normalise';
import type { CalendarSnapshot, CalendarStore, InviteGroup, SnapEvent } from './store';

// The Outlook calendar source (Phase 2, R2.8, P0-12). Calendar search filters on start time and has
// no modified cursor, so a poll looks at the whole window, from yesterday to two weeks ahead, and
// compares it with the last poll's snapshot:
//   1. searches the window, oldest first, the first page alone and the rest in one relay run;
//   2. reads, at most MAX_READS, soonest first: someone else's new or changed meetings, then every
//      event in an open invite (search has no answer, so only a read shows Frank has answered). New
//      ones go first so a crowd of open invites can't keep a new one from being seen;
//   3. opens an invite item for each organiser and subject Frank hasn't answered, and adds a
//      message when one of its events moves;
//   4. closes an invite item once nothing in it wants an answer: answered, cancelled, deleted or
//      started;
//   5. publishes the new snapshot once the poll's items are saved (commit).
// The cursor is only when the poll ran: the snapshot is the state.

export const MAX_PAGES = 8; // 200 events in the window
export const MAX_READS = 15; // per poll: two relay runs

/** Why an invite item closed, by what happened to the last of its events. */
const REASONS = {
  accepted: 'You accepted it in Outlook.',
  tentativelyAccepted: 'You answered “tentative” in Outlook.',
  declined: 'You declined it in Outlook.',
  cancelled: 'The organiser cancelled it.',
  gone: 'It is no longer on your calendar.',
  started: 'It has started.',
  answered: 'You answered it in Outlook.',
} as const;

export interface CalendarOptions {
  api: Ms365Api;
  store: CalendarStore;
  account: () => Ms365Connector['account'];
  logger?: Logger;
}

export class CalendarAdapter implements SourceAdapter {
  readonly id = 'calendar' as const;
  readonly deps = ['network' as const, 'claude' as const, 'ms365' as const];
  readonly needsNetwork = true;

  constructor(private readonly o: CalendarOptions) {}

  identity() {
    const a = this.o.account();
    return a ? { id: a.address.toLowerCase(), name: a.name } : undefined;
  }

  private me(): MeInfo {
    const me = meOf(this.o.account());
    if (!me) throw new SourceError('ms365', { state: 'auth_failed', reason: 'token_missing' }, 'Outlook Calendar: not connected');
    return me;
  }

  async probe(signal: AbortSignal): Promise<DepState> {
    try {
      return await this.o.api.status(signal);
    } catch (err) {
      if (err instanceof SourceError) return err.failure.state;
      throw err;
    }
  }

  async fetchSince(_cursor: string | undefined, ctx: FetchContext): Promise<FetchResult> {
    const me = this.me();
    const now = ctx.now;
    const prev = this.o.store.snapshot;
    const prevById = new Map(prev?.events.map((e) => [e.id, e]) ?? []);
    const from = londonAt(now, '00:00', -1);
    const to = londonAt(now, '00:00', 15);
    const rows = await this.search(from, to, ctx.signal);

    // The window as search shows it, carrying over what earlier reads learnt while nothing changed.
    const listed = new Map<string, SnapEvent>();
    const changed = new Set<string>();
    const hashes = new Map<string, string>();
    for (const row of rows) {
      const fresh = snapFromRow(row, me);
      if (!fresh) continue;
      const hash = rowHash(row);
      hashes.set(row.id, hash);
      const was = prevById.get(row.id);
      if (was?.hash === hash) {
        // Categories come with search, so a change to them needs no read.
        const { categories: _was, ...kept } = was;
        listed.set(row.id, { ...kept, uri: row.uri, showAs: fresh.showAs, isOrganizer: fresh.isOrganizer, ...(fresh.categories && { categories: fresh.categories }) });
      } else {
        listed.set(row.id, { ...fresh, ...(was?.response !== undefined && { response: was.response }) });
        changed.add(row.id);
      }
    }

    // What to read: new or changed meetings first, then open invites (has Frank answered?).
    const openIds = new Set(prev?.invites.flatMap((g) => g.eventIds) ?? []);
    const open = [...openIds].map((id) => listed.get(id) ?? prevById.get(id)).filter((e): e is SnapEvent => !!e);
    const fresh = [...changed].map((id) => listed.get(id)!).filter((e) => !openIds.has(e.id) && isCandidate(e, now));
    const bySoonest = (a: SnapEvent, b: SnapEvent) => a.start.localeCompare(b.start);
    const toRead = [...fresh.sort(bySoonest), ...open.sort(bySoonest)].slice(0, MAX_READS);
    const outcomes = toRead.length ? await this.o.api.readEvents(toRead.map((e) => e.uri), ctx.signal) : [];

    const details = new Map<string, EventDetail>();
    const gone = new Set<string>();
    toRead.forEach((e, i) => {
      const r = outcomes[i];
      if (r?.ok) details.set(e.id, r.event);
      else if (r?.gone) gone.add(e.id);
    });
    const unread = toRead.filter((e) => !details.has(e.id) && !gone.has(e.id)).length + open.length + fresh.length - toRead.length;
    if (unread > 0) this.o.logger?.info({ unread }, 'Outlook Calendar: some events were not read; the next poll tries again');

    // The new picture: the window, plus open invites that moved out of it (still tracked by read).
    const events = new Map<string, SnapEvent>();
    for (const [id, e] of listed) {
      const d = details.get(id);
      const read = d && snapFromDetail(d, e, me);
      if (read) events.set(id, { ...read, hash: hashes.get(id) });
      else if (changed.has(id)) events.set(id, { ...e, hash: isCandidate(e, now) ? undefined : hashes.get(id) }); // unset: read next poll
      else events.set(id, e);
    }
    for (const e of open) {
      if (events.has(e.id) || gone.has(e.id)) continue;
      // Out of the window (moved weeks ahead) yet still unanswered: followed by reading it. One whose
      // read failed stays as it was until a read says otherwise.
      const d = details.get(e.id);
      events.set(e.id, d ? { ...(snapFromDetail(d, e, me) ?? e), hash: undefined } : e);
    }

    // Invite items: what wants an answer now, by organiser and subject.
    const wanting = [...events.values()].filter((e) => wantsAnswer(e, now));
    const groups = new Map<string, SnapEvent[]>();
    for (const e of wanting.sort(bySoonest)) groups.set(inviteItemId(e), [...(groups.get(inviteItemId(e)) ?? []), e]);
    const prevGroups = new Map((prev?.invites ?? []).map((g) => [g.itemId, g]));

    const items: Item[] = [];
    for (const [itemId, list] of groups) {
      const before = prevGroups.get(itemId);
      const messages: Message[] = [];
      if (!before) {
        const first = list[0];
        const body = details.get(first.id) ? inviteBody(details.get(first.id)!.body) : '';
        messages.push(inviteMessage(first, body, list.slice(1), me, now));
      } else {
        for (const e of list) {
          const was = prevById.get(e.id);
          if (before.eventIds.includes(e.id) && was && was.start !== e.start) messages.push(movedMessage(e, was, me, now));
        }
      }
      if (messages.length) items.push(inviteItem(itemId, list, messages, me));
    }

    // Open invite items with nothing left to answer close, saying why.
    const resolved: { itemId: string; reason: string }[] = [];
    for (const g of prev?.invites ?? []) {
      if (groups.has(g.itemId)) continue;
      const fates = g.eventIds.map((id) => fateOf(events.get(id), gone.has(id), now));
      resolved.push({ itemId: g.itemId, reason: REASONS[pickFate(fates)] });
    }

    const invites: InviteGroup[] = [...groups].map(([itemId, list]) => ({ itemId, eventIds: list.map((e) => e.id) }));
    const next: CalendarSnapshot = { schemaVersion: 1, polledAt: now.toISOString(), from, to, events: [...events.values()].sort(bySoonest), invites };
    return { items, resolved, nextCursor: fixedTs(now.toISOString()), commit: () => this.o.store.publish(next) };
  }

  /** The window's events, oldest first: the first page, then every other page in one relay run. */
  private async search(from: string, to: string, signal: AbortSignal): Promise<EventRow[]> {
    const call = (offset: number): EventSearchArgs => ({ after: from, before: to, offset });
    const first = (await this.o.api.events([call(0)], signal))[0];
    if (!first) throw new SourceError('ms365', { state: 'degraded', reason: 'relay: the tool was not called' }, 'Outlook Calendar: the search was not made');
    const rows = [...first.events];
    if (first.nextOffset === undefined || !first.events.length) return rows;
    const total = first.total ?? (MAX_PAGES * PAGE_SIZE);
    const offsets: number[] = [];
    for (let o = first.nextOffset; o < total && offsets.length < MAX_PAGES - 1; o += PAGE_SIZE) offsets.push(o);
    const pages = await this.o.api.events(offsets.map(call), signal);
    pages.forEach((p) => {
      if (!p) throw new SourceError('ms365', { state: 'degraded', reason: 'relay: the tool was not called' }, 'Outlook Calendar: a search page was not made');
      rows.push(...p.events);
    });
    if (total > (offsets.length + 1) * PAGE_SIZE) this.o.logger?.info({ total }, 'Outlook Calendar: more events in the window than one poll lists');
    const seen = new Set<string>();
    return rows.filter((r) => !seen.has(r.id) && seen.add(r.id));
  }
}

type Fate = keyof typeof REASONS;

function fateOf(e: SnapEvent | undefined, gone: boolean, now: Date): Fate {
  if (gone || !e) return 'gone';
  if (e.cancelled) return 'cancelled';
  if (e.response === 'accepted' || e.response === 'tentativelyAccepted' || e.response === 'declined') return e.response;
  if (Date.parse(e.start) <= now.getTime()) return 'started';
  return 'answered';
}

/** One reason for a group: Frank's own answer first, then what the organiser did, then time. */
function pickFate(fates: Fate[]): Fate {
  const answers = [...new Set(fates.filter((f) => f === 'accepted' || f === 'tentativelyAccepted' || f === 'declined'))];
  if (answers.length === 1) return answers[0];
  if (answers.length > 1) return 'answered';
  for (const f of ['cancelled', 'gone', 'started'] as const) if (fates.includes(f)) return f;
  return 'answered';
}

/** Builds the adapter from settings; the snapshot lives as long as the factory. */
export function calendarFactory(api: Ms365Api, store: CalendarStore, logger?: Logger) {
  return (settings: Settings) => new CalendarAdapter({ api, store, account: () => settings.connectors?.ms365?.account, logger });
}
