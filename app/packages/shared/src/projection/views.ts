import type { BudgetState, ClosedByReply, ItemSummary } from '../api';
import { effectiveTriage, laneFor, viewLane } from '../lanes';
import type { ActionType, NextStep, Settings, UsageRecord } from '../schemas';
import { askId } from './topics';
import { londonParts } from '../time';
import type { ActionState, ItemFlags, ItemMeta } from './state';

// Read-side views built from the projection. The server and the mock build the inbox the same way.

const MIN = 60_000;
const SUMMARY_MAX = 110;

type ActionLike = Pick<ActionState, 'id' | 'type' | 'status' | 'supersedes' | 'createdAt'>;

/**
 * The action that stands for a type: the newest one that wasn't discarded or replaced by a re-draft.
 * `actions` must be newest first. A failed draft stays failed after its Retry, and must not come back
 * when that retry is discarded; a filed entry does come back when a later version is discarded.
 */
export function currentAction<A extends ActionLike>(actions: readonly A[], type: ActionType): A | undefined {
  const replaced = new Set(actions.map((a) => a.supersedes));
  return actions.find((a) => a.type === type && a.status !== 'discarded' && !replaced.has(a.id));
}

/** An entry's version: the entries of its type filed before it, plus one. Failed, retried and discarded drafts don't count. */
export function entryVersion(actions: readonly ActionLike[], a: ActionLike): number {
  return 1 + actions.filter((b) => b.type === a.type && b.status === 'done' && b.id !== a.id && b.createdAt < a.createdAt).length;
}

/** The current action per type (see currentAction). `actions` must be newest first. */
export function actionSummaries(actions: Iterable<ActionState>, revision: number): ItemSummary['actions'] {
  const all = [...actions];
  const out: ItemSummary['actions'] = {};
  for (const type of ['confluence_entry', 'vault_note'] as const) {
    const a = currentAction(all, type);
    if (!a) continue;
    const repliesSince = a.itemRevision < revision;
    out[type] = { id: a.id, type, status: a.status, failureReason: a.failureReason, stale: a.status === 'ready' && repliesSince, repliesSince, version: entryVersion(all, a) };
  }
  return out;
}

/** The decision's free text, which lives with the raw content in items/, not in the log. */
export interface DecisionText {
  summary?: string;
  reason?: string;
  next?: NextStep;
  firstMessage?: string; // shown, shortened, until the item has a summary
  settleWhy?: string; // the last settle check's reason an ask is still open (CK-2.3)
}

export interface SummaryContext {
  actions: Iterable<ActionState>; // this item's actions, newest first
  quietMinutes: number;
  now: string;
  triageBudgetHit: boolean;
  text: DecisionText;
}

/**
 * The next step once Frank has ticked off some of a topic's asks: the first ask still open, or none
 * when all are done. A topic without asks keeps its next step.
 */
export function openNext(next: NextStep | undefined, asksDone: string[] = []): NextStep | undefined {
  if (!next?.asks?.length || !asksDone.length) return next;
  const open = next.asks.filter((a) => !asksDone.includes(askId(a.step)));
  if (!open.length) return undefined;
  if (!asksDone.includes(askId(next.step))) return next;
  const [first] = open;
  return { need: first.need, step: first.step, why: '', ...(first.dueAt && { dueAt: first.dueAt }), ...(first.dueLabel && { dueLabel: first.dueLabel }), asks: next.asks };
}

export function summaryOf(meta: Omit<ItemMeta, 'participants' | 'messageCount'>, s: ItemFlags, ctx: SummaryContext): ItemSummary {
  const d = s.decision;
  const quietUntil = s.triageState === 'pending' ? new Date(Date.parse(meta.lastActivityAt) + ctx.quietMinutes * MIN).toISOString() : undefined;
  const first = ctx.text.firstMessage ?? '';
  const next = openNext(ctx.text.next, s.asksDone);
  return {
    id: meta.id,
    source: meta.source,
    kind: meta.kind,
    title: meta.title,
    permalink: meta.permalink,
    lastActivityAt: meta.lastActivityAt,
    revision: meta.revision,
    lane: viewLane(laneFor(s), next, ctx.now),
    status: s.status,
    triageState: s.triageState,
    summary: ctx.text.summary ?? (first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX - 3)}…` : first),
    reason: ctx.text.reason,
    next,
    triage: effectiveTriage(d, s.correction),
    correctedFrom: s.correctedFrom,
    containsPeopleObservations: d?.containsPeopleObservations ?? false,
    targetHints: { confluence: d?.confluence.targetHint, vault: d?.vault.targetHint },
    actions: actionSummaries(ctx.actions, meta.revision),
    newReplies: s.newReplies,
    backFromSnooze: s.backFromSnooze,
    modelPaused: s.triageState === 'pending' && ctx.triageBudgetHit && !!quietUntil && quietUntil <= ctx.now,
    snoozedUntil: s.snoozedUntil,
    quietUntil,
    doneAt: s.doneAt,
    pieces: 1 + (s.parts?.length ?? 0),
    asksDone: s.asksDone ?? [],
    ...(s.doneBy && s.status === 'done' && { doneBy: s.doneBy }),
    ...(s.doneSource && { doneSource: s.doneSource }),
    ...(s.doneReason && { doneReason: s.doneReason }),
    ...(s.settlePending && { settling: true }),
    ...(s.replyCheck && { replyCheck: { at: s.replyCheck.at, allSettled: s.replyCheck.allSettled, settled: s.replyCheck.settled, ...(ctx.text.settleWhy && { why: ctx.text.settleWhy }) } }),
  };
}

/** Items Frank's replies closed today, London time, for Needs you's footer (CK-2.5). */
export function closedByReply(items: Iterable<Pick<ItemSummary, 'doneBy' | 'doneAt' | 'title'>>, now: Date | string): ClosedByReply {
  const today = londonParts(now).dateKey;
  const closed = [...items].filter((i) => i.doneBy === 'reply' && i.doneAt && londonParts(i.doneAt).dateKey === today).sort((a, b) => b.doneAt!.localeCompare(a.doneAt!));
  return { today: closed.length, ...(closed[0] && { latestAt: closed[0].doneAt, latestTitle: closed[0].title }) };
}

/** Today's budget use (FR-5.5). `force` lets the mock's Scenarios drawer hit a budget on demand. */
export function budgetsOf(
  usage: Iterable<Pick<UsageRecord, 'at' | 'purpose' | 'costEquivalent'>>,
  settings: Pick<Settings, 'budgets' | 'baselineCostPerDay'>,
  now: Date,
  force: { triage?: boolean; drafts?: boolean } = {},
): BudgetState {
  const today = londonParts(now).dateKey;
  let triage = 0;
  let drafts = 0;
  let cost = 0;
  for (const u of usage) {
    if (londonParts(u.at).dateKey !== today) continue;
    if (u.purpose === 'triage' || u.purpose === 'routing' || u.purpose === 'settle') triage += 1; // routing and settle checks count as triage
    else if (u.purpose === 'draft_vault' || u.purpose === 'draft_confluence') drafts += 1;
    cost += u.costEquivalent;
  }
  const b = settings.budgets;
  const baseline = settings.baselineCostPerDay;
  return {
    triage: { used: triage, limit: b.triageCallsPerDay, hit: !!force.triage || triage >= b.triageCallsPerDay },
    drafts: { used: drafts, limit: b.draftsPerDay, hit: !!force.drafts || drafts >= b.draftsPerDay },
    cost: { used: cost, limit: b.costEquivalentPerDay, hit: cost >= b.costEquivalentPerDay },
    baseline,
    pctOfBaseline: baseline ? Math.round((cost / baseline) * 100) : null,
  };
}
