import type { ReactNode } from 'react';
import type { Lane } from '@work-os/shared';
import { cx } from '../../components/ui';
import type { ItemSummary } from '../../api';
import { LANE_META, readyFiling } from '../../lib/lanes';
import { SOURCE_NAME, type DueTone } from '../../lib/next';

// Small inline labels for Inbox rows and the item panel. Colour only where it means something:
// the deadline's urgency, a blocker, a filing target.

const base = 'inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-md px-[7px] text-[11px]';

export function NeedTag({ children }: { children: ReactNode }) {
  return <span className={cx(base, 'bg-bg font-semibold text-ink-strong')}>{children}</span>;
}

const DUE: Record<DueTone, string> = { late: 'bg-red-wash text-red-fg', now: 'bg-orange-wash text-orange-fg', today: 'bg-accent-wash text-accent-ink', later: 'bg-bg text-ink-2' };

export function DueChip({ due }: { due: { text: string; tone: DueTone } }) {
  return <span className={cx(base, 'font-medium', DUE[due.tone])}>{due.text}</span>;
}

const STATUS = { block: 'bg-amber-wash text-amber-fg', file: 'bg-teal-wash text-teal-ink', ready: 'bg-green-wash text-green-fg', bad: 'bg-red-line/40 text-red-fg' } as const;

export function StatusChip({ tone, children }: { tone: keyof typeof STATUS; children: ReactNode }) {
  return <span className={cx(base, 'font-medium', STATUS[tone])}>{children}</span>;
}

/** Ready to approve (FR-15.5): drafted ahead by the filing policy, waiting for one key. */
export function ReadyChip({ item }: { item: ItemSummary }) {
  const ready = item.lane === 'file' ? readyFiling(item) : undefined;
  if (!ready) return null;
  return (
    <span className={cx(base, 'font-medium', STATUS.ready)} title={`Ready to approve${ready.rule ? `, by filing policy rule ${ready.rule}` : ''}`}>
      Ready{ready.rule && ` · ${ready.rule}`}
    </span>
  );
}

const DONE_BY = { reply: 'bg-green-wash text-green-fg', source: 'bg-accent-wash text-accent-ink', you: 'bg-bg text-ink-2' } as const;

/** Who closed a done item (cockpit CK-2.5): his reply, the source itself (an invite answered), or Frank. */
export function doneByLabel(item: Pick<ItemSummary, 'doneBy' | 'doneSource' | 'source'>): string | undefined {
  if (item.doneBy === 'reply') return `Your reply in ${SOURCE_NAME[item.doneSource ?? item.source]}`;
  if (item.doneBy === 'source') return item.source === 'calendar' || item.source === 'outlook' ? 'Answered in Outlook' : `Closed in ${SOURCE_NAME[item.source]}`;
  if (item.doneBy === 'you') return 'Done by you';
  return undefined;
}

export function DoneByChip({ item }: { item: ItemSummary }) {
  const label = doneByLabel(item);
  if (!label || !item.doneBy) return null;
  return (
    <span data-done-by={item.doneBy} title={item.doneReason} className={cx(base, 'font-medium', DONE_BY[item.doneBy])}>
      {label}
    </span>
  );
}

const LANE_BG: Partial<Record<Lane, string>> = { now: 'bg-orange', today: 'bg-accent-bg', file: 'bg-teal-solid', failed: 'bg-red', done: 'bg-green' };

export function LaneChip({ lane }: { lane: Lane }) {
  return <span className={cx(base, 'font-semibold text-on-solid', LANE_BG[lane] ?? 'bg-gray-solid')}>{lane === 'file' ? 'To file' : lane === 'waiting' ? 'Waiting' : LANE_META[lane].name}</span>;
}
