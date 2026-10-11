import { mentionsMe, type EarlierView, type Item, type Me } from '@work-os/shared';

// What the model sees of a thread, and how threads are packed into calls (§5.3, CL-4).
//
// A long thread keeps its first message, its last `keepLastMessages` and any message that mentions
// Frank; the rest are counted, not sent. A very long message is cut. Threads are then packed in
// order into calls of at most `maxThreadsPerCall` threads and `maxInputTokens` tokens, the prompt
// included. Tokens are estimated from characters: the real count comes back in the usage log, and
// the limit has headroom.

export const MESSAGE_MAX_CHARS = 2000;
/** A meeting's summary or notes (R2.3): about 3 KB, with the action items near the end (P0-11). */
export const MEETING_MAX_CHARS = 8000;
/** One email, already without its quoted history and signature (Outlook). */
export const EMAIL_MAX_CHARS = 4000;
// Measured on triage JSON (the mock seed threads, 12.9k characters): 2.33 characters a token on
// Claude Haiku 5.5, whose tokenizer every model here except haiku-4.5 shares. Haiku 4.5 gave 3.3.
export const CHARS_PER_TOKEN = 2.3;

export interface TriageMessage {
  author: string; // "me" for Frank, otherwise the display name
  at: string;
  text: string;
  thread?: true; // a reply in a Slack thread, in a topic that also has chat outside it
  to?: string[]; // an email's recipients, "me" for Frank
  cc?: string[];
}

export interface TriageThread {
  id: string;
  kind: Item['kind'];
  title: string;
  messages: TriageMessage[];
  /** Messages in the thread that are not in `messages`. */
  omitted: number;
  /** A DM's last few messages before this item, for context only (oldest first). */
  before?: TriageMessage[];
  /** A topic's asks Frank has ticked off: not to be listed again (topics). */
  done?: string[];
  /** When a meeting ran or an invite is for, and its calendar event (R2.8). */
  meeting?: { start: string; end: string; calendar?: { title: string; organizer?: string; invitees: string[]; more?: number } };
}

/** Enough invitees to tell a one-to-one from a team meeting from an all-hands. */
export const INVITEES_MAX = 15;

/** How much of a DM's earlier conversation triage sees: enough for the question a reply answers. */
export const BEFORE_MAX_MESSAGES = 5;
export const BEFORE_MAX_CHARS = 500;

const cut = (text: string, max = MESSAGE_MAX_CHARS) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

const MENTION = /<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g;

/**
 * Slack's `<@id>` mentions as "@Name", Frank's as "@Frank", so the model can tie a mention to the
 * author of another message: a reply that names who asked belongs with what they asked. An ID
 * with no known name stays as it is.
 */
export function withNames(text: string, me: Me, name: (id: string) => string | undefined): string {
  return text.replace(MENTION, (raw, id: string, label?: string) => {
    const n = me.id && id === me.id ? 'Frank' : (name(id) ?? label);
    return n ? `@${n}` : raw;
  });
}

/** A topic's extras (topics.ts): messages kept whatever their place, and those from a Slack thread. */
export interface TopicView {
  keep: Set<string>;
  inThread: Set<string>;
}

export function threadForTriage(item: Item, me: Me, keepLast: number, earlier?: EarlierView, topic?: TopicView): TriageThread {
  const msgs = item.messages;
  const keep = new Set<number>();
  if (msgs.length) keep.add(0);
  for (let i = Math.max(0, msgs.length - keepLast); i < msgs.length; i++) keep.add(i);
  msgs.forEach((m, i) => {
    if (mentionsMe(m.text, me) || topic?.keep.has(m.id)) keep.add(i);
  });
  const inThread = topic?.inThread;
  const names = new Map(item.participants.map((p) => [p.id, p.name]));
  const who = (id: string) => (me.id && id === me.id ? 'me' : (names.get(id) ?? id));
  const mentioned = new Map([...(item.mentioned ?? []).map((p): [string, string] => [p.id, p.name]), ...names]);
  // Thread replies are marked only in a topic that also has chat outside the thread.
  const mixed = !!inThread?.size && inThread.size < msgs.length;
  const messages = [...keep]
    .sort((a, b) => a - b)
    .map((i) => msgs[i])
    .map((m): TriageMessage => ({
      author: who(m.authorId),
      at: m.ts,
      text: cut(withNames(m.text, me, (id) => mentioned.get(id)), item.kind === 'meeting' ? MEETING_MAX_CHARS : item.kind === 'email' ? EMAIL_MAX_CHARS : MESSAGE_MAX_CHARS),
      ...(mixed && inThread.has(m.id) && { thread: true as const }),
      ...(m.to && { to: m.to.map(who) }),
      ...(m.cc?.length && { cc: m.cc.map(who) }),
    }));
  const thread: TriageThread = { id: item.id, kind: item.kind, title: item.title, messages, omitted: Math.max(0, item.messageCount - messages.length) };
  if (item.meeting) {
    const cal = item.meeting.calendar;
    const invitees = cal?.invitees ?? [];
    thread.meeting = {
      start: item.meeting.start,
      end: item.meeting.end,
      ...(cal && {
        calendar: {
          title: cal.title,
          ...(cal.organizer && { organizer: who(cal.organizer.id) === 'me' ? 'me' : cal.organizer.name }),
          invitees: invitees.slice(0, INVITEES_MAX).map((p) => (who(p.id) === 'me' ? 'me' : p.name)),
          ...(invitees.length > INVITEES_MAX && { more: invitees.length - INVITEES_MAX }),
        },
      }),
    };
  }
  const prior = earlier?.messages.slice(-BEFORE_MAX_MESSAGES) ?? [];
  if (prior.length) {
    const known = new Map([...names, ...(earlier?.people ?? []).map((p): [string, string] => [p.id, p.name])]);
    const short = (t: string) => (t.length > BEFORE_MAX_CHARS ? `${t.slice(0, BEFORE_MAX_CHARS - 1)}…` : t);
    thread.before = prior.map((m) => ({ author: me.id && m.authorId === me.id ? 'me' : (known.get(m.authorId) ?? m.authorId), at: m.ts, text: short(withNames(m.text, me, (id) => known.get(id) ?? mentioned.get(id))) }));
  }
  return thread;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
export const threadTokens = (t: TriageThread) => estimateTokens(JSON.stringify(t));

/** Messages at the end of a thread that capThread keeps: the latest is what needs Frank. */
const CAP_KEEP_LAST = 2;
const CAP_MIN_CHARS = 200;

/**
 * A thread no call could take, cut to fit `maxTokens` on its own (§5.3): first the DM's earlier
 * messages go, then kept messages from the middle, oldest first (the first message and the last
 * two stay), then the longest texts are halved. A thread that fits is returned as it is.
 */
export function capThread(t: TriageThread, maxTokens: number): TriageThread {
  if (threadTokens(t) <= maxTokens) return t;
  const out: TriageThread = { ...t, messages: [...t.messages] };
  delete out.before;
  while (out.messages.length > 1 + CAP_KEEP_LAST && threadTokens(out) > maxTokens) {
    out.messages.splice(1, 1);
    out.omitted++;
  }
  while (threadTokens(out) > maxTokens) {
    const longest = out.messages.reduce((a, m, i) => (m.text.length > out.messages[a].text.length ? i : a), 0);
    const m = out.messages[longest];
    if (!m || m.text.length <= CAP_MIN_CHARS) break; // nothing left worth cutting
    out.messages[longest] = { ...m, text: cut(m.text, Math.max(CAP_MIN_CHARS, Math.floor(m.text.length / 2))) };
  }
  return out;
}

/**
 * Packs items in order into batches within both limits. An item too big for any batch goes alone:
 * it is still triaged, and the call's own limit decides.
 */
export function packBatches<T>(items: T[], tokensOf: (t: T) => number, limits: { maxThreads: number; maxInputTokens: number; overheadTokens: number }): T[][] {
  const budget = limits.maxInputTokens - limits.overheadTokens;
  const batches: T[][] = [];
  let current: T[] = [];
  let used = 0;
  for (const it of items) {
    const cost = tokensOf(it);
    if (current.length && (current.length >= limits.maxThreads || used + cost > budget)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push(it);
    used += cost;
  }
  if (current.length) batches.push(current);
  return batches;
}
