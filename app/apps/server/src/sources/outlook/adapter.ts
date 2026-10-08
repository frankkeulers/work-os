import type { DepState, Ms365Connector, Settings } from '@work-os/shared';
import type { Logger } from '../../log';
import { SourceError } from '../errors';
import type { Ms365Api, SearchArgs } from '../ms365/client';
import type { EmailDetail, EmailRow, Folder } from '../ms365/types';
import { fixedTs } from '../time';
import type { FetchContext, FetchResult, SourceAdapter } from '../types';
import { buildItems, isNoise, type MeInfo } from './normalise';

// The Outlook mail source (Phase 2, R2.5, P0-9 addendum). One poll:
//   1. searches Inbox and Sent Items for emails received since each folder's high-water mark (less
//      a 10-minute overlap for late indexing), oldest first, both folders in one relay run, page by
//      page up to MAX_PAGES each;
//   2. skips what it has already read (this process) and Outlook's receipts and auto-replies;
//   3. reads the rest whole, oldest first, up to MAX_READS per poll, ten per relay run;
//   4. groups them into one item per conversation;
//   5. moves each folder's mark to the last email of its unbroken run of handled ones (read, skipped
//      or gone), so an email whose read failed or didn't fit this poll is listed again next time.
// The cursor is "<Inbox mark>|<Sent Items mark>": both only move forward, so it sorts as text.
// Sent Items is context: triage sees Frank's replies as "me"; it doesn't move lanes on its own.

export const FOLDERS: Folder[] = ['Inbox', 'Sent Items'];
export const FIRST_POLL_MS = 2 * 86_400_000; // as Slack's first poll
export const OVERLAP_MS = 10 * 60_000;
export const MAX_PAGES = 4; // per folder per poll: 100 emails
export const MAX_READS = 60; // per poll: six relay runs
const RECENT_MAX = 2000;

type Marks = Record<Folder, string>;

export function parseCursor(cursor: string | undefined, now: Date): Marks {
  const first = fixedTs(new Date(now.getTime() - FIRST_POLL_MS).toISOString());
  const [inbox, sent] = (cursor ?? '').split('|');
  const ok = (t: string | undefined) => (t && !Number.isNaN(Date.parse(t)) ? fixedTs(t) : first);
  return { Inbox: ok(inbox), 'Sent Items': ok(sent) };
}

export const formatCursor = (m: Marks) => `${m.Inbox}|${m['Sent Items']}`;

/** Emails read lately, so the overlap and a re-listed folder don't read them again. Kept per process. */
export class RecentEmails {
  private keys = new Set<string>();
  has(key: string) {
    return this.keys.has(key);
  }
  add(key: string) {
    this.keys.delete(key);
    this.keys.add(key);
    if (this.keys.size > RECENT_MAX) this.keys.delete(this.keys.values().next().value!);
  }
}

const keyOf = (r: EmailRow) => r.internetMessageId?.trim() || r.id;
const markOf = (r: EmailRow) => fixedTs(new Date(Date.parse(r.receivedDateTime)).toISOString());

export interface OutlookOptions {
  api: Ms365Api;
  /** The account the connector reads (settings.connectors.ms365.account), set when it was connected. */
  account: () => Ms365Connector['account'];
  recent: RecentEmails;
  logger?: Logger;
}

export class OutlookAdapter implements SourceAdapter {
  readonly id = 'outlook' as const;
  readonly deps = ['network' as const, 'claude' as const, 'ms365' as const];
  readonly needsNetwork = true;

  constructor(private readonly o: OutlookOptions) {}

  identity() {
    const a = this.o.account();
    return a ? { id: a.address.toLowerCase(), name: a.name } : undefined;
  }

  private me(): MeInfo {
    const a = this.o.account();
    if (!a) throw new SourceError('ms365', { state: 'auth_failed', reason: 'token_missing' }, 'Outlook: not connected');
    const id = a.address.toLowerCase();
    return { id, name: a.name || a.address, aliases: [...new Set([id, (a.upn ?? '').toLowerCase()].filter(Boolean))] };
  }

  async probe(signal: AbortSignal): Promise<DepState> {
    try {
      return await this.o.api.status(signal);
    } catch (err) {
      if (err instanceof SourceError) return err.failure.state;
      throw err;
    }
  }

  async fetchSince(cursor: string | undefined, ctx: FetchContext): Promise<FetchResult> {
    const me = this.me();
    const marks = parseCursor(cursor, ctx.now);
    const rows = await this.list(marks, ctx.signal);

    // What each listed email is: already handled, or to be read now or on a later poll.
    type Entry = { folder: Folder; row: EmailRow; key: string; handled: boolean };
    const entries: Entry[] = [];
    const seen = new Set<string>();
    for (const folder of FOLDERS)
      for (const row of rows[folder]) {
        const key = keyOf(row);
        const handled = this.o.recent.has(key) || seen.has(key) || isNoise(row.subject);
        if (isNoise(row.subject)) this.o.recent.add(key);
        seen.add(key);
        entries.push({ folder, row, key, handled });
      }
    const toRead = entries
      .filter((e) => !e.handled)
      .sort((a, b) => markOf(a.row).localeCompare(markOf(b.row)))
      .slice(0, MAX_READS);

    const emails: { email: EmailDetail; folder: Folder }[] = [];
    const outcomes = toRead.length ? await this.o.api.read(toRead.map((e) => e.row.uri), ctx.signal) : [];
    toRead.forEach((e, i) => {
      const r = outcomes[i];
      if (r?.ok) emails.push({ email: r.email, folder: e.folder });
      else if (r && r.gone) this.o.logger?.info({ folder: e.folder }, 'Outlook: an email was gone by the time it was read');
      else return; // not read: listed again next poll
      e.handled = true;
      this.o.recent.add(e.key);
    });
    if (toRead.some((e) => !e.handled)) this.o.logger?.warn({ unread: toRead.filter((e) => !e.handled).length }, 'Outlook: some emails were not read; the next poll tries again');

    const next = { ...marks };
    for (const folder of FOLDERS) {
      for (const e of entries.filter((x) => x.folder === folder).sort((a, b) => markOf(a.row).localeCompare(markOf(b.row)))) {
        if (!e.handled) break;
        if (markOf(e.row) > next[folder]) next[folder] = markOf(e.row);
      }
    }
    return { items: buildItems(emails, me), nextCursor: formatCursor(next) };
  }

  /** Each folder's emails since its mark, oldest first; both folders' pages share a relay run. */
  private async list(marks: Marks, signal: AbortSignal): Promise<Record<Folder, EmailRow[]>> {
    const out: Record<Folder, EmailRow[]> = { Inbox: [], 'Sent Items': [] };
    let pending: SearchArgs[] = FOLDERS.map((folder) => ({ folder, after: new Date(Date.parse(marks[folder]) - OVERLAP_MS).toISOString(), offset: 0 }));
    for (let page = 0; page < MAX_PAGES && pending.length; page++) {
      const pages = await this.o.api.search(pending, signal);
      const more: SearchArgs[] = [];
      pages.forEach((p, i) => {
        const call = pending[i];
        if (!p) throw new SourceError('ms365', { state: 'degraded', reason: 'relay: the tool was not called' }, `Outlook: the ${call.folder} search was not made`);
        out[call.folder].push(...p.emails);
        if (p.nextOffset !== undefined && p.emails.length) more.push({ ...call, offset: p.nextOffset });
      });
      pending = more;
    }
    if (pending.length) this.o.logger?.info({ folders: pending.map((p) => p.folder) }, 'Outlook: more emails than one poll lists; the rest come next poll');
    return out;
  }
}

/** Builds the adapter from settings; what it has read lately lives as long as the factory. */
export function outlookFactory(api: Ms365Api, logger?: Logger) {
  const recent = new RecentEmails();
  return (settings: Settings) => new OutlookAdapter({ api, account: () => settings.connectors?.ms365?.account, recent, logger });
}
