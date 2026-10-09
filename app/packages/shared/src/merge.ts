// A Settings save carries the files it was edited from, so the server applies only what Frank
// changed (FR-1.5). Anything else changed meanwhile, such as Connect turning a source on, is kept,
// though the form hadn't caught up with it yet.

type Bag = Record<string, unknown>;
const isBag = (x: unknown): x is Bag => !!x && typeof x === 'object' && !Array.isArray(x);

/** The same value, whatever order its keys are in. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  if (!isBag(a) || !isBag(b)) return false;
  const ka = Object.keys(a).filter((k) => a[k] !== undefined);
  const kb = Object.keys(b).filter((k) => b[k] !== undefined);
  return ka.length === kb.length && ka.every((k) => sameValue(a[k], b[k]));
}

/**
 * `current` with the changes that turn `base` into `edited`, field by field. A field the edit
 * didn't touch keeps its current value; one it changed or removed takes the edit. A list is one
 * value: changed, it is replaced whole.
 */
export function mergeEdit<T>(current: T, base: unknown, edited: T): T {
  if (sameValue(edited, base)) return current;
  if (!isBag(edited) || !isBag(base) || !isBag(current)) return edited;
  const out: Bag = { ...current };
  for (const k of new Set([...Object.keys(base), ...Object.keys(edited)])) {
    if (edited[k] === undefined) {
      if (base[k] !== undefined) delete out[k];
    } else out[k] = mergeEdit(current[k], base[k], edited[k]);
  }
  return out as T;
}
