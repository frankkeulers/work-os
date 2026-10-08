import { conversationOf, topicItem, type EarlierView, type EventDraft, type Item, type ItemState, type Me, type Projection, type Settings } from '@work-os/shared';
import { z } from 'zod';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import type { ItemFiles, StoredItem } from '../store/items';
import type { Store } from '../store/store';
import { estimateTokens, packBatches, threadForTriage, threadTokens, type TopicView, type TriageMessage, type TriageThread } from './truncate';

// Topics (amendment). Ingestion cuts a conversation into pieces (a Slack thread, a DM window, a
// channel post); routing puts each new piece in the open topic it continues, or starts a new one,
// before triage runs once per topic over all its pieces. Pieces never leave their conversation.
//
// A piece is routed once, when it is first quiet. Its later messages stay in its topic. A call is
// made only when a conversation has a choice to offer: an open topic, or two new pieces. A bad
// answer leaves every piece on its own (the behaviour before topics), so routing never holds up
// triage. Regroup sends a conversation's open topics through again, to merge them.

/** How far back a topic can still take a new piece: open ones, and those done in the last day. */
export const CANDIDATE_ACTIVE_DAYS = 7;
export const CANDIDATE_DONE_HOURS = 24;
/** What routing sees of an open topic: its summary and its latest messages. */
export const CANDIDATE_RECENT_MESSAGES = 3;
const RECENT_MAX_CHARS = 300;

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const TopicsAnswer = z.object({
  assignments: z.array(z.object({ id: z.string().min(1), topic: z.string().min(1) })),
});
export type TopicsAnswer = z.infer<typeof TopicsAnswer>;

export interface TopicsDeps {
  store: Store;
  items: ItemFiles;
  claude: ClaudeAdapter;
  now: () => Date;
  logger?: Logger;
  config: () => { settings: Settings };
  me: () => Me;
  topicsPrompt: () => Promise<Prompt>;
  budgetHit: () => boolean;
}

interface Candidate {
  id: string;
  summary: string;
  need?: string;
  lastActivityAt: string;
  recent: TriageMessage[];
}

interface Conversation {
  conversation: string;
  title: string;
  topics: Candidate[];
  pieces: TriageThread[];
}

export interface RoutingRun {
  calls: number;
  routed: number;
  joined: number;
  /** Pieces waited: the budget is spent. */
  paused?: boolean;
}

// ---------------------------------------------------------------- topic content

/** The pieces of a topic, as stored: the anchor first. A piece whose file is gone is left out. */
export async function readTopic(p: Projection, items: ItemFiles, id: string): Promise<{ anchor: StoredItem; parts: Item[] } | undefined> {
  const it = p.items[id];
  if (!it) return undefined;
  const anchor = await items.read(it.source, id);
  if (!anchor) return undefined;
  const parts: Item[] = [];
  for (const pid of it.parts ?? []) {
    const part = p.items[pid];
    const stored = part && (await items.read(part.source, pid));
    if (stored) parts.push(stored.item);
  }
  return { anchor, parts };
}

/** What triage sees of a topic, and the content it was built from. Undefined when the anchor's file is gone. */
export async function topicForTriage(
  p: Projection,
  items: ItemFiles,
  id: string,
  me: Me,
  keepLast: number,
  earlier?: EarlierView,
): Promise<{ anchor: StoredItem; item: Item; view: TriageThread } | undefined> {
  const topic = await readTopic(p, items, id);
  if (!topic) return undefined;
  const { item, inThread, ends } = topicItem(topic.anchor.item, topic.parts);
  const view: TopicView = { keep: ends(keepLast), inThread };
  return { anchor: topic.anchor, item, view: threadForTriage(item, me, keepLast, earlier, view) };
}

// ---------------------------------------------------------------- routing

const keyTs = (id: string) => Number(id.split(':').at(-1));
const earliest = (ids: string[]) => [...ids].sort((a, b) => keyTs(a) - keyTs(b) || a.localeCompare(b))[0];

/** New pieces waiting to be placed: quiet, pending, never routed, in a conversation. */
export function piecesToRoute(items: Iterable<ItemState>, now: Date, quietMinutes: number): ItemState[] {
  const quietMs = quietMinutes * 60_000;
  return [...items].filter((it) => !it.routed && !it.topicOf && it.triageState === 'pending' && !!conversationOf(it) && Date.parse(it.lastActivityAt) + quietMs <= now.getTime());
}

/** The topics in a conversation that a new piece may join. */
export function candidatesIn(items: Iterable<ItemState>, conversation: string, now: Date, exclude: Set<string>): ItemState[] {
  const activeSince = new Date(now.getTime() - CANDIDATE_ACTIVE_DAYS * DAY).toISOString();
  const doneSince = new Date(now.getTime() - CANDIDATE_DONE_HOURS * HOUR).toISOString();
  return [...items].filter(
    (it) =>
      !exclude.has(it.id) &&
      !it.topicOf &&
      conversationOf(it) === conversation &&
      it.lastActivityAt >= activeSince &&
      (it.status !== 'done' || (!!it.doneAt && it.doneAt >= doneSince)) &&
      (it.routed || !!it.decision),
  );
}

/**
 * Turns the model's assignments into placements. A piece may name an open topic, another new
 * piece, or "new"; anything else counts as "new". New pieces that name each other form a new
 * topic, anchored on the earliest; one that reaches an open topic takes its whole group along.
 * Frank's splits hold: a piece never goes back to a topic he took it out of.
 */
export function resolveAssignments(pieceIds: string[], candidateIds: string[], answer: TopicsAnswer, notWith: (id: string) => string[] = () => []): Map<string, string | undefined> {
  const pieces = new Set(pieceIds);
  const candidates = new Set(candidateIds);
  const said = new Map(answer.assignments.map((a) => [a.id, a.topic]));
  // Union-find over the new pieces.
  const parent = new Map(pieceIds.map((id) => [id, id]));
  const find = (id: string): string => {
    const up = parent.get(id)!;
    if (up === id) return id;
    const root = find(up);
    parent.set(id, root);
    return root;
  };
  const target = new Map<string, string>(); // group root → open topic
  for (const id of [...pieceIds].sort((a, b) => keyTs(a) - keyTs(b))) {
    const to = said.get(id);
    if (!to || to === id) continue;
    if (pieces.has(to)) {
      const [a, b] = [find(id), find(to)];
      if (a === b) continue;
      const t = target.get(a) ?? target.get(b);
      parent.set(b, a);
      if (t) target.set(a, t);
    } else if (candidates.has(to) && !notWith(id).includes(to)) {
      const root = find(id);
      if (!target.has(root)) target.set(root, to);
    }
  }
  const groups = new Map<string, string[]>();
  for (const id of pieceIds) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  const out = new Map<string, string | undefined>();
  for (const [root, members] of groups) {
    const topic = target.get(root);
    const anchor = topic ?? earliest(members);
    for (const id of members) {
      const into = id === anchor ? undefined : anchor;
      out.set(id, into && notWith(id).includes(into) ? undefined : into);
    }
  }
  return out;
}

function candidateView(it: ItemState, item: Item | undefined, summary: string | undefined, me: Me): Candidate {
  const names = new Map(item?.participants.map((x) => [x.id, x.name]) ?? []);
  const recent = (item?.messages ?? []).slice(-CANDIDATE_RECENT_MESSAGES).map((m) => ({
    author: me.id && m.authorId === me.id ? 'me' : (names.get(m.authorId) ?? m.authorId),
    at: m.ts,
    text: m.text.length > RECENT_MAX_CHARS ? `${m.text.slice(0, RECENT_MAX_CHARS - 1)}…` : m.text,
  }));
  return { id: it.id, summary: summary || it.title, ...(it.decision?.next && { need: it.decision.next.need }), lastActivityAt: it.lastActivityAt, recent };
}

export function renderConversations(convs: Conversation[], now: Date, regroup: boolean): string {
  const ask = regroup
    ? 'Group these open topics: give each piece the id of another piece on the same subject, or "new". Answer with the JSON only.'
    : 'Place each new piece in a topic. Answer with the JSON only.';
  return [`Now: ${now.toISOString()}`, ask, '<conversations>', JSON.stringify(convs), '</conversations>'].join('\n');
}

/**
 * Places the pieces due for routing, or with `regroup`, sends that conversation's open topics
 * through again so routing can merge them. Throws ClaudeError (for health) or the abort reason;
 * placements from calls that finished before stay.
 */
export async function routeTopics(d: TopicsDeps, signal: AbortSignal, opts: { regroup?: string } = {}): Promise<RoutingRun> {
  const run: RoutingRun = { calls: 0, routed: 0, joined: 0 };
  const { settings } = d.config();
  const t = settings.triage;
  const now = d.now();
  const p = d.store.projection;
  const all = Object.values(p.items);
  const me = d.me();
  const regroup = opts.regroup;

  const waiting = regroup
    ? all.filter((it) => !it.topicOf && it.status !== 'done' && conversationOf(it) === regroup)
    : piecesToRoute(all, now, t.quietMinutes);
  if (!waiting.length || (regroup && waiting.length < 2)) return run;

  const byConv = new Map<string, ItemState[]>();
  for (const it of waiting) {
    const c = conversationOf(it)!;
    byConv.set(c, [...(byConv.get(c) ?? []), it]);
  }

  // A conversation with nothing to choose between needs no call.
  const convs: { conv: Conversation; pieces: ItemState[]; candidates: ItemState[] }[] = [];
  const alone: EventDraft[] = [];
  for (const [c, pieces] of byConv) {
    const ids = new Set(pieces.map((x) => x.id));
    const candidates = regroup ? [] : candidatesIn(all, c, now, ids);
    if (!candidates.length && pieces.length === 1) {
      alone.push({ type: 'topic.routed', itemId: pieces[0].id, data: { by: 'model' } });
      continue;
    }
    const views: TriageThread[] = [];
    for (const it of pieces) {
      const topic = await topicForTriage(p, d.items, it.id, me, regroup ? CANDIDATE_RECENT_MESSAGES : t.keepLastMessages);
      if (topic) views.push(topic.view);
    }
    const topics: Candidate[] = [];
    for (const it of candidates) {
      const stored = await d.items.read(it.source, it.id);
      topics.push(candidateView(it, stored?.item, stored?.text?.summary, me));
    }
    convs.push({ conv: { conversation: c, title: pieces[0].title, topics, pieces: views }, pieces, candidates });
  }
  if (alone.length) {
    await d.store.append(...alone);
    run.routed += alone.length;
  }
  if (!convs.length) return run;
  if (d.budgetHit()) return { ...run, paused: true }; // triage waits on the budget too; the pieces are routed once it lifts

  const prompt = await d.topicsPrompt();
  const model = settings.models.routing ?? 'haiku-5.5';
  const by = regroup ? 'regroup' : 'model';
  const batches = packBatches(convs, (x) => estimateTokens(JSON.stringify(x.conv.topics)) + x.conv.pieces.reduce((n, v) => n + threadTokens(v), 0), {
    maxThreads: t.maxThreadsPerCall,
    maxInputTokens: t.maxInputTokens,
    overheadTokens: estimateTokens(prompt.text) + 200,
  });
  for (const [n, batch] of batches.entries()) {
    if (n > 0 && d.budgetHit()) {
      run.paused = true;
      break;
    }
    let answer: TopicsAnswer;
    try {
      const r = await d.claude.structured(
        {
          purpose: 'routing',
          model,
          system: prompt.text,
          prompt: renderConversations(
            batch.map((x) => x.conv),
            d.now(),
            !!regroup,
          ),
          promptVersion: prompt.version,
          timeoutMs: DEADLINES.triage,
          signal,
          itemIds: batch.flatMap((x) => x.pieces.map((it) => it.id)),
        },
        TopicsAnswer,
      );
      run.calls += r.usage.length;
      answer = r.value;
    } catch (err) {
      if (!(err instanceof ClaudeOutputError)) throw err;
      run.calls += err.attempts;
      d.logger?.warn({ conversations: batch.map((x) => x.conv.conversation) }, 'Routing output did not match the schema; each piece is its own topic');
      answer = { assignments: [] };
    }

    const events: EventDraft[] = [];
    for (const { pieces, candidates } of batch) {
      const ids = pieces.map((x) => x.id);
      const placed = resolveAssignments(
        ids,
        candidates.map((x) => x.id),
        answer,
        (id) => d.store.projection.items[id]?.notWith ?? [],
      );
      // Anchors first, so a join always finds its topic in place.
      const order = [...ids].sort((a, b) => Number(placed.get(a) !== undefined) - Number(placed.get(b) !== undefined));
      for (const id of order) {
        const into = placed.get(id);
        // Regroup: a topic that stays on its own is already placed.
        if (regroup && !into) continue;
        events.push({ type: 'topic.routed', itemId: id, data: { ...(into && { into }), by } });
        run.routed++;
        if (into) run.joined++;
      }
    }
    if (events.length) await d.store.append(...events);
  }
  d.logger?.info({ ...run, regroup }, 'Routed');
  return run;
}

