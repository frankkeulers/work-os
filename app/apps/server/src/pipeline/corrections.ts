import { effectiveTriage, type CorrectionInput, type Me } from '@work-os/shared';
import type { ItemFiles } from '../store/items';
import type { LabelStore } from '../store/labels';
import type { Store } from '../store/store';
import { topicForTriage } from './topics';

// "Correct triage" (FR-6.2, Story 6.1): the inbox moves the item, and the labelled set gains a
// line. The label goes to disk first: a crash before the event leaves an extra label, which the
// next correction of that item supersedes, never an inbox change without its label.

export interface CorrectionDeps {
  store: Store;
  items: ItemFiles;
  labels: LabelStore;
  now: () => Date;
  me: () => Me;
  keepLastMessages: () => number;
}

export async function correctTriage(d: CorrectionDeps, itemId: string, input: CorrectionInput): Promise<{ labelCount: number }> {
  const it = d.store.projection.items[itemId];
  if (!it) throw new Error(`No item ${itemId}`);
  const at = d.now().toISOString();
  const topic = await topicForTriage(d.store.projection, d.items, itemId, d.me(), d.keepLastMessages());
  const stored = topic?.anchor;
  // Without its content (gone to retention) the correction still moves the item; there is
  // nothing for the eval to re-triage, so no label.
  if (stored) {
    const was = effectiveTriage(it.decision, it.correction);
    await d.labels.append({
      at,
      origin: 'correction',
      itemId,
      itemRevision: stored.item.revision,
      source: it.source,
      label: { attention: input.attention, confluence: input.confluence, vault: input.vault },
      ...(was && { was: { attention: was.attention, confluence: was.confluence, vault: was.vault, by: was.by } }),
      thread: topic.view, // a topic's label holds all its pieces
    });
  }
  await d.store.append({ type: 'triage.corrected', itemId, data: { correction: { itemId, itemRevision: it.revision, ...input, correctedAt: at } } });
  return { labelCount: d.labels.counts.labels };
}
