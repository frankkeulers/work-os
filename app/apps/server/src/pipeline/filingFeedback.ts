import {
  currentAction,
  effectiveTriage,
  filingPlan,
  laneFor,
  type ActionType,
  type CorrectionInput,
  type FilingFeedbackBody,
  type FilingSettings,
  type ItemState,
  type Me,
  type SourceId,
} from '@work-os/shared';
import { HttpError } from '../api/errors';
import { FILING_SIGNALS, impliedFlags, type FilingFlags, type FilingLabel, type FilingLabelStore, type FilingSignal } from '../store/filingLabels';
import type { ItemFiles } from '../store/items';
import type { Store } from '../store/store';
import { topicForTriage } from './topics';
import type { TriageThread } from './truncate';

// Feedback on the filing policy (E14, FR-15.7): Frank's word, and what his actions say, as lines
// in labels/filing.jsonl for the filing eval and the tuner. Implicit lines are written after the
// action they read, and callers catch their failures: a label is never worth failing a click.

export interface FilingFeedbackDeps {
  store: Store;
  items: ItemFiles;
  labels: FilingLabelStore;
  now: () => Date;
  me: (source?: SourceId) => Me;
  keepLastMessages: () => number;
  filing: () => FilingSettings;
}

type Target = 'confluence' | 'vault';
const TARGET: Record<Exclude<ActionType, 'todo'>, Target> = { confluence_entry: 'confluence', vault_note: 'vault' };
const EXPLICIT: readonly FilingSignal[] = FILING_SIGNALS.explicit;

/** The filings the item has now, by its effective triage. */
function filings(it: ItemState): Target[] {
  const eff = effectiveTriage(it.decision, it.correction);
  return (['confluence', 'vault'] as const).filter((t) => eff?.[t]);
}

export class FilingFeedback {
  constructor(private readonly d: FilingFeedbackDeps) {}

  get counts() {
    return this.d.labels.counts;
  }

  /**
   * One line for the item, with the decision as it stood, the thread as triage sees it and Frank's
   * reason if he gave one. False when there is nothing to label: no item, or its content has gone
   * to retention.
   */
  async label(itemId: string, signal: FilingSignal, label: FilingLabel, thread?: { anchor: { item: { revision: number } }; view: TriageThread }, reason?: string): Promise<boolean> {
    const it = this.d.store.projection.items[itemId];
    if (!it) return false;
    const topic = thread ?? (await topicForTriage(this.d.store.projection, this.d.items, itemId, this.d.me(it.source), this.d.keepLastMessages()));
    if (!topic) return false;
    const d = it.decision;
    await this.d.labels.append({
      at: this.d.now().toISOString(),
      origin: EXPLICIT.includes(signal) ? 'explicit' : 'implicit',
      signal,
      itemId,
      itemRevision: topic.anchor.item.revision,
      source: it.source,
      label: {
        ...(label.confluence && { confluence: impliedFlags(label.confluence) }),
        ...(label.vault && { vault: impliedFlags(label.vault) }),
        ...(label.todo !== undefined && { todo: label.todo }),
      },
      ...(reason && { reason }),
      ...(d && {
        was: {
          confluence: d.confluence,
          vault: d.vault,
          ...(d.todo && { todo: { ...(d.todo.rule && { rule: d.todo.rule }) } }),
          by: d.decidedBy,
          ...(d.promptVersion && { promptVersion: d.promptVersion }),
          ...(d.policyVersion && { policyVersion: d.policyVersion }),
        },
      }),
      thread: topic.view,
    });
    return true;
  }

  // ------------------------------------------------------------- explicit

  /** The Filing… menu, but for "Not for filing", which is a correction (see `corrected`). */
  async feedback(itemId: string, body: FilingFeedbackBody): Promise<{ labelCount: number }> {
    const it = this.d.store.projection.items[itemId];
    if (!it) throw new HttpError('not_found', 'Item not found. It may have been removed by retention.');
    const targets = filings(it).filter((t) => !body.type || TARGET[body.type] === t);
    if (!targets.length) throw new HttpError('conflict', body.type ? 'This item isn’t suggested for that filing.' : 'This item has nothing to file.');
    const flags: FilingFlags = body.signal === 'no_predraft' ? { predraft: false } : body.signal === 'should_be_ready' ? { ready: true } : body.signal === 'not_ready' ? { ready: false } : { toFile: false };
    const label: FilingLabel = Object.fromEntries(targets.map((t) => [t, flags]));
    if (!(await this.label(itemId, body.signal, label, undefined, body.reason))) throw new HttpError('conflict', 'Its content has gone to retention, so there is nothing to label.');
    return { labelCount: this.counts.labels };
  }

  /** A triage correction that turns a filing on or off says whether it belonged in To file. */
  async corrected(itemId: string, input: CorrectionInput, thread: Parameters<FilingFeedback['label']>[3], reason?: string): Promise<boolean> {
    const it = this.d.store.projection.items[itemId];
    const eff = it && effectiveTriage(it.decision, it.correction);
    const label: FilingLabel = {};
    for (const t of ['confluence', 'vault'] as const) if (!eff || eff[t] !== input[t]) label[t] = { toFile: input[t] };
    if (!label.confluence && !label.vault) return false;
    return this.label(itemId, 'corrected', label, thread, reason);
  }

  /** "Triage was right": To file was right for both, and so was Ready to approve where it showed. */
  async confirmed(itemId: string, thread: Parameters<FilingFeedback['label']>[3]): Promise<boolean> {
    const it = this.d.store.projection.items[itemId];
    const eff = it && effectiveTriage(it.decision, it.correction);
    if (!eff) return false;
    const plan = filingPlan(it.decision, it.correction, this.d.filing(), it.staged);
    const label: FilingLabel = {
      confluence: { toFile: eff.confluence, ...(plan.confluence_entry?.ready && { ready: true }) },
      vault: { toFile: eff.vault, ...(plan.vault_note?.ready && { ready: true }) },
    };
    return this.label(itemId, 'confirmed', label, thread);
  }

  // ------------------------------------------------------------- implicit

  /** Approved as drafted: worth drafting ahead, and ready to approve. Approved after an edit: worth drafting, not ready. */
  approved(itemId: string, type: Exclude<ActionType, 'todo'>, edited: boolean) {
    return this.label(itemId, edited ? 'approved_edited' : 'approved', { [TARGET[type]]: { predraft: true, ready: !edited } });
  }

  /** Discarded, not re-drafted: not worth drafting ahead. */
  discarded(itemId: string, type: Exclude<ActionType, 'todo'>) {
    return this.label(itemId, 'discarded', { [TARGET[type]]: { predraft: false } });
  }

  /** The suggested to-do, added or dismissed. */
  todo(itemId: string, added: boolean) {
    return this.label(itemId, added ? 'todo_added' : 'todo_dismissed', { todo: added });
  }

  /**
   * Done on items in To file, from their state before the event: each filing nothing was filed
   * for didn't belong there. A weak signal, so implicit.
   */
  async doneUnfiled(before: readonly ItemState[]): Promise<number> {
    let n = 0;
    for (const it of before) {
      if (laneFor(it) !== 'file') continue;
      const actions = Object.values(this.d.store.projection.actions)
        .filter((a) => a.itemId === it.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      const label: FilingLabel = {};
      for (const t of filings(it)) {
        const type = t === 'confluence' ? 'confluence_entry' : 'vault_note';
        if (currentAction(actions, type)?.status !== 'done') label[t] = { toFile: false };
      }
      if ((label.confluence || label.vault) && (await this.label(it.id, 'done_unfiled', label))) n++;
    }
    return n;
  }
}
