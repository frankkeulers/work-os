import type { ActionSummary, BudgetState, ItemSummary } from '../api';
import { effectiveTriage, laneFor } from '../lanes';
import type { NextStep, Settings, UsageRecord } from '../schemas';
import { askId } from './topics';
import { londonParts } from '../time';
import type { ActionState, ItemFlags, ItemMeta } from './state';

// Read-side views built from the projection. The server and the mock build the inbox the same way.

const MIN = 60_000;
const SUMMARY_MAX = 110;

/** The latest non-discarded action per type. `actions` must be newest first. */
export function actionSummaries(actions: Iterable<ActionState>, revision: number): ItemSummary['actions'] {
  const out: ItemSummary['actions'] = {};
  for (const a of actions) {
    if (out[a.type] || a.status === 'discarded') continue;
    const s: ActionSummary = { id: a.id, type: a.type, status: a.status, failureReason: a.failureReason, stale: a.status === 'ready' && a.itemRevision < revision };
    out[a.type] = s;
  }
  return out;
}

/** The decision's free text, which lives with the raw content in items/, not in the log. */
export interface DecisionText {
  summary?: string;
  reason?: string;
  next?: NextStep;
  firstMessage?: string; // shown, shortened, until the item has a summary
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
  return {
    id: meta.id,
    source: meta.source,
    kind: meta.kind,
    title: meta.title,
    permalink: meta.permalink,
    lastActivityAt: meta.lastActivityAt,
    revision: meta.revision,
    lane: laneFor(s),
    status: s.status,
    triageState: s.triageState,
    summary: ctx.text.summary ?? (first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX - 3)}…` : first),
    reason: ctx.text.reason,
    next: openNext(ctx.text.next, s.asksDone),
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
  };
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
    if (u.purpose === 'triage' || u.purpose === 'routing') triage += 1; // routing is part of triage
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
