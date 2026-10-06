import type { EventDraft, Item, PollReason, Rule, Settings } from '@work-os/shared';
import type { Logger } from '../log';
import type { SourceAdapter } from '../sources/types';
import type { ItemFiles } from '../store/items';
import type { Store } from '../store/store';
import type { CursorFile } from './cursors';
import { meFrom, ruleDecision, ruleReason, ruleVerdict } from './rules';

// One poll of one source (FR-2.8). Idempotent: message IDs (Slack ts) are the dedupe key, so a
// replayed or overlapping fetch changes nothing, and an item's revision only moves when it has a
// message it didn't have before. The write order makes a crash at any point safe:
//   1. item files (each written atomically);
//   2. one append: the item.upserted events and source.polled with the cursor (one fsync);
//   3. cursors.json.
// A crash before 2 re-fetches the same messages next time and finds them already in the files.
//
// Rules run on every item with new messages from someone else (FR-4, §5.3): a drop rule keeps a
// new thread out altogether; a now/today rule logs its decision with the upsert, in the same append.

export const MAX_STORED_MESSAGES = 500;

export interface PollStats {
  fetched: number;
  changed: number;
  dropped: number; // new threads a drop rule kept out
  ruleDecided: number; // items a now/today rule decided
  cursor?: string;
  durationMs: number;
}

export interface PollDeps {
  store: Store;
  items: ItemFiles;
  cursors: CursorFile;
  now: () => Date;
  logger?: Logger;
  /** The rules and settings in force; without them every item waits for the model. */
  rules?: () => { rules: Rule[]; settings: Settings };
}

const EXCERPT_MAX = 110;
const excerpt = (text = '') => (text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text);

/** Merges a fetched item into what is stored: the union of messages, by ID. */
export function mergeItem(stored: Item | undefined, fetched: Item, prevRevision: number | undefined): { item: Item; newIds: string[] } {
  const known = new Set(stored?.messages.map((m) => m.id) ?? []);
  const newIds = fetched.messages.filter((m) => !known.has(m.id)).map((m) => m.id);
  const byId = new Map((stored?.messages ?? []).map((m) => [m.id, m]));
  for (const m of fetched.messages) byId.set(m.id, m); // an edited message replaces its old text
  const messages = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id)).slice(-MAX_STORED_MESSAGES);
  const participants = [...(stored?.participants ?? [])];
  for (const p of fetched.participants) if (!participants.some((q) => q.id === p.id)) participants.push(p);
  const lastActivityAt = [stored?.lastActivityAt, fetched.lastActivityAt].filter((x): x is string => !!x).sort().at(-1)!;
  return {
    newIds,
    item: {
      ...fetched,
      participants: participants.map((p) => fetched.participants.find((q) => q.id === p.id) ?? p), // fresher names
      messages,
      messageCount: Math.max(stored?.messageCount ?? 0, fetched.messageCount, messages.length),
      lastActivityAt,
      revision: newIds.length || prevRevision === undefined ? (prevRevision ?? 0) + 1 : prevRevision,
    },
  };
}

export async function pollSource(d: PollDeps, source: SourceAdapter, reason: PollReason, signal: AbortSignal): Promise<PollStats> {
  const t0 = performance.now();
  const cursor = d.cursors.get(source.id, d.store.projection.sources[source.id]?.cursor);
  const result = await source.fetchSince(cursor, { signal, now: d.now(), reason });
  signal.throwIfAborted(); // asleep mid-poll: don't write half a picture

  const identity = source.identity?.();
  const me = identity?.id;
  const rules = d.rules?.();
  const now = d.now();
  const drafts: EventDraft[] = [];
  let changed = 0;
  let dropped = 0;
  let ruleDecided = 0;
  for (const fetched of result.items) {
    const prev = d.store.projection.items[fetched.id];
    const stored = await d.items.read(fetched.source, fetched.id);
    // Without the file (retention, or a crash before it was written) the merge starts afresh.
    const { item, newIds } = mergeItem(stored?.item, fetched, prev?.revision);
    if (prev && !newIds.length) continue;
    const byId = new Map(item.messages.map((m) => [m.id, m]));
    const fromMeOnly = !!prev && !!me && newIds.every((id) => byId.get(id)?.authorId === me);
    const verdict = rules && !fromMeOnly ? ruleVerdict(item, rules.rules, rules.settings, meFrom(identity)) : undefined;
    if (verdict?.kind === 'drop' && !prev) {
      dropped++;
      continue;
    }
    const fixed = verdict?.kind === 'fixed' ? verdict : undefined;
    // A rule's decision replaces the text of any earlier one, which described older messages.
    const text = fixed ? { summary: excerpt(item.messages[0]?.text) || item.title, reason: ruleReason(fixed) } : stored?.text;
    await d.items.write({ item, text, schemaVersion: 1 });
    changed++;
    drafts.push({
      type: 'item.upserted',
      itemId: item.id,
      data: {
        source: item.source,
        kind: item.kind,
        title: item.title,
        permalink: item.permalink,
        participants: item.participants,
        lastActivityAt: item.lastActivityAt,
        revision: item.revision,
        messageCount: item.messageCount,
        fromMeOnly,
      },
    });
    if (fixed) {
      drafts.push({ type: 'triage.decided', itemId: item.id, data: { decision: ruleDecision(item, fixed, now) } });
      ruleDecided++;
    }
  }
  const durationMs = Math.round(performance.now() - t0);
  drafts.push({ type: 'source.polled', data: { source: source.id, reason, fetched: result.items.length, cursor: result.nextCursor, durationMs } });
  await d.store.append(...drafts);
  if (result.nextCursor) await d.cursors.set(source.id, result.nextCursor);
  d.logger?.info({ source: source.id, reason, fetched: result.items.length, changed, dropped, ruleDecided, durationMs }, 'Polled');
  return { fetched: result.items.length, changed, dropped, ruleDecided, cursor: result.nextCursor, durationMs };
}
