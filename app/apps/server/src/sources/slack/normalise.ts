import type { Item, Message, Participant } from '@work-os/shared';
import type { Conversation, SlackMessage } from './types';

// Pure helpers that turn Slack messages into Work OS items (FR-2.6, FR-2.10).

/** Slack's message ts ("1791189720.000100") as an ISO instant. Microseconds are dropped. */
export function tsToIso(ts: string): string {
  const [s, us = '0'] = ts.split('.');
  return new Date(Number(s) * 1000 + Math.floor(Number(us.padEnd(6, '0').slice(0, 6)) / 1000)).toISOString();
}

/** An ISO instant (or epoch ms) as a Slack ts, for `oldest` and cursors. */
export function isoToTs(at: string | number): string {
  const ms = typeof at === 'number' ? at : Date.parse(at);
  return `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1000).padStart(6, '0')}`;
}

/** Compares two ts strings numerically: the seconds part can differ in length. */
export function cmpTs(a: string, b: string): number {
  const [as, au = ''] = a.split('.');
  const [bs, bu = ''] = b.split('.');
  return Number(as) - Number(bs) || Number(au.padEnd(6, '0')) - Number(bu.padEnd(6, '0'));
}

export const maxTs = (a: string | undefined, b: string): string => (a === undefined || cmpTs(b, a) > 0 ? b : a);

// Kept: plain messages, replies also sent to the channel, shared files, /me. Dropped: bots, joins,
// leaves, topic changes and the like, which never need Frank (FR-2.10).
const KEEP_SUBTYPES = new Set([undefined, 'thread_broadcast', 'file_share', 'me_message']);

export function isHuman(m: SlackMessage): boolean {
  return !m.bot_id && !!m.user && KEEP_SUBTYPES.has(m.subtype);
}

/** Who wrote a message: the user, or for an app posting without one, the bot. */
export const authorOf = (m: SlackMessage): string => m.user ?? m.bot_id ?? 'unknown';

const isAppMessage = (m: SlackMessage) => !!m.bot_id || m.subtype === 'bot_message';

/**
 * Whether to keep a message. People's messages always; an app's posts (Gong's call recaps, say)
 * only in the channels listed under "Read app posts in". Search answers without bot_id, so an app
 * is also known by its user being a bot.
 */
export function keepMessage(m: SlackMessage, o: { apps: boolean; isBot?: (userId: string) => boolean }): boolean {
  const app = isAppMessage(m) || (!!m.user && !!o.isBot?.(m.user));
  if (!app) return isHuman(m);
  return o.apps && (!!m.user || !!m.bot_id) && (KEEP_SUBTYPES.has(m.subtype) || m.subtype === 'bot_message');
}

/**
 * A message's text. Layout blocks (section, header, context) are the message when present: an
 * app's `text` is then just the notification line, and search sends it empty. A person's message
 * repeats its text in rich_text blocks, which are skipped. Attachments fill in when there is no
 * text, and follow an app's text; a message of only files is their names.
 */
export function messageText(m: SlackMessage): string {
  const blocks = (m.blocks ?? [])
    .flatMap((b): string[] => {
      if (b.type === 'section') return [b.text?.text ?? '', ...(b.fields ?? []).map((f) => f.text)].filter(Boolean);
      if (b.type === 'header') return b.text?.text ? [`*${b.text.text}*`] : [];
      if (b.type === 'context') {
        const t = (b.elements ?? []).flatMap((e) => (e.text ? [e.text] : [])).join(' ');
        return t ? [t] : [];
      }
      return [];
    })
    .join('\n\n');
  if (blocks) return blocks;
  const attached = (m.attachments ?? [])
    .map((a) =>
      [a.pretext, a.title && `*${a.title}*`, a.text ?? (a.title ? undefined : a.fallback), ...(a.fields ?? []).map((f) => [f.title && `*${f.title}*`, f.value].filter(Boolean).join(': '))]
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n');
  const text = m.text ?? '';
  const files = (m.files ?? []).flatMap((f) => (f.title || f.name ? [`📎 ${f.title || f.name}`] : [])).join('\n');
  if (!attached) return text || files;
  if (!text) return attached;
  return isAppMessage(m) ? `${text}\n\n${attached}` : text;
}

/** Matches a channel against a settings list, which may hold "#name", "name" or an ID. */
export function channelListed(list: string[], c: { id: string; name?: string }): boolean {
  return list.some((entry) => {
    const e = entry.trim();
    return e === c.id || (!!c.name && (e === `#${c.name}` || e === c.name));
  });
}

/** Whether a conversation is a DM or a group DM. */
export const isDirect = (c: Pick<Conversation, 'is_im' | 'is_mpim' | 'id'>): boolean => !!c.is_im || !!c.is_mpim || c.id.startsWith('D');

/** The thread a search match belongs to: its thread_ts, or the one in its permalink. */
export function threadTsOf(m: SlackMessage): string | undefined {
  if (m.thread_ts) return m.thread_ts;
  const q = m.permalink ? /[?&]thread_ts=([\d.]+)/.exec(m.permalink) : null;
  return q?.[1];
}

/** A permalink built from the workspace URL, for messages that came without one. */
export function permalinkFor(teamUrl: string, channel: string, ts: string, threadTs?: string): string {
  const base = `${teamUrl.replace(/\/$/, '')}/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs && threadTs !== ts ? `${base}?thread_ts=${threadTs}&cid=${channel}` : base;
}

/**
 * The item in Slack's web client, which opens in the browser rather than handing over to the app:
 * a thread opens in its side pane, a DM at its latest messages.
 */
export function webClientUrl(teamId: string, itemId: string, kind: string): string | undefined {
  const [, channel, key] = itemId.split(':');
  if (!channel || !key) return undefined;
  const base = `https://app.slack.com/client/${teamId}/${channel}`;
  return kind === 'thread' ? `${base}/thread/${channel}-${key}` : base;
}

export const DM_GAP_MS = 30 * 60_000;

/**
 * Splits DM messages that are not in a thread into windows separated by 30+ minutes of quiet
 * (FR-2.6). Messages must be sorted by ts. A window is keyed by its first message.
 */
export function dmWindows<T extends { ts: string }>(sorted: T[], gapMs = DM_GAP_MS): T[][] {
  const out: T[][] = [];
  let last: number | undefined;
  for (const m of sorted) {
    const at = Date.parse(tsToIso(m.ts));
    if (last === undefined || at - last >= gapMs) out.push([]);
    out[out.length - 1].push(m);
    last = at;
  }
  return out;
}

export const MAX_STORED_MESSAGES = 500;

export interface ItemInput {
  channel: Conversation;
  /** The thread's ts, or a DM window's first ts: with the channel, the item's ID. */
  key: string;
  messages: SlackMessage[];
  /** The full thread length when known (reply_count + 1); otherwise the messages given. */
  total?: number;
  title: string;
  permalink: string;
  names: (userId: string) => string;
  /** Which messages to keep; people's only, by default. */
  keep?: (m: SlackMessage) => boolean;
}

const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;

/** The user IDs @-mentioned in these texts. */
export const mentionedIds = (texts: string[]): string[] => [...new Set(texts.flatMap((t) => [...t.matchAll(MENTION)].map((m) => m[1])))];

export function itemId(channel: string, key: string): string {
  return `slack:${channel}:${key}`;
}

/** Builds the item. Its revision is set by the poll pipeline, which knows what was there before. */
export function buildItem(i: ItemInput): Item {
  const human = i.messages.filter(i.keep ?? isHuman).sort((a, b) => cmpTs(a.ts, b.ts));
  const kept = human.slice(-MAX_STORED_MESSAGES);
  const messages: Message[] = kept.map((m) => ({ id: m.ts, authorId: authorOf(m), ts: tsToIso(m.ts), text: messageText(m) }));
  const seen = new Set<string>();
  const participants: Participant[] = [];
  for (const m of human) {
    const author = authorOf(m);
    if (seen.has(author)) continue;
    seen.add(author);
    participants.push({ id: author, name: i.names(author) });
  }
  const mentioned = mentionedIds(messages.map((m) => m.text))
    .map((id) => ({ id, name: i.names(id) }))
    .filter((p) => p.name !== p.id);
  const last = human.at(-1);
  return {
    id: itemId(i.channel.id, i.key),
    source: 'slack',
    kind: isDirect(i.channel) ? 'dm' : 'thread',
    title: i.title,
    permalink: i.permalink,
    participants,
    ...(mentioned.length && { mentioned }),
    messages,
    messageCount: Math.max(i.total ?? 0, human.length),
    lastActivityAt: last ? tsToIso(last.ts) : tsToIso(i.key),
    revision: 1,
    schemaVersion: 1,
  };
}
