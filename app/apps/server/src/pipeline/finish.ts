import { SettleBatchOutput, finishQueue, londonParts, suggestFinished, type EventDraft, type ItemState, type Me, type Settings } from '@work-os/shared';
import { ClaudeOutputError } from '../claude/errors';
import { DEADLINES } from '../net/http';
import type { SettleSnapshot } from '../store/items';
import { SETTLE_MAX_PER_CALL, judge, type SettleAsk, type SettleDeps, type SettleRun } from './settle';
import { topicForTriage } from './topics';
import { estimateTokens, packBatches, threadTokens, type TriageMessage, type TriageThread } from './truncate';

// Looks finished (cockpit CK-2.10). A topic that waited on Frank was re-triaged after messages from
// others, and the model said None (a rule's floor may still hold it in Today). A short model call, separate from triage, decides whether those messages
// settled what it asked of him: someone did it or answered it, or the person who asked withdrew
// it. If every ask is settled, the topic looks finished and is suggested as Done. Nothing closes
// by itself: Frank accepts the suggestion or keeps the topic, and either answer is a label for
// the finish eval, which says when suggesting could become closing.
//
// Per batch, each snapshot goes into the item's file first (under its lock), then one append
// carries `finish.checked`. A check that can't be made or fails suggests nothing.

/** One check as the model gets it: the topic, the asks it had for Frank, and what came after. */
export interface FinishCheck {
  itemId: string;
  itemRevision: number;
  thread: TriageThread;
  asks: SettleAsk[];
  since: TriageMessage[];
}

/** Topics waiting for the check: open anchors whose decision asked for it, on a source it runs for. */
export function finishQueueOf(items: Iterable<ItemState>, settings: Pick<Settings, 'triage'>): ItemState[] {
  const on = suggestFinished(settings);
  return [...items].filter((it) => finishQueue(it) && on[it.source]);
}

/**
 * The check on a topic as it stands: undefined when its content or its earlier asks are gone, and
 * `since` empty when nothing came after the decision the asks are from.
 */
export async function finishCheckOf(d: Pick<SettleDeps, 'store' | 'items'>, it: ItemState, me: Me, keepLast: number): Promise<{ revision: number; check: FinishCheck } | undefined> {
  const topic = await topicForTriage(d.store.projection, d.items, it.id, me, keepLast);
  const f = topic?.anchor.finish;
  if (!topic || !f) return undefined;
  return {
    revision: topic.anchor.item.revision,
    check: { itemId: it.id, itemRevision: it.revision, thread: topic.view, asks: f.asks, since: topic.view.messages.filter((m) => m.at > f.since) },
  };
}

const hhmm = (d: Date) => {
  const p = londonParts(d);
  return `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`;
};

/** The user message: the time, then the checks. */
export function renderFinishChecks(checks: FinishCheck[], now: Date): string {
  return [
    `Now: ${now.toISOString()} (${londonParts(now).weekday} ${hhmm(now)} in London)`,
    `Check ${checks.length === 1 ? 'this topic' : `these ${checks.length} topics`}. Answer with the JSON only.`,
    '<checks>',
    JSON.stringify(checks),
    '</checks>',
  ].join('\n');
}

/** Checks every topic waiting for one. Throws ClaudeError (for health) or the abort reason; batches that finished before stay. */
export async function runFinish(d: SettleDeps, signal: AbortSignal): Promise<SettleRun> {
  const { settings } = d.config();
  const run: SettleRun = { calls: 0, checked: 0, closed: 0, failed: 0, paused: 0 };
  const queue = finishQueueOf(Object.values(d.store.projection.items), settings);
  if (!queue.length) return run;
  if (d.budgetHit()) return { ...run, paused: queue.length };

  const failed = (it: ItemState, reason: string): EventDraft => ({ type: 'finish.failed', itemId: it.id, data: { revision: it.revision, reason } });
  const checks: { it: ItemState; check: FinishCheck }[] = [];
  const unusable: EventDraft[] = [];
  for (const it of queue) {
    const c = await finishCheckOf(d, it, d.me(it.source), settings.triage.keepLastMessages);
    if (!c) unusable.push(failed(it, 'content missing'));
    else if (c.revision !== it.revision) continue; // a poll is between its file and its log entry
    else if (!c.check.since.length) unusable.push(failed(it, 'nothing new since the asks'));
    else checks.push({ it, check: c.check });
  }
  if (unusable.length) {
    await d.store.append(...unusable);
    run.failed += unusable.length;
  }

  const prompt = await d.prompt();
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
    const batchId = `finish-${at.toISOString()}-${n + 1}`;
    let answer: SettleBatchOutput;
    try {
      const r = await d.claude.structured(
        {
          purpose: 'settle',
          model: settings.models.triage,
          system: prompt.text,
          prompt: renderFinishChecks(
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
      // Claude itself failed: these wait for the next run, and health hears of it.
      throw err;
    }

    const byId = new Map(answer.decisions.map((a) => [a.itemId, a]));
    const events: EventDraft[] = [];
    for (const { it, check } of batch) {
      const a = byId.get(it.id);
      if (!a || a.itemRevision !== it.revision) {
        events.push(failed(it, 'missing from the answer'));
        run.failed++;
        continue;
      }
      const v = judge(check, a);
      const snapshot: SettleSnapshot = { at: at.toISOString(), batchId, model: settings.models.triage, promptVersion: prompt.version, input: { ...check }, decision: a, ...(v.why && { why: v.why }) };
      // Someone wrote meanwhile, or Frank already answered it: this check no longer applies.
      const current = () => {
        const now = d.store.projection.items[it.id];
        return !!now && now.revision === it.revision && now.topicVersion === it.topicVersion && finishQueue(now);
      };
      const saved = await d.items.update(it.source, it.id, (stored) => (stored?.finish && stored.item.revision === it.revision && current() ? { ...stored, finish: { ...stored.finish, check: snapshot } } : undefined));
      if (!saved) continue;
      events.push({ type: 'finish.checked', itemId: it.id, data: { revision: it.revision, batchId, allSettled: v.allSettled } });
      if (v.allSettled) run.closed++;
      run.checked++;
    }
    if (events.length) await d.store.append(...events);
  }
  d.logger?.info({ ...run }, 'Finish checks');
  return run;
}
