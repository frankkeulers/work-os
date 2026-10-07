// Search for the chip pickers (LookupPicker): channels in rules and settings, people for VIPs.

const SHOWN = 8;

/** Something to pick: `value` goes into the setting; `detail` is shown beside it and searched too. */
export interface LookupOption {
  value: string;
  detail?: string;
}

const words = (s: string) => s.split(/[\s\-_.]+/).filter(Boolean);

/**
 * The options matching what was typed, compared by `key` (case and any prefix such as "#" ignored):
 * values starting with it first, then any word of the value or detail starting with it, then the
 * rest that contain it. Options already picked are left out.
 */
export function matchLookup(all: LookupOption[], query: string, exclude: string[], key: (s: string) => string): LookupOption[] {
  const q = key(query);
  const taken = new Set(exclude.map(key));
  const open = all.filter((o) => !taken.has(key(o.value)));
  if (!q) return open.slice(0, SHOWN);
  const rank = (o: LookupOption) => {
    const v = key(o.value);
    const d = o.detail ? key(o.detail) : '';
    if (v.startsWith(q)) return 0;
    if ([...words(v), ...words(d)].some((w) => w.startsWith(q))) return 1;
    if (v.includes(q) || d.includes(q)) return 2;
    return -1;
  };
  const ranked = open.map((o) => ({ o, r: rank(o) })).filter((x) => x.r >= 0);
  return [0, 1, 2].flatMap((r) => ranked.filter((x) => x.r === r).map((x) => x.o)).slice(0, SHOWN);
}

/** A channel name compared without its "#" or case. */
export const channelKey = (s: string) => s.trim().replace(/^#/, '').toLowerCase();

/** A person's name compared without case. */
export const personKey = (s: string) => s.trim().toLowerCase();
