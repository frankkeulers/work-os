import type { BudgetState, ClosedByReply, Criterion, ItemSummary } from '../api';
import { effectiveTriage, laneFor, viewLane } from '../lanes';
import type { ActionType, NextStep, Settings, UsageRecord } from '../schemas';
import { askId } from './topics';
import { londonParts } from '../time';
import type { ActionState, CloseStats, ItemFlags, ItemMeta } from './state';

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

/**
 * Every filing the triage suggests has been written (cockpit CK-4.4): what marks an item filed in a
 * batch done. Confluence doesn't count for a thread with observations about people (FR-10.1).
 * `actions` must be newest first.
 */
export function filedAll(it: Pick<ItemFlags, 'decision' | 'correction'>, actions: readonly ActionLike[]): boolean {
  const eff = effectiveTriage(it.decision, it.correction);
  const types: ActionType[] = [];
  if (eff?.confluence && !it.decision?.containsPeopleObservations) types.push('confluence_entry');
  if (eff?.vault) types.push('vault_note');
  return types.length > 0 && types.every((t) => currentAction(actions, t)?.status === 'done');
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
  finishWhy?: string; // what settled the topic, when it looks finished (CK-2.10)
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

/** Frank said the decision standing now was right: same revision, and not overridden by his correction. */
export const confirmedNow = (s: Pick<ItemFlags, 'confirmed' | 'decision' | 'correction'>) =>
  s.confirmed !== undefined && !!s.decision && s.confirmed === s.decision.itemRevision && effectiveTriage(s.decision, s.correction)?.by !== 'user';

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
    ...(confirmedNow(s) && { confirmed: true }),
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
    ...(s.looksFinished && s.status === 'open' && { looksFinished: { at: s.looksFinished, ...(ctx.text.finishWhy && { why: ctx.text.finishWhy }) } }),
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

/** C1 and C2 look back this many days. */
export const CLOSE_CRITERIA_DAYS = 14;

/**
 * C1, the share of Needs you exits closed by Frank's reply, and C2, the share of those closes he
 * undid within 24 h (cockpit CK-2.8), over the last 14 days.
 */
export function replyCloseCriteria(closes: Record<string, CloseStats> | undefined, now: Date): Criterion[] {
  const since = londonParts(new Date(now.getTime() - (CLOSE_CRITERIA_DAYS - 1) * 86_400_000)).dateKey;
  const t = { exits: 0, byReply: 0, undone: 0 };
  for (const [day, c] of Object.entries(closes ?? {})) {
    if (day < since) continue;
    t.exits += c.exits;
    t.byReply += c.byReply;
    t.undone += c.undone;
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const c1 = t.exits ? t.byReply / t.exits : undefined;
  const c2 = t.byReply ? t.undone / t.byReply : undefined;
  return [
    c1 === undefined
      ? { id: 'C1', name: 'Needs you closed by your reply', value: '—', target: '≥ 40%', status: 'pending', statusLabel: 'Nothing closed yet' }
      : { id: 'C1', name: 'Needs you closed by your reply', value: pct(c1), target: '≥ 40%', status: c1 >= 0.4 ? 'on_track' : 'at_risk', statusLabel: `${t.byReply} of ${t.exits} in ${CLOSE_CRITERIA_DAYS} days` },
    c2 === undefined
      ? { id: 'C2', name: 'False closes', value: '—', target: '≤ 2%', status: 'pending', statusLabel: 'No reply closes yet' }
      : { id: 'C2', name: 'False closes', value: pct(c2), target: '≤ 2%', status: c2 <= 0.02 ? 'on_track' : 'at_risk', statusLabel: `${t.undone} of ${t.byReply} undone` },
  ];
}
