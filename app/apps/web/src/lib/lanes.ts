import type { ActionType, Lane } from '@work-os/shared';
import type { ItemSummary } from '../api';

export const LANE_META: Record<Lane, { name: string; dot: string; headline: string; band: { bg: string; line: string; badge: string } }> = {
  now: { name: 'Now', dot: 'var(--orange)', headline: 'Needs you within the hour.', band: { bg: 'var(--orange-wash)', line: 'var(--orange-line)', badge: 'var(--orange)' } },
  today: { name: 'Today', dot: 'var(--accent-bg)', headline: 'Handle before end of day.', band: { bg: 'var(--accent-wash-3)', line: 'var(--accent-line-4)', badge: 'var(--accent-bg)' } },
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
};

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
  ready: (t) => `Review ${t === 'vault_note' ? 'vault note' : 'Confluence entry'}`,
  stale: (t) => `Review ${t === 'vault_note' ? 'vault note' : 'Confluence entry'}`,
  writing: () => 'Writing…',
  done: (t) => `Filed to ${TYPE_LABEL[t].target}`,
  failed: (t) => `${TYPE_LABEL[t].target} draft failed`,
};

export function draftButton(item: ItemSummary, type: ActionType, draftsBudgetHit: boolean): DraftButton {
  const state = draftState(item, type);
  let disabledReason: string | undefined;
  if (type === 'confluence_entry' && item.containsPeopleObservations) {
    disabledReason = 'Mentions named people, so it can only go to the private vault (FR-10.1).';
  } else if (state === 'none' && draftsBudgetHit) {
    disabledReason = 'Drafts budget reached for today.';
  }
  return { type, state, label: state === 'none' ? TYPE_LABEL[type].draft : STATE_LABEL[state](type), disabledReason };
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

/** Design guide §3: one primary per card chosen by lane, at most one secondary, the rest in the overflow. */
export function cardActions(item: ItemSummary, draftsBudgetHit: boolean): CardActions {
  const all: ActionType[] = ['confluence_entry', 'vault_note'];
  const suggested = suggestedTypes(item);
  const btn = (t: ActionType) => draftButton(item, t, draftsBudgetHit);
  // Confluence is never offered for people observations; other disabled drafts stay visible with their reason.
  const usable = suggested.filter((t) => !(t === 'confluence_entry' && item.containsPeopleObservations));
  if (item.lane === 'file' && usable.length) {
    // Prefer a filing that is still open over one already filed.
    const ordered = [...usable].sort((a, b) => Number(draftState(item, a) === 'done') - Number(draftState(item, b) === 'done'));
    const [p, s] = ordered;
    return { primary: { kind: 'draft', button: btn(p) }, secondary: s ? btn(s) : undefined, overflowDrafts: all.filter((t) => t !== p && t !== s).map(btn) };
  }
  const sec = usable[0];
  return { primary: { kind: 'slack' }, secondary: sec ? btn(sec) : undefined, overflowDrafts: all.filter((t) => t !== sec).map(btn) };
}
