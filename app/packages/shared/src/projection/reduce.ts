import type { WorkEvent } from '../events';
import { emptyProjection, type ActionState, type Projection } from './state';
import {
  applyDecision,
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
      createdAt: e.at,
      updatedAt: e.at,
    };
    return true;
  }
  const a = actions[e.actionId];
  if (!a) return false;
  a.updatedAt = e.at;
  switch (e.type) {
    case 'action.drafted':
      a.status = 'ready';
      a.draftRef = e.data.draftRef;
      a.target = e.data.target;
      break;
    case 'action.approved':
      a.status = 'approved';
      break;
    case 'action.executing':
      a.status = 'executing';
      break;
    case 'action.executed':
      a.status = 'done';
      break;
    case 'action.failed':
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
      if (d.itemRevision >= item.revision && (d.topicVersion === undefined || d.topicVersion === item.topicVersion)) applyDecision(item, d);
      break;
    }
    case 'topic.routed':
      routeTopic(p.items, self, e.itemId, e.data.into, e.data.by);
      break;
    case 'topic.askDone':
      markAskDone(item, e.data.askId);
      break;
    case 'triage.corrected':
      correct(item, e.data.correction);
      break;
    case 'triage.failed':
      failTriage(item, e.data.attempts);
      break;
    case 'item.done':
      countClose((p.closes ??= {}), item, e.at, e.data);
      markDone(item, e.at, e.data);
      break;
    case 'settle.checked':
      settleChecked(item, e.at, e.data);
      break;
    case 'settle.failed':
      settleFailed(item, e.data.attempts);
      break;
    case 'item.reopened':
      countUndo((p.closes ??= {}), item, e.at);
      reopen(item);
      break;
    case 'item.snoozed':
      snooze(item, e.data.until);
      break;
    case 'item.unsnoozed':
      unsnooze(item);
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
