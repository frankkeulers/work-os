import {
  Attention,
  NextStep,
  askId,
  effectiveTriage,
  londonAt,
  londonParts,
  ruleFloor,
  suggestFinished,
  toLoggedDecision,
  type EarlierView,
  type EventDraft,
  type Item,
  type ItemState,
  type Me,
  type Rule,
  type Settings,
  type SourceId,
  type TriageDecision,
} from '@work-os/shared';
import { z } from 'zod';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import type { ItemFiles } from '../store/items';
import type { SnapEvent } from '../sources/calendar/store';
import type { Store } from '../store/store';
import { triageQueue } from './eligibility';
import { ruleVerdict } from './rules';
import { openAsks } from './settle';
import { routeTopics, topicForTriage } from './topics';
import { estimateTokens, packBatches, threadTokens, type TriageThread } from './truncate';

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
  /** Frank in a source (Slack by default): his own messages show as "me". */
  me: (source?: SourceId) => Me;
  prompt: () => Promise<Prompt>;
  /** A DM item's earlier conversation, for context. A failure is logged and triage goes ahead without it. */
  earlier?: (item: Item, signal?: AbortSignal) => Promise<EarlierView>;
  /** Today's triage calls or cost-equivalent are at their budget (CL-6). */
  budgetHit: () => boolean;
  /** The topics prompt (amendment). Without it, routing is off and every piece is its own topic. */
  topicsPrompt?: () => Promise<Prompt>;
  /** Frank's timed meetings today, while the calendar is read (cockpit CK-3.9). */
  meetings?: (now: Date) => TodayMeeting[];
}

export interface TriageRun {
  calls: number;
  triaged: number;
  failed: number;
  /** Quiet and waiting, but not sent: the budget is spent. */
  paused: number;
  nextReadyAt?: Date;
}

/** A meeting the model can resolve "before the exec sync" against (cockpit CK-3.9): its title and start. */
export interface TodayMeeting {
  title: string;
  start: string;
}

const MAX_MEETINGS = 15;
const hhmm = (d: Date | string) => {
  const p = londonParts(d);
  return `${String(p.hours).padStart(2, '0')}:${String(p.minutes).padStart(2, '0')}`;
};

/** Frank's timed meetings today, London time: not cancelled, declined, all-day or shown as free. Titles only. */
export function meetingsToday(events: readonly SnapEvent[], now: Date): TodayMeeting[] {
  const from = Date.parse(londonAt(now, '00:00'));
  const to = Date.parse(londonAt(now, '00:00', 1));
  return events
    .filter((e) => !e.cancelled && !e.allDay && e.response !== 'declined' && e.showAs?.toLowerCase() !== 'free')
    .filter((e) => Date.parse(e.start) >= from && Date.parse(e.start) < to)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
    .slice(0, MAX_MEETINGS)
    .map((e) => ({ title: e.subject || '(no title)', start: e.start }));
}

/** The user message: the time (UTC and London, for deadlines), today's meetings if any, then the threads. */
export function renderBatch(threads: TriageThread[], now: Date, meetings: readonly TodayMeeting[] = []): string {
  const calendar = meetings.length ? ['<calendar>', JSON.stringify(meetings.map((m) => ({ title: m.title, start: m.start, london: hhmm(m.start) }))), '</calendar>'] : [];
  return [
    `Now: ${now.toISOString()} (${londonParts(now).weekday} ${hhmm(now)} in London)`,
    ...calendar,
    `Triage ${threads.length === 1 ? 'this thread' : `these ${threads.length} threads`}. Answer with the JSON only.`,
    '<threads>',
    JSON.stringify(threads),
    '</threads>',
  ].join('\n');
}

/**
 * Triages what is due: the quiet pending items, or with `only`, those items whatever their state
 * and quiet window ("Try again" on a failed item). Throws ClaudeError (for health) or the abort
 * reason; decisions from calls that finished before stay.
 */
export async function runTriage(d: TriageDeps, signal: AbortSignal, opts: { only?: string[] } = {}): Promise<TriageRun> {
  const { settings, rules } = d.config();
  const t = settings.triage;
  // New pieces find their topic first, so each topic is triaged once, over all its pieces.
  const routing = !opts.only && d.topicsPrompt ? await routeTopics({ ...d, topicsPrompt: d.topicsPrompt }, signal) : undefined;
  const now = d.now();
  const queue = triageQueue(Object.values(d.store.projection.items), now, t.quietMinutes);
  const due = opts.only ? opts.only.map((id) => d.store.projection.items[id]).filter((i) => !!i) : queue.ready;
  const run: TriageRun = { calls: routing?.calls ?? 0, triaged: 0, failed: 0, paused: 0, ...(queue.nextReadyAt && { nextReadyAt: queue.nextReadyAt }) };
  if (!due.length) return run;
  if (d.budgetHit()) return { ...run, paused: due.length };

  // What the model sees of each thread. An item whose file is gone can't be triaged: it fails
  // once, visibly, instead of being retried on every tick.
  // A topic is triaged through its anchor, over all its pieces.
  const threads: { item: Item; topic: Item; state: ItemState; thread: TriageThread; topicVersion: number; asksDone: string[] }[] = [];
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
    const topic = await topicForTriage(d.store.projection, d.items, it.id, d.me(it.source), t.keepLastMessages, earlier);
    if (!topic) continue;
    const asksDone = it.asksDone ?? [];
    const done = (stored.text?.next?.asks ?? []).filter((a) => asksDone.includes(askId(a.step))).map((a) => a.step);
    if (done.length) topic.view.done = done;
    threads.push({ item: stored.item, topic: topic.item, state: it, thread: topic.view, topicVersion: it.topicVersion, asksDone });
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
            d.meetings?.(at),
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
    for (const { item, topic, state, topicVersion, asksDone } of batch) {
      const a = byId.get(item.id);
      if (!a) {
        events.push({ type: 'triage.failed', itemId: item.id, data: { revision: item.revision, attempts: 1, reason: 'missing from the answer' } });
        run.failed++;
        continue;
      }
      // A rule that sends to the model may send the thread to To file, or set a floor (FR-4.3). The
      // floor holds only while what came after Frank's last message in the topic still matches it.
      const me = d.me(item.source);
      const verdict = ruleVerdict(item, rules, settings, me);
      const toFile = verdict.kind === 'model' && verdict.file ? verdict.rule : undefined;
      const floor = verdict.kind === 'model' && !toFile ? ruleFloor(topic, rules, settings, me) : undefined;
      const attention = toFile ? 'none' : atLeast(a.attention, floor?.min);
      const ruleId = (toFile ?? floor?.rule)?.id;
      // Never Confluence for observations about people (NF-2, FR-10.1).
      const confluence = a.containsPeopleObservations ? { suggested: false } : a.confluence;
      // To file needs a destination: the model's, or the vault when it suggested neither.
      const vault = toFile && !confluence.suggested && !a.vault.suggested ? { suggested: true } : a.vault;
      // An ask Frank ticked off stays off, even if the model lists it again.
      const next = a.next?.asks ? { ...a.next, asks: a.next.asks.filter((x) => !asksDone.includes(askId(x.step))) } : a.next;
      const decision: TriageDecision = {
        itemId: item.id,
        itemRevision: item.revision,
        topicVersion,
        attention,
        confluence,
        vault,
        containsPeopleObservations: a.containsPeopleObservations,
        summary: a.summary,
        reason: a.reason,
        ...(next && { next }),
        decidedBy: 'model',
        ...(ruleId && { ruleId }),
        ...(attention !== a.attention && { modelAttention: a.attention }),
        model: settings.models.triage,
        promptVersion: prompt.version,
        batchId,
        decidedAt: d.now().toISOString(),
      };
      // A topic that waited on Frank, with new content since, that the model now says needs nothing
      // from him, not even filing: a check of whether the new messages settled his asks follows
      // (CK-2.10). The model's answer counts, not a rule's floor on it: a mention others answered
      // stays in Today, and the check may then suggest it as finished there. The asks come from the
      // decision this one replaces, kept with the item's content.
      const before = state.decision;
      const was = effectiveTriage(state.decision, state.correction)?.attention;
      const moved = !!before && (item.revision > before.itemRevision || topicVersion > (before.topicVersion ?? 0));
      const finishCheck = state.status === 'open' && (was === 'now' || was === 'today') && moved && a.attention === 'none' && !toFile && !confluence.suggested && !vault.suggested && suggestFinished(settings)[item.source];
      // The thread moved on during the call, or the topic's parts changed: the new content waits its turn.
      const current = () => d.store.projection.items[item.id]?.topicVersion === topicVersion;
      const saved = await d.items.update(item.source, item.id, (stored) => {
        if (!stored || stored.item.revision !== item.revision || !current()) return undefined;
        const { finish: _finish, ...rest } = stored;
        const asks = finishCheck ? openAsks(stored.text, asksDone) : [];
        return { ...rest, text: { summary: a.summary, reason: a.reason, ...(next && { next }) }, ...(asks.length > 0 && before && { finish: { asks, since: before.decidedAt } }) };
      });
      if (!saved) continue;
      events.push({ type: 'triage.decided', itemId: item.id, data: { decision: toLoggedDecision(decision), ...(finishCheck && saved.finish && { finishCheck: true as const }) } });
      run.triaged++;
    }
    if (events.length) await d.store.append(...events);
  }
  d.logger?.info({ ...run, nextReadyAt: run.nextReadyAt?.toISOString() }, 'Triaged');
  return run;
}
