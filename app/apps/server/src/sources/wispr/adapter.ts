import type { DepState, Item } from '@work-os/shared';
import type { Logger } from '../../log';
import { SourceError } from '../errors';
import { mapLimit } from '../limit';
import type { FetchContext, FetchResult, SourceAdapter } from '../types';
import type { Call, WisprMcp } from './mcp';
import { buildItem, cursorKey, fixedTs, ME_ID, meetingIdOf, participantsOf, ready } from './normalise';
import { WisprAccount, WisprMeeting, WisprParticipants, WisprSearchPage, type WisprMeetingRow } from './types';

// The Wispr Flow source (R2.7, P0-11). One poll:
//   1. lists meetings with no query, which Wispr returns newest-modified first, page by page, until
//      one is at or before the cursor (modified_at|id);
//   2. reads each finalised one with its participants, three at a time;
//   3. moves the cursor to the newest meeting seen, finalised or not: a meeting finalised later gets
//      a newer modified_at, so it comes round again.

export const PAGE_SIZE = 50;
export const MAX_PAGES = 10;
export const FIRST_POLL_MS = 7 * 86_400_000;
export const CONCURRENCY = 3;

export class WisprAdapter implements SourceAdapter {
  readonly id = 'wispr' as const;
  readonly deps = ['network' as const, 'wisprMcp' as const];
  readonly needsNetwork = true;

  constructor(private readonly o: { mcp: WisprMcp; logger?: Logger }) {}

  identity() {
    return { id: ME_ID, ...(this.o.mcp.account && { name: this.o.mcp.account }) };
  }

  async probe(signal: AbortSignal): Promise<DepState> {
    try {
      await this.o.mcp.session(signal, (call) => this.whoAmI(call));
      return 'ok';
    } catch (err) {
      if (err instanceof SourceError) return err.failure.state;
      throw err;
    }
  }

  private async whoAmI(call: Call) {
    this.o.mcp.account ??= (await call('get_account_info', {}, WisprAccount)).name;
    return this.o.mcp.account;
  }

  async fetchSince(cursor: string | undefined, ctx: FetchContext): Promise<FetchResult> {
    const floor = cursor ?? `${fixedTs(new Date(ctx.now.getTime() - FIRST_POLL_MS).toISOString())}|`;
    return this.o.mcp.session(ctx.signal, async (call) => {
      const me = await this.whoAmI(call);
      const rows = await this.listSince(call, floor);
      const ids = new Set(rows.filter((r) => r.finalized).map((r) => r.id));
      for (const id of ctx.refetch ?? []) {
        const mid = meetingIdOf(id);
        if (mid) ids.add(mid);
      }
      const items = await mapLimit([...ids], CONCURRENCY, (id) => this.read(call, id, me));
      const newest = rows.map(cursorKey).sort().at(-1);
      return { items: items.filter((i): i is Item => !!i), nextCursor: newest && newest > floor ? newest : floor };
    });
  }

  /** Meetings modified after `floor`, newest first. */
  private async listSince(call: Call, floor: string): Promise<WisprMeetingRow[]> {
    const out: WisprMeetingRow[] = [];
    let next: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await call('search_meetings', { limit: PAGE_SIZE, ...(next && { cursor: next }) }, WisprSearchPage);
      for (const m of r.meetings) {
        if (cursorKey(m) <= floor) return out;
        if (!out.some((x) => x.id === m.id)) out.push(m);
      }
      next = r.has_more ? (r.next_cursor ?? undefined) : undefined;
      if (!next) return out;
    }
    this.o.logger?.warn({ pages: MAX_PAGES }, 'Wispr Flow listing hit its page limit: older meetings in this window were skipped');
    return out;
  }

  private async read(call: Call, id: string, me: string): Promise<Item | undefined> {
    const m = await call('get_meeting', { meeting_id: id }, WisprMeeting);
    if (!ready(m)) return undefined;
    const p = await call('get_meeting_participants_enriched', { meeting_id: id }, WisprParticipants);
    return buildItem(m, participantsOf(p, me));
  }
}

export const wisprFactory = (mcp: WisprMcp, logger?: Logger) => () => new WisprAdapter({ mcp, logger });
