import type { ReactNode } from 'react';
import type { Lane } from '@work-os/shared';
import { cx } from '../../components/ui';
import { LANE_META } from '../../lib/lanes';
import type { DueTone } from '../../lib/next';

// Small inline labels for Inbox rows and the item panel. Colour only where it means something:
// the deadline's urgency, a blocker, a filing target.

const base = 'inline-flex h-[22px] items-center gap-[5px] whitespace-nowrap rounded-md px-[7px] text-[11px]';

export function NeedTag({ children }: { children: ReactNode }) {
  return <span className={cx(base, 'bg-bg font-semibold text-ink-strong')}>{children}</span>;
}

const DUE: Record<DueTone, string> = { now: 'bg-orange-wash text-orange-fg', today: 'bg-accent-wash text-accent-ink', later: 'bg-bg text-ink-2' };

export function DueChip({ due }: { due: { text: string; tone: DueTone } }) {
  return <span className={cx(base, 'font-medium', DUE[due.tone])}>{due.text}</span>;
}

const STATUS = { block: 'bg-amber-wash text-amber-fg', file: 'bg-teal-wash text-teal-ink', bad: 'bg-red-line/40 text-red-fg' } as const;

export function StatusChip({ tone, children }: { tone: keyof typeof STATUS; children: ReactNode }) {
  return <span className={cx(base, 'font-medium', STATUS[tone])}>{children}</span>;
}

const LANE_BG: Partial<Record<Lane, string>> = { now: 'bg-orange', today: 'bg-accent-bg', file: 'bg-teal-solid', failed: 'bg-red', done: 'bg-green' };

export function LaneChip({ lane }: { lane: Lane }) {
  return <span className={cx(base, 'font-semibold text-on-solid', LANE_BG[lane] ?? 'bg-gray-solid')}>{lane === 'file' ? 'To file' : lane === 'waiting' ? 'Waiting' : LANE_META[lane].name}</span>;
}
