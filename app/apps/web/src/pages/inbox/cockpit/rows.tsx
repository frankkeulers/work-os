import type { ReactNode } from 'react';
import type { ItemSummary } from '../../../api';
import { SourceMark } from '../../../components/BrandIcon';
import { CategoryDot, ItemMarkers, kindLabel, markDoneWithUndo } from '../../../components/item';
import { IconButton, cx } from '../../../components/ui';
import { useNow } from '../../../hooks/useNow';
import { fmtAgo, plural } from '../../../lib/format';
import { targetChip } from '../../../lib/lanes';
import { dueInfo, needLabel, topicAsks } from '../../../lib/next';
import { DueChip, NeedTag, StatusChip } from '../chips';

// The cockpit's rows (CK-3.8, CK-3.11). Needs you: two lines, where and the chips, then the summary
// large enough to read from across the desk. Later: the summary first, then where and its one chip.

interface RowProps {
  item: ItemSummary;
  selected: boolean;
  isNew: boolean;
  leaving?: boolean;
  onPick: () => void;
}

function NewDot() {
  return (
    <span data-new-dot className="inline-flex shrink-0 items-center gap-1 font-medium text-accent">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
      New
    </span>
  );
}

/** The Done button beside a row (a button can't hold another). */
function DoneButton({ item }: { item: ItemSummary }) {
  return item.status !== 'done' ? (
    <IconButton
      data-row-action
      label={`Mark done: ${item.summary}`}
      icon="check"
      size={32}
      className="text-muted opacity-60 hover:text-ink hover:opacity-100 focus-visible:opacity-100 group-hover/row:opacity-100"
      onClick={() => void markDoneWithUndo(item)}
    />
  ) : (
    <span aria-hidden="true" className="w-8 shrink-0" />
  );
}

/** A row that left collapses where it was (CK-1.2). */
const collapse = (leaving: boolean | undefined, row: ReactNode) =>
  leaving ? (
    <div className="row-leave" inert>
      <div>{row}</div>
    </div>
  ) : (
    row
  );

const rowAttrs = (item: ItemSummary, isNew: boolean, leaving: boolean | undefined, selected: boolean) => ({
  'data-row': item.id,
  'data-lane': item.lane,
  'data-new': isNew || undefined,
  'data-leaving': leaving || undefined,
  'data-activity': item.lastActivityAt,
  'aria-current': selected ? ('true' as const) : undefined,
});

function Categories({ item }: { item: ItemSummary }) {
  const c = item.calendarCategories;
  if (!c?.length) return null;
  const named = c.map((x) => x.name).join(', ');
  return (
    <span data-row-categories={named} title={named} className="flex shrink-0 gap-0.5">
      {c.map((x) => (
        <CategoryDot key={x.name} color={x.color} />
      ))}
      <span className="sr-only">, {named}</span>
    </span>
  );
}

export function CockpitRow({ item, selected, isNew, leaving, onPick }: RowProps) {
  const now = useNow(30_000);
  const failed = item.lane === 'failed';
  const due = dueInfo(item.next, now);
  const moreAsks = topicAsks(item).filter((a) => !a.done).length - 1;
  const row = (
    <div
      className={cx(
        'group/row flex items-center border-t pr-3',
        item.lane === 'now' ? 'border-now-line' : 'border-line-soft',
        selected ? 'bg-accent-wash shadow-[inset_3px_0_0_var(--accent-bg)]' : item.lane === 'now' ? 'bg-orange-wash-2' : 'hover:bg-surface-2',
      )}
    >
      <button type="button" {...rowAttrs(item, isNew, leaving, selected)} onClick={onPick} className="flex min-w-0 flex-1 flex-col gap-1 py-2.5 pl-6 pr-2 text-left cursor-pointer">
        <span className="flex w-full min-w-0 items-center gap-2 text-xs text-muted">
          <span className="flex w-[18px] shrink-0 justify-center">
            <SourceMark source={item.source} size={18} />
          </span>
          <Categories item={item} />
          <span className="min-w-0 truncate font-medium text-ink-2">{item.title}</span>
          <span className="shrink-0">
            {kindLabel(item.kind)} · {fmtAgo(item.lastActivityAt, now)}
            {item.pieces > 1 && <span data-pieces={item.pieces}> · {plural(item.pieces, 'part')}</span>}
          </span>
          {isNew && <NewDot />}
          <span className="flex-1" />
          {failed ? <StatusChip tone="bad">Triage failed</StatusChip> : <NeedTag>{item.next ? needLabel(item.next) : 'Reply'}</NeedTag>}
          {moreAsks > 0 && <span className="shrink-0 font-mono text-[11px] text-muted">+{plural(moreAsks, 'ask')}</span>}
          {due && <DueChip due={due} />}
        </span>
        <span className="w-full truncate pl-[26px] text-row">{item.summary}</span>
        <span className="pl-[26px] empty:hidden">
          <ItemMarkers item={item} />
        </span>
      </button>
      <DoneButton item={item} />
    </div>
  );
  return collapse(leaving, row);
}

export function LaterRow({ item, selected, isNew, leaving, meta, onPick }: RowProps & { meta?: string }) {
  const now = useNow(30_000);
  const target = targetChip(item);
  const due = item.lane === 'week' ? dueInfo(item.next, now) : undefined;
  const row = (
    <div className={cx('group/row flex items-center border-t border-line-soft pr-3', selected ? 'bg-accent-wash shadow-[inset_3px_0_0_var(--accent-bg)]' : 'hover:bg-surface-2')}>
      <button type="button" {...rowAttrs(item, isNew, leaving, selected)} onClick={onPick} className="flex min-w-0 flex-1 flex-col gap-1 py-[9px] pl-6 pr-2 text-left cursor-pointer">
        <span className={cx('w-full truncate text-sm leading-[19px]', item.lane === 'file' || item.lane === 'week' ? 'font-medium text-ink' : 'text-ink-2')}>{item.summary}</span>
        <span className="flex w-full min-w-0 items-center gap-2 text-xs text-muted">
          <SourceMark source={item.source} size={14} />
          <Categories item={item} />
          <span className="min-w-0 truncate">
            {item.title} · {fmtAgo(item.lastActivityAt, now)}
          </span>
          {isNew && <NewDot />}
          <span className="flex-1" />
          {item.lane === 'week' && item.next && <NeedTag>{needLabel(item.next)}</NeedTag>}
          {due && <DueChip due={due} />}
          {target && <StatusChip tone="file">{target}</StatusChip>}
          {meta && <span className="shrink-0 font-mono text-[11px]">{meta}</span>}
        </span>
        <span className="empty:hidden">
          <ItemMarkers item={item} />
        </span>
      </button>
      <DoneButton item={item} />
    </div>
  );
  return collapse(leaving, row);
}
