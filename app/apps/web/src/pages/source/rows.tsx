import type { ReactNode } from 'react';
import { londonAt, londonParts, mondayOf, type SourceRow } from '@work-os/shared';
import { kindLabel, markDoneWithUndo } from '../../components/item';
import { IconButton, cx } from '../../components/ui';
import { fmtDayDate, fmtTime, plural } from '../../lib/format';
import { TYPE_LABEL } from '../../lib/lanes';
import { channelKey } from '../../lib/next';
import { DoneByChip, LaneChip, StatusChip } from '../inbox/chips';

// A source's history (cockpit CK-5): every item it has stored, newest first. Rows say where triage
// put each one, so nothing is hidden and nothing is ranked.

/** Where triage put it, whether it was filed, and why it may look different from the Inbox. */
export function StateChips({ item }: { item: SourceRow }) {
  const filed = Object.values(item.actions).filter((a) => a?.status === 'done');
  return (
    <span data-state-chips className="flex flex-wrap items-center gap-1">
      {item.lane === 'done' ? <DoneByChip item={item} /> : <LaneChip lane={item.lane} />}
      {item.lane === 'done' && !item.doneBy && <LaneChip lane="done" />}
      {filed.map((a) => (
        <StatusChip key={a!.id} tone="file">
          Filed · {TYPE_LABEL[a!.type].target}
        </StatusChip>
      ))}
      {item.excluded && <StatusChip tone="block">Excluded channel</StatusChip>}
      {item.expired && (
        <span title="Older than the retention period: its text is gone, its link still works." className="font-mono text-[11px] text-muted">
          text expired
        </span>
      )}
    </span>
  );
}

/**
 * One item in a history list. `lead` is who or what it is (people, a sender, a meeting), `title`
 * an optional bold line (an email's subject), then the summary; the chips sit at the right edge.
 */
export function HistoryRow({ item, selected, onPick, lead, title, when }: { item: SourceRow; selected: boolean; onPick: () => void; lead: ReactNode; title?: ReactNode; when: string }) {
  return (
    <div className={cx('group/row flex items-center border-t border-line-soft pr-3', selected ? 'bg-accent-wash shadow-[inset_3px_0_0_var(--accent-bg)]' : 'hover:bg-surface-2')}>
      <button
        type="button"
        data-row={item.id}
        data-lane={item.lane}
        data-status={item.status}
        data-activity={item.lastActivityAt}
        aria-current={selected ? 'true' : undefined}
        onClick={onPick}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3.5 gap-y-1.5 py-[11px] pl-6 pr-2 text-left cursor-pointer"
      >
        <span className="flex min-w-[130px] flex-[0_1_190px] flex-col gap-px">
          <span className="truncate text-xs font-medium text-ink-2">{lead}</span>
          <span className="text-[11px] text-muted">
            {kindLabel(item.kind)} · {when}
            {item.messageCount > 1 && <> · {plural(item.messageCount, 'message')}</>}
            {item.pieces > 1 && <span data-pieces={item.pieces}> · {plural(item.pieces, 'part')}</span>}
          </span>
        </span>
        <span className="flex min-w-0 flex-[1_1_260px] flex-wrap items-center gap-x-3.5 gap-y-1.5">
          <span className={cx('flex min-w-0 flex-[1_1_240px] flex-col gap-0.5 text-[13px] leading-[1.4]', item.status === 'done' ? 'text-ink-2' : 'text-ink')}>
            {title && <span className="font-medium">{title}</span>}
            {item.summary && <span className={cx(!!title && 'line-clamp-1 text-ink-2')}>{item.summary}</span>}
          </span>
          <StateChips item={item} />
        </span>
      </button>
      {item.status !== 'done' ? (
        <IconButton
          data-row-action
          label={`Mark done: ${item.summary || item.title}`}
          icon="check"
          size={32}
          className="text-muted opacity-60 hover:text-ink hover:opacity-100 focus-visible:opacity-100 group-hover/row:opacity-100"
          onClick={() => void markDoneWithUndo(item)}
        />
      ) : (
        <span aria-hidden="true" className="w-8 shrink-0" />
      )}
    </div>
  );
}

/** A labelled run of rows: a day, a week, or a Slack conversation. */
export function HistoryGroup({ id, title, count, children }: { id: string; title: ReactNode; count: number; children: ReactNode }) {
  return (
    <section aria-label={typeof title === 'string' ? title : undefined} data-history-group={id} className="flex flex-col">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-t border-line-soft bg-surface-2 px-6 py-1">
        <h3 className="m-0 min-w-0 truncate text-xs font-semibold text-ink-2">{title}</h3>
        <span className="font-mono text-[11px] text-muted">{count}</span>
      </div>
      {children}
    </section>
  );
}

export interface Group {
  id: string;
  title: string;
  items: SourceRow[];
}

/** Runs of rows that share a key, in the order the rows come (newest first). */
function runs(items: readonly SourceRow[], keyOf: (i: SourceRow) => string, titleOf: (i: SourceRow) => string): Group[] {
  const by = new Map<string, Group>();
  for (const i of items) {
    const id = keyOf(i);
    const g = by.get(id);
    if (g) g.items.push(i);
    else by.set(id, { id, title: titleOf(i), items: [i] });
  }
  return [...by.values()];
}

/** "Today", "Yesterday", else "Mon 5 Oct": a London day. */
export function dayTitle(iso: string, now: Date): string {
  const key = londonParts(iso).dateKey;
  if (key === londonParts(now).dateKey) return 'Today';
  if (key === londonParts(londonAt(now, '12:00', -1)).dateKey) return 'Yesterday';
  return fmtDayDate(iso);
}

/** "This week", "Last week", else "Week of 21 Sep": a London week, from its Monday. */
export function weekTitle(iso: string, now: Date): string {
  const monday = mondayOf(new Date(iso));
  const thisWeek = mondayOf(now);
  if (monday === thisWeek) return 'This week';
  if (monday === londonParts(londonAt(new Date(`${thisWeek}T12:00:00Z`), '12:00', -7)).dateKey) return 'Last week';
  return `Week of ${fmtDayDate(`${monday}T12:00:00Z`).replace(/^\w+ /, '')}`;
}

/** Slack (CK-5.3): a conversation's items together, the conversation with the newest first. */
export const byConversation = (items: readonly SourceRow[]) =>
  runs(
    items,
    (i) => channelKey(i) ?? `item:${i.id}`,
    (i) => (i.kind === 'dm' ? `DM · ${i.title}` : i.title),
  );

/** Outlook (CK-5.4): a day's mail together. */
export const byDay = (items: readonly SourceRow[], now: Date) =>
  runs(
    items,
    (i) => londonParts(i.lastActivityAt).dateKey,
    (i) => dayTitle(i.lastActivityAt, now),
  );

/** Wispr Flow (CK-5.5): a week's meeting notes together. */
export const byWeek = (items: readonly SourceRow[], now: Date) =>
  runs(
    items,
    (i) => mondayOf(new Date(i.lastActivityAt)),
    (i) => weekTitle(i.lastActivityAt, now),
  );

/** "09:20" today, "Mon 09:20" this week, "5 Oct 09:20" before. */
export function whenOf(iso: string, now: Date): string {
  const days = (now.getTime() - Date.parse(iso)) / 86_400_000;
  if (londonParts(iso).dateKey === londonParts(now).dateKey) return fmtTime(iso);
  return days < 6 ? `${londonParts(iso).weekday} ${fmtTime(iso)}` : `${fmtDayDate(iso).replace(/^\w+ /, '')} ${fmtTime(iso)}`;
}
