import { Attention, NextStep, toLoggedDecision, type EarlierView, type EventDraft, type Item, type Me, type Rule, type Settings, type TriageDecision } from '@work-os/shared';
import { z } from 'zod';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import type { ItemFiles } from '../store/items';
import type { Store } from '../store/store';
import { triageQueue } from './eligibility';
import { ruleVerdict } from './rules';
import { estimateTokens, packBatches, threadForTriage, threadTokens, type TriageThread } from './truncate';

// Batched model triage (FR-5.1–5.5, §5.3, CL-6, CL-7). Quiet pending threads go to the model in as
// few calls as the limits allow; nothing eligible means no call. The budget is checked before
// every call: once it is spent, the queue waits (rules still decide at ingest) and the inbox says
// so. Each decision is for the revision the model saw: if the thread moved on meanwhile, the
// projection ignores it and the newer revision is triaged later.
//
// Per item, in order: the decision's text goes into its file (under the item's lock, and only if
// the file is still that revision), then `triage.decided` goes into the log. A crash in between
// leaves the item pending, and it is triaged again.

const Filing = z.object({ suggested: z.boolean(), targetHint: z.string().min(1).optional() });

/** What the model must answer (FR-5.3); checked with zod, one retry (CL-7). */
export const TriageAnswer = z.object({
  decisions: z.array(
    z.object({
      id: z.string().min(1),
      attention: Attention,
      confluence: Filing,
      vault: Filing,
      containsPeopleObservations: z.boolean(),
      summary: z.string().min(1).max(200),
      reason: z.string().min(1).max(400),
      next: NextStep.optional(),
    }),
  ),
});
export type TriageAnswer = z.infer<typeof TriageAnswer>;

const RANK: Record<Attention, number> = { none: 0, today: 1, now: 2 };
const atLeast = (a: Attention, min?: Attention): Attention => (min && RANK[min] > RANK[a] ? min : a);

export interface TriageDeps {
  store: Store;
  items: ItemFiles;
  claude: ClaudeAdapter;
  now: () => Date;
  logger?: Logger;
  config: () => { settings: Settings; rules: Rule[] };
  me: () => Me;
  prompt: () => Promise<Prompt>;
  /** A DM item's earlier conversation, for context. A failure is logged and triage goes ahead without it. */
  earlier?: (item: Item, signal?: AbortSignal) => Promise<EarlierView>;
  /** Today's triage calls or cost-equivalent are at their budget (CL-6). */
  budgetHit: () => boolean;
}

export interface TriageRun {
  calls: number;
  triaged: number;
  failed: number;
  /** Quiet and waiting, but not sent: the budget is spent. */
  paused: number;
  nextReadyAt?: Date;
}

export function renderBatch(threads: TriageThread[], now: Date): string {
  return [`Now: ${now.toISOString()}`, `Triage ${threads.length === 1 ? 'this thread' : `these ${threads.length} threads`}. Answer with the JSON only.`, '<threads>', JSON.stringify(threads), '</threads>'].join('\n');
}

/**
 * Triages what is due: the quiet pending items, or with `only`, those items whatever their state
 * and quiet window ("Try again" on a failed item). Throws ClaudeError (for health) or the abort
 * reason; decisions from calls that finished before stay.
 */
export async function runTriage(d: TriageDeps, signal: AbortSignal, opts: { only?: string[] } = {}): Promise<TriageRun> {
  const { settings, rules } = d.config();
  const t = settings.triage;
  const now = d.now();
  const queue = triageQueue(Object.values(d.store.projection.items), now, t.quietMinutes);
  const due = opts.only ? opts.only.map((id) => d.store.projection.items[id]).filter((i) => !!i) : queue.ready;
  const run: TriageRun = { calls: 0, triaged: 0, failed: 0, paused: 0, ...(queue.nextReadyAt && { nextReadyAt: queue.nextReadyAt }) };
  if (!due.length) return run;
  if (d.budgetHit()) return { ...run, paused: due.length };

  // What the model sees of each thread. An item whose file is gone can't be triaged: it fails
  // once, visibly, instead of being retried on every tick.
  const me = d.me();
  const threads: { item: Item; thread: TriageThread }[] = [];
  const missing: EventDraft[] = [];
  for (const it of due) {
    const stored = await d.items.read(it.source, it.id);
    if (!stored) {
      missing.push({ type: 'triage.failed', itemId: it.id, data: { revision: it.revision, attempts: 1, reason: 'content missing' } });
      continue;
    }
    if (stored.item.revision !== it.revision) continue; // a poll is between its file and its log entry
    let earlier: EarlierView | undefined;
    if (stored.item.kind === 'dm' && d.earlier) {
      earlier = await d.earlier(stored.item, signal).catch((err: unknown) => {
        if (signal.aborted) throw err;
        d.logger?.warn({ itemId: it.id, err: String(err) }, 'Could not read the conversation before a DM; triaging without it');
        return undefined;
      });
    }
    threads.push({ item: stored.item, thread: threadForTriage(stored.item, me, t.keepLastMessages, earlier) });
  }
  if (missing.length) {
    await d.store.append(...missing);
    run.failed += missing.length;
  }

  const prompt = await d.prompt();
  const batches = packBatches(threads, (x) => threadTokens(x.thread), { maxThreads: t.maxThreadsPerCall, maxInputTokens: t.maxInputTokens, overheadTokens: estimateTokens(prompt.text) + 200 });
  for (const [n, batch] of batches.entries()) {
    if (n > 0 && d.budgetHit()) {
      run.paused += batches.slice(n).reduce((k, b) => k + b.length, 0);
      break;
    }
    const at = d.now();
    const batchId = `batch-${at.toISOString()}-${n + 1}`;
    const itemIds = batch.map((x) => x.item.id);
    let answer: TriageAnswer;
    try {
      const r = await d.claude.structured(
        {
          purpose: 'triage',
          model: settings.models.triage,
          system: prompt.text,
          prompt: renderBatch(
            batch.map((x) => x.thread),
            at,
          ),
          promptVersion: prompt.version,
          timeoutMs: DEADLINES.triage,
          signal,
          itemIds,
        },
        TriageAnswer,
      );
      run.calls += r.usage.length;
      answer = r.value;
    } catch (err) {
      if (!(err instanceof ClaudeOutputError)) throw err;
      run.calls += err.attempts;
      // Twice out of shape: shown in the inbox untriaged, with "Try again" (CL-7).
      await d.store.append(...batch.map((x): EventDraft => ({ type: 'triage.failed', itemId: x.item.id, data: { revision: x.item.revision, attempts: err.attempts, reason: 'output did not match the schema' } })));
      run.failed += batch.length;
      continue;
    }

    const byId = new Map(answer.decisions.map((a) => [a.id, a]));
    const events: EventDraft[] = [];
    for (const { item } of batch) {
      const a = byId.get(item.id);
      if (!a) {
        events.push({ type: 'triage.failed', itemId: item.id, data: { revision: item.revision, attempts: 1, reason: 'missing from the answer' } });
        run.failed++;
        continue;
      }
      // A rule that sends to the model may set a floor (FR-4.3), or send the thread to To file.
      const verdict = ruleVerdict(item, rules, settings, me);
      const floor = verdict.kind === 'model' ? verdict.min : undefined;
      const toFile = verdict.kind === 'model' && verdict.file;
      // Never Confluence for observations about people (NF-2, FR-10.1).
      const confluence = a.containsPeopleObservations ? { suggested: false } : a.confluence;
      // To file needs a destination: the model's, or the vault when it suggested neither.
      const vault = toFile && !confluence.suggested && !a.vault.suggested ? { suggested: true } : a.vault;
      const decision: TriageDecision = {
        itemId: item.id,
        itemRevision: item.revision,
        attention: toFile ? 'none' : atLeast(a.attention, floor),
        confluence,
        vault,
        containsPeopleObservations: a.containsPeopleObservations,
        summary: a.summary,
        reason: a.reason,
        ...(a.next && { next: a.next }),
        decidedBy: 'model',
        ...((floor || toFile) && verdict.kind === 'model' && verdict.rule && { ruleId: verdict.rule.id }),
        model: settings.models.triage,
        promptVersion: prompt.version,
        batchId,
        decidedAt: d.now().toISOString(),
      };
      const saved = await d.items.update(item.source, item.id, (stored) =>
        stored && stored.item.revision === item.revision ? { ...stored, text: { summary: a.summary, reason: a.reason, ...(a.next && { next: a.next }) } } : undefined,
      );
      if (!saved) continue; // the thread moved on during the call; its new revision waits its turn
      events.push({ type: 'triage.decided', itemId: item.id, data: { decision: toLoggedDecision(decision) } });
      run.triaged++;
    }
    if (events.length) await d.store.append(...events);
  }
  d.logger?.info({ ...run, nextReadyAt: run.nextReadyAt?.toISOString() }, 'Triaged');
  return run;
}
