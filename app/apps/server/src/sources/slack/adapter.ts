import type { DepState, Item, Settings } from '@work-os/shared';
import type { Logger } from '../../log';
import { SourceError } from '../errors';
import { mapLimit } from '../limit';
import type { FetchContext, FetchResult, SourceAdapter } from '../types';
import type { SlackApi } from './api';
import { SlackDirectory } from './directory';
import { authorOf, buildItem, channelListed, mentionedIds, cmpTs, dmWindows, isDirect, isoToTs, keepMessage, maxTs, messageText, permalinkFor, threadTsOf, tsToIso } from './normalise';
import type { Conversation, HistoryResponse, SearchMatch, SearchResponse, SlackMessage } from './types';

// The Slack source (FR-2.3–2.10). One poll:
//   1. finds messages newer than the cursor: search.messages (primary) or conversations.history;
//   2. drops bots, excluded channels, and channels Frank isn't in (unless listed in includeChannels);
//   3. fetches each thread with a new reply whole with conversations.replies, three at a time;
//   4. groups DMs outside threads into windows split by 30 minutes of quiet.
// The cursor is the newest message ts seen. Search lags behind posting, so each poll looks back
// 15 minutes before the cursor; the poll pipeline dedupes on ts (FR-2.8).

export const SEARCH_OVERLAP_MS = 15 * 60_000;
export const FIRST_POLL_MS = 2 * 86_400_000;
export const DM_LOOKBACK_MS = 12 * 3600_000;
export const MAX_SEARCH_PAGES = 10;
export const MAX_HISTORY_PAGES = 5;
export const MAX_REPLY_PAGES = 5;
/** History mode: how far back to look for thread parents that may have new replies. */
export const THREAD_LOOKBACK_MS = 3 * 86_400_000;
export const CONCURRENCY = 3;

interface Found {
  channel: Conversation;
  msg: SlackMessage;
}

export interface SlackAdapterOptions {
  api: SlackApi;
  settings: Settings;
  logger?: Logger;
  directory?: SlackDirectory;
}

export class SlackAdapter implements SourceAdapter {
  readonly id = 'slack' as const;
  readonly deps = ['network' as const, 'slack' as const];
  readonly needsNetwork = true;
  readonly directory: SlackDirectory;

  constructor(private readonly o: SlackAdapterOptions) {
    this.directory = o.directory ?? new SlackDirectory(o.api);
  }

  /** Frank's Slack user ID, once the first poll has asked Slack. */
  identity() {
    const me = this.directory.identityKnown;
    return me && { id: me.user_id, name: me.user };
  }

  /** Which messages to keep in a conversation: people's, and apps' where settings allow (FR-2.10). */
  private keep(c: Conversation) {
    const apps = channelListed(this.o.settings.slack.appChannels ?? [], c);
    return (m: SlackMessage) => keepMessage(m, { apps, isBot: this.directory.isBot });
  }

  async probe(signal: AbortSignal): Promise<DepState> {
    try {
      await this.o.api.call('auth.test', {}, signal);
      return 'ok';
    } catch (err) {
      if (err instanceof SourceError) return err.failure.state;
      throw err;
    }
  }

  async fetchSince(cursor: string | undefined, ctx: FetchContext): Promise<FetchResult> {
    const { signal } = ctx;
    const s = this.o.settings.slack;
    const me = await this.directory.identity(signal);
    const members = await this.directory.conversations(signal);
    const sinceMs = cursor ? Date.parse(tsToIso(cursor)) - SEARCH_OVERLAP_MS : ctx.now.getTime() - FIRST_POLL_MS;
    const since = isoToTs(sinceMs);

    const allowed = (c: Conversation) => {
      if (channelListed(s.excludeChannels, c)) return false;
      if (isDirect(c)) return true;
      return s.includeChannels.length ? channelListed(s.includeChannels, c) : members.has(c.id);
    };

    const fetched = s.fetchMode === 'history' ? await this.historySince(since, sinceMs, members, allowed, signal) : await this.searchSince(since, sinceMs, signal);
    let nextCursor = cursor;
    for (const f of fetched) {
      nextCursor = maxTs(nextCursor, f.msg.ts);
      if (f.msg.latest_reply) nextCursor = maxTs(nextCursor, f.msg.latest_reply);
    }
    const isNew = (m: SlackMessage) => cmpTs(m.ts, since) > 0 || (!!m.latest_reply && cmpTs(m.latest_reply, since) > 0);
    // Search drops bot_id: an app's post is known by its user being a bot, so look the authors up first.
    await this.directory.resolveUsers(fetched.flatMap((f) => (f.msg.user && allowed(f.channel) ? [f.msg.user] : [])), signal);
    const found = fetched.filter((f) => allowed(f.channel) && isNew(f.msg) && this.keep(f.channel)(f.msg));

    // Group: threads by thread_ts, DM messages outside a thread into windows. A thread is fetched
    // whole only when a reply points at it: a new reply always shows up in the search itself, so a
    // top-level message with no reply among the matches is complete as it is.
    const threads = new Map<string, { channel: Conversation; key: string; msgs: SlackMessage[]; fetch: boolean }>();
    const loose = new Map<string, Found[]>(); // DM channel → messages outside threads
    for (const f of found) {
      const parent = threadTsOf(f.msg);
      const key = parent ?? f.msg.ts;
      const hasReplies = (parent !== undefined && parent !== f.msg.ts) || !!f.msg.reply_count;
      if (!hasReplies && isDirect(f.channel) && !parent) {
        loose.set(f.channel.id, [...(loose.get(f.channel.id) ?? []), f]);
        continue;
      }
      const id = `${f.channel.id}:${key}`;
      const t = threads.get(id) ?? { channel: f.channel, key, msgs: [], fetch: false };
      t.msgs.push(f.msg);
      t.fetch ||= hasReplies;
      threads.set(id, t);
    }
    // A DM message that turns out to be a thread's parent belongs to the thread, not a window.
    for (const [cid, fs] of loose) loose.set(cid, fs.filter((f) => !threads.has(`${cid}:${f.msg.ts}`)));

    const threadItems = await mapLimit([...threads.values()], CONCURRENCY, (t) =>
      t.fetch ? this.thread(t.channel, t.key, me.url, signal) : Promise.resolve<ItemDraft>({ channel: t.channel, key: t.key, messages: t.msgs, permalink: permalinkFor(me.url, t.channel.id, t.key) }),
    );
    const dmItems = await mapLimit(
      [...loose.values()].filter((fs) => fs.length),
      CONCURRENCY,
      (fs) => this.dmWindows(fs, me.url, signal),
    );
    const drafts = [...threadItems, ...dmItems.flat()].filter((d): d is ItemDraft => !!d);
    const have = new Set(drafts.map((d) => `${d.channel.id}:${d.key}`));
    for (const id of ctx.refetch ?? []) {
      const [, cid, key] = id.split(':');
      const channel = members.get(cid) ?? this.directory.conversation(cid);
      if (!channel || !key || !allowed(channel) || have.has(`${cid}:${key}`)) continue;
      const again = await this.again(channel, key, me.url, signal);
      if (again) drafts.push(again);
    }

    await this.directory.resolveUsers(
      drafts.flatMap((d) => [...d.messages.flatMap((m) => (m.user ? [m.user] : [])), ...(d.channel.user ? [d.channel.user] : []), ...mentionedIds(d.messages.map(messageText))]),
      signal,
    );
    await mapLimit(
      [...new Map(drafts.filter((d) => d.channel.is_mpim).map((d) => [d.channel.id, d.channel])).values()],
      CONCURRENCY,
      (c) => this.directory.dmMembers(c, signal),
    );
    const items: Item[] = drafts.map((d) =>
      buildItem({
        ...d,
        title: this.directory.title(d.channel, d.messages.map(authorOf)),
        names: this.directory.name,
        keep: this.keep(d.channel),
      }),
    );
    return { items, nextCursor: nextCursor ?? isoToTs(sinceMs) };
  }

  /** search.messages, newest first, until a page reaches back past `since`. */
  private async searchSince(since: string, sinceMs: number, signal: AbortSignal): Promise<Found[]> {
    // `after:` is a date in Frank's own time zone and excludes that day: two days back covers any zone.
    const after = new Date(sinceMs - 2 * 86_400_000).toISOString().slice(0, 10);
    const out: Found[] = [];
    for (let page = 1; page <= MAX_SEARCH_PAGES; page++) {
      const r = await this.o.api.call<SearchResponse>('search.messages', { query: `after:${after}`, sort: 'timestamp', sort_dir: 'desc', count: 100, page }, signal);
      const matches: SearchMatch[] = r.messages.matches ?? [];
      for (const m of matches) {
        const known = this.directory.conversation(m.channel.id);
        out.push({ channel: known ?? { id: m.channel.id, name: m.channel.name, is_im: m.channel.is_im, is_mpim: m.channel.is_mpim, is_private: m.channel.is_private }, msg: m });
      }
      const pages = r.messages.paging?.pages ?? r.messages.pagination?.page_count ?? 1;
      const oldest = matches.at(-1)?.ts;
      if (!oldest || cmpTs(oldest, since) <= 0 || page >= pages) return out;
    }
    this.o.logger?.warn({ pages: MAX_SEARCH_PAGES }, 'Slack search hit its page limit: older messages in this window were skipped');
    return out;
  }

  /** conversations.history for each allowed conversation: the fallback mode (FR-2.4). */
  private async historySince(since: string, sinceMs: number, members: Map<string, Conversation>, allowed: (c: Conversation) => boolean, signal: AbortSignal): Promise<Found[]> {
    const convs = [...members.values()].filter(allowed);
    // A thread with a reply since the cursor shows up only as its parent, with a newer latest_reply,
    // so read back a few days of parents too.
    const oldest = isoToTs(sinceMs - THREAD_LOOKBACK_MS);
    const per = await mapLimit(convs, CONCURRENCY, async (c) => {
      const msgs = await this.paged<HistoryResponse>('conversations.history', { channel: c.id, oldest, limit: 200 }, MAX_HISTORY_PAGES, signal);
      return msgs.filter((m) => cmpTs(m.ts, since) > 0 || (m.latest_reply && cmpTs(m.latest_reply, since) > 0)).map((msg) => ({ channel: c, msg }));
    });
    return per.flat();
  }

  private async paged<R extends HistoryResponse>(method: string, params: Record<string, string | number>, maxPages: number, signal: AbortSignal): Promise<SlackMessage[]> {
    const out: SlackMessage[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const r = await this.o.api.call<R>(method, { ...params, cursor }, signal);
      out.push(...r.messages);
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** A whole thread, from conversations.replies. */
  private async thread(channel: Conversation, threadTs: string, teamUrl: string, signal: AbortSignal): Promise<ItemDraft | undefined> {
    const msgs = await this.paged<HistoryResponse>('conversations.replies', { channel: channel.id, ts: threadTs, limit: 200 }, MAX_REPLY_PAGES, signal);
    const human = msgs.filter(this.keep(channel));
    if (!human.length) return undefined;
    const parent = msgs.find((m) => m.ts === threadTs);
    return {
      channel,
      key: threadTs,
      messages: human,
      total: parent?.reply_count !== undefined ? parent.reply_count + 1 : undefined,
      permalink: permalinkFor(teamUrl, channel.id, threadTs),
    };
  }

  /**
   * An item read again whole: a thread, or the DM window it starts. For items stored before their
   * content could be read, such as an app's post whose text was only in its blocks.
   */
  private async again(channel: Conversation, key: string, teamUrl: string, signal: AbortSignal): Promise<ItemDraft | undefined> {
    const thread = await this.thread(channel, key, teamUrl, signal);
    if (!isDirect(channel) || (thread && thread.messages.length > 1)) return thread;
    const history = await this.paged<HistoryResponse>('conversations.history', { channel: channel.id, oldest: key, inclusive: 1, limit: 200 }, MAX_HISTORY_PAGES, signal);
    const keep = this.keep(channel);
    const outside = history.filter((m) => keep(m) && !m.reply_count && (!m.thread_ts || m.thread_ts === m.ts)).sort((a, b) => cmpTs(a.ts, b.ts));
    const w = dmWindows(outside).find((x) => x[0].ts === key);
    return w ? { channel, key, messages: w, permalink: permalinkFor(teamUrl, channel.id, key) } : thread;
  }

  /** DM messages outside threads, as windows split by 30 minutes of quiet (FR-2.6). */
  private async dmWindows(fs: Found[], teamUrl: string, signal: AbortSignal): Promise<ItemDraft[]> {
    const channel = fs[0].channel;
    const newTs = new Set(fs.map((f) => f.msg.ts));
    const sorted = [...newTs].sort(cmpTs);
    // Read back far enough that a window which began before the cursor keeps its first message as its key.
    const oldest = isoToTs(Date.parse(tsToIso(sorted[0])) - DM_LOOKBACK_MS);
    const history = await this.paged<HistoryResponse>('conversations.history', { channel: channel.id, oldest, latest: sorted.at(-1)!, inclusive: 1, limit: 200 }, MAX_HISTORY_PAGES, signal);
    const byTs = new Map<string, SlackMessage>(history.map((m) => [m.ts, m]));
    for (const f of fs) if (!byTs.has(f.msg.ts)) byTs.set(f.msg.ts, f.msg);
    const keep = this.keep(channel);
    const outside = [...byTs.values()].filter((m) => keep(m) && !m.reply_count && (!m.thread_ts || m.thread_ts === m.ts)).sort((a, b) => cmpTs(a.ts, b.ts));
    return dmWindows(outside)
      .filter((w) => w.some((m) => newTs.has(m.ts)))
      .map((w) => ({ channel, key: w[0].ts, messages: w, permalink: permalinkFor(teamUrl, channel.id, w[0].ts) }));
  }
}

interface ItemDraft {
  channel: Conversation;
  key: string;
  messages: SlackMessage[];
  total?: number;
  permalink: string;
}

/** Builds the adapter for the settings in force, sharing one directory (token, identity, names). */
export const slackFactory = (directory: SlackDirectory, logger?: Logger) => (settings: Settings) => new SlackAdapter({ api: directory.api, settings, logger, directory });
