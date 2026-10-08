import { askId, conversationOf, londonAt, londonParts, tomorrowAt9, type Ask, type Need, type NextStep, type SourceId } from '@work-os/shared';
import type { ItemSummary } from '../api';
import { fmtIn, fmtTime, fmtWhen } from './format';
import { cardActions, type DraftButton, type DraftState } from './lanes';

// What the Inbox shows as each item's next step: the triage's suggestion when it made one,
// otherwise a default from the lane. Rules and older decisions have no next step (no model call).

export const SOURCE_NAME: Record<SourceId, string> = { slack: 'Slack', outlook: 'Outlook', teams: 'Teams', plaud: 'Plaud', wispr: 'Wispr Flow', calendar: 'Outlook Calendar' };

/** The sources this version reads. The others (Teams, Plaud) are previews, shown only in Full scope. */
export const LIVE_SOURCES: readonly SourceId[] = ['slack', 'outlook', 'wispr'];
export const isLive = (source: SourceId) => LIVE_SOURCES.includes(source);

const NEED_LABEL: Record<Need, string> = { reply: 'Reply', approve: 'Approve', decide: 'Decide', prepare: 'Prepare', review: 'Review', actions: 'Actions', file: 'File' };

export function needLabel(n: Pick<NextStep, 'need' | 'actionItems'>): string {
  const count = n.actionItems?.length ?? 0;
  return n.need === 'actions' && count ? `${count} ${count === 1 ? 'action' : 'actions'}` : NEED_LABEL[n.need];
}

export type DueTone = 'now' | 'today' | 'later';

const sameDay = (a: Date | string, b: Date | string) => londonParts(a).dateKey === londonParts(b).dateKey;

/** "12:00 · in 2 h 15 min", "Thu 09:00", "this week". Close or overdue deadlines read as Now. */
export function dueInfo(next: Partial<NextStep> | undefined, now: Date): { text: string; tone: DueTone } | undefined {
  if (!next) return undefined;
  if (!next.dueAt) return next.dueLabel ? { text: next.dueLabel, tone: next.dueLabel === 'today' ? 'today' : 'later' } : undefined;
  const mins = (Date.parse(next.dueAt) - now.getTime()) / 60_000;
  const today = sameDay(next.dueAt, now);
  let text = fmtWhen(next.dueAt, now);
  if (next.dueLabel) text += ` ${next.dueLabel}`;
  if (mins < 0) return { text: `${text} · overdue`, tone: 'now' };
  if (today && mins <= 6 * 60) text += ` · ${fmtIn(next.dueAt, now)}`;
  return { text, tone: today && mins <= 4 * 60 ? 'now' : today ? 'today' : 'later' };
}

const isTop = (i: ItemSummary) => i.lane === 'now' || i.lane === 'today' || i.lane === 'file';

/** The earliest deadline still ahead among the items that need you, for the page header. */
export function nextDeadline(items: ItemSummary[], now: Date): string | undefined {
  const due = items
    .filter((i) => isTop(i) && i.next?.dueAt && Date.parse(i.next.dueAt) > now.getTime())
    .map((i) => i.next!.dueAt!)
    .sort()[0];
  return due && fmtWhen(due, now);
}

const LANE_RANK: Partial<Record<ItemSummary['lane'], number>> = { now: 0, failed: 1, today: 2 };

/** When an item is due, for sorting: an exact time, end of today for "today", then other labels, then none. */
function dueKey(i: ItemSummary, now: Date): [number, number] {
  const n = i.next;
  if (n?.dueAt) return [0, Date.parse(n.dueAt)];
  if (n?.dueLabel === 'today') return [0, Date.parse(londonAt(now, '23:59'))];
  return [n?.dueLabel ? 1 : 2, 0];
}

/**
 * The Needs you group (FR-8.1): Now first, then failed triage (shown untriaged so it isn't missed),
 * then Today by deadline. Ties go to the newest activity.
 */
export function needsYouOrder(items: ItemSummary[], now: Date): ItemSummary[] {
  return items
    .filter((i) => i.lane in LANE_RANK)
    .map((i) => ({ i, lane: LANE_RANK[i.lane]!, due: dueKey(i, now) }))
    .sort((a, b) => a.lane - b.lane || a.due[0] - b.due[0] || a.due[1] - b.due[1] || b.i.lastActivityAt.localeCompare(a.i.lastActivityAt))
    .map((x) => x.i);
}

export type InboxSort = 'newest' | 'oldest' | 'priority';

export const INBOX_SORT_LABEL: Record<InboxSort, string> = { newest: 'Newest first', oldest: 'Oldest first', priority: 'Priority' };

/**
 * A group's rows in the chosen order: by last activity, or Priority, which is the FR-8.1 order for
 * Needs you and the server's order for the other groups.
 */
export function sortItems(items: ItemSummary[], sort: InboxSort, needs: boolean, now: Date): ItemSummary[] {
  if (sort === 'priority') return needs ? needsYouOrder(items, now) : items;
  const dir = sort === 'newest' ? -1 : 1;
  const shown = needs ? items.filter((i) => i.lane in LANE_RANK) : items;
  return [...shown].sort((a, b) => dir * a.lastActivityAt.localeCompare(b.lastActivityAt));
}

/** A Slack item's channel or DM, from its id (`slack:<channel>:<key>`). Other sources have none. */
/** A topic's checklist: its asks, each with whether Frank ticked it off. Empty with fewer than two asks. */
export function topicAsks(i: Pick<ItemSummary, 'next' | 'asksDone'>): { ask: Ask; id: string; done: boolean }[] {
  const asks = i.next?.asks ?? [];
  if (asks.length < 2) return [];
  return asks.map((ask) => {
    const id = askId(ask.step);
    return { ask, id, done: i.asksDone.includes(id) };
  });
}

export function channelKey(i: Pick<ItemSummary, 'id' | 'source'>): string | undefined {
  return conversationOf(i);
}

/**
 * Brings each Slack channel's items together, keeping the sorted order inside each channel. A channel
 * sits where its first item was, so the channels follow the sort too. Other sources stay in place.
 */
export function groupByChannel(items: ItemSummary[]): ItemSummary[] {
  const runs = new Map<string, ItemSummary[]>();
  for (const i of items) {
    const key = channelKey(i) ?? `item:${i.id}`;
    const run = runs.get(key);
    if (run) run.push(i);
    else runs.set(key, [i]);
  }
  return [...runs.values()].flat();
}

export function openLabel(i: Pick<ItemSummary, 'source' | 'kind'>): string {
  const app = SOURCE_NAME[i.source];
  if (i.source === 'outlook') return 'Reply in Outlook';
  if (i.kind === 'meeting') return `Open transcript in ${app}`;
  if (i.kind === 'dm' || i.kind === 'chat') return `Reply in ${app}`;
  return `Open thread in ${app}`;
}

export type Primary = { kind: 'open'; label: string } | { kind: 'draft'; button: DraftButton };

export interface ShownStep {
  need: string;
  step: string;
  why?: string;
  due?: { text: string; tone: DueTone };
  blocks?: string;
  actionItems: string[];
  primary: Primary;
}

const FILE_STEP: Record<DraftState, (what: string) => string> = {
  none: (w) => (w === 'vault note' ? 'Draft a vault note' : 'Draft the Confluence entry'),
  drafting: (w) => `Drafting the ${w}`,
  ready: (w) => `Review the ${w}`,
  stale: (w) => `Review the ${w}`,
  writing: (w) => `Writing the ${w}`,
  done: () => 'Filed',
  failed: (w) => `Check the failed ${w}`,
};

/** The Next step card, or undefined when nothing needs doing (Everything else, waiting, done). */
export function shownStep(item: ItemSummary, draftsBudgetHit: boolean, now: Date): ShownStep | undefined {
  if (item.status !== 'open' || !isTop(item)) return undefined;
  const actions = cardActions(item, draftsBudgetHit);
  const primary: Primary = actions.primary.kind === 'draft' ? { kind: 'draft', button: actions.primary.button } : { kind: 'open', label: openLabel(item) };
  const n = item.next;
  if (n) return { need: needLabel(n), step: n.step, why: n.why, due: dueInfo(n, now), blocks: n.blocks, actionItems: n.actionItems ?? [], primary };
  if (item.lane === 'file') {
    const step = primary.kind === 'draft' ? FILE_STEP[primary.button.state](primary.button.type === 'vault_note' ? 'vault note' : 'Confluence entry') : 'File it';
    return { need: 'File', step, why: item.reason, actionItems: [], primary };
  }
  const step = item.kind === 'email' ? 'Reply to the email' : item.kind === 'dm' || item.kind === 'chat' ? `Reply to ${item.title}` : 'Reply in the thread';
  return { need: 'Reply', step, why: item.reason, actionItems: [], primary };
}

/** The one-click snooze offered next to the primary action, timed to the deadline. */
export function suggestedSnooze(item: ItemSummary, now: Date): { label: string; until: string } {
  const hour = { label: 'Snooze 1 hour', until: new Date(now.getTime() + 3600_000).toISOString() };
  const tomorrow = { label: 'Snooze until tomorrow 09:00', until: tomorrowAt9(now) };
  if (item.lane === 'file') {
    const evening = londonAt(now, '17:30');
    return Date.parse(evening) - now.getTime() > 60 * 60_000 ? { label: 'Snooze until 17:30', until: evening } : tomorrow;
  }
  const due = item.next?.dueAt;
  if (!due) return hour;
  const before = Date.parse(due) - 30 * 60_000;
  if (sameDay(due, now)) return before - now.getTime() > 15 * 60_000 ? { label: `Snooze until ${fmtTime(new Date(before))}`, until: new Date(before).toISOString() } : hour;
  return Date.parse(due) - Date.parse(tomorrow.until) > 30 * 60_000 ? tomorrow : hour;
}
