import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import type { ActionType } from '@work-os/shared';
import { api, type InboxView, type ItemSummary } from '../api';
import { typeParam } from '../components/ActionPanel';
import { Agenda } from '../components/Agenda';
import { SourceMark } from '../components/BrandIcon';
import { BrandMark } from '../components/brand/BrandMark';
import { CategoryDot, ItemMarkers, itemPath, kindLabel, markDoneWithUndo, markManyDoneWithUndo } from '../components/item';
import { HealthBanner } from '../components/HealthBanner';
import { HEALTH_BAR, HealthPill, usePillHealth } from '../components/HealthPill';
import { Icon } from '../components/icons';
import { useShell } from '../components/Shell';
import { Banner, Button, IconButton, MenuItem, PhaseTag, PopoverPanel, Spinner, cx, phaseToast, usePopover } from '../components/ui';
import { useLookedAt } from '../hooks/useLookedAt';
import { useWideLayout } from '../hooks/useLayout';
import { useStableGroups, type ShownRow } from '../hooks/useStableGroups';
import { useNow } from '../hooks/useNow';
import type { OpenItemState } from '../hooks/useOpenItem';
import { closedByReply, useRepliedHold } from '../hooks/useRepliedHold';
import { fmtAgo, fmtDayDate, fmtIn, fmtMoney, fmtTime, fmtWhen, plural } from '../lib/format';
import { isReady, targetChip } from '../lib/lanes';
import { INBOX_SORT_LABEL, SOURCE_NAME, byDue, channelKey, dueInfo, groupByChannel, isLive, laneCounts, needLabel, sortItems, topicAsks, type InboxSort, type LaneCounts } from '../lib/next';
import { NEW_FOR_MS, usePrefs } from '../store/prefs';
import { useUserMoves } from '../store/userMoves';
import { requestQuietDraft } from '../store/quietDrafts';
import { errorToast, toast } from '../store/toasts';
import { DoneByChip, DueChip, NeedTag, ReadyChip, StatusChip } from './inbox/chips';
import { CockpitRow, LaterRow, RepliedRow, ReplyNote } from './inbox/cockpit/rows';
import { TimeColumn } from './inbox/cockpit/TimeColumn';
import { LOWER, LaterZone, NeedsYouZone, RepliesLine, type Lower } from './inbox/cockpit/zones';
import { BatchDone, ItemPanel, SweepDone } from './inbox/ItemPanel';
import { counted, newSweep, nextInSweep, type Sweep } from './inbox/sweep';
import { FiledToday } from './inbox/FiledToday';
import { TodoGroup, focusFirstTodo } from './inbox/TodoGroup';
import { batchable, filingFor, needsDraft, type Batch } from './inbox/batch';
import { useDraftAhead } from './inbox/draftAhead';
import { LeaveDialog, PanelSlide } from './inbox/PanelSlide';
import { rowEl, usePanelHost } from './inbox/usePanelHost';
import { NotificationBell } from '../components/NotificationBell';

// The two groups on screen (FR-8.1). Failed triage sits in Needs you, untriaged, so it isn't missed.
const isTop = (i: ItemSummary) => i.lane === 'now' || i.lane === 'today' || i.lane === 'week' || i.lane === 'failed' || i.lane === 'file';
const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]');

// ---------- Header ----------

/** What the last poll found, for a few minutes after it ran. */
function pollResult(inbox: InboxView, now: Date) {
  const r = inbox.poll.lastResult;
  if (!r || now.getTime() - Date.parse(r.at) >= 3 * 60_000) return null;
  return r.triaged === 0 ? (r.fetched === 0 ? 'Nothing new, no Claude call' : `${r.fetched} new · no Claude call needed`) : `${r.fetched} new · ${r.triaged} triaged in ${plural(r.calls, 'call')}`;
}

/** "Triaging 12 threads…", or just "Triaging…" before the count is known. What it cost is in the result line after. */
const triaging = (n: number | undefined) => (n ? `Triaging ${plural(n, 'thread')}…` : 'Triaging…');

/**
 * One quiet line left of the Poll button: what the poll is doing or what the last one found, then
 * threads still being written. The poll part shows only when there's something to say; the rest
 * (last and next poll) is in the button's tooltip. Slack trouble has its own banner.
 */
function StatusLine({ inbox, stillActive, open, onToggle }: { inbox: InboxView; stillActive: number; open: boolean; onToggle: () => void }) {
  const now = useNow(5_000);
  const { poll } = inbox;
  const busy = poll.phase !== 'idle';
  const text = poll.phase === 'polling' ? `Polling ${poll.polling ? SOURCE_NAME[poll.polling] : 'sources'}…` : poll.phase === 'triaging' ? triaging(poll.triagingCount) : pollResult(inbox, now);
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted">
      <span data-testid="poll-line" aria-live="polite" className="inline-flex items-center gap-1.5">
        {busy && (
          <span className="text-accent">
            <Spinner size={12} />
          </span>
        )}
        {text}
      </span>
      {text && stillActive > 0 && <span aria-hidden>·</span>}
      {/* Threads still being written, which triage once they go quiet. Opens their list under the footer. */}
      {stillActive > 0 && (
        <button
          type="button"
          aria-expanded={open}
          onClick={onToggle}
          title="Triage runs once each thread has been quiet for a while."
          className={cx('-mx-1 inline-flex min-h-8 items-center rounded-lg px-1 cursor-pointer hover:bg-surface-2 hover:text-ink-2', open && 'text-ink-2')}
        >
          {stillActive} still active
        </button>
      )}
    </span>
  );
}

function pollTooltip(inbox: InboxView) {
  const { poll, source } = inbox;
  const parts = [poll.lastPollAt ? `Last poll ${fmtTime(poll.lastPollAt)}` : 'Not polled yet'];
  if (source.status === 'backoff' && source.retryAt) parts.push(`retry ${fmtTime(source.retryAt)}`);
  else if (source.status === 'auth_failed') parts.push('polling stopped');
  else if (poll.nextPollAt) parts.push(`next ${fmtTime(poll.nextPollAt)}`);
  if (!inbox.workHours) parts.push('off-hours');
  return parts.join(' · ');
}

/** Where each count pill scrolls to: the first row of its lane, or the To file group. */
const PILL_TARGET: Record<keyof LaneCounts, string> = {
  now: '[data-group="needs"] [data-row][data-lane="now"]',
  today: '[data-group="needs"] [data-row][data-lane="today"], [data-group="needs"] [data-row][data-lane="failed"]',
  file: '[data-group="file"]',
};

const PILLS: { id: keyof LaneCounts; label: string; tone: string }[] = [
  { id: 'now', label: 'now', tone: 'bg-orange-wash text-orange-fg' },
  { id: 'today', label: 'today', tone: 'bg-accent-wash text-accent-ink' },
  { id: 'file', label: 'to file', tone: 'bg-teal-wash text-teal-ink' },
];

/** "3 now · 6 today · 4 to file", readable from across the desk (cockpit CK-1.5). A click scrolls there. */
function CountPills({ counts }: { counts: LaneCounts }) {
  const go = (id: keyof LaneCounts) => {
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.querySelector(PILL_TARGET[id])?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  };
  return (
    <div data-testid="count-pills" className="flex items-center gap-2.5">
      {PILLS.map((p) => {
        const n = counts[p.id];
        return (
          <button
            key={p.id}
            type="button"
            data-pill={p.id}
            disabled={!n}
            onClick={() => go(p.id)}
            className={cx('inline-flex items-baseline gap-1.5 rounded-lg px-3 py-1 text-sm font-medium', n ? `${p.tone} cursor-pointer hover:brightness-[0.97]` : 'bg-surface-2 text-muted')}
          >
            <span className="text-glance-l tabular-nums">{n}</span>
            {p.label}
          </button>
        );
      })}
    </div>
  );
}

function SortMenu() {
  const sort = usePrefs((s) => s.inboxSort);
  const setSort = usePrefs((s) => s.setInboxSort);
  const grouped = usePrefs((s) => s.groupByChannel);
  const setGrouped = usePrefs((s) => s.setGroupByChannel);
  const { open, setOpen, close, trigger, panel } = usePopover();
  return (
    <div className="relative">
      <button
        type="button"
        ref={trigger}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={`Sort: ${INBOX_SORT_LABEL[sort]}`}
        className={cx('inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium text-ink-2 cursor-pointer hover:bg-track', open && 'bg-track')}
      >
        {INBOX_SORT_LABEL[sort]}
        <Icon name="down" size={12} className="text-muted" />
      </button>
      {open && (
        <PopoverPanel panelRef={panel} role="menu" label="Sort" align="left" className="w-[200px]">
          {(Object.keys(INBOX_SORT_LABEL) as InboxSort[]).map((k) => (
            <MenuItem key={k} onClick={() => (setSort(k), close())} hint={k === sort && <Icon name="check" size={14} className="text-accent" />}>
              {INBOX_SORT_LABEL[k]}
            </MenuItem>
          ))}
          <div className="mx-1 my-1.5 border-t border-line-soft" />
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={grouped}
            onClick={() => setGrouped(!grouped)}
            className="flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] text-ink cursor-pointer hover:bg-surface-2"
          >
            <span className="flex-1">Group by channel</span>
            {grouped && <Icon name="check" size={14} className="text-accent" />}
          </button>
        </PopoverPanel>
      )}
    </div>
  );
}

function UsagePopover({ inbox }: { inbox: InboxView }) {
  const { open: pOpen, setOpen: setPOpen, close: closeP, trigger: pTrigger, panel: pPanel } = usePopover();
  const b = inbox.budgets;
  const pct = b.pctOfBaseline;
  const worst = Math.max(b.triage.used / b.triage.limit, b.drafts.used / b.drafts.limit, b.cost.used / b.cost.limit);
  const tone = b.triage.hit || b.drafts.hit || b.cost.hit ? 'red' : worst >= 0.8 ? 'amber' : 'green';
  const colour = { red: 'var(--red)', amber: 'var(--amber)', green: 'var(--green)' }[tone];
  const status = { red: 'Budget reached', amber: 'Close to budget', green: 'Under budget' }[tone];
  const label = pct === null ? 'Claude usage today: baseline not measured yet' : `Claude usage today: ${pct}% of baseline`;
  return (
    <div className="relative">
      <button
        type="button"
        ref={pTrigger}
        onClick={() => setPOpen(!pOpen)}
        aria-expanded={pOpen}
        aria-haspopup="dialog"
        aria-label={label}
        title="Claude usage today"
        className={cx('relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 cursor-pointer hover:bg-track', pOpen && 'bg-track')}
      >
        <Icon name="dollar" size={17} />
        {/* Only when it's worth a look: under budget says nothing. */}
        {tone !== 'green' && <span data-testid="usage-dot" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full border-2 border-surface box-content" style={{ background: colour }} />}
      </button>
      {pOpen && (
        <PopoverPanel panelRef={pPanel} label="Claude usage today" className="flex w-[300px] flex-col gap-3 !p-4">
          <div className="flex items-baseline gap-2">
            <span className="flex-1 font-semibold">Claude usage today</span>
            <span className={cx('text-xs font-medium', tone === 'green' ? 'text-green-fg' : tone === 'amber' ? 'text-amber-fg' : 'text-red-fg')}>{status}</span>
          </div>
          <div className="grid grid-cols-3 gap-2.5">
            <Kpi value={pct === null ? fmtMoney(b.cost.used) : `${pct}%`} label={pct === null ? 'no baseline yet' : 'of baseline'} />
            <Kpi value={String(b.triage.used)} label={`triage / ${b.triage.limit}`} />
            <Kpi value={String(b.drafts.used)} label={`drafts / ${b.drafts.limit}`} />
          </div>
          <div className="h-1.5 overflow-hidden rounded-[3px] bg-track">
            <div className="h-1.5" style={{ width: `${Math.min(100, Math.round(worst * 100))}%`, background: colour }} />
          </div>
          <Link to="/usage" className="text-[13px] font-medium" onClick={() => closeP(false)}>
            Usage &amp; health
          </Link>
        </PopoverPanel>
      )}
    </div>
  );
}

const Kpi = ({ value, label }: { value: string; label: string }) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-xl font-semibold">{value}</span>
    <span className="text-xs text-muted">{label}</span>
  </div>
);

/** Disabled while a poll runs; the status line beside it carries the spinner. */
function PollButton({ inbox }: { inbox: InboxView }) {
  const busy = inbox.poll.phase !== 'idle';
  return (
    <IconButton label={busy ? 'Poll in progress' : 'Poll now'} title={`Poll now · ${pollTooltip(inbox)}`} size={32} disabled={busy} onClick={() => void api.pollNow().catch(errorToast)}>
      <Icon name="poll" size={17} />
    </IconButton>
  );
}

// ---------- Banners ----------

function Banners({ inbox }: { inbox: InboxView }) {
  const now = useNow(5_000);
  const [hidden, setHidden] = useState<Record<string, boolean>>({});
  const hide = (k: string) => setHidden((h) => ({ ...h, [k]: true }));
  const { budgets: b, source } = inbox;
  const waitingOnBudget = inbox.items.filter((i) => i.modelPaused).length;
  const out: ReactNode[] = [];
  if (source.status === 'auth_failed')
    out.push(
      <Banner key="auth" tone="bad" icon="alert" action={<Link to="/usage#health" className="text-[13px] font-medium">Source health</Link>}>
        <strong>Slack rejected the token.</strong> Polling has stopped. Re-install the Slack app and update the Keychain entry, then poll again.
      </Banner>,
    );
  else if (source.status === 'backoff')
    out.push(
      <Banner key="429" tone="warn" icon="clock">
        <strong>Slack is rate-limiting.</strong> Waiting for Retry-After{source.retryAt ? `, next try ${fmtIn(source.retryAt, now)}` : ''}. Nothing is lost; the cursor holds.
      </Banner>,
    );
  if (b.triage.hit)
    out.push(
      <Banner key="tb" tone="warn" icon="alert" action={<Link to="/settings/budgets" className="text-[13px] font-medium">Budgets</Link>}>
        <strong>
          Triage budget reached ({b.triage.used}/{b.triage.limit}).
        </strong>{' '}
        Rules still run. Model triage pauses until tomorrow{waitingOnBudget ? `; ${plural(waitingOnBudget, 'thread')} waiting` : ''}.
      </Banner>,
    );
  if (b.drafts.hit)
    out.push(
      <Banner key="db" tone="warn" icon="alert" action={<Link to="/settings/budgets" className="text-[13px] font-medium">Budgets</Link>}>
        <strong>
          Drafts budget reached ({b.drafts.used}/{b.drafts.limit}).
        </strong>{' '}
        Draft buttons are off until tomorrow. Drafts already made can still be approved.
      </Banner>,
    );
  if (b.cost.hit && !b.triage.hit && !b.drafts.hit)
    out.push(
      <Banner key="cb" tone="warn" icon="alert" action={<Link to="/settings/budgets" className="text-[13px] font-medium">Budgets</Link>}>
        <strong>Daily cost-equivalent cap reached ({fmtMoney(b.cost.limit)}).</strong> Model calls pause until tomorrow.
      </Banner>,
    );
  if (inbox.notices.rebuilt && !hidden[`rebuilt:${inbox.notices.rebuilt}`])
    out.push(
      <Banner key="rb" tone="info" icon="info" onDismiss={() => hide(`rebuilt:${inbox.notices.rebuilt}`)}>
        {inbox.notices.rebuilt}
      </Banner>,
    );
  if (inbox.notices.fileVaultOff && !hidden.fv)
    out.push(
      <Banner key="fv" tone="warn" icon="lock" onDismiss={() => hide('fv')}>
        <strong>FileVault is off.</strong> Work OS keeps running, but thread text in the data directory isn’t encrypted at rest.
      </Banner>,
    );
  // empty: drops the padding when the health banner has nothing to say either.
  return (
    <div className="flex flex-col gap-2 px-6 pt-3 empty:hidden">
      <HealthBanner />
      {out}
    </div>
  );
}

// ---------- Empty and first-run states ----------

function FirstRun({ inbox }: { inbox: InboxView }) {
  const busy = inbox.poll.phase !== 'idle';
  return (
    <div className="mx-6 my-4 flex flex-col items-start gap-4 rounded-xl border border-line bg-surface px-8 py-10">
      <BrandMark size={72} checking={busy} />
      <div className="flex max-w-[560px] flex-col gap-1.5">
        <h2 className="m-0 text-xl font-semibold">Work OS hasn’t polled Slack yet</h2>
        <p className="m-0 text-sm leading-relaxed text-ink-2">
          The first poll reads the last 24 hours of the channels and DMs you’re in, applies your rules, and triages quiet threads in batches. It takes about a minute and uses roughly one triage call per 25 threads.
        </p>
      </div>
      <Button variant="solid" size="lg" disabled={busy} onClick={() => void api.pollNow().catch(errorToast)}>
        {busy ? (
          <>
            <Spinner /> {inbox.poll.phase === 'polling' ? 'Polling Slack…' : triaging(inbox.poll.triagingCount)}
          </>
        ) : (
          'Run first poll'
        )}
      </Button>
      <div className="text-xs text-muted">
        <Link to="/settings/rules">Rules</Link>, <Link to="/settings/people">VIPs</Link> and the <Link to="/settings/schedule">quiet window</Link> are in Settings.
      </div>
    </div>
  );
}

function InboxZero({ inbox }: { inbox: InboxView }) {
  return (
    <div className="mx-6 my-4 flex flex-col items-center gap-2 rounded-xl border border-line bg-surface px-8 py-12 text-center" data-testid="inbox-zero">
      <BrandMark size={88} checking={inbox.poll.phase !== 'idle'} />
      <h2 className="m-0 text-xl font-semibold">Inbox zero</h2>
      <p className="m-0 max-w-[460px] text-sm text-ink-2">
        Nothing needs you and nothing is waiting to be filed.
        {inbox.poll.nextPollAt && <> Next poll at {fmtTime(inbox.poll.nextPollAt)}.</>}
      </p>
    </div>
  );
}

// ---------- Rows ----------

type Group = 'needs' | 'follow' | 'file';

// Waiting on others (FR-8.1, amended) shows only when it holds something.
const GROUPS: { id: Group; title: string; dot: string; hideEmpty?: boolean }[] = [
  { id: 'needs', title: 'Needs you', dot: 'var(--orange)' },
  { id: 'follow', title: 'Waiting on others', dot: 'var(--gray-solid)', hideEmpty: true },
  { id: 'file', title: 'To file', dot: 'var(--teal-solid)' },
];

// Off the main list (LOWER, Lower): one footer link each (Waiting's link is in the header), opening
// one list at a time. On the cockpit they open in the Later zone.

/** Low priority leads as an outlined button; Snoozed and Done are quiet links at the far end. */
function FooterLinks({ by, open, onToggle }: { by: Record<Lower, ItemSummary[]>; open: Lower | null; onToggle: (g: Lower) => void }) {
  const now = useNow(30_000);
  const back = by.snoozed[0]?.snoozedUntil;
  const chevron = (id: Lower) => <Icon name="down" size={12} className={cx('transition-transform', open !== id && '-rotate-90')} />;
  const quiet: { id: Lower; icon: 'calendar' | 'clock' | 'check'; label: string }[] = [
    ...(by.week.length ? [{ id: 'week' as const, icon: 'calendar' as const, label: `${by.week.length} this week` }] : []),
    ...(by.snoozed.length ? [{ id: 'snoozed' as const, icon: 'clock' as const, label: `${by.snoozed.length} snoozed${back ? ` · next back ${fmtWhen(back, now)}` : ''}` }] : []),
    ...(by.done.length ? [{ id: 'done' as const, icon: 'check' as const, label: `${by.done.length} done` }] : []),
  ];
  return (
    <div data-testid="inbox-footer" className="flex flex-wrap items-center gap-x-2 gap-y-2 px-6 py-3">
      <button
        type="button"
        aria-expanded={open === 'else'}
        onClick={() => onToggle('else')}
        className={cx(
          'inline-flex min-h-8 items-center gap-2 rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium text-ink-2 cursor-pointer hover:bg-surface-2 hover:text-ink',
          open === 'else' && 'bg-surface-2 text-ink',
        )}
      >
        <Icon name="inbox" size={14} className="text-muted" />
        <span>
          <span className="font-semibold text-ink">{by.else.length}</span> low priority
        </span>
        {chevron('else')}
      </button>
      <span className="flex-1" />
      {quiet.map((l) => (
        <button
          key={l.id}
          type="button"
          aria-expanded={open === l.id}
          onClick={() => onToggle(l.id)}
          className={cx('inline-flex min-h-7 items-center gap-1.5 rounded-md px-2 text-xs text-muted cursor-pointer hover:bg-surface-2 hover:text-ink-2', open === l.id && 'bg-surface-2 text-ink-2')}
        >
          <Icon name={l.icon} size={13} />
          {l.label}
          {chevron(l.id)}
        </button>
      ))}
    </div>
  );
}

function lowerMeta(i: ItemSummary, now: Date): string | undefined {
  if (i.lane === 'failed') return 'output invalid twice';
  if (i.lane === 'follow' && i.replyCheck?.handedOn) return 'you handed it on';
  if (i.lane === 'waiting') return i.modelPaused ? 'paused · triage budget reached' : i.quietUntil && Date.parse(i.quietUntil) > now.getTime() ? `quiet ${fmtIn(i.quietUntil, now)}` : 'next poll';
  if (i.lane === 'snoozed' && i.snoozedUntil) return `until ${fmtDayDate(i.snoozedUntil)} ${fmtTime(i.snoozedUntil)}`;
  if (i.lane === 'done' && i.doneAt) return `done ${fmtDayDate(i.doneAt)} ${fmtTime(i.doneAt)}`;
  if (i.triage?.by === 'rule') return 'by rule';
  if (i.triage?.by === 'user') return 'corrected';
  return undefined;
}

function QueueRow({ item, selected, isNew, leaving, divide, onPick }: { item: ItemSummary; selected: boolean; isNew: boolean; leaving?: boolean; divide?: boolean; onPick: () => void }) {
  const now = useNow(30_000);
  const top = isTop(item);
  const failed = item.lane === 'failed';
  const due = top ? dueInfo(item.next, now) : undefined;
  const target = targetChip(item);
  const meta = top && !failed ? undefined : lowerMeta(item, now);
  const ago = fmtAgo(item.lastActivityAt, now);
  // A topic: more asks than the one on the chip, and the pieces it gathers.
  const moreAsks = topicAsks(item).filter((a) => !a.done).length - 1;
  // The row opens the item; Done sits beside it (a button can't hold another), for items you
  // already know are finished or don't matter.
  const row = (
    <div
      className={cx(
        'group/row flex items-center border-t pr-3',
        divide ? 'border-line' : 'border-line-soft',
        selected ? 'bg-accent-wash shadow-[inset_3px_0_0_var(--accent-bg)]' : item.lane === 'now' ? 'bg-orange-wash-2' : 'hover:bg-surface-2',
      )}
    >
      <button
        type="button"
        data-row={item.id}
        data-lane={item.lane}
        data-new={isNew || undefined}
        data-leaving={leaving || undefined}
        data-activity={item.lastActivityAt}
        aria-current={selected ? 'true' : undefined}
        onClick={onPick}
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3.5 gap-y-1.5 py-[11px] pl-6 pr-2 text-left cursor-pointer"
      >
        <span className="flex w-5 justify-center">
          <SourceMark source={item.source} size={18} />
        </span>
        <span className="flex min-w-[110px] flex-[0_1_170px] flex-col gap-px">
          <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-ink-2">
            {/* An invite's or a joined meeting's Outlook categories (R2.8), as on the agenda. */}
            {item.calendarCategories?.length ? (
              <span data-row-categories={item.calendarCategories.map((c) => c.name).join(', ')} title={item.calendarCategories.map((c) => c.name).join(', ')} className="flex shrink-0 gap-0.5">
                {item.calendarCategories.map((c) => (
                  <CategoryDot key={c.name} color={c.color} />
                ))}
              </span>
            ) : null}
            <span className="truncate">{item.title}</span>
            {item.calendarCategories?.length ? <span className="sr-only">, {item.calendarCategories.map((c) => c.name).join(', ')}</span> : null}
          </span>
          <span className="text-[11px] text-muted">
            {kindLabel(item.kind)} · {ago}
            {item.pieces > 1 && <span data-pieces={item.pieces}> · {plural(item.pieces, 'part')}</span>}
            {isNew && (
              <span data-new-dot className="ml-1.5 inline-flex items-center gap-1 font-medium text-accent">
                <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" />
                New
              </span>
            )}
          </span>
        </span>
        {/* Chips sit at the right edge, or wrap under the summary when the list is narrow. */}
        <span className="flex min-w-0 flex-[1_1_260px] flex-wrap items-center gap-x-3.5 gap-y-1.5">
          <span className={cx('flex min-w-0 flex-[1_1_240px] flex-col gap-1 text-[13px] leading-[1.4]', top ? 'font-medium text-ink' : 'text-ink-2')}>
            <span>{item.summary}</span>
            <ReplyNote item={item} />
            <ItemMarkers item={item} />
          </span>
          <span className="flex flex-wrap gap-1">
            {top && !failed && <NeedTag>{item.next ? needLabel(item.next) : item.lane === 'file' ? 'File' : 'Reply'}</NeedTag>}
            {top && moreAsks > 0 && <span className="self-center font-mono text-[11px] text-muted">+{plural(moreAsks, 'ask')}</span>}
            {due && <DueChip due={due} />}
            <ReadyChip item={item} />
            {target && <StatusChip tone="file">{target}</StatusChip>}
            {item.lane === 'failed' && <StatusChip tone="bad">Triage failed</StatusChip>}
            {item.lane === 'done' && <DoneByChip item={item} />}
            {meta && <span className="font-mono text-[11px] text-muted">{meta}</span>}
          </span>
        </span>
      </button>
      {item.status !== 'done' ? (
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
      )}
    </div>
  );
  // A row that left collapses where it was (CK-1.2).
  return leaving ? (
    <div className="row-leave" inert>
      <div>{row}</div>
    </div>
  ) : (
    row
  );
}

/** Asks routing to merge a conversation's open topics that share a subject (topics). */
async function regroup(conversation: string, name: string) {
  try {
    const { merged } = await api.regroup(conversation);
    toast(merged ? `Regrouped ${name} · ${plural(merged, 'entry', 'entries')} merged into ${merged === 1 ? 'its' : 'their'} topic` : `Nothing to merge in ${name}: each entry is its own topic.`);
  } catch (e) {
    errorToast(e);
  }
}

/** The name over a Slack channel's rows when the Inbox groups by channel. */
function ChannelHead({ item, items, topics }: { item: ItemSummary; items: ItemSummary[]; topics: number }) {
  const name = item.kind === 'dm' ? `DM · ${item.title}` : item.title;
  const open = items.filter((i) => i.status !== 'done');
  const [busy, setBusy] = useState(false);
  const key = channelKey(item);
  return (
    <div data-channel={key} className="flex items-center gap-2 border-t border-line-soft bg-surface-2 px-6 py-1">
      <h3 className="m-0 min-w-0 truncate text-xs font-semibold text-ink-2">{name}</h3>
      <span className="font-mono text-[11px] text-muted">{items.length}</span>
      <span className="flex-1" />
      {key && topics > 1 && (
        <button
          type="button"
          disabled={busy}
          aria-label={`Regroup ${name} by topic`}
          title="Merge entries in this conversation that are about the same thing"
          className="inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted hover:bg-track hover:text-ink disabled:opacity-60 cursor-pointer"
          onClick={async () => {
            setBusy(true);
            await regroup(key, name);
            setBusy(false);
          }}
        >
          {busy ? <Spinner size={12} /> : <Icon name="layers" size={12} />} Regroup
        </button>
      )}
      {open.length > 0 && (
        <button
          type="button"
          aria-label={`Mark all ${open.length} in ${name} done`}
          className="inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted hover:bg-track hover:text-ink cursor-pointer"
          onClick={() => void markManyDoneWithUndo(open, name)}
        >
          <Icon name="check" size={12} /> Mark all done
        </button>
      )}
    </div>
  );
}

/**
 * "1 new Now item above" (CK-1.2): rows held back while the panel is open, or that landed above the
 * view while Frank was scrolled down. A click shows them.
 */
function NewPill({ items, above, group, onGo }: { items: ItemSummary[]; above: boolean; group: Group; onGo: () => void }) {
  if (!items.length) return null;
  const lanes = new Set(items.map((i) => i.lane));
  const n = items.length;
  const where = above ? ' above' : '';
  const label =
    group === 'file'
      ? `${n} new ${n === 1 ? 'item' : 'items'} to file${where}`
      : group === 'follow'
        ? `${n} new ${n === 1 ? 'item' : 'items'} waiting on others${where}`
        : `${n} new${lanes.size === 1 && lanes.has('now') ? ' Now' : lanes.size === 1 && lanes.has('today') ? ' Today' : ''} ${n === 1 ? 'item' : 'items'}${where}`;
  return (
    // At the left, so the open item panel never covers it.
    <div className="sticky top-2 z-10 flex px-6">
      <button
        type="button"
        data-new-pill={group}
        onClick={onGo}
        className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-accent-wash px-3.5 text-[13px] font-semibold text-accent-ink shadow-[0_6px_18px_rgba(20,23,28,0.14)] cursor-pointer hover:bg-accent-tonal"
      >
        <Icon name="arrow" size={13} className="-rotate-90" />
        {label}
      </button>
    </div>
  );
}

/** A heading inside a group: To file's Ready to approve and Other filings (FR-15.5). */
function SubHead({ title, count, tone, action }: { title: string; count: number; tone?: 'ready'; action?: ReactNode }) {
  return (
    <div role="heading" aria-level={3} data-subhead={tone ?? 'other'} className={cx('flex min-h-9 items-center gap-2 border-t border-line-soft px-6 py-1 text-xs font-semibold', tone === 'ready' ? 'bg-green-wash text-green-fg' : 'text-muted')}>
      <span>{title}</span>
      <span className="font-mono font-normal">{count}</span>
      {action && <span className="ml-auto">{action}</span>}
    </div>
  );
}

function GroupHead({ dot, title, count }: { dot: string; title: string; count: number }) {
  return (
    <>
      <span className="h-[9px] w-[9px] shrink-0 self-center rounded-[3px]" style={{ background: dot }} />
      <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
      <span className="font-mono text-xs text-muted">{count}</span>
    </>
  );
}

function CommitmentsGroup() {
  const rows = [
    { where: 'from #mvi-launch', when: 'Fri 9 Oct', summary: 'Send MVI V2 release notes to Sales.', quote: '“I’ll send the notes by Friday.”' },
    { where: 'from DM', when: 'Wed 7 Oct', summary: 'Review the PSPD-112 PRD draft.', quote: '“Will review before Wednesday.”' },
  ];
  return (
    <section aria-label="Commitments (P3)" className="mx-4 mb-3 flex flex-col rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-wash">
      <div className="flex items-baseline gap-2 px-4 pb-2 pt-3">
        <GroupHead dot="var(--violet-dot)" title="Commitments" count={2} />
        <span className="flex-1" />
        <PhaseTag phase="P3" />
      </div>
      {rows.map((r) => (
        <button key={r.summary} type="button" onClick={() => phaseToast('P3', 'Commitments')} className="flex flex-wrap items-center gap-x-3.5 gap-y-1 border-t border-violet-line/30 px-4 py-2.5 text-left cursor-pointer">
          <Icon name="commit" size={16} className="text-violet-fg" />
          <span className="flex-[0_1_170px] text-xs text-ink-2">{r.where}</span>
          <span className="min-w-0 flex-[1_1_260px] text-[13px] font-medium">
            {r.summary} <span className="font-normal text-muted">{r.quote}</span>
          </span>
          <span className="font-mono text-[11px] text-muted">{r.when}</span>
        </button>
      ))}
    </section>
  );
}

// ---------- Page ----------

/**
 * The rows j/k walk, as they show. The list: Needs you, Waiting on others, To file, then the
 * footer's open list. The cockpit (CK-3.3): Now, Today, then Later as it shows, Waiting on others,
 * To file and This week, or the list open there.
 */
function cockpitOrder(needsRows: ShownRow[], followRows: ShownRow[], fileRows: ShownRow[], by: Record<Lower, ItemSummary[]>, open: Lower | null, wide: boolean) {
  const ids = (rows: ShownRow[]) => rows.filter((r) => !r.leaving).map((r) => r.item.id);
  // This week is always on screen on the cockpit, so it doesn't open as a list there.
  const listOpen = open && !(wide && open === 'week') ? open : null;
  const list = listOpen ? by[listOpen].map((i) => i.id) : [];
  const needs = wide ? [...ids(needsRows.filter((r) => r.item.lane === 'now')), ...ids(needsRows.filter((r) => r.item.lane !== 'now'))] : ids(needsRows);
  const later = wide ? (listOpen ? list : [...ids(followRows), ...ids(fileRows), ...by.week.map((i) => i.id)]) : [...ids(followRows), ...ids(fileRows)];
  return { order: wide ? [...needs, ...later] : [...needs, ...later, ...list], firstNeeds: needs[0], firstLater: later[0] };
}

/** How long after g its second key counts. */
const G_WINDOW_MS = 1_000;

/**
 * Clicks here aren't "outside" the item panel: rows, and the cockpit's deadline pins, switch the item; links leave the page anyway
 * (closing would rewrite the URL mid-navigation); the page header's and the sidebar's buttons
 * (Poll, Usage, Scope) work alongside it; and layers (toasts, dialogs, menus, the scenario drawer)
 * sit above it.
 */
const NOT_OUTSIDE = '[data-row], [data-row-action], [data-open-item], [data-agenda-event] button, a[href], [data-inbox-header] button, nav button, [aria-live], [data-scenarios], [data-overlay], [role="dialog"], [role="menu"]';

export function InboxPage() {
  const { inbox: q } = useShell();
  const inbox = q.data;
  const navigate = useNavigate();
  const full = usePrefs((s) => s.scope === 'full');
  const setPanelOpen = usePrefs((s) => s.setPanelOpen);
  // The open item, for holding rows still under it; the panel host below reads the rest of the URL.
  const [search] = useSearchParams();
  const sel = search.get('item');

  // Outlook and Teams are Phase 2 previews: their items only show in Full scope.
  const inScope = useCallback((i: ItemSummary) => full || isLive(i.source), [full]);
  const all = useMemo(() => (inbox?.items ?? []).filter(inScope), [inbox, inScope]);
  // To Dos (E15, FR-16.2): from the sources in scope, as items are.
  const todos = useMemo(() => (inbox?.todos ?? []).filter((t) => full || isLive(t.source)), [inbox, full]);
  const [open, setOpen] = useState<Lower | null>(null);
  const toggle = (g: Lower) => setOpen(open === g ? null : g);
  const now = useNow(60_000);
  const sort = usePrefs((s) => s.inboxSort);
  const grouped = usePrefs((s) => s.groupByChannel);
  // The three-zone cockpit on a wide window (CK-3.1); today's list below 1600 px.
  const wide = useWideLayout();

  // Items Frank's reply just closed stay where they were for 5 s as "You replied" (CK-2.5).
  const replied = useRepliedHold(all, !!inbox);
  const by = useMemo(() => {
    const m: Record<Group | Lower, ItemSummary[]> = { needs: [...sortItems(all, sort, true, now), ...replied.filter((i) => i.lane !== 'week')], follow: [], file: [], week: replied.filter((i) => i.lane === 'week'), else: [], waiting: [], snoozed: [], done: [], replied: [] };
    for (const i of all) if (i.lane in m) m[i.lane as Group | Lower].push(i);
    for (const g of ['follow', 'file', 'else', 'waiting'] as const) m[g] = sortItems(m[g], sort, false, now);
    if (grouped) for (const g of ['needs', 'follow', 'file', 'else', 'waiting'] as const) m[g] = groupByChannel(m[g]);
    m.week = byDue(m.week);
    m.snoozed.sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
    m.done.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
    m.replied = m.done.filter((i) => i.doneBy === 'reply'); // Review, from the closes line
    return m;
  }, [all, now, sort, grouped, replied]);
  // Open topics per conversation, across every group: Regroup is offered where there are two or more.
  const openTopics = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) {
      const key = channelKey(i);
      if (key && i.status !== 'done') m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [all]);
  // Rows hold their place (CK-1.2): the order on screen changes only where it must, and not under
  // the open panel. The first load, and changing the sort, the grouping, the scope or the layout,
  // start afresh. Each scroller has its own call, as it keeps its own rows still: the list holds
  // both groups; on the cockpit, Needs you and Later scroll apart, and To file is in Later.
  const listRef = useRef<HTMLElement>(null);
  const laterRef = useRef<HTMLElement>(null);
  const selItem = sel ? all.find((i) => i.id === sel) : undefined;
  const topGroups = useMemo(() => (wide ? { needs: by.needs } : { needs: by.needs, follow: by.follow, file: by.file }) as Record<Group, ItemSummary[]>, [by, wide]);
  const laterGroups = useMemo(() => (wide ? { follow: by.follow, file: by.file } : {}) as Record<'follow' | 'file', ItemSummary[]>, [by, wide]);
  // Rows that land even under the panel: those Frank moved himself, the open item, and those he
  // asked to see from the pill (until the panel closes).
  const userMoves = useUserMoves((s) => s.ids);
  const [released, setReleased] = useState<ReadonlySet<string>>(() => new Set());
  if (!selItem && released.size) setReleased(new Set());
  const exempt = useMemo(() => new Set([...Object.keys(userMoves), ...released, ...(sel ? [sel] : [])]), [userMoves, released, sel]);
  const stableOpts = { resetKey: `${sort}:${grouped}:${full}:${wide}:${inbox ? 'loaded' : 'loading'}`, frozen: !!selItem, exempt };
  const stableTop = useStableGroups(topGroups, listRef, stableOpts);
  const stableLater = useStableGroups(laterGroups, laterRef, stableOpts);
  const fileStable = wide ? stableLater : stableTop;
  const stable = {
    above: { needs: stableTop.above.needs, follow: fileStable.above.follow, file: fileStable.above.file },
    pending: { needs: stableTop.pending.needs, follow: fileStable.pending.follow, file: fileStable.pending.file },
  };
  // The pill's target, scrolled to once it's on screen.
  const goTo = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    const id = goTo.current;
    const el = id ? rowEl(id) : undefined;
    if (!el) return;
    goTo.current = undefined;
    el.scrollIntoView({ block: 'center' });
  });
  // j/k walk the rows on screen: Needs you, To file, then the footer's list if one is open. On the
  // cockpit (CK-3.3): Now, Today, then Later as it shows, To file and This week or the list open there.
  const needsRows = stableTop.rows.needs;
  // Ready to approve leads To file (FR-15.5); rows keep their place within it and within the rest.
  const fileRows = useMemo(() => [...fileStable.rows.file.filter((r) => isReady(r.item)), ...fileStable.rows.file.filter((r) => !isReady(r.item))], [fileStable.rows.file]);
  const followRows = fileStable.rows.follow;
  const { order, firstNeeds, firstLater } = useMemo(() => cockpitOrder(needsRows, followRows, fileRows, by, open, wide), [needsRows, followRows, fileRows, by, open, wide]);
  // The New dot (CK-1.3): items that entered a group since Frank last looked.
  const newItems = usePrefs((s) => s.newItems);
  const markNew = usePrefs((s) => s.markNew);
  const clearNew = usePrefs((s) => s.clearNew);
  useEffect(() => {
    if (stableTop.entered.ids.length) markNew(stableTop.entered.ids, api.now());
  }, [stableTop.entered, markNew]);
  useEffect(() => {
    if (stableLater.entered.ids.length) markNew(stableLater.entered.ids, api.now());
  }, [stableLater.entered, markNew]);
  const isNew = (id: string) => id in newItems && now.getTime() - Date.parse(newItems[id]) < NEW_FOR_MS;
  const unseen = useMemo(() => {
    const ids = (rows: ShownRow[]) => rows.filter((r) => !r.leaving && r.item.id in newItems).map((r) => r.item.id);
    return wide ? { top: ids(needsRows), later: ids([...followRows, ...fileRows]) } : { top: ids([...needsRows, ...followRows, ...fileRows]), later: [] };
  }, [needsRows, followRows, fileRows, newItems, wide]);
  useLookedAt(listRef, unseen.top);
  useLookedAt(laterRef, unseen.later);

  // File in a batch (CK-4.1–4.4): ended by closing the panel or opening an item outside it.
  const [batch, setBatch] = useState<Batch | null>(null);
  // The end-of-day sweep (UX-10): ended by Esc, which shows its tally, or by opening an item outside it.
  const [sweep, setSweep] = useState<Sweep | null>(null);
  const host = usePanelHost({
    items: all,
    order,
    notOutside: NOT_OUTSIDE,
    onPick: (id) => {
      clearNew(id);
      setPanelOpen(true);
    },
    onClose: () => {
      setBatch(null);
      setPanelOpen(false);
    },
  });
  const { filing, setSearch, pick, step, close, doneAndNext, setFiling, onDirty, blocker, panelRef, panel, closing } = host;

  // The batch opens each item on its filing, its draft started, with the next item's draft
  // running ahead: only one, so stopping wastes at most one draft (CK-4.2).
  const budgetHit = !!inbox?.budgets.drafts.hit;
  useDraftAhead(all, sel, inbox?.budgets);
  const batchIds = useMemo(() => fileRows.filter((r) => !r.leaving && batchable(r.item)).map((r) => r.item.id), [fileRows]);
  const readyIds = useMemo(() => fileRows.filter((r) => !r.leaving && batchable(r.item, true)).map((r) => r.item.id), [fileRows]);
  const fileOn = useCallback(
    (item: ItemSummary, type: ActionType) => {
      if (needsDraft(item, type, budgetHit)) void requestQuietDraft(item.id, type).catch(errorToast);
      clearNew(item.id);
      setPanelOpen(true);
      setSearch({ item: item.id, file: typeParam(type) }, { replace: true });
      rowEl(item.id)?.scrollIntoView({ block: 'nearest' });
    },
    [budgetHit, clearNew, setPanelOpen, setSearch],
  );
  const batchFrom = useCallback(
    (b: Batch, from: number) => {
      const [cur, ahead] = b.ids.slice(from).flatMap((id) => all.filter((i) => i.id === id && batchable(i, b.readyOnly)));
      if (!cur) {
        // Past the last one: the tally, until Esc.
        setBatch({ ...b, done: true });
        setPanelOpen(false);
        setSearch({}, { replace: true });
        return;
      }
      setBatch({ ...b, approved: [] });
      fileOn(cur, filingFor(cur, [], b.readyOnly)!);
      const next = ahead && filingFor(ahead, [], b.readyOnly);
      if (ahead && next && needsDraft(ahead, next, budgetHit)) void requestQuietDraft(ahead.id, next).catch(errorToast);
    },
    [all, fileOn, budgetHit, setPanelOpen, setSearch, setBatch],
  );
  const batchPos = batch && !batch.done && sel ? batch.ids.indexOf(sel) : -1;
  if (batch && !batch.done && sel && batchPos < 0) setBatch(null);

  // The sweep takes Needs you as it shows, and moves on as each item is dealt with.
  const sweepIds = useMemo(() => needsRows.filter((r) => !r.leaving && r.item.status === 'open').map((r) => r.item.id), [needsRows]);
  // The next item still open, or past the last one: the panel closes, and the sweep shows its tally.
  const sweepOn = useCallback(
    (s: Sweep, from: number) => {
      const next = nextInSweep(s, from, all);
      if (next) pick(next);
      else {
        setPanelOpen(false);
        setSearch({}, { replace: true });
      }
    },
    [all, pick, setPanelOpen, setSearch],
  );
  // Picked first, so the sweep never sees a moment with no item open.
  const sweepFrom = (s: Sweep, from: number) => {
    sweepOn(s, from);
    setSweep(s);
  };
  const sweepPos = sweep && !sweep.finished && sel ? sweep.ids.indexOf(sel) : -1;
  // Opening an item outside it ends the sweep; closing the panel (Esc) shows the tally.
  if (sweep && !sweep.finished && sel && sweepPos < 0) setSweep(null);
  else if (sweep && !sweep.finished && !sel) setSweep({ ...sweep, finished: true });
  // e and s act on the item as ever. Once it is done or snoozed, the sweep counts it, then moves on.
  const cur = sweepPos >= 0 ? selItem : undefined;
  if (sweep && cur && !sweep.counted.includes(cur.id) && (cur.status === 'done' || cur.status === 'snoozed')) setSweep({ ...counted(sweep, cur.id, cur.status), from: cur.id });
  else if (sweep?.from && sweep.from !== sel) setSweep({ ...sweep, from: undefined });
  const moveFrom = sweep?.from && sweep.from === sel ? sweepPos : -1;
  useEffect(() => {
    if (sweep && moveFrom >= 0) sweepOn(sweep, moveFrom + 1);
  }, [sweep, moveFrom, sweepOn]);

  // Today's list opens the panel on the first item when Work OS opens, until it's closed; the
  // cockpit doesn't, as the panel would cover Later (UX-13). Only once, as the inbox arrives: the
  // preference is set a moment before a pick's URL changes, and opening the first item in that gap
  // (a poll landing as File in a batch starts) would replace the one picked.
  // An item the inbox doesn't show (done long ago, or out of scope), opened from a notification, a
  // toast or the bell, opens as a full page instead (UX-6). Otherwise a stale ?item= (after a
  // reset) moves on to the first item on the list, and closes the panel on the cockpit.
  const first = order[0];
  const missing = !!inbox && !!sel && !selItem;
  const orPage = (useLocation().state as Partial<OpenItemState> | null)?.orPage;
  const arrived = useRef(false);
  useEffect(() => {
    if (!inbox) return;
    const opening = !arrived.current;
    if (sel || first) arrived.current = true;
    const open = !wide && usePrefs.getState().panelOpen;
    if (missing && (orPage || opening)) navigate(orPage ?? itemPath(sel, filing ? `?tab=${typeParam(filing)}` : ''), { replace: true });
    else if (missing) setSearch(open && first ? { item: first } : {}, { replace: true });
    else if (opening && !sel && open && first) setSearch({ item: first }, { replace: true });
  }, [inbox, missing, orPage, sel, first, filing, wide, navigate, setSearch]);

  // g then n or l, within a second (CK-3.3); g then d, the first To Do (FR-16.4).
  const gAt = useRef(0);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      const afterG = Date.now() - gAt.current < G_WINDOW_MS;
      gAt.current = 0;
      if (afterG && (e.key === 'n' || e.key === 'l')) {
        e.preventDefault();
        pick(e.key === 'n' ? firstNeeds : firstLater);
      } else if (afterG && e.key === 'd') {
        // The first open To Do (FR-16.4): its keys are its own, e for Done. On the cockpit, under the
        // time column's To Dos tab (FR-16.2).
        e.preventDefault();
        if (wide) focusFirstTodo();
        else {
          const row = document.querySelector<HTMLElement>('[data-todo][data-todo-status="open"]');
          row?.focus();
          row?.scrollIntoView({ block: 'nearest' });
        }
      } else if (e.key === 'g') {
        gAt.current = Date.now();
      } else if (e.key === 'j') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'k') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'Escape' && sel) {
        e.preventDefault();
        close();
      } else if (e.key === 'Escape' && batch?.done) {
        e.preventDefault();
        setBatch(null);
      } else if (e.key === 'Escape' && sweep?.finished) {
        e.preventDefault();
        setSweep(null);
      } else if (e.key === 'Escape' && wide && open) {
        // A list open in the Later zone goes back to its default view.
        e.preventDefault();
        setOpen(null);
      } else if (e.key === 'o' && sel) {
        e.preventDefault();
        navigate(itemPath(sel));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step, close, sel, navigate, pick, firstNeeds, firstLater, wide, open, batch, sweep]);

  useEffect(() => {
    document.title = 'Inbox · Work OS';
  }, []);
  const health = usePillHealth(inbox);

  if (!inbox) return <div className="p-8 text-muted">{q.error ? 'Could not load the inbox.' : 'Loading…'}</div>;

  const topCount = by.needs.length + by.follow.length + by.file.length;
  const counts = laneCounts(all);
  // Under Priority, a darker hairline closes the Now block at the top of Needs you. Grouped by
  // channel, each Slack channel's run of rows opens with its name. The cockpit has its own rows:
  // two lines in Needs you, the summary first in Later.
  const row = (r: ShownRow, n: number, list: ShownRow[], variant: 'list' | 'needs' | 'later' = 'list', lower = false) => {
    const i = r.item;
    const key = grouped ? channelKey(i) : undefined;
    const head = key && (n === 0 || channelKey(list[n - 1].item) !== key);
    const props = { item: i, selected: i.id === sel, isNew: !r.leaving && isNew(i.id), leaving: r.leaving, onPick: () => pick(i.id) };
    return [
      head && <ChannelHead key={`head:${i.id}`} item={i} items={list.filter((x) => !x.leaving && channelKey(x.item) === key).map((x) => x.item)} topics={openTopics.get(key) ?? 0} />,
      // Held in Needs you or This week for a moment after Frank's reply closed it (CK-2.5).
      closedByReply(i) && (!lower || i.lane === 'week') ? (
        <RepliedRow key={i.id} {...props} compact={variant === 'list'} />
      ) : variant === 'needs' ? (
        <CockpitRow key={i.id} {...props} />
      ) : variant === 'later' ? (
        <LaterRow key={i.id} {...props} meta={isTop(i) ? undefined : lowerMeta(i, now)} />
      ) : (
        <QueueRow key={i.id} {...props} divide={!grouped && sort === 'priority' && n > 0 && list[n - 1].item.lane === 'now' && i.lane !== 'now'} />
      ),
    ];
  };
  const groupRows = { needs: needsRows, follow: followRows, file: fileRows };
  const lowerRow = (i: ItemSummary, n: number, list: ItemSummary[]) => row({ item: i }, n, list.map((item) => ({ item })), wide ? 'later' : 'list', true);
  const openItem = (id: string) => (all.some((i) => i.id === id) ? pick(id) : navigate(itemPath(id)));
  const pillItems = (g: Group) => [...stable.pending[g].map((p) => p.id), ...stable.above[g]].flatMap((id) => all.filter((i) => i.id === id));
  const goNew = (g: Group) => {
    const held = stable.pending[g].map((p) => p.id);
    if (held.length) setReleased(new Set([...released, ...held]));
    goTo.current = held[0] ?? stable.above[g][0];
    const el = goTo.current ? rowEl(goTo.current) : undefined;
    if (el) {
      goTo.current = undefined;
      el.scrollIntoView({ block: 'center' });
    }
  };
  // In the To file header (CK-4.1). Not a click outside the panel: it opens the batch there.
  const batchButton = batchIds.length > 0 && (
    <Button size="sm" icon="forward" data-row-action onClick={() => batchFrom({ ids: batchIds, filed: 0, skipped: 0, approved: [], done: false }, 0)}>
      File in a batch
    </Button>
  );
  // Ready to approve (FR-15.5): its own batch, over the ready filings only.
  const approveReady = readyIds.length > 0 && (
    <Button size="sm" icon="check" data-row-action title="Each ready draft in turn: ⌘↵ approves and moves on, → skips" onClick={() => batchFrom({ ids: readyIds, filed: 0, skipped: 0, approved: [], done: false, readyOnly: true }, 0)}>
      Approve ready
    </Button>
  );
  // To file's rows, with Ready to approve first under its own heading, then the rest.
  const fileRow = (r: ShownRow, n: number, list: ShownRow[], variant?: 'later') => {
    const ready = isReady(r.item);
    const prev = n > 0 && isReady(list[n - 1].item);
    const head =
      ready && !prev ? (
        <SubHead key="ready-head" tone="ready" title="Ready to approve" count={list.filter((x) => !x.leaving && isReady(x.item)).length} action={approveReady} />
      ) : !ready && prev ? (
        <SubHead key="other-head" title="Other filings" count={list.filter((x) => !x.leaving && !isReady(x.item)).length} />
      ) : null;
    return [head, ...row(r, n, list, variant)];
  };
  // In the Needs you header (UX-10). Not a click outside the panel: it opens the sweep there.
  const sweepButton = sweepIds.length > 0 && (
    <Button size="sm" icon="forward" data-row-action title="Go through Needs you one item at a time: e done, s snooze, r reply, f or v file, → skip" onClick={() => sweepFrom(newSweep(sweepIds), 0)}>
      Sweep
    </Button>
  );
  const sweepPanel =
    sweep && sweepPos >= 0
      ? {
          pos: sweepPos + 1,
          total: sweep.ids.length,
          onSkip: () => sweepFrom(counted(sweep, sweep.ids[sweepPos], 'skipped'), sweepPos + 1),
          onReplied: () => sweepFrom(counted(sweep, sweep.ids[sweepPos], 'replied'), sweepPos + 1),
          onApproved: () => sweepFrom(counted(sweep, sweep.ids[sweepPos], 'filed'), sweepPos + 1),
        }
      : undefined;
  const batchPanel =
    batch && batchPos >= 0
      ? {
          pos: batchPos + 1,
          total: batch.ids.length,
          ...(batch.readyOnly && { ready: true }),
          onSkip: () => batchFrom({ ...batch, skipped: batch.skipped + 1 }, batchPos + 1),
          // Its other suggested filing next, if any; then the next item.
          onApproved: (t: ActionType) => {
            const cur = all.find((i) => i.id === batch.ids[batchPos]);
            const approved = [...batch.approved, t];
            const other = cur && filingFor(cur, approved, batch.readyOnly);
            if (cur && other) {
              setBatch({ ...batch, approved });
              fileOn(cur, other);
            } else batchFrom({ ...batch, filed: batch.filed + 1 }, batchPos + 1);
          },
        }
      : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* 64px, the height of the sidebar's header, so the two line up. */}
      <header data-inbox-header data-health={health?.tone} className={cx('flex h-16 shrink-0 items-center gap-2 whitespace-nowrap border-b px-6', HEALTH_BAR[health?.tone ?? 'ok'])}>
        <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">Inbox</h1>
        <CountPills counts={counts} />
        {!wide && <SortMenu />}
        <span className="flex-1" />
        <StatusLine inbox={inbox} stillActive={by.waiting.length} open={open === 'waiting'} onToggle={() => toggle('waiting')} />
        {inbox.dryRun && (
          <Link
            to="/settings/writing#dry-run"
            title="Approved writes go to a sandbox folder, not to your vault or Confluence."
            className="inline-flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-[13px] font-medium !text-amber-fg no-underline hover:bg-amber-wash"
          >
            <Icon name="flask" size={14} /> Dry-run on
          </Link>
        )}
        {full && (
          <label className="flex min-h-8 flex-[0_1_220px] items-center gap-2 rounded-lg border-[1.5px] border-dashed border-violet-line bg-surface px-2.5 text-muted">
            <Icon name="search" size={14} />
            <span className="sr-only">Search items, decisions and vault</span>
            <input type="search" placeholder="Search" className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none" onFocus={(e) => (e.currentTarget.blur(), phaseToast('P4', 'Search'))} />
            <span className="font-mono text-[10px] text-violet-fg">P4</span>
          </label>
        )}
        {health && <HealthPill health={health} />}
        <PollButton inbox={inbox} />
        <UsagePopover inbox={inbox} />
        <NotificationBell />
      </header>

      {!wide && <Agenda full={full} onOpenItem={openItem} />}
      <Banners inbox={inbox} />

      <div className="relative flex min-h-0 flex-1">
        {wide ? (
          <>
            <TimeColumn items={all} todos={todos} onOpenItem={openItem} />
            <NeedsYouZone
              rows={needsRows}
              render={(r, n, list) => row(r, n, list, 'needs')}
              pill={<NewPill group="needs" items={pillItems('needs')} above={stable.pending.needs.every((p) => p.above)} onGo={() => goNew('needs')} />}
              scrollerRef={listRef}
              sortMenu={
                <>
                  {sweepButton}
                  <SortMenu />
                </>
              }
              empty={inbox.firstRun ? <FirstRun inbox={inbox} /> : undefined}
              footer={<RepliesLine closed={inbox.closedByReply} onReview={() => setOpen('replied')} className="h-12" />}
            >
              {full && <CommitmentsGroup />}
            </NeedsYouZone>
            <LaterZone
              followRows={followRows}
              followPill={<NewPill group="follow" items={pillItems('follow')} above={stable.pending.follow.every((p) => p.above)} onGo={() => goNew('follow')} />}
              fileRows={fileRows}
              by={by}
              open={open}
              onOpen={setOpen}
              renderFile={(r, n, list) => row(r, n, list, 'later')}
              renderFileRow={(r, n, list) => fileRow(r, n, list, 'later')}
              renderLower={lowerRow}
              pill={<NewPill group="file" items={pillItems('file')} above={stable.pending.file.every((p) => p.above)} onGo={() => goNew('file')} />}
              fileAction={batchButton}
              filedToday={<FiledToday onOpen={openItem} />}
              scrollerRef={laterRef}
            />
          </>
        ) : (
        <section ref={listRef} aria-label="Inbox list" className="min-w-0 flex-[1_1_480px] overflow-y-auto pb-6 pt-2 [overflow-anchor:none]">

          {inbox.firstRun ? (
            <FirstRun inbox={inbox} />
          ) : (
            <>
              {topCount === 0 ? (
                <>
                  <InboxZero inbox={inbox} />
                  <TodoGroup todos={todos} onOpen={openItem} />
                </>
              ) : (
                GROUPS.filter((g) => !g.hideEmpty || groupRows[g.id].length > 0).map((g) => (
                  <Fragment key={g.id}>
                  <section aria-label={g.title} data-group={g.id} className="flex flex-col pb-3">
                    <NewPill group={g.id} items={pillItems(g.id)} above={stable.pending[g.id].every((p) => p.above)} onGo={() => goNew(g.id)} />
                    <div className="flex items-baseline gap-2 px-6 pb-2 pt-3">
                      <GroupHead dot={g.dot} title={g.title} count={by[g.id].length} />
                      {g.id === 'file' && <span className="ml-auto self-center">{batchButton}</span>}
                      {g.id === 'needs' && <span className="ml-auto self-center">{sweepButton}</span>}
                    </div>
                    <div className="border-b border-line-soft">
                      {groupRows[g.id].length ? groupRows[g.id].flatMap((r, n, list) => (g.id === 'file' ? fileRow(r, n, list) : row(r, n, list))) : <div className="border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing here.</div>}
                    </div>
                    {g.id === 'needs' && <RepliesLine closed={inbox.closedByReply} onReview={() => setOpen('replied')} className="border-t-0 py-2.5" />}
                  </section>
                  {g.id === 'needs' && <TodoGroup todos={todos} onOpen={openItem} />}
                  </Fragment>
                ))
              )}
              {full && <CommitmentsGroup />}
              <FooterLinks by={by} open={open} onToggle={toggle} />
              {open && (
                <section aria-label={LOWER[open].title} data-group={open} className="flex flex-col">
                  <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-6 pb-2 pt-1">
                    <h2 className="m-0 text-[13px] font-semibold">{LOWER[open].title}</h2>
                    <span className="font-mono text-xs text-muted">{by[open].length}</span>
                    <span className="min-w-0 flex-[1_1_200px] pl-1 text-xs text-muted">{LOWER[open].note}</span>
                    {open === 'else' && by.else.length > 0 && (
                      <Button size="sm" icon="check" onClick={() => void markManyDoneWithUndo(by.else, 'Low priority')}>
                        Mark all {by.else.length} done
                      </Button>
                    )}
                  </div>
                  {open === 'done' && <FiledToday onOpen={openItem} />}
                  <div className="border-b border-line-soft">{by[open].length ? by[open].flatMap(lowerRow) : <div className="border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing here.</div>}</div>
                </section>
              )}
            </>
          )}
        </section>
        )}

        {panel && (
          <PanelSlide closing={closing} panelRef={panelRef} onSlidOut={host.onSlidOut} className={wide ? 'max-w-[640px]' : 'max-w-[600px]'}>
            <ItemPanel
              item={panel.item}
              view={panel.view}
              pos={panel.pos}
              total={order.length}
              filing={filing}
              setFiling={setFiling}
              draftsBudgetHit={inbox.budgets.drafts.hit}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onClose={close}
              onDoneNext={sweepPanel ? () => void markDoneWithUndo(panel.item) : doneAndNext}
              onDirty={onDirty}
              batch={batchPanel}
              sweep={sweepPanel}
            />
          </PanelSlide>
        )}
        {!panel && batch?.done && (
          <div data-state="open" className={cx('item-panel absolute inset-y-0 right-0 z-30 flex w-full flex-col', wide ? 'max-w-[640px]' : 'max-w-[600px]')}>
            <BatchDone batch={batch} onClose={() => setBatch(null)} />
          </div>
        )}
        {!panel && sweep?.finished && (
          <div data-state="open" className={cx('item-panel absolute inset-y-0 right-0 z-30 flex w-full flex-col', wide ? 'max-w-[640px]' : 'max-w-[600px]')}>
            <SweepDone sweep={sweep} left={by.needs.filter((i) => i.status === 'open').length} onClose={() => setSweep(null)} />
          </div>
        )}
      </div>

      <LeaveDialog blocker={blocker} />
    </div>
  );
}
