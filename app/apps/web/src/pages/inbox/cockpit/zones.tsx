import type { ReactNode, RefObject } from 'react';
import { londonParts } from '@work-os/shared';
import type { ItemSummary } from '../../../api';
import { markManyDoneWithUndo } from '../../../components/item';
import { Icon } from '../../../components/icons';
import { Button, IconButton, cx } from '../../../components/ui';
import { useResizable } from '../../../components/useResizable';
import type { ShownRow } from '../../../hooks/useStableGroups';
import { useNow } from '../../../hooks/useNow';
import type { ClosedByReply } from '@work-os/shared';
import { fmtAgoLong, fmtWhen } from '../../../lib/format';
import { LATER_WIDTH, usePrefs } from '../../../store/prefs';

// The cockpit's Needs you and Later zones (CK-3.8, CK-3.11). The Inbox page owns the rows (their
// order, the New dot, the panel); the zones lay them out, each scrolling on its own.

/** The lists off the main groups: footer links in the list layout, the Later zone on the cockpit. */
export type Lower = 'week' | 'else' | 'snoozed' | 'done' | 'waiting' | 'replied';

export const LOWER: Record<Lower, { title: string; note: string }> = {
  week: { title: 'This week', note: 'Due after today. Each moves to Needs you on the day it falls due.' },
  else: { title: 'Low priority', note: 'No action and nothing to file. Correct any that are wrong.' },
  snoozed: { title: 'Snoozed', note: 'Each comes back at its snooze time, or early if a new reply makes it Now.' },
  done: { title: 'Done', note: 'Comes back if someone other than you replies.' },
  waiting: { title: 'Waiting for quiet window', note: 'Still active. Triage runs once each thread has been quiet for a while.' },
  replied: { title: 'Closed by your replies', note: 'Your reply settled each of these. Reopen any that should still be open: it teaches the check.' },
};

type RenderRow = (r: ShownRow, n: number, list: ShownRow[]) => ReactNode;

/** "7 closed by your replies today · latest 2 min ago: Head of Sales", with Review (cockpit CK-2.5). */
export function RepliesLine({ closed, onReview, className }: { closed?: ClosedByReply; onReview: () => void; className?: string }) {
  const now = useNow(30_000);
  if (!closed?.today) return null;
  return (
    <div data-testid="replies-line" className={cx('flex shrink-0 items-center gap-2 border-t border-line px-6 text-[13px] text-muted', className)}>
      <Icon name="check" size={16} strokeWidth={2.25} className="shrink-0 text-green-fg" />
      <span className="min-w-0 truncate">
        <b className="font-semibold text-ink-2">
          {closed.today} closed by your {closed.today === 1 ? 'reply' : 'replies'}
        </b>{' '}
        today{closed.latestAt && ` · latest ${fmtAgoLong(closed.latestAt, now)}: ${closed.latestTitle ?? ''}`}
      </span>
      <span className="flex-1" />
      <button type="button" onClick={onReview} className="shrink-0 font-medium text-accent cursor-pointer hover:underline">
        Review
      </button>
    </div>
  );
}

function ZoneHead({ dot, title, count, children }: { dot: string; title: string; count: number; children?: ReactNode }) {
  return (
    <div className="flex h-14 shrink-0 items-center gap-2.5 px-6">
      <span aria-hidden className={cx('size-2.5 shrink-0 rounded-full', dot)} />
      <h2 className="m-0 text-glance-m">{title}</h2>
      <span className="text-sm text-muted tabular-nums">{count}</span>
      <span className="flex-1" />
      {children}
    </div>
  );
}

const live = (rows: ShownRow[]) => rows.filter((r) => !r.leaving).length;

/** Now, then Today (failed triage at its top), each under its own header. */
export function NeedsYouZone({
  rows,
  render,
  pill,
  scrollerRef,
  sortMenu,
  empty,
  footer,
  children,
}: {
  rows: ShownRow[];
  render: RenderRow;
  pill: ReactNode;
  scrollerRef: RefObject<HTMLElement | null>;
  sortMenu: ReactNode;
  empty?: ReactNode;
  /** The line under the list: closes by reply today (CK-2.5). */
  footer?: ReactNode;
  children?: ReactNode;
}) {
  const now = rows.filter((r) => r.item.lane === 'now');
  const today = rows.filter((r) => r.item.lane !== 'now');
  return (
    <section aria-label="Needs you" data-cockpit-zone="needs" className="flex min-w-0 flex-1 flex-col border-r border-line">
      <ZoneHead dot="bg-orange" title="Needs you" count={live(rows)}>
        {sortMenu}
      </ZoneHead>
      <section ref={scrollerRef} aria-label="Needs you list" data-group="needs" className="min-h-0 flex-1 overflow-y-auto pb-6 [overflow-anchor:none]">
        {pill}
        {empty ??
          (rows.length ? (
            <>
              {now.length > 0 && (
                <>
                  <h3 data-lane-head="now" className="m-0 border-t border-orange-line bg-orange-wash-2 px-6 py-1.5 text-xs font-semibold tracking-[0.04em] text-orange-fg">
                    NOW · {live(now)}
                  </h3>
                  {now.flatMap(render)}
                </>
              )}
              {today.length > 0 && (
                <>
                  <h3 data-lane-head="today" className="m-0 border-t border-line-strong bg-surface-2 px-6 py-1.5 text-xs font-semibold tracking-[0.04em] text-accent-ink">
                    TODAY · {live(today)}
                  </h3>
                  {today.flatMap(render)}
                </>
              )}
              <div className="border-t border-line-soft" />
            </>
          ) : (
            <p className="m-0 border-t border-line-soft px-6 py-4 text-sm text-muted">Nothing needs you. Later holds what can wait.</p>
          ))}
        {children}
      </section>
      {footer}
    </section>
  );
}

function SubHead({ dot, title, count, children }: { dot: string; title: string; count: number; children?: ReactNode }) {
  return (
    <div className="flex min-h-11 items-center border-t border-line px-6 py-2">
      <span aria-hidden className={cx('mr-2 size-2 shrink-0 rounded-full', dot)} />
      <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
      <span className="ml-1.5 text-xs text-muted tabular-nums">{count}</span>
      <span className="flex-1" />
      {children}
    </div>
  );
}

/** Items done since midnight, London time. */
const doneToday = (done: readonly ItemSummary[], now: Date) => {
  const day = londonParts(now).dateKey;
  return done.filter((i) => i.doneAt && londonParts(i.doneAt).dateKey === day).length;
};

/**
 * Waiting on others (when it holds something), To file, This week and a Snoozed link, with Low
 * priority and Done at the foot. Snoozed, Low priority, Done and Waiting open in place of the
 * default view, one at a time; Esc comes back.
 */
export function LaterZone({
  followRows,
  followPill,
  fileRows,
  by,
  open,
  onOpen,
  renderFile,
  renderLower,
  pill,
  fileAction,
  scrollerRef,
}: {
  /** Waiting on others (FR-8.1, amended): Frank owns the outcome, someone else has the next move. */
  followRows: ShownRow[];
  followPill: ReactNode;
  fileRows: ShownRow[];
  by: Record<Lower, ItemSummary[]>;
  open: Lower | null;
  onOpen: (g: Lower | null) => void;
  renderFile: RenderRow;
  renderLower: (i: ItemSummary, n: number, list: ItemSummary[]) => ReactNode;
  pill: ReactNode;
  /** File in a batch (CK-4.1), in the To file header. */
  fileAction?: ReactNode;
  scrollerRef: RefObject<HTMLElement | null>;
}) {
  const now = useNow(30_000);
  const back = by.snoozed[0]?.snoozedUntil;
  const files = live(fileRows);
  const follows = live(followRows);
  const today = doneToday(by.done, now);
  const list = open && open !== 'week' ? open : null;
  const { width, dragging, handle } = useResizable({ saved: usePrefs((s) => s.laterWidth), save: usePrefs((s) => s.setLaterWidth), bounds: LATER_WIDTH, edge: 'left', label: 'Resize the Later column' });
  return (
    <section aria-label="Later" data-cockpit-zone="later" className={cx('relative flex shrink-0 flex-col bg-later-bg', !dragging && 'transition-[width] duration-200 ease-out motion-reduce:transition-none')} style={{ width }}>
      <ZoneHead dot="bg-faint" title="Later" count={follows + files + by.week.length + by.snoozed.length}>
        <span className="text-[13px] text-muted">Once a day</span>
      </ZoneHead>
      <section ref={scrollerRef} aria-label="Later list" className="min-h-0 flex-1 overflow-y-auto pb-4 [overflow-anchor:none]">
        {list ? (
          <section aria-label={LOWER[list].title} data-group={list} className="flex flex-col">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-line py-2 pl-3 pr-6">
              <IconButton label="Back to Later (Esc)" icon="back" size={28} onClick={() => onOpen(null)} />
              <h3 className="m-0 text-[13px] font-semibold">{LOWER[list].title}</h3>
              <span className="text-xs text-muted tabular-nums">{by[list].length}</span>
              <span className="flex-1" />
              {list === 'else' && by.else.length > 0 && (
                <Button size="sm" icon="check" onClick={() => void markManyDoneWithUndo(by.else, 'Low priority')}>
                  Mark all {by.else.length} done
                </Button>
              )}
              <p className="m-0 w-full pb-1 pl-9 text-xs text-muted">{LOWER[list].note}</p>
            </div>
            <div className="border-b border-line-soft">{by[list].length ? by[list].flatMap(renderLower) : <p className="m-0 border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing here.</p>}</div>
          </section>
        ) : (
          <>
            {followRows.length > 0 && (
              <section aria-label="Waiting on others" data-group="follow" className="mb-2 flex flex-col">
                {followPill}
                <SubHead dot="bg-gray-solid" title="Waiting on others" count={follows} />
                {followRows.flatMap(renderFile)}
              </section>
            )}
            <section aria-label="To file" data-group="file" className="flex flex-col">
              {pill}
              <SubHead dot="bg-teal-solid" title="To file" count={files}>
                {fileAction}
              </SubHead>
              {fileRows.length ? fileRows.flatMap(renderFile) : <p className="m-0 border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing to file.</p>}
            </section>
            <section aria-label="This week" data-group="week" className="mt-2 flex flex-col">
              <SubHead dot="bg-gray-mid" title="This week" count={by.week.length} />
              {by.week.length ? by.week.flatMap(renderLower) : <p className="m-0 border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing due later this week.</p>}
            </section>
            {by.snoozed.length > 0 && (
              <button
                type="button"
                onClick={() => onOpen('snoozed')}
                className="mt-2 flex w-full items-center gap-2 border-t border-line px-6 py-3 text-left text-[13px] text-ink-2 cursor-pointer hover:bg-surface-2"
              >
                <Icon name="clock" size={16} />
                <span className="font-semibold">{by.snoozed.length} snoozed</span>
                {back && <span className="text-muted">· next back {fmtWhen(back, now)}</span>}
              </button>
            )}
          </>
        )}
      </section>
      <div data-testid="later-foot" className="flex shrink-0 items-center gap-3 border-t border-line px-6 py-4">
        <button
          type="button"
          aria-expanded={open === 'else'}
          onClick={() => onOpen(open === 'else' ? null : 'else')}
          className={cx(
            'inline-flex h-9 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[13px] text-ink-2 cursor-pointer hover:bg-surface-2 hover:text-ink',
            open === 'else' && 'bg-surface-2 text-ink',
          )}
        >
          <Icon name="inbox" size={16} />
          <span>
            <span className="font-semibold">{by.else.length} low priority</span> · check triage
          </span>
        </button>
        <span className="flex-1" />
        {by.done.length > 0 && (
          <button type="button" aria-expanded={open === 'done'} onClick={() => onOpen(open === 'done' ? null : 'done')} className="text-[13px] text-muted cursor-pointer hover:text-ink-2 hover:underline">
            {today ? `${today} done today` : `${by.done.length} done`}
          </button>
        )}
      </div>
      {handle}
    </section>
  );
}
