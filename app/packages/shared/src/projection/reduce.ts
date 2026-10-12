import type { EventType, TodoBy, WorkEvent } from '../events';
import { stageFiling } from '../policy';
import type { ActionStatus } from '../schemas';
import { DISMISSED_DAYS, emptyProjection, type ActionState, type Projection, type TodoState } from './state';
import {
  applyDecision,
  confirm,
  correct,
  failTriage,
  markDone,
  countClose,
  countUndo,
  markNotified,
  markSeen,
  newItemFlags,
  receiveMessages,
  reopen,
  settleChecked,
  settleFailed,
  finishChecked,
  snooze,
  unsnooze,
} from './transitions';
import { followAnchor, markAskDone, partGrew, routeTopic } from './topics';

/** The log skipped or repeated a seq. The store decides how to recover (PLAN.md §4.3). */
export class SeqGapError extends Error {
  constructor(
    readonly expected: number,
    readonly got: number,
  ) {
    super(`Event log out of sequence: expected seq ${expected}, got ${got}`);
    this.name = 'SeqGapError';
  }
}

/**
 * The statuses each action event may move an action from. One that arrives too late changes
 * nothing: a draft or write finishing after Frank discarded it, an approval before the draft was
 * ready, a discard that lost the race to the write (the service then tells Frank it was written).
 */
const ACTION_FROM: Partial<Record<EventType, readonly ActionStatus[]>> = {
  'action.drafted': ['drafting'],
  'action.approved': ['ready', 'failed'], // failed: Retry write, for a failed write only (below)
  'action.executing': ['approved', 'executing'],
  'action.executed': ['approved', 'executing'],
  'action.failed': ['drafting', 'ready', 'approved', 'executing'],
  'action.discarded': ['drafting', 'ready', 'approved', 'failed'],
};

/**
 * Applies one action event to the actions it touches, in place. Fields the log doesn't carry
 * (the mock's error text) are left alone. Returns false for an action the log never requested.
 */
export function applyActionEvent(actions: Record<string, ActionState>, e: WorkEvent): boolean {
  if (!e.actionId || !e.type.startsWith('action.')) return false;
  if (e.type === 'action.requested') {
    if (!e.itemId) return false;
    actions[e.actionId] = {
      id: e.actionId,
      itemId: e.itemId,
      itemRevision: e.data.revision,
      type: e.data.type,
      status: 'drafting',
      target: {},
      draftRef: `drafts/${e.actionId}.json`,
      supersedes: e.data.supersedes,
      ...(e.data.quiet && { quiet: true }),
      createdAt: e.at,
      updatedAt: e.at,
    };
    return true;
  }
  const a = actions[e.actionId];
  if (!a) return false;
  if (ACTION_FROM[e.type] && !ACTION_FROM[e.type]!.includes(a.status)) return true;
  if (e.type === 'action.approved' && a.status === 'failed' && a.failedWhile !== 'writing') return true; // a failed draft needs a re-draft
  a.updatedAt = e.at;
  switch (e.type) {
    case 'action.drafted':
      a.status = 'ready';
      a.draftRef = e.data.draftRef;
      a.target = e.data.target;
      break;
    case 'action.approved':
      a.status = 'approved';
      delete a.failureReason;
      delete a.failedWhile;
      if (e.data?.markDoneWhenFiled) a.markDoneWhenFiled = true;
      break;
    case 'action.executing':
      a.status = 'executing';
      break;
    case 'action.executed':
      a.status = 'done';
      break;
    case 'action.failed':
      // Writing once approved, whether or not the write itself had started; before that, the draft failed.
      a.failedWhile = a.status === 'approved' || a.status === 'executing' ? 'writing' : 'drafting';
      a.status = 'failed';
      a.failureReason = e.data.reason;
      break;
    case 'action.discarded':
      a.status = 'discarded';
      break;
    case 'action.edited':
      break;
  }
  return true;
}

/** The To Do events (E15). todo.dismissed is the item's suggestion, not a To Do. */
const TODO_EVENTS = new Set(['todo.created', 'todo.done', 'todo.reopened', 'todo.mirrored', 'todo.mirrorFailed', 'todo.timed', 'todo.planned', 'todo.planFailed', 'todo.edited', 'todo.scheduled', 'todo.unscheduled', 'todo.followups', 'todo.followupsFailed', 'todo.followupAnswered']);
export const isTodoEvent = (e: WorkEvent): e is Extract<WorkEvent, { type: 'todo.created' | 'todo.done' | 'todo.reopened' | 'todo.mirrored' | 'todo.mirrorFailed' | 'todo.timed' | 'todo.planned' | 'todo.planFailed' | 'todo.edited' | 'todo.scheduled' | 'todo.unscheduled' | 'todo.followups' | 'todo.followupsFailed' | 'todo.followupAnswered' }> =>
  TODO_EVENTS.has(e.type);

/**
 * Applies one To Do event, in place (FR-16.1–16.3). A To Do is created once: a replay of its
 * creation changes nothing. Done and reopened only move it from the other state, so a tick read
 * back from the note after Frank pressed Done changes nothing either.
 *
 * Done or reopened by Frank in Work OS leaves the line to mirror (FR-16.4) until todo.mirrored
 * says the line matches; by the note itself, there is nothing to mirror.
 */
export function applyTodoEvent(todos: Record<string, TodoState>, e: WorkEvent): void {
  if (!isTodoEvent(e)) return;
  const id = e.data.todoId;
  if (e.type === 'todo.created') {
    if (todos[id] || !e.itemId || !e.actionId) return;
    const { lineId, deadline, deadlineFrom, backfilled } = e.data;
    todos[id] = { id, itemId: e.itemId, actionId: e.actionId, ...(lineId && { lineId }), createdAt: e.at, status: 'open', ...(deadline && { deadline }), deadlineFrom, ...(backfilled && { backfilled }) };
    return;
  }
  const t = todos[id];
  if (!t) return;
  switch (e.type) {
    case 'todo.done':
      if (t.status !== 'open') return;
      Object.assign(t, { status: 'done', doneAt: e.at, doneBy: e.data.by });
      mirror(t, e.data.by, 'ticked');
      return;
    case 'todo.reopened':
      if (t.status !== 'done') return;
      t.status = 'open';
      delete t.doneAt;
      delete t.doneBy;
      delete t.actualMinutes;
      mirror(t, e.data.by, 'open');
      return;
    case 'todo.mirrored':
      if (t.mirror?.want === e.data.state) delete t.mirror;
      return;
    case 'todo.mirrorFailed':
      if (t.mirror) Object.assign(t.mirror, { failed: e.data.reason, failedAt: e.at });
      return;
    case 'todo.timed':
      if (t.status !== 'done') return;
      if (e.data.minutes === null) delete t.actualMinutes;
      else t.actualMinutes = e.data.minutes;
      return;
    case 'todo.planned':
      // Once, and never over Frank's own estimate or deadline.
      if (t.planned) return;
      t.planned = true;
      delete t.planFailures;
      t.confidence = e.data.confidence;
      if (t.effortBy !== 'you') Object.assign(t, { effortMinutes: e.data.effortMinutes, effortBy: 'model' });
      if (e.data.ideal && t.deadlineFrom !== 'you') t.ideal = e.data.ideal;
      return;
    case 'todo.planFailed':
      if (!t.planned) t.planFailures = e.data.attempts;
      return;
    case 'todo.edited':
      if (e.data.effortMinutes !== undefined) Object.assign(t, { effortMinutes: e.data.effortMinutes, effortBy: 'you' });
      if (e.data.deadline !== undefined) {
        // Frank's deadline replaces the ideal one too: it is the date he means.
        delete t.ideal;
        if (e.data.deadline === null) {
          delete t.deadline;
          t.deadlineFrom = 'you';
        } else Object.assign(t, { deadline: e.data.deadline, deadlineFrom: 'you' });
      }
      return;
    case 'todo.scheduled':
      // The plan never moves Frank's own slot.
      if (t.status !== 'open' || (e.data.by === 'plan' && t.slot?.by === 'you')) return;
      t.slot = { start: e.data.start, end: e.data.end, by: e.data.by };
      return;
    case 'todo.unscheduled':
      if (t.slot?.by === e.data.by) delete t.slot;
      return;
    case 'todo.followups':
      // Once: a replay changes nothing.
      if (t.followups) return;
      t.followups = { kinds: e.data.kinds };
      delete t.followupFailures;
      return;
    case 'todo.followupsFailed':
      if (!t.followups) t.followupFailures = e.data.attempts;
      return;
    case 'todo.followupAnswered': {
      // One answer each.
      const f = t.followups;
      if (!f || e.data.index >= f.kinds.length || f.answers?.[e.data.index]) return;
      (f.answers ??= {})[e.data.index] = e.data.answer;
      return;
    }
  }
}

function mirror(t: TodoState, by: TodoBy, want: 'ticked' | 'open') {
  if (by === 'you') t.mirror = { want };
  else delete t.mirror;
}

/** Records a dismissal and forgets those older than DISMISSED_DAYS, so the set stays small. */
export function dismiss(dismissed: Record<string, string>, key: string, at: string) {
  const cutoff = new Date(Date.parse(at) - DISMISSED_DAYS * 86_400_000).toISOString();
  for (const [k, when] of Object.entries(dismissed)) if (when < cutoff) delete dismissed[k];
  dismissed[key] = at;
}

const self = <R extends { lastActivityAt: string }>(r: R) => r;

/** Applies one event to the projection, in place. Events must arrive in seq order with no gaps. */
export function reduce(p: Projection, e: WorkEvent): Projection {
  if (e.seq !== p.lastSeq + 1) throw new SeqGapError(p.lastSeq + 1, e.seq);
  p.lastSeq = e.seq;

  if (e.type === 'source.polled') {
    const prev = p.sources[e.data.source];
    p.sources[e.data.source] = { lastPollAt: e.at, cursor: e.data.cursor ?? prev?.cursor };
    return p;
  }
  if (e.type.startsWith('action.')) {
    applyActionEvent(p.actions, e);
    return p;
  }
  if (isTodoEvent(e)) {
    applyTodoEvent((p.todos ??= {}), e);
    return p;
  }
  if (e.type === 'attention.dismissed') {
    dismiss((p.dismissed ??= {}), e.data.key, e.at);
    return p;
  }
  if (!e.itemId) return p;

  if (e.type === 'item.upserted') {
    const { fromMeOnly, ...meta } = e.data;
    const item = p.items[e.itemId];
    if (!item) {
      p.items[e.itemId] = {
        id: e.itemId,
        source: meta.source,
        kind: meta.kind,
        title: meta.title,
        permalink: meta.permalink,
        participants: meta.participants,
        lastActivityAt: meta.lastActivityAt,
        revision: meta.revision,
        messageCount: meta.messageCount,
        ...newItemFlags(),
      };
    } else if (meta.revision >= item.revision) {
      const grew = meta.revision > item.revision;
      Object.assign(item, {
        title: meta.title,
        permalink: meta.permalink,
        participants: meta.participants,
        // An anchor's activity is its whole topic's.
        lastActivityAt: item.parts ? [item.lastActivityAt, meta.lastActivityAt].sort().at(-1) : meta.lastActivityAt,
        revision: meta.revision,
        messageCount: meta.messageCount,
      });
      // A replayed poll carries the same revision and changes nothing (FR-2.8).
      if (grew) {
        receiveMessages(item, fromMeOnly, meta.lastActivityAt);
        partGrew(p.items, self, e.itemId, fromMeOnly);
      }
    }
    return p;
  }

  const item = p.items[e.itemId];
  if (!item) return p;
  switch (e.type) {
    case 'triage.decided': {
      // A decision made from older messages than the item now has is stale (§5.3); so is one
      // made before the topic's parts changed.
      const d = e.data.decision;
      if (d.itemRevision >= item.revision && (d.topicVersion === undefined || d.topicVersion === item.topicVersion)) applyDecision(item, d, e.data.finishCheck);
      break;
    }
    case 'topic.routed':
      routeTopic(p.items, self, e.itemId, e.data.into, e.data.by, e.data.fromMeOnly);
      break;
    case 'topic.askDone':
      markAskDone(item, e.data.askId);
      break;
    case 'triage.corrected':
      correct(item, e.data.correction);
      break;
    case 'triage.confirmed':
      confirm(item, e.data.revision);
      break;
    case 'todo.dismissed':
      item.todoDismissed = e.data.revision;
      break;
    case 'filing.staged': {
      const { revision: rev, type, predraft, ready } = e.data;
      item.staged = stageFiling(item.staged, type, rev, { ...(predraft !== undefined && { predraft }), ...(ready !== undefined && { ready }) });
      break;
    }
    // Failures and checks for older messages than the item now has are stale, like decisions: the
    // newer messages get their own triage and checks.
    case 'triage.failed':
      if (e.data.revision >= item.revision) failTriage(item, e.data.attempts);
      break;
    case 'item.done':
      countClose((p.closes ??= {}), item, e.at, e.data);
      markDone(item, e.at, e.data);
      break;
    // A settle check still counts after Frank replies again (it waits on by `through`), but not
    // once someone else has written: their message dropped the check and asks for triage.
    case 'settle.checked':
      if (e.data.revision >= item.revision || item.settlePending) settleChecked(item, e.at, e.data);
      break;
    case 'settle.failed':
      if (e.data.revision >= item.revision || item.settlePending) settleFailed(item, e.data.attempts);
      break;
    case 'finish.checked':
      if (e.data.revision >= item.revision) finishChecked(item, e.at, e.data);
      break;
    case 'finish.failed':
      item.finishPending = undefined;
      break;
    case 'item.reopened':
      countUndo((p.closes ??= {}), item, e.at);
      reopen(item);
      break;
    case 'item.snoozed':
      snooze(item, e.data.until);
      break;
    case 'item.unsnoozed':
      unsnooze(item, e.at);
      break;
    case 'item.seen':
      markSeen(item);
      break;
    case 'item.notified':
      markNotified(item);
      break;
  }
  if (item.parts) followAnchor(p.items, item.id);
  return p;
}

/** Replays a run of events, in order, onto a projection (a fresh one by default). */
export function replay(events: Iterable<WorkEvent>, from: Projection = emptyProjection()): Projection {
  for (const e of events) reduce(from, e);
  return from;
}
