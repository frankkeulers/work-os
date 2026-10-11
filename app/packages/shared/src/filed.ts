import type { Filing, FiledView } from './api';
import type { ActionState } from './projection/state';
import { londonParts } from './time';

// Done today shows filings (BACKLOG UX-12): every filing written since midnight, London time, with
// what it wrote and where. The server and the mock build it the same way, from this.

export interface FiledInput {
  now: string;
  actions: readonly ActionState[];
  /** The items the actions belong to; an action whose item is gone (retention) is left out. */
  items: ReadonlyMap<string, { title: string; summary: string; done: boolean }>;
  /** Outcome messages by action id. */
  results: Readonly<Record<string, string>>;
  dryRun: boolean;
  targets: FiledView['targets'];
}

export function buildFiled(input: FiledInput): FiledView {
  const day = londonParts(input.now).dateKey;
  const filings: Filing[] = [];
  for (const a of input.actions) {
    if (a.status !== 'done' || londonParts(a.updatedAt).dateKey !== day) continue;
    const it = input.items.get(a.itemId);
    if (!it) continue;
    const paths = a.target.paths ?? (a.target.path ? [a.target.path] : undefined);
    const result = input.results[a.id];
    filings.push({
      actionId: a.id,
      itemId: a.itemId,
      type: a.type,
      at: a.updatedAt,
      title: it.title,
      summary: it.summary,
      itemDone: it.done,
      ...(result && { result }),
      ...(paths && { paths }),
      ...(a.target.pageId && { pageId: a.target.pageId }),
    });
  }
  filings.sort((x, y) => y.at.localeCompare(x.at));
  return { filings, dryRun: input.dryRun, targets: input.targets };
}
