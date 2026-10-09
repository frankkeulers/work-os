import type { EventData, LoggedDecision } from '../events';
import { effectiveTriage } from '../lanes';
import { SETTLE_MAX_ATTEMPTS, type TriageCorrection } from '../schemas';
import { londonParts } from '../time';
import type { CloseStats, ItemFlags } from './state';

// Item state transitions. Each one changes the flags in place and does no I/O, so the server's
// reducer and the mock run exactly the same rules. The caller logs the matching event.

export const newItemFlags = (): ItemFlags => ({
  status: 'open',
  triageState: 'pending',
  newReplies: false,
  backFromSnooze: false,
  failCount: 0,
  notified: false,
  routed: false,
  topicVersion: 0,
});

/**
 * New messages on a known item, the latest at `at`. Messages from Frank alone don't need a
 * re-triage (§5.3); on an open item that needs him they wait for a settle check (cockpit CK-2.1).
 * Someone else writing after him puts the item back to triage, which reads his reply too.
 */
export function receiveMessages(s: ItemFlags, fromMeOnly: boolean, at?: string) {
  if (fromMeOnly) {
    if (at && awaitsReply(s)) s.settlePending = at;
    return;
  }
  s.triageState = 'pending';
  s.newReplies = true;
  s.settlePending = undefined;
  s.settleFailures = undefined;
  s.replyCheck = undefined;
}

/** An open, triaged item in Needs you or This week: one Frank's reply can settle (CK-2.1). */
export function awaitsReply(s: ItemFlags): boolean {
  const a = effectiveTriage(s.decision, s.correction)?.attention;
  return s.status === 'open' && s.triageState === 'triaged' && (a === 'now' || a === 'today');
}

/** A settle check ran: it saw Frank's replies up to `through` (CK-2.3). */
export function settleChecked(s: ItemFlags, at: string, d: EventData<'settle.checked'>) {
  if (s.settlePending && d.through >= s.settlePending) s.settlePending = undefined;
  s.settleFailures = undefined;
  s.replyCheck = { at, revision: d.revision, allSettled: d.allSettled, settled: d.settled.length };
}

/** A settle check failed; after the last attempt the item stays as it is (CK-2.3). */
export function settleFailed(s: ItemFlags, attempts: number) {
  s.settleFailures = attempts;
  if (attempts >= SETTLE_MAX_ATTEMPTS) s.settlePending = undefined;
}

export function applyDecision<D extends LoggedDecision>(s: ItemFlags<D>, d: D) {
  if (s.correction && d.itemRevision > s.correction.itemRevision) s.correctedFrom = s.correction.attention;
  s.decision = d;
  s.triageState = 'triaged';
  // Defaults for revision collisions; see JOURNEYS.md open questions 1–2.
  if (s.status === 'done' && s.newReplies) {
    s.status = 'open';
    s.doneAt = undefined;
    s.doneBy = s.doneSource = s.doneReason = undefined;
  }
  if (s.status === 'snoozed' && d.attention === 'now') {
    s.status = 'open';
    s.snoozedUntil = undefined;
    s.backFromSnooze = true;
  }
}

/** True when the item has just become Now and hasn't been notified yet (FR-11.2). */
export function needsNotification(s: ItemFlags): boolean {
  return !s.notified && effectiveTriage(s.decision, s.correction)?.attention === 'now';
}

export function markNotified(s: ItemFlags) {
  s.notified = true;
}

export function failTriage(s: ItemFlags, attempts: number) {
  s.failCount += attempts;
  s.triageState = 'failed';
}

export function correct(s: ItemFlags, c: TriageCorrection) {
  s.correction = c;
  s.correctedFrom = undefined;
  if (s.triageState === 'failed') s.triageState = 'triaged';
}

/** Closes an item; `by` is the item.done event's data: none when Frank pressed Done. */
export function markDone(s: ItemFlags, at: string, by?: EventData<'item.done'>) {
  s.status = 'done';
  s.doneAt = at;
  s.snoozedUntil = undefined;
  s.newReplies = false;
  s.backFromSnooze = false;
  s.settlePending = undefined;
  s.doneBy = by?.by ?? 'you';
  s.doneSource = by?.by === 'reply' ? by.source : undefined;
  s.doneReason = by?.by === 'source' ? by.reason : undefined;
}

export function reopen(s: ItemFlags) {
  s.status = 'open';
  s.doneAt = undefined;
  s.snoozedUntil = undefined;
  s.doneBy = undefined;
  s.doneSource = undefined;
  s.doneReason = undefined;
  s.replyCheck = undefined;
}

export function snooze(s: ItemFlags, until: string) {
  s.status = 'snoozed';
  s.snoozedUntil = until;
  s.backFromSnooze = false;
}

export const isSnoozeDue = (s: ItemFlags, now: string) => s.status === 'snoozed' && !!s.snoozedUntil && s.snoozedUntil <= now;

/** The snooze time passed (FR-8.3). */
export function unsnooze(s: ItemFlags) {
  s.status = 'open';
  s.snoozedUntil = undefined;
  s.backFromSnooze = true;
}

/** Whether opening the item would clear a flag, so the caller logs item.seen only when it changes something. */
export const seenChanges = (s: ItemFlags) => (s.newReplies && s.triageState === 'triaged') || s.backFromSnooze;

/** Opening an item counts as seeing it. */
export function markSeen(s: ItemFlags) {
  if (s.newReplies && s.triageState === 'triaged') s.newReplies = false;
  s.backFromSnooze = false;
}

// ---------------------------------------------------------------- close counts (cockpit C1, C2)

export const CLOSE_STATS_DAYS = 30;
const DAY_MS = 86_400_000;

function closeDay(closes: Record<string, CloseStats>, at: string): CloseStats {
  const cutoff = londonParts(new Date(Date.parse(at) - CLOSE_STATS_DAYS * DAY_MS)).dateKey;
  for (const k of Object.keys(closes)) if (k < cutoff) delete closes[k];
  return (closes[londonParts(at).dateKey] ??= { exits: 0, byReply: 0, undone: 0 });
}

/** Before item.done: an open item leaving Needs you (or This week) counts as an exit, and as a reply close if his reply closed it. */
export function countClose(closes: Record<string, CloseStats>, s: ItemFlags, at: string, by?: EventData<'item.done'>) {
  const a = effectiveTriage(s.decision, s.correction)?.attention;
  if (s.status !== 'open' || (a !== 'now' && a !== 'today')) return;
  const day = closeDay(closes, at);
  day.exits++;
  if (by?.by === 'reply') day.byReply++;
}

/** Before item.reopened: a reply close Frank undoes within 24 h is a false close, counted on the day it closed. */
export function countUndo(closes: Record<string, CloseStats>, s: ItemFlags, at: string) {
  if (s.status !== 'done' || s.doneBy !== 'reply' || !s.doneAt || Date.parse(at) - Date.parse(s.doneAt) > DAY_MS) return;
  closeDay(closes, s.doneAt).undone++;
}
