import type { LoggedDecision } from '../events';
import { effectiveTriage } from '../lanes';
import type { TriageCorrection } from '../schemas';
import type { ItemFlags } from './state';

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

/** New messages on a known item. Messages from Frank alone don't need a re-triage (§5.3). */
export function receiveMessages(s: ItemFlags, fromMeOnly: boolean) {
  if (fromMeOnly) return;
  s.triageState = 'pending';
  s.newReplies = true;
}

export function applyDecision<D extends LoggedDecision>(s: ItemFlags<D>, d: D) {
  if (s.correction && d.itemRevision > s.correction.itemRevision) s.correctedFrom = s.correction.attention;
  s.decision = d;
  s.triageState = 'triaged';
  // Defaults for revision collisions; see JOURNEYS.md open questions 1–2.
  if (s.status === 'done' && s.newReplies) {
    s.status = 'open';
    s.doneAt = undefined;
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

export function markDone(s: ItemFlags, at: string) {
  s.status = 'done';
  s.doneAt = at;
  s.snoozedUntil = undefined;
  s.newReplies = false;
  s.backFromSnooze = false;
}

export function reopen(s: ItemFlags) {
  s.status = 'open';
  s.doneAt = undefined;
  s.snoozedUntil = undefined;
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
