import type { DepState, Ms365Connector, Settings } from '@work-os/shared';
import type { Logger } from '../../log';
import { isMeetingMail } from '../calendar/mail';
import type { CalendarSnapshot } from '../calendar/store';
import { SourceError } from '../errors';
import type { Ms365Api, ReadOutcome, SearchArgs } from '../ms365/client';
import type { EmailDetail, EmailRow, Folder } from '../ms365/types';
import { fixedTs } from '../time';
import type { FetchContext, FetchResult, SourceAdapter } from '../types';
import { buildItems, isNoise, meOf, type MeInfo } from './normalise';

// The Outlook mail source (Phase 2, R2.5, P0-9 addendum). One poll:
//   1. searches Inbox and Sent Items for emails received since each folder's high-water mark (less
//      a 10-minute overlap for late indexing), oldest first, both folders in one relay run, page by
//      page up to MAX_PAGES each;
//   2. skips what it has already read and saved (this process) and Outlook's receipts and
//      auto-replies;
//   3. reads the rest whole, oldest first, up to MAX_READS per poll, ten per relay run;
//   4. groups them into one item per conversation;
//   5. moves each folder's mark to the last email of its unbroken run of handled ones (read, skipped
//      or gone), so an email whose read failed or didn't fit this poll is listed again next time.
//      An email whose read fails MAX_READ_FAILURES times goes to the inbox as unreadable (its
//      subject and sender, with a note), so one bad email can't hold its folder back for good.
// The cursor is "<Inbox mark>|<Sent Items mark>": both only move forward, so it sorts as text.
// Sent Items is context: triage sees Frank's replies as "me"; it doesn't move lanes on its own.

export const FOLDERS: Folder[] = ['Inbox', 'Sent Items'];
export const FIRST_POLL_MS = 2 * 86_400_000; // as Slack's first poll
export const OVERLAP_MS = 10 * 60_000;
export const MAX_PAGES = 4; // per folder per poll: 100 emails
export const MAX_READS = 60; // per poll: six relay runs
const RECENT_MAX = 2000;
export const MAX_READ_FAILURES = 3;
export const UNREADABLE = 'Work OS couldn’t read this email after three tries, so only its subject and sender are here. Open it in Outlook.';

type Marks = Record<Folder, string>;

export function parseCursor(cursor: string | undefined, now: Date): Marks {
  const first = fixedTs(new Date(now.getTime() - FIRST_POLL_MS).toISOString());
  const [inbox, sent] = (cursor ?? '').split('|');
  const ok = (t: string | undefined) => (t && !Number.isNaN(Date.parse(t)) ? fixedTs(t) : first);
  return { Inbox: ok(inbox), 'Sent Items': ok(sent) };
}

export const formatCursor = (m: Marks) => `${m.Inbox}|${m['Sent Items']}`;

/** Emails read and saved lately, so the overlap and a re-listed folder don't read them again. Kept per process. */
export class RecentEmails {
  private keys = new Set<string>();
  private failures = new Map<string, number>();
  has(key: string) {
    return this.keys.has(key);
  }
  add(key: string) {
    this.keys.delete(key);
    this.keys.add(key);
    this.failures.delete(key);
    if (this.keys.size > RECENT_MAX) this.keys.delete(this.keys.values().next().value!);
  }
  /** Counts a failed read of this email; returns how many there have been. */
  failed(key: string) {
    const n = (this.failures.get(key) ?? 0) + 1;
    this.failures.set(key, n);
    if (this.failures.size > RECENT_MAX) this.failures.delete(this.failures.keys().next().value!);
    return n;
  }
}

/** What search knows of an email, as an email read whole: for one that can't be read (UNREADABLE). */
function unreadable(row: EmailRow): EmailDetail {
  const sender = row.sender?.trim() ?? '';
  const address = /<([^>]+)>/.exec(sender)?.[1] ?? (sender.includes('@') ? sender : undefined);
  const name = sender.replace(/<[^>]*>/, '').trim() || address;
  return {
    id: row.id,
    subject: row.subject,
    body: { contentType: 'text', content: UNREADABLE },
    from: { name, address },
    receivedDateTime: row.receivedDateTime,
    conversationId: `unreadable-${row.id}`,
    internetMessageId: row.internetMessageId,
  };
}

const keyOf = (r: EmailRow) => r.internetMessageId?.trim() || r.id;
const markOf = (r: EmailRow) => fixedTs(new Date(Date.parse(r.receivedDateTime)).toISOString());

export interface OutlookOptions {
  api: Ms365Api;
  /** The account the connector reads (settings.connectors.ms365.account), set when it was connected. */
  account: () => Ms365Connector['account'];
  recent: RecentEmails;
  /** The calendar as last read, while it is on: its meetings' own mail is left to it (R2.8). */
  calendar?: () => CalendarSnapshot | undefined;
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
    const me = meOf(this.o.account());
    if (!me) throw new SourceError('ms365', { state: 'auth_failed', reason: 'token_missing' }, 'Outlook: not connected');
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
    const read: string[] = []; // remembered only once saved (commit): a poll cut off reads them again
    let outcomes: ReadOutcome[] = [];
    let odd: SourceError | undefined;
    try {
      outcomes = toRead.length ? await this.o.api.read(toRead.map((e) => e.row.uri), ctx.signal) : [];
    } catch (err) {
      // A lone email answered in an unexpected shape fails the whole read: count it like any
      // failed read, so it can't stall the folder; until it is let through, health still hears.
      if (!(err instanceof SourceError && err.failure.reason === 'tools_changed' && toRead.length === 1)) throw err;
      odd = err;
      outcomes = [{ ok: false, error: err.message, gone: false }];
    }
    toRead.forEach((e, i) => {
      const r = outcomes[i];
      if (r?.ok) emails.push({ email: r.email, folder: e.folder });
      else if (r && r.gone) this.o.logger?.info({ folder: e.folder }, 'Outlook: an email was gone by the time it was read');
      else if (r && this.o.recent.failed(e.key) >= MAX_READ_FAILURES) {
        this.o.logger?.warn({ folder: e.folder, error: r.error }, 'Outlook: an email failed to read three times; it goes to the inbox as unreadable');
        emails.push({ email: unreadable(e.row), folder: e.folder });
      } else return; // not read (failed, or not made): listed again next poll
      e.handled = true;
      read.push(e.key);
    });
    if (odd && !toRead[0].handled) throw odd;
    if (toRead.some((e) => !e.handled)) this.o.logger?.warn({ unread: toRead.filter((e) => !e.handled).length }, 'Outlook: some emails were not read; the next poll tries again');

    const next = { ...marks };
    for (const folder of FOLDERS) {
      for (const e of entries.filter((x) => x.folder === folder).sort((a, b) => markOf(a.row).localeCompare(markOf(b.row)))) {
        if (!e.handled) break;
        if (markOf(e.row) > next[folder]) next[folder] = markOf(e.row);
      }
    }
    const snap = this.o.calendar?.();
    const mail = snap ? emails.filter((x) => !isMeetingMail(x.email, snap)) : emails;
    if (mail.length < emails.length) this.o.logger?.info({ meetingMail: emails.length - mail.length }, 'Outlook: meeting mail left to the calendar');
    return { items: buildItems(mail, me), nextCursor: formatCursor(next), commit: async () => read.forEach((k) => this.o.recent.add(k)) };
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
export function outlookFactory(api: Ms365Api, logger?: Logger, recent = new RecentEmails(), calendar?: () => CalendarSnapshot | undefined) {
  return (settings: Settings) => new OutlookAdapter({ api, account: () => settings.connectors?.ms365?.account, recent, calendar, logger });
}
