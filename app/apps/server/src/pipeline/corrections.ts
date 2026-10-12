import { effectiveTriage, type CorrectionInput, type Me } from '@work-os/shared';
import { HttpError } from '../api/errors';
import type { ItemFiles } from '../store/items';
import type { LabelStore } from '../store/labels';
import type { Store } from '../store/store';
import type { FilingFeedback } from './filingFeedback';
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
  /** E14 (FR-15.7): a correction or a confirmation also labels the filing fields. */
  filing?: Pick<FilingFeedback, 'corrected' | 'confirmed'>;
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
    await d.filing?.corrected(itemId, input, topic).catch(() => false);
  }
  await d.store.append({ type: 'triage.corrected', itemId, data: { correction: { itemId, itemRevision: it.revision, ...input, correctedAt: at } } });
  return { labelCount: d.labels.counts.labels };
}

/**
 * "Triage was right": the decision as it stands joins the labelled set, origin `confirmed`, so the
 * eval also measures what triage gets right, not only the cases Frank corrected. Label first, as
 * for a correction. Only a model's or a rule's decision on the thread as it is now can be confirmed.
 */
export async function confirmTriage(d: CorrectionDeps, itemId: string): Promise<{ labelCount: number }> {
  const it = d.store.projection.items[itemId];
  if (!it) throw new Error(`No item ${itemId}`);
  const eff = effectiveTriage(it.decision, it.correction);
  if (!it.decision || !eff) throw new HttpError('conflict', 'This item hasn’t been triaged yet.');
  if (eff.by === 'user') throw new HttpError('conflict', 'This is your own correction, already in the labelled set.');
  if (it.decision.itemRevision < it.revision) throw new HttpError('conflict', 'New messages since it was triaged. Confirm once it has been triaged again.');
  const topic = await topicForTriage(d.store.projection, d.items, itemId, d.me(), d.keepLastMessages());
  if (!topic) throw new HttpError('conflict', 'Its content has gone to retention, so there is nothing to label.');
  const label = { attention: eff.attention, confluence: eff.confluence, vault: eff.vault };
  await d.labels.append({
    at: d.now().toISOString(),
    origin: 'confirmed',
    itemId,
    itemRevision: topic.anchor.item.revision,
    source: it.source,
    label,
    was: { ...label, by: eff.by },
    thread: topic.view,
  });
  await d.filing?.confirmed(itemId, topic).catch(() => false);
  await d.store.append({ type: 'triage.confirmed', itemId, data: { revision: it.decision.itemRevision } });
  return { labelCount: d.labels.counts.labels };
}
