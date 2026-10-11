// Close on file (UX-4): an approval that may complete a To file item's filings asks the server to
// mark it done once written (`markDoneWhenFiled`, as a batch does). The write lands later, maybe
// after Frank has moved on, so the approval is watched here until its action settles: if the item
// was closed by it, a toast says so, with Undo.

interface Watch {
  itemId: string;
  title: string;
}

const watching = new Map<string, Watch>();

/** Watch the approved action `actionId` until it is written or fails. */
export function watchCloseOnFile(actionId: string, itemId: string, title: string) {
  watching.set(actionId, { itemId, title });
}

/** The approvals being watched for this item. */
export function watchedFor(itemId: string): [string, Watch][] {
  return [...watching].filter(([, w]) => w.itemId === itemId);
}

export function unwatch(actionId: string) {
  watching.delete(actionId);
}
