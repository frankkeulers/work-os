import type { ActionType, Lane } from '@work-os/shared';
import type { ItemSummary } from '../api';

export const LANE_META: Record<Lane, { name: string; dot: string; headline: string; band: { bg: string; line: string; badge: string } }> = {
  now: { name: 'Now', dot: 'var(--orange)', headline: 'Needs you within the hour.', band: { bg: 'var(--orange-wash)', line: 'var(--orange-line)', badge: 'var(--orange)' } },
  today: { name: 'Today', dot: 'var(--accent-bg)', headline: 'Handle before end of day.', band: { bg: 'var(--accent-wash-3)', line: 'var(--accent-line-4)', badge: 'var(--accent-bg)' } },
  week: { name: 'This week', dot: 'var(--accent-light)', headline: 'Due later this week. Moves to Needs you on the day.', band: { bg: 'var(--surface-2)', line: 'var(--line-strong)', badge: 'var(--accent-bg)' } },
  follow: { name: 'Waiting on others', dot: 'var(--gray-solid)', headline: 'You own the outcome. Someone else has the next move.', band: { bg: 'var(--surface-2)', line: 'var(--line-strong)', badge: 'var(--gray-solid)' } },
  file: { name: 'File', dot: 'var(--teal-solid)', headline: 'No reply needed. Worth filing.', band: { bg: 'var(--teal-wash)', line: 'var(--teal-line)', badge: 'var(--teal-solid)' } },
  else: { name: 'Everything else', dot: 'var(--gray-mid)', headline: 'No action and nothing to file.', band: { bg: 'var(--line-soft)', line: 'var(--line-strong)', badge: 'var(--gray-solid)' } },
  failed: { name: 'Failed', dot: 'var(--red)', headline: 'Triage failed. Shown untriaged.', band: { bg: 'var(--surface)', line: 'var(--red-line)', badge: 'var(--red)' } },
  waiting: { name: 'Waiting for quiet window', dot: 'var(--gray-mid)', headline: 'Still active. Triage runs once the thread goes quiet.', band: { bg: 'var(--surface-2)', line: 'var(--line-strong)', badge: 'var(--gray-solid)' } },
  snoozed: { name: 'Snoozed', dot: 'var(--gray-mid)', headline: 'Snoozed. It comes back at the snooze time.', band: { bg: 'var(--surface-2)', line: 'var(--line-strong)', badge: 'var(--gray-solid)' } },
  done: { name: 'Done', dot: 'var(--green)', headline: 'Marked done.', band: { bg: 'var(--surface-2)', line: 'var(--line-strong)', badge: 'var(--green)' } },
};

export const TYPE_LABEL: Record<ActionType, { draft: string; short: string; target: string }> = {
  confluence_entry: { draft: 'Draft Confluence entry', short: 'Confluence entry', target: 'Confluence' },
  vault_note: { draft: 'Draft vault note', short: 'Vault note', target: 'Vault' },
  todo: { draft: 'Add to-do', short: 'To-do', target: 'Tasks' },
};

/** What a draft of each type is called in a sentence. */
export const TYPE_NOUN: Record<ActionType, string> = { confluence_entry: 'Confluence entry', vault_note: 'vault note', todo: 'to-do' };

export type DraftState = 'none' | 'drafting' | 'ready' | 'stale' | 'writing' | 'done' | 'failed';

export interface DraftButton {
  type: ActionType;
  label: string;
  state: DraftState;
  disabledReason?: string;
}

export function draftState(item: ItemSummary, type: ActionType): DraftState {
  const a = item.actions[type];
  if (!a) return 'none';
  if (a.status === 'drafting') return 'drafting';
  if (a.status === 'ready') return a.stale ? 'stale' : 'ready';
  if (a.status === 'approved' || a.status === 'executing') return 'writing';
  if (a.status === 'done') return 'done';
  if (a.status === 'failed') return 'failed';
  return 'none';
}

const STATE_LABEL: Record<Exclude<DraftState, 'none'>, (t: ActionType) => string> = {
  drafting: () => 'Drafting…',
  ready: (t) => `Review ${TYPE_NOUN[t]}`,
  stale: (t) => `Review ${TYPE_NOUN[t]}`,
  writing: () => 'Writing…',
  done: (t) => `${t === 'todo' ? 'Added' : 'Filed'} to ${TYPE_LABEL[t].target}`,
  failed: (t) => `${TYPE_LABEL[t].target} draft failed`,
};

export function draftButton(item: ItemSummary, type: ActionType, draftsBudgetHit: boolean): DraftButton {
  const state = draftState(item, type);
  const disabledReason = state === 'none' && draftsBudgetHit && type !== 'todo' ? 'Drafts budget reached for today.' : undefined;
  const label = state === 'none' ? TYPE_LABEL[type].draft : state === 'failed' && item.actions[type]?.failedWhile === 'writing' ? `Not written to ${TYPE_LABEL[type].target}` : STATE_LABEL[state](type);
  return { type, state, label, disabledReason };
}

/** Filing types the triage suggests, Confluence first (as in the designs). */
export function suggestedTypes(item: ItemSummary): ActionType[] {
  const t: ActionType[] = [];
  if (item.triage?.confluence) t.push('confluence_entry');
  if (item.triage?.vault) t.push('vault_note');
  return t;
}

export interface CardActions {
  primary: { kind: 'slack' } | { kind: 'draft'; button: DraftButton };
  secondary?: DraftButton;
  overflowDrafts: DraftButton[];
}

/** An invitation holds nothing to file: Frank answers it in Outlook (R2.8). */
export const canFile = (item: Pick<ItemSummary, 'kind'>) => item.kind !== 'event';

/** Design guide §3: one primary per card chosen by lane, at most one secondary, the rest in the overflow. */
export function cardActions(item: ItemSummary, draftsBudgetHit: boolean): CardActions {
  if (!canFile(item)) return { primary: { kind: 'slack' }, overflowDrafts: [] };
  const all: ActionType[] = ['confluence_entry', 'vault_note'];
  const suggested = suggestedTypes(item);
  const btn = (t: ActionType) => draftButton(item, t, draftsBudgetHit);
  if (item.lane === 'file' && suggested.length) {
    // Prefer a filing that is still open over one already filed.
    const ordered = [...suggested].sort((a, b) => Number(draftState(item, a) === 'done') - Number(draftState(item, b) === 'done'));
    const [p, s] = ordered;
    return { primary: { kind: 'draft', button: btn(p) }, secondary: s ? btn(s) : undefined, overflowDrafts: all.filter((t) => t !== p && t !== s).map(btn) };
  }
  const sec = suggested[0];
  return { primary: { kind: 'slack' }, secondary: sec ? btn(sec) : undefined, overflowDrafts: all.filter((t) => t !== sec).map(btn) };
}

/** "Insights APIs › Decisions" for Confluence, "Vault · Resources" for the vault. */
/**
 * The filing in Ready to approve (FR-15.5), if the item has one still to approve: the vault's before
 * Confluence's, as it is the more routine.
 */
export function readyFiling(i: ItemSummary | undefined): { type: 'vault_note' | 'confluence_entry'; rule?: string } | undefined {
  for (const type of ['vault_note', 'confluence_entry'] as const) {
    const p = i?.filing?.[type];
    const state = i && draftState(i, type);
    if (p?.ready && state !== 'done' && state !== 'writing') return { type, ...(p.rule && { rule: p.rule }) };
  }
  return undefined;
}

/** Whether the item is in Ready to approve (FR-15.5). */
export const isReady = (i: ItemSummary | undefined) => !!readyFiling(i);

export function targetChip(i: ItemSummary): string | undefined {
  if (i.lane !== 'file') return undefined;
  const ready = readyFiling(i)?.type;
  if (ready === 'vault_note' && i.targetHints.vault) return `Vault · ${i.targetHints.vault.split('/')[0]}`;
  if (i.triage?.confluence && i.targetHints.confluence) return i.targetHints.confluence;
  const v = i.targetHints.vault;
  return v ? `Vault · ${v.split('/')[0]}` : undefined;
}
