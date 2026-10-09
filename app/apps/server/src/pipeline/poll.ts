import type { EventDraft, Item, LoggedDecision, PollReason, Rule, Settings } from '@work-os/shared';
import type { Logger } from '../log';
import type { SourceAdapter } from '../sources/types';
import type { ItemFiles } from '../store/items';
import type { Store } from '../store/store';
import type { CursorFile } from './cursors';
import { crashPoint } from '../runtime/crash';
import { meFrom, ruleDecision, ruleReason, ruleVerdict, type RuleVerdict } from './rules';

// One poll of one source (FR-2.8). Idempotent: message IDs (Slack ts) are the dedupe key, so a
// replayed or overlapping fetch changes nothing, and an item's revision only moves when it has a
// message it didn't have before. A message whose text changed under the same ID (a Slack edit, a
// summary Wispr Flow rewrites) is saved and logged at the same revision: not triaged again. The write order makes a crash at any point safe:
//   1. item files (each written atomically);
//   2. one append: the item.upserted events and source.polled with the cursor (one fsync);
//   3. cursors.json.
// A crash before 2 re-fetches the same messages next time and finds them already in the files.
//
// Rules run on every item with new messages from someone else (FR-4, §5.3): a drop rule keeps a
// new thread out altogether; a now/today rule logs its decision with the upsert, in the same append.
//
// A new email conversation holding only Frank's own emails (Sent Items, Outlook) is decided "none"
// the same way, by the built-in rule SENT_BY_YOU: nobody has answered, so there is nothing for him
// to do yet. A reply from someone else is new content from another author, so it is triaged as usual.

export const SENT_BY_YOU = 'sent-by-you';

export const MAX_STORED_MESSAGES = 500;

export interface PollStats {
  fetched: number;
  changed: number;
  dropped: number; // new threads a drop rule kept out
  ruleDecided: number; // items a now/today rule decided
  resolved: number; // open items the source closed itself (R2.8)
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
  /** Items to read again whole on this source's next poll (taken once). */
  refetch?: (source: string) => string[];
  /** Adds what other sources know to fetched items before they are merged: a meeting's calendar event (R2.8). */
  enrich?: (items: Item[]) => Item[];
}

const EXCERPT_MAX = 110;
const excerpt = (text = '') => (text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX - 1)}…` : text);

/** Merges a fetched item into what is stored: the union of messages, by ID. */
export function mergeItem(stored: Item | undefined, fetched: Item, prevRevision: number | undefined): { item: Item; newIds: string[]; edited: boolean } {
  const known = new Set(stored?.messages.map((m) => m.id) ?? []);
  const newIds = fetched.messages.filter((m) => !known.has(m.id)).map((m) => m.id);
  // A message stored empty (an app's post read before its blocks were) whose text has now arrived
  // is new content: triage it again.
  const was = new Map(stored?.messages.map((m) => [m.id, m.text]) ?? []);
  const filled = fetched.messages.some((m) => was.get(m.id) === '' && m.text !== '');
  const edited = fetched.messages.some((m) => was.has(m.id) && was.get(m.id) !== m.text);
  const byId = new Map((stored?.messages ?? []).map((m) => [m.id, m]));
  for (const m of fetched.messages) byId.set(m.id, m); // an edited message replaces its old text
  const messages = [...byId.values()].sort((a, b) => a.ts.localeCompare(b.ts) || a.id.localeCompare(b.id)).slice(-MAX_STORED_MESSAGES);
  const participants = [...(stored?.participants ?? [])];
  for (const p of fetched.participants) if (!participants.some((q) => q.id === p.id)) participants.push(p);
  const mentioned = [...(fetched.mentioned ?? [])];
  for (const p of stored?.mentioned ?? []) if (!mentioned.some((q) => q.id === p.id)) mentioned.push(p);
  // A meeting joined to its calendar event stays joined, though the source doesn't say so (R2.8).
  const calendar = fetched.meeting?.calendar ?? stored?.meeting?.calendar;
  const meeting = fetched.meeting ? { ...fetched.meeting, ...(calendar && { calendar }) } : stored?.meeting;
  const lastActivityAt = [stored?.lastActivityAt, fetched.lastActivityAt]
    .filter((x): x is string => !!x)
    .sort()
    .at(-1)!;
  return {
    newIds,
    edited,
    item: {
      ...fetched,
      participants: participants.map((p) => fetched.participants.find((q) => q.id === p.id) ?? p), // fresher names
      ...(mentioned.length && { mentioned }),
      ...((fetched.thread || stored?.thread) && { thread: true }),
      messages,
      messageCount: Math.max(stored?.messageCount ?? 0, fetched.messageCount, messages.length),
      lastActivityAt,
      ...(meeting && { meeting }),
      // A file ahead of the log (a crash between the two) keeps its revision, so the poll logs it.
      revision: newIds.length || filled || prevRevision === undefined ? (prevRevision ?? 0) + 1 : Math.max(prevRevision, stored?.revision ?? 0),
    },
  };
}

export async function pollSource(d: PollDeps, source: SourceAdapter, reason: PollReason, signal: AbortSignal): Promise<PollStats> {
  const t0 = performance.now();
  const cursor = d.cursors.get(source.id, d.store.projection.sources[source.id]?.cursor);
  const refetch = d.refetch?.(source.id);
  const result = await source.fetchSince(cursor, { signal, now: d.now(), reason, ...(refetch?.length && { refetch }) });
  signal.throwIfAborted(); // asleep mid-poll: don't write half a picture

  const identity = source.identity?.();
  const me = identity?.id;
  const rules = d.rules?.();
  const now = d.now();
  const drafts: EventDraft[] = [];
  let changed = 0;
  let dropped = 0;
  let ruleDecided = 0;
  for (const fetched of d.enrich ? d.enrich(result.items) : result.items) {
    const prev = d.store.projection.items[fetched.id];
    // Read, merge and write under the item's lock: triage may be saving its text meanwhile.
    const r: { item?: Item; fromMeOnly?: boolean; fixed?: Extract<RuleVerdict, { kind: 'fixed' }>; sentByYou?: boolean; dropped?: boolean } = {};
    await d.items.update(fetched.source, fetched.id, (stored) => {
      // Without the file (retention, or a crash before it was written) the merge starts afresh.
      const { item, newIds, edited } = mergeItem(stored?.item, fetched, prev?.revision);
      if (prev && item.revision === prev.revision) {
        if (!edited || !stored) return undefined; // nothing the log doesn't have
        // Only text that changed: saved, and logged at the same revision so it isn't triaged again.
        r.item = item;
        return { ...stored, item };
      }
      const byId = new Map(item.messages.map((m) => [m.id, m]));
      // Recovering a file the log never heard of: who wrote what is unknown, so triage it again.
      const fromMeOnly = !!prev && !!me && newIds.length > 0 && newIds.every((id) => byId.get(id)?.authorId === me);
      const verdict = rules && !fromMeOnly ? ruleVerdict(item, rules.rules, rules.settings, meFrom(identity)) : undefined;
      if (verdict?.kind === 'drop' && !prev) {
        r.dropped = true;
        return undefined;
      }
      const fixed = verdict?.kind === 'fixed' ? verdict : undefined;
      const sentByYou = !prev && !fixed && item.kind === 'email' && !!me && item.messages.length > 0 && item.messages.every((m) => m.authorId === me);
      Object.assign(r, { item, fromMeOnly, fixed, sentByYou });
      // A rule's decision replaces the text of any earlier one, which described older messages.
      const summary = excerpt(item.messages[0]?.text) || item.title;
      const text = fixed ? { summary, reason: ruleReason(fixed) } : sentByYou ? { summary, reason: 'You sent this and nobody has answered yet.' } : stored?.text;
      return { item, text, ...(stored?.settle && { settle: stored.settle }), schemaVersion: 1 as const };
    });
    if (r.dropped) dropped++;
    if (!r.item) continue;
    const { item, fromMeOnly, fixed, sentByYou } = r;
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
        fromMeOnly: !!fromMeOnly,
      },
    });
    if (fixed) {
      drafts.push({ type: 'triage.decided', itemId: item.id, data: { decision: ruleDecision(item, fixed, now) } });
      ruleDecided++;
    } else if (sentByYou) {
      drafts.push({ type: 'triage.decided', itemId: item.id, data: { decision: sentByYouDecision(item, now) } });
      ruleDecided++;
    }
  }
  // Items the source closes itself (an invite answered in Outlook), after their updates above.
  let resolved = 0;
  for (const r of result.resolved ?? []) {
    const it = d.store.projection.items[r.itemId];
    if (!it || it.status === 'done' || it.source !== source.id) continue;
    drafts.push({ type: 'item.done', itemId: r.itemId, data: { by: 'source', reason: r.reason } });
    resolved++;
  }
  const durationMs = Math.round(performance.now() - t0);
  drafts.push({ type: 'source.polled', data: { source: source.id, reason, fetched: result.items.length, cursor: result.nextCursor, durationMs } });
  crashPoint('after-items');
  await d.store.append(...drafts);
  crashPoint('after-events');
  if (result.nextCursor) await d.cursors.set(source.id, result.nextCursor);
  crashPoint('after-cursor');
  await result.commit?.(); // the source's own state, only once what it read is saved
  d.logger?.info({ source: source.id, reason, fetched: result.items.length, changed, dropped, ruleDecided, resolved, durationMs }, 'Polled');
  return { fetched: result.items.length, changed, dropped, ruleDecided, resolved, cursor: result.nextCursor, durationMs };
}

function sentByYouDecision(item: Item, at: Date): LoggedDecision {
  return {
    itemId: item.id,
    itemRevision: item.revision,
    attention: 'none',
    confluence: { suggested: false },
    vault: { suggested: false },
    containsPeopleObservations: false,
    decidedBy: 'rule',
    ruleId: SENT_BY_YOU,
    decidedAt: at.toISOString(),
  };
}
