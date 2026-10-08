import { mentionsMe, type EarlierView, type Item, type Me } from '@work-os/shared';

// What the model sees of a thread, and how threads are packed into calls (§5.3, CL-4).
//
// A long thread keeps its first message, its last `keepLastMessages` and any message that mentions
// Frank; the rest are counted, not sent. A very long message is cut. Threads are then packed in
// order into calls of at most `maxThreadsPerCall` threads and `maxInputTokens` tokens, the prompt
// included. Tokens are estimated from characters: the real count comes back in the usage log, and
// the limit has headroom.

export const MESSAGE_MAX_CHARS = 2000;
// Measured on triage JSON (the mock seed threads, 12.9k characters): 2.33 characters a token on
// Claude Haiku 5.5, whose tokenizer every model here except haiku-4.5 shares. Haiku 4.5 gave 3.3.
export const CHARS_PER_TOKEN = 2.3;

export interface TriageMessage {
  author: string; // "me" for Frank, otherwise the display name
  at: string;
  text: string;
  thread?: true; // a reply in a Slack thread, in a topic that also has chat outside it
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
}

/** How much of a DM's earlier conversation triage sees: enough for the question a reply answers. */
export const BEFORE_MAX_MESSAGES = 5;
export const BEFORE_MAX_CHARS = 500;

const cut = (text: string) => (text.length > MESSAGE_MAX_CHARS ? `${text.slice(0, MESSAGE_MAX_CHARS - 1)}…` : text);

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
  // Thread replies are marked only in a topic that also has chat outside the thread.
  const mixed = !!inThread?.size && inThread.size < msgs.length;
  const messages = [...keep]
    .sort((a, b) => a - b)
    .map((i) => msgs[i])
    .map((m): TriageMessage => ({
      author: me.id && m.authorId === me.id ? 'me' : (names.get(m.authorId) ?? m.authorId),
      at: m.ts,
      text: cut(m.text),
      ...(mixed && inThread.has(m.id) && { thread: true as const }),
    }));
  const thread: TriageThread = { id: item.id, kind: item.kind, title: item.title, messages, omitted: Math.max(0, item.messageCount - messages.length) };
  const prior = earlier?.messages.slice(-BEFORE_MAX_MESSAGES) ?? [];
  if (prior.length) {
    const known = new Map([...names, ...(earlier?.people ?? []).map((p): [string, string] => [p.id, p.name])]);
    const short = (t: string) => (t.length > BEFORE_MAX_CHARS ? `${t.slice(0, BEFORE_MAX_CHARS - 1)}…` : t);
    thread.before = prior.map((m) => ({ author: me.id && m.authorId === me.id ? 'me' : (known.get(m.authorId) ?? m.authorId), at: m.ts, text: short(m.text) }));
  }
  return thread;
}

export const estimateTokens = (text: string) => Math.ceil(text.length / CHARS_PER_TOKEN);
export const threadTokens = (t: TriageThread) => estimateTokens(JSON.stringify(t));

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
