// A tiny in-memory event for the mark's "filed" animation (WO-14). ActionPanel emits when an action it shows
// becomes done; Shell plays filed. Emits within COALESCE_MS of the last one are dropped, so a batch plays once.

const COALESCE_MS = 500;
const listeners = new Set<() => void>();
let last = -Infinity;

export function emitFiled(now = Date.now()): void {
  if (now - last < COALESCE_MS) return;
  last = now;
  for (const l of listeners) l();
}

export function onFiled(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
