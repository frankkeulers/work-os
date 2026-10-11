// A copy of a draft edit in progress, per draft and note, in this tab's session storage: a server
// that goes away unmounts the page, and a reload starts it again, but the edit comes back. It is
// dropped once saved, cancelled or left on purpose. Storage can be unavailable; then there is no copy.

export interface KeptEdit {
  text: string;
  /** The draft's text when the edit began: a copy of an edit to a draft that has changed since is stale. */
  original: string;
}

const key = (actionId: string, part?: number) => `workos.draftEdit.${actionId}.${part ?? '-'}`;

export function keepEdit(actionId: string, part: number | undefined, e: KeptEdit) {
  try {
    sessionStorage.setItem(key(actionId, part), JSON.stringify(e));
  } catch {
    // No storage: the edit lives only in the page.
  }
}

export function keptEdit(actionId: string, part: number | undefined): KeptEdit | undefined {
  try {
    const raw = sessionStorage.getItem(key(actionId, part));
    const e = raw ? (JSON.parse(raw) as Partial<KeptEdit>) : undefined;
    return typeof e?.text === 'string' && typeof e.original === 'string' ? { text: e.text, original: e.original } : undefined;
  } catch {
    return undefined;
  }
}

export function forgetEdit(actionId: string, part: number | undefined) {
  try {
    sessionStorage.removeItem(key(actionId, part));
  } catch {
    // Nothing kept.
  }
}
