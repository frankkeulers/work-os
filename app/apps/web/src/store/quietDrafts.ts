import type { ActionType } from '@work-os/shared';
import { api } from '../api';

// Drafts the inbox starts for itself, such as a batch's draft ahead (cockpit CK-4.2): their
// "draft ready" toast would only interrupt, as the batch opens them in turn.
const quiet = new Map<string, number>();

/** No "draft ready" toast for this item's next draft. */
export const quietDraft = (itemId: string) => void quiet.set(itemId, (quiet.get(itemId) ?? 0) + 1);

/** Whether this draft was one of the quiet ones; each counts once. */
export function takeQuiet(itemId: string): boolean {
  const n = quiet.get(itemId);
  if (!n) return false;
  if (n > 1) quiet.set(itemId, n - 1);
  else quiet.delete(itemId);
  return true;
}

/**
 * Starts a draft without its "draft ready" toast. If the request fails no draft follows, so the
 * mark is taken back: the next draft Frank asks for still says when it's ready.
 */
export function requestQuietDraft(itemId: string, type: ActionType) {
  quietDraft(itemId);
  return api.requestDraft(itemId, type, { quiet: true }).catch((e: unknown) => {
    takeQuiet(itemId);
    throw e;
  });
}
