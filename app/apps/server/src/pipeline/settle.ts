import {
  SETTLE_MAX_ATTEMPTS,
  SettleBatchOutput,
  askId,
  awaitsReply,
  closeOnReply,
  londonParts,
  type EventDraft,
  type ItemState,
  type Me,
  type Need,
  type NextStep,
  type Settings,
  type SettleDecision,
  type SourceId,
} from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import type { ItemFiles, SettleSnapshot } from '../store/items';
import type { Store } from '../store/store';
import { topicForTriage } from './topics';
import { estimateTokens, packBatches, threadTokens, type TriageMessage, type TriageThread } from './truncate';

// Settle checks on Frank's replies (cockpit CK-2.1–2.3). When Frank answers an open item in Needs
// you or This week, a short model call, separate from triage, decides whether his reply settles
// the item's open asks. There is no quiet window: his message ends his turn.
//
// Per batch, the snapshot and the reason go into each item's file first (under its lock), then one
// append carries `settle.checked`, a `topic.askDone` per settled ask of a topic with several, and
// `item.done` when every ask is settled and closing is on. A crash in between leaves the item
// waiting, and it is checked again. A failed check retries on the next poll, and after the third
// failure the item stays as it is: nothing closes on a failure.

/** At most this many checks in one call (CK-2.2), and fewer if triage's own limit is lower. */
export const SETTLE_MAX_PER_CALL = 20;

export interface SettleDeps {
  store: Store;
  items: ItemFiles;
  claude: ClaudeAdapter;
  now: () => Date;
  logger?: Logger;
  config: () => { settings: Settings };
  me: (source?: SourceId) => Me;
  prompt: () => Promise<Prompt>;
  /** Today's triage calls or cost-equivalent are at their budget (CL-6). Settle counts towards it. */
  budgetHit: () => boolean;
}

export interface SettleRun {
  calls: number;
  checked: number;
  closed: number;
  failed: number;
  /** Waiting, but not sent: the budget is spent. */
  paused: number;
}

/** One ask as the model sees it: its place in the list is the index it answers with. */
export interface SettleAsk {
  index: number;
  need: Need;
  step: string;
}

/** One check as sent: the thread as triage sees it, the open asks and Frank's reply. */
export interface SettleCheck {
  itemId: string;
  itemRevision: number;
  thread: TriageThread;
  asks: SettleAsk[];
  reply: Pick<TriageMessage, 'at' | 'text'>[];
}

/** The items whose reply waits for a check: anchors still in Needs you or This week, on a source the check runs for. */
export function settleQueue(items: Iterable<ItemState>, settings: Pick<Settings, 'triage'>): ItemState[] {
  const on = closeOnReply(settings).sources;
  return [...items].filter((it) => !!it.settlePending && !it.topicOf && on[it.source] && awaitsReply(it));
}

/** The asks still open: a topic's unticked asks, or the next step alone, or the summary as a reply. */
export function openAsks(text: { summary?: string; next?: NextStep } | undefined, asksDone: string[] = []): SettleAsk[] {
  const next = text?.next;
  const list = next?.asks?.length ? next.asks.filter((a) => !asksDone.includes(askId(a.step))) : next ? [next] : [{ need: 'reply' as const, step: text?.summary ?? 'Reply' }];
  return list.map((a, index) => ({ index, need: a.need, step: a.step }));
}

/**
 * The check on an item's reply, as the model gets it, built from the topic's content now: no
 * `messageId` when Frank hasn't written after the others. Undefined when the content is gone.
 */
export async function settleCheckOf(d: Pick<SettleDeps, 'store' | 'items'>, it: ItemState, me: Me, keepLast: number): Promise<{ revision: number; messageId?: string; check: SettleCheck } | undefined> {
  const topic = await topicForTriage(d.store.projection, d.items, it.id, me, keepLast);
  if (!topic) return undefined;
  const reply = trailingReply(topic.view.messages);
  const last = topic.item.messages.findLast((m) => m.authorId === me.id);
  return {
    revision: topic.anchor.item.revision,
    ...(reply.length > 0 && last && { messageId: last.id }),
    check: { itemId: it.id, itemRevision: it.revision, thread: topic.view, asks: openAsks(topic.anchor.text, it.asksDone), reply: reply.map((m) => ({ at: m.at, text: m.text })) },
  };
}

/** Frank's reply: his messages after the last one from anyone else. */
export function trailingReply(messages: readonly TriageMessage[]): TriageMessage[] {
  let i = messages.length;
  while (i > 0 && messages[i - 1].author === 'me') i--;
  return messages.slice(i);
}

const hhmm = (d: Date) => {
  const p = londonParts(d);
  return `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`;
};

/** The user message: the time, then the checks. */
export function renderChecks(checks: SettleCheck[], now: Date): string {
  return [
    `Now: ${now.toISOString()} (${londonParts(now).weekday} ${hhmm(now)} in London)`,
    `Check ${checks.length === 1 ? 'this reply' : `these ${checks.length} replies`}. Answer with the JSON only.`,
    '<checks>',
    JSON.stringify(checks),
    '</checks>',
  ].join('\n');
}

/**
 * The model's answer for one check, held to the asks it was given: an ask it left out counts as
 * not settled, so the item closes only when every ask it was sent is settled.
 */
export function judge(check: SettleCheck, d: SettleDecision): { settled: SettleAsk[]; allSettled: boolean; why?: string } {
  const verdict = new Map(d.asks.filter((a) => a.index < check.asks.length).map((a) => [a.index, a]));
  const settled = check.asks.filter((a) => verdict.get(a.index)?.settled);
  const open = check.asks.find((a) => !verdict.get(a.index)?.settled);
  const why = open && verdict.get(open.index)?.why;
  return { settled, allSettled: !open, ...(why && { why }) };
}

/** Checks every reply waiting for one. Throws ClaudeError (for health) or the abort reason; batches that finished before stay. */
export async function runSettle(d: SettleDeps, signal: AbortSignal): Promise<SettleRun> {
  const { settings } = d.config();
  const run: SettleRun = { calls: 0, checked: 0, closed: 0, failed: 0, paused: 0 };
  const queue = settleQueue(Object.values(d.store.projection.items), settings);
  if (!queue.length) return run;
  if (d.budgetHit()) return { ...run, paused: queue.length };

  const failed = (it: ItemState, reason: string, attempts = (it.settleFailures ?? 0) + 1): EventDraft => ({ type: 'settle.failed', itemId: it.id, data: { revision: it.revision, attempts: Math.min(attempts, SETTLE_MAX_ATTEMPTS), reason } });

  const checks: { it: ItemState; check: SettleCheck; through: string; messageId: string }[] = [];
  const unusable: EventDraft[] = [];
  for (const it of queue) {
    const c = await settleCheckOf(d, it, d.me(it.source), settings.triage.keepLastMessages);
    if (!c) {
      unusable.push(failed(it, 'content missing', SETTLE_MAX_ATTEMPTS));
      continue;
    }
    if (c.revision !== it.revision) continue; // a poll is between its file and its log entry
    if (!c.messageId) {
      unusable.push(failed(it, 'no reply from you after the others', SETTLE_MAX_ATTEMPTS));
      continue;
    }
    checks.push({ it, through: it.settlePending!, messageId: c.messageId, check: c.check });
  }
  if (unusable.length) {
    await d.store.append(...unusable);
    run.failed += unusable.length;
  }

  const prompt = await d.prompt();
  const close = closeOnReply(settings).enabled;
  const batches = packBatches(checks, (x) => threadTokens(x.check.thread) + estimateTokens(JSON.stringify(x.check.asks)), {
    maxThreads: Math.min(SETTLE_MAX_PER_CALL, settings.triage.maxThreadsPerCall),
    maxInputTokens: settings.triage.maxInputTokens,
    overheadTokens: estimateTokens(prompt.text) + 200,
  });
  for (const [n, batch] of batches.entries()) {
    if (n > 0 && d.budgetHit()) {
      run.paused += batches.slice(n).reduce((k, b) => k + b.length, 0);
      break;
    }
    const at = d.now();
    const batchId = `settle-${at.toISOString()}-${n + 1}`;
    let answer: SettleBatchOutput;
    try {
      const r = await d.claude.structured(
        {
          purpose: 'settle',
          model: settings.models.triage,
          system: prompt.text,
          prompt: renderChecks(
            batch.map((x) => x.check),
            at,
          ),
          promptVersion: prompt.version,
          timeoutMs: DEADLINES.triage,
          signal,
          itemIds: batch.map((x) => x.it.id),
        },
        SettleBatchOutput,
      );
      run.calls += r.usage.length;
      answer = r.value;
    } catch (err) {
      if (signal.aborted) throw err; // cut off by sleep: not a failure
      run.failed += batch.length;
      if (err instanceof ClaudeOutputError) {
        run.calls += err.attempts;
        await d.store.append(...batch.map((x) => failed(x.it, 'output did not match the schema')));
        continue;
      }
      // Claude itself failed: these replies count an attempt, and health hears of it.
      await d.store.append(...batch.map((x) => failed(x.it, 'claude unavailable')));
      throw err;
    }

    const byId = new Map(answer.decisions.map((a) => [a.itemId, a]));
    const events: EventDraft[] = [];
    for (const { it, check, through, messageId } of batch) {
      const a = byId.get(it.id);
      if (!a || a.itemRevision !== it.revision) {
        events.push(failed(it, 'missing from the answer'));
        run.failed++;
        continue;
      }
      const v = judge(check, a);
      const snapshot: SettleSnapshot = { at: at.toISOString(), batchId, model: settings.models.triage, promptVersion: prompt.version, input: { ...check }, decision: a, ...(v.why && { why: v.why }) };
      // Someone else wrote meanwhile, or the item left Needs you: this check no longer applies.
      const current = () => {
        const now = d.store.projection.items[it.id];
        return !!now && now.revision === it.revision && now.topicVersion === it.topicVersion && awaitsReply(now);
      };
      const saved = await d.items.update(it.source, it.id, (stored) => (stored && stored.item.revision === it.revision && current() ? { ...stored, settle: snapshot } : undefined));
      if (!saved) continue;
      events.push({ type: 'settle.checked', itemId: it.id, data: { revision: it.revision, through, batchId, allSettled: v.allSettled, settled: v.settled.map((x) => askId(x.step)) } });
      // A topic's asks tick off one by one; a single ask is the item itself.
      if (check.asks.length > 1 && !v.allSettled) for (const x of v.settled) events.push({ type: 'topic.askDone', itemId: it.id, data: { askId: askId(x.step), by: 'reply' } });
      if (v.allSettled && close) {
        events.push({ type: 'item.done', itemId: it.id, data: { by: 'reply', source: it.source, messageId, check: batchId } });
        run.closed++;
      }
      run.checked++;
    }
    if (events.length) await d.store.append(...events);
  }
  d.logger?.info({ ...run }, 'Settle checks');
  return run;
}
