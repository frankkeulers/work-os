import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useSearchParams, type BlockerFunction } from 'react-router';
import type { ActionType } from '@work-os/shared';
import { api, type InboxView, type ItemSummary, type ItemView } from '../api';
import { parseType } from '../components/ActionPanel';
import { Agenda } from '../components/Agenda';
import { SourceMark } from '../components/BrandIcon';
import { CategoryDot, ItemMarkers, itemPath, kindLabel, markDoneWithUndo, markManyDoneWithUndo } from '../components/item';
import { HealthBanner } from '../components/HealthBanner';
import { Icon } from '../components/icons';
import { useShell } from '../components/Shell';
import { Banner, Button, ConfirmDialog, IconButton, MenuItem, PhaseTag, PopoverPanel, Spinner, cx, phaseToast, usePopover } from '../components/ui';
import { useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { fmtAgo, fmtDayDate, fmtIn, fmtMoney, fmtTime, fmtWhen, plural } from '../lib/format';
import { INBOX_SORT_LABEL, channelKey, dueInfo, groupByChannel, isLive, laneCounts, needLabel, sortItems, topicAsks, type InboxSort, type LaneCounts } from '../lib/next';
import { usePrefs } from '../store/prefs';
import { errorToast, toast } from '../store/toasts';
import { DueChip, NeedTag, StatusChip } from './inbox/chips';
import { ItemPanel } from './inbox/ItemPanel';

// The two groups on screen (FR-8.1). Failed triage sits in Needs you, untriaged, so it isn't missed.
const isTop = (i: ItemSummary) => i.lane === 'now' || i.lane === 'today' || i.lane === 'failed' || i.lane === 'file';
const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]');

// ---------- Header ----------

/** What the last poll found, for a few minutes after it ran. */
function pollResult(inbox: InboxView, now: Date) {
  const r = inbox.poll.lastResult;
  if (!r || now.getTime() - Date.parse(r.at) >= 3 * 60_000) return null;
  return r.triaged === 0 ? (r.fetched === 0 ? 'Nothing new, no Claude call' : `${r.fetched} new · no Claude call needed`) : `${r.fetched} new · ${r.triaged} triaged in ${plural(r.calls, 'call')}`;
}

/**
 * Poll status next to the Poll button, only when there's something to say: a poll in flight, or
 * what the last one found. The rest (last and next poll) is in the button's tooltip, and the
 * sidebar shows how long ago Slack was polled. Slack trouble has its own banner.
 */
/** Threads still being written, which triage once they go quiet. Opens their list under the footer. */
function StillActive({ count, open, onToggle }: { count: number; open: boolean; onToggle: () => void }) {
  if (!count) return null;
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onToggle}
      title="Triage runs once each thread has been quiet for a while."
      className={cx('inline-flex min-h-8 items-center rounded-lg px-2 text-xs text-muted cursor-pointer hover:bg-surface-2 hover:text-ink-2', open && 'text-ink-2')}
    >
      {count} still active
    </button>
  );
}

function PollStatus({ inbox }: { inbox: InboxView }) {
  const now = useNow(5_000);
  const { poll } = inbox;
  let body: ReactNode;
  if (poll.phase === 'polling')
    body = (
      <>
        <Spinner size={12} /> Polling Slack…
      </>
    );
  else if (poll.phase === 'triaging') {
    const n = poll.triagingCount ?? 0;
    body = (
      <>
        <Spinner size={12} /> Triaging {plural(n, 'thread')} · {plural(Math.max(1, Math.ceil(n / 25)), 'call')}
      </>
    );
  } else body = pollResult(inbox, now);
  return (
    <span data-testid="poll-line" aria-live="polite" className={cx('inline-flex items-center gap-1.5 text-xs', poll.phase === 'idle' ? 'text-muted' : 'text-accent')}>
      {body}
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
        <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full border-2 border-surface box-content" style={{ background: colour }} />
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

function PollButton({ inbox }: { inbox: InboxView }) {
  const busy = inbox.poll.phase !== 'idle';
  return (
    <IconButton label={busy ? 'Poll in progress' : 'Poll now'} title={`Poll now · ${pollTooltip(inbox)}`} size={32} disabled={busy} onClick={() => void api.pollNow().catch(errorToast)}>
      {busy ? <Spinner size={15} /> : <Icon name="poll" size={17} />}
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
      <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent-wash text-accent">
        <Icon name="inbox" size={22} />
      </span>
      <div className="flex max-w-[560px] flex-col gap-1.5">
        <h2 className="m-0 text-xl font-semibold">Work OS hasn’t polled Slack yet</h2>
        <p className="m-0 text-sm leading-relaxed text-ink-2">
          The first poll reads the last 24 hours of the channels and DMs you’re in, applies your rules, and triages quiet threads in batches. It takes about a minute and uses roughly one triage call per 25 threads.
        </p>
      </div>
      <Button variant="solid" size="lg" disabled={busy} onClick={() => void api.pollNow().catch(errorToast)}>
        {busy ? (
          <>
            <Spinner /> {inbox.poll.phase === 'polling' ? 'Polling Slack…' : `Triaging ${plural(inbox.poll.triagingCount ?? 0, 'thread')}…`}
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
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-teal-wash text-teal-ink">
        <Icon name="check" size={22} strokeWidth={2.5} />
      </span>
      <h2 className="m-0 text-xl font-semibold">Inbox zero</h2>
      <p className="m-0 max-w-[460px] text-sm text-ink-2">
        Nothing needs you and nothing is waiting to be filed.
        {inbox.poll.nextPollAt && <> Next poll at {fmtTime(inbox.poll.nextPollAt)}.</>}
      </p>
    </div>
  );
}

// ---------- "N new" holding ----------

/** Holds newly arrived top-lane items behind a pill so lanes don't reflow under the cursor. */
function useHeldItems(items: ItemSummary[] | undefined) {
  const [ack, setAck] = useState<Set<string> | null>(null);
  const [seenItems, setSeenItems] = useState<ItemSummary[] | undefined>(undefined);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  let seen = ack;
  if (items && items !== seenItems) {
    // First load acknowledges everything; later loads acknowledge items outside the top lanes,
    // and everything when no card is on screen (nothing would reflow).
    const next = new Set(ack ?? items.map((i) => i.id));
    items.forEach((i) => !isTop(i) && next.add(i.id));
    if (!items.some((i) => isTop(i) && next.has(i.id))) items.forEach((i) => next.add(i.id));
    setAck(next);
    setSeenItems(items);
    seen = next;
  }
  const held = (items ?? []).filter((i) => isTop(i) && seen && !seen.has(i.id));
  const showHeld = () => {
    setAck(new Set([...(seen ?? []), ...held.map((i) => i.id)]));
    setFresh(new Set(held.map((i) => i.id)));
  };
  return { held, heldIds: new Set(held.map((i) => i.id)), showHeld, fresh };
}

// ---------- Rows ----------

type Group = 'needs' | 'file';

const GROUPS: { id: Group; title: string; dot: string }[] = [
  { id: 'needs', title: 'Needs you', dot: 'var(--orange)' },
  { id: 'file', title: 'To file', dot: 'var(--teal-solid)' },
];

// Off the main list: one footer link each (Waiting's link is in the header), opening one list at a time.
type Lower = 'else' | 'snoozed' | 'done' | 'waiting';

const LOWER: Record<Lower, { title: string; note: string }> = {
  else: { title: 'Low priority', note: 'No action and nothing to file. Correct any that are wrong.' },
  snoozed: { title: 'Snoozed', note: 'Each comes back at its snooze time, or early if a new reply makes it Now.' },
  done: { title: 'Done', note: 'Comes back if someone other than you replies.' },
  waiting: { title: 'Waiting for quiet window', note: 'Still active. Triage runs once each thread has been quiet for a while.' },
};

/** Low priority leads as an outlined button; Snoozed and Done are quiet links at the far end. */
function FooterLinks({ by, open, onToggle }: { by: Record<Lower, ItemSummary[]>; open: Lower | null; onToggle: (g: Lower) => void }) {
  const now = useNow(30_000);
  const back = by.snoozed[0]?.snoozedUntil;
  const chevron = (id: Lower) => <Icon name="down" size={12} className={cx('transition-transform', open !== id && '-rotate-90')} />;
  const quiet: { id: Lower; icon: 'clock' | 'check'; label: string }[] = [
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

/** "Insights APIs › Decisions" for Confluence, "Vault · Resources" for the vault. */
function targetChip(i: ItemSummary): string | undefined {
  if (i.lane !== 'file') return undefined;
  if (i.triage?.confluence && i.targetHints.confluence && !i.containsPeopleObservations) return i.targetHints.confluence;
  const v = i.targetHints.vault;
  return v ? `Vault · ${v.split('/')[0]}` : undefined;
}

function lowerMeta(i: ItemSummary, now: Date): string | undefined {
  if (i.lane === 'failed') return 'output invalid twice';
  if (i.lane === 'waiting') return i.modelPaused ? 'paused · triage budget reached' : i.quietUntil && Date.parse(i.quietUntil) > now.getTime() ? `quiet ${fmtIn(i.quietUntil, now)}` : 'next poll';
  if (i.lane === 'snoozed' && i.snoozedUntil) return `until ${fmtDayDate(i.snoozedUntil)} ${fmtTime(i.snoozedUntil)}`;
  if (i.lane === 'done' && i.doneAt) return `done ${fmtDayDate(i.doneAt)} ${fmtTime(i.doneAt)}`;
  if (i.triage?.by === 'rule') return 'by rule';
  if (i.triage?.by === 'user') return 'corrected';
  return undefined;
}

function QueueRow({ item, selected, fresh, divide, onPick }: { item: ItemSummary; selected: boolean; fresh: boolean; divide?: boolean; onPick: () => void }) {
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
  return (
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
          </span>
        </span>
        {/* Chips sit at the right edge, or wrap under the summary when the list is narrow. */}
        <span className="flex min-w-0 flex-[1_1_260px] flex-wrap items-center gap-x-3.5 gap-y-1.5">
          <span className={cx('flex min-w-0 flex-[1_1_240px] flex-col gap-1 text-[13px] leading-[1.4]', top ? 'font-medium text-ink' : 'text-ink-2')}>
            <span>
              {item.summary}
              {fresh && <span className="ml-1.5 rounded bg-accent-bg px-1.5 py-px align-[1px] text-[10px] font-semibold text-on-solid">New</span>}
            </span>
            <ItemMarkers item={item} />
          </span>
          <span className="flex flex-wrap gap-1">
            {top && !failed && <NeedTag>{item.next ? needLabel(item.next) : item.lane === 'file' ? 'File' : 'Reply'}</NeedTag>}
            {top && moreAsks > 0 && <span className="self-center font-mono text-[11px] text-muted">+{plural(moreAsks, 'ask')}</span>}
            {due && <DueChip due={due} />}
            {target && <StatusChip tone="file">{target}</StatusChip>}
            {item.lane === 'failed' && <StatusChip tone="bad">Triage failed</StatusChip>}
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

const keyOf = (q: URLSearchParams) => `${q.get('item')}:${parseType(q.get('file'))}`;

/**
 * Clicks here aren't "outside" the item panel: rows switch the item; links leave the page anyway
 * (closing would rewrite the URL mid-navigation); the page header's and the sidebar's buttons
 * (Poll, Usage, Scope) work alongside it; and layers (toasts, dialogs, menus, the scenario drawer)
 * sit above it.
 */
const NOT_OUTSIDE = '[data-row], [data-row-action], [data-agenda-event] button, a[href], [data-inbox-header] button, nav button, [aria-live], [data-scenarios], [data-overlay], [role="dialog"], [role="menu"]';

export function InboxPage() {
  const { inbox: q } = useShell();
  const inbox = q.data;
  const navigate = useNavigate();
  const full = usePrefs((s) => s.scope === 'full');
  const setPanelOpen = usePrefs((s) => s.setPanelOpen);
  const [search, setSearch] = useSearchParams();
  const sel = search.get('item');
  const filing = parseType(search.get('file'));

  // Outlook and Teams are Phase 2 previews: their items only show in Full scope.
  // Holding works on every item, so switching scope never makes items look newly arrived.
  const { held: heldAll, heldIds, showHeld, fresh } = useHeldItems(inbox?.items);
  const inScope = useCallback((i: ItemSummary) => full || isLive(i.source), [full]);
  const all = useMemo(() => (inbox?.items ?? []).filter(inScope), [inbox, inScope]);
  const held = heldAll.filter(inScope);
  const [open, setOpen] = useState<Lower | null>(null);
  const toggle = (g: Lower) => setOpen(open === g ? null : g);
  const now = useNow(60_000);
  const sort = usePrefs((s) => s.inboxSort);
  const grouped = usePrefs((s) => s.groupByChannel);

  const by = useMemo(() => {
    const shown = all.filter((i) => !heldIds.has(i.id));
    const m: Record<Group | Lower, ItemSummary[]> = { needs: sortItems(shown, sort, true, now), file: [], else: [], waiting: [], snoozed: [], done: [] };
    for (const i of shown) if (i.lane in m) m[i.lane as Group | Lower].push(i);
    for (const g of ['file', 'else', 'waiting'] as const) m[g] = sortItems(m[g], sort, false, now);
    if (grouped) for (const g of ['needs', 'file', 'else', 'waiting'] as const) m[g] = groupByChannel(m[g]);
    m.snoozed.sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
    m.done.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
    return m;
  }, [all, heldIds, now, sort, grouped]);
  // Open topics per conversation, across every group: Regroup is offered where there are two or more.
  const openTopics = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of all) {
      const key = channelKey(i);
      if (key && i.status !== 'done') m.set(key, (m.get(key) ?? 0) + 1);
    }
    return m;
  }, [all]);
  // j/k walk the rows on screen: Needs you, To file, then the footer's list if one is open.
  const order = useMemo(() => [...by.needs, ...by.file, ...(open ? by[open] : [])].map((i) => i.id), [by, open]);
  const selItem = sel ? all.find((i) => i.id === sel) : undefined;
  const idx = sel ? order.indexOf(sel) : -1;
  // Where the cursor was, so j/k carry on from there after the item leaves the list.
  const [anchor, setAnchor] = useState(0);
  if (idx >= 0 && idx !== anchor) setAnchor(idx);
  // The panel's last content, kept on screen while it slides out.
  const [shown, setShown] = useState<{ item: ItemSummary; view?: ItemView; pos: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const detail = useApiQuery(() => (sel ? api.getItem(sel) : Promise.resolve(undefined)), (n) => (n.topic === 'item' && n.id === sel) || n.topic === 'settings' || n.topic === 'usage', [sel]);

  // Unsaved draft edits belong to one item and filing target. The blocker reads them from a ref,
  // so a keypress straight after typing can't slip past it before the next render.
  const editKey = keyOf(search);
  const [dirtyState, setDirtyState] = useState({ key: '', dirty: false });
  const dirtyRef = useRef(dirtyState);
  const dirty = dirtyState.key === editKey && dirtyState.dirty;
  const onDirty = useCallback(
    (d: boolean) => {
      dirtyRef.current = { key: editKey, dirty: d };
      setDirtyState(dirtyRef.current);
    },
    [editKey],
  );
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current.dirty && dirtyRef.current.key === keyOf(new URLSearchParams(currentLocation.search)) && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
    [],
  );
  const blocker = useBlocker(shouldBlock);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const pick = useCallback(
    (id: string | undefined) => {
      if (!id) return;
      setPanelOpen(true);
      setSearch({ item: id }, { replace: true });
      const el = document.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest' });
    },
    [setPanelOpen, setSearch],
  );
  const step = useCallback(
    (d: 1 | -1) => {
      if (!order.length) return;
      if (idx < 0) return pick(sel ? order[Math.max(0, Math.min(order.length - 1, d > 0 ? anchor : anchor - 1))] : order[0]);
      pick(order[Math.max(0, Math.min(order.length - 1, idx + d))]);
    },
    [order, idx, sel, anchor, pick],
  );
  const close = useCallback(() => {
    setPanelOpen(false);
    setSearch({}, { replace: true });
  }, [setPanelOpen, setSearch]);
  const doneAndNext = useCallback(() => {
    if (!selItem) return;
    const next = idx >= 0 ? (order[idx + 1] ?? order[idx - 1]) : order[Math.min(anchor, order.length - 1)];
    if (selItem.status === 'open') void markDoneWithUndo(selItem);
    if (next && next !== selItem.id) pick(next);
    else close();
  }, [selItem, idx, order, anchor, pick, close]);
  const setFiling = useCallback(
    (t: ActionType | undefined) => {
      if (!sel) return;
      setSearch(t ? { item: sel, file: t === 'vault_note' ? 'vault' : 'confluence' } : { item: sel }, { replace: true });
    },
    [sel, setSearch],
  );

  // The panel opens on the first item until it's closed. A stale ?item= (after a reset) moves on.
  // The preference is read, not watched: picking a row sets it a moment before the URL changes,
  // and reacting to that would open the first item over the one you picked.
  const first = order[0];
  const missing = !!inbox && !!sel && !selItem;
  useEffect(() => {
    if (!inbox) return;
    const open = usePrefs.getState().panelOpen;
    if (missing) setSearch(open && first ? { item: first } : {}, { replace: true });
    else if (!sel && open && first) setSearch({ item: first }, { replace: true });
  }, [inbox, missing, sel, first, setSearch]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'j') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'k') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'Escape' && sel) {
        e.preventDefault();
        close();
      } else if (e.key === 'o' && sel) {
        e.preventDefault();
        navigate(itemPath(sel));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step, close, sel, navigate]);

  // A click outside the panel closes it. On click rather than mousedown, so the control you
  // clicked still gets the click before the list widens.
  useEffect(() => {
    if (!sel) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.isConnected || panelRef.current?.contains(t) || t.closest(NOT_OUTSIDE)) return;
      if (!(window.getSelection()?.isCollapsed ?? true)) return; // the end of a text selection
      close();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [sel, close]);

  useEffect(() => {
    document.title = 'Inbox · Work OS';
  }, []);

  if (!inbox) return <div className="p-8 text-muted">{q.error ? 'Could not load the inbox.' : 'Loading…'}</div>;

  const topCount = by.needs.length + by.file.length;
  const counts = laneCounts(all);
  // Under Priority, a darker hairline closes the Now block at the top of Needs you. Grouped by
  // channel, each Slack channel's run of rows opens with its name.
  const row = (i: ItemSummary, n: number, list: ItemSummary[]) => {
    const key = grouped ? channelKey(i) : undefined;
    const head = key && (n === 0 || channelKey(list[n - 1]) !== key);
    return [
      head && <ChannelHead key={`head:${i.id}`} item={i} items={list.filter((x) => channelKey(x) === key)} topics={openTopics.get(key) ?? 0} />,
      <QueueRow key={i.id} item={i} selected={i.id === sel} fresh={fresh.has(i.id)} divide={!grouped && sort === 'priority' && n > 0 && list[n - 1].lane === 'now' && i.lane !== 'now'} onPick={() => pick(i.id)} />,
    ];
  };
  const view = detail.data && detail.data.summary.id === sel ? detail.data : undefined;
  if (selItem && (shown?.item !== selItem || shown.view !== view || shown.pos !== idx + 1)) setShown({ item: selItem, view, pos: idx + 1 });
  const closing = !selItem && !!shown;
  const panel = selItem ? { item: selItem, view, pos: idx + 1 } : shown;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* 64px, the height of the sidebar's header, so the two line up. */}
      <header data-inbox-header className="flex h-16 shrink-0 items-center gap-2 border-b border-line px-6">
        <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">Inbox</h1>
        <CountPills counts={counts} />
        <SortMenu />
        <span className="flex-1" />
        <PollStatus inbox={inbox} />
        <StillActive count={by.waiting.length} open={open === 'waiting'} onToggle={() => toggle('waiting')} />
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
        <PollButton inbox={inbox} />
        <UsagePopover inbox={inbox} />
      </header>

      <Agenda full={full} onOpenItem={(id) => (all.some((i) => i.id === id) ? pick(id) : navigate(itemPath(id)))} />
      <Banners inbox={inbox} />

      <div className="relative flex min-h-0 flex-1">
        <section aria-label="Inbox list" className="min-w-0 flex-[1_1_480px] overflow-y-auto pb-6 pt-2">
          {held.length > 0 && (
            <div className="sticky top-2 z-10 flex justify-center">
              <button
                type="button"
                onClick={showHeld}
                className="inline-flex min-h-9 items-center gap-2 rounded-full bg-accent-bg px-4 text-[13px] font-semibold text-on-solid shadow-[0_8px_24px_rgba(20,23,28,0.2)] cursor-pointer hover:brightness-110"
              >
                <Icon name="arrow" size={14} className="-rotate-90" />
                {held.length} new {held.length === 1 ? 'item' : 'items'}
              </button>
            </div>
          )}

          {inbox.firstRun ? (
            <FirstRun inbox={inbox} />
          ) : (
            <>
              {topCount === 0 && held.length === 0 ? (
                <InboxZero inbox={inbox} />
              ) : (
                GROUPS.map((g) => (
                  <section key={g.id} aria-label={g.title} data-group={g.id} className="flex flex-col pb-3">
                    <div className="flex items-baseline gap-2 px-6 pb-2 pt-3">
                      <GroupHead dot={g.dot} title={g.title} count={by[g.id].length} />
                    </div>
                    <div className="border-b border-line-soft">{by[g.id].length ? by[g.id].flatMap(row) : <div className="border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing here.</div>}</div>
                  </section>
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
                  <div className="border-b border-line-soft">{by[open].length ? by[open].flatMap(row) : <div className="border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing here.</div>}</div>
                </section>
              )}
            </>
          )}
        </section>

        {panel && (
          <>
            {/* Visual only: the list stays scrollable and its rows still switch the item. */}
            <div aria-hidden="true" data-state={closing ? 'closed' : 'open'} className="item-panel-backdrop pointer-events-none absolute inset-0 z-20 bg-scrim" />
            <div
              ref={panelRef}
              data-state={closing ? 'closed' : 'open'}
              inert={closing}
              onAnimationEnd={(e) => e.target === e.currentTarget && closing && setShown(null)}
              className="item-panel absolute inset-y-0 right-0 z-30 flex w-full max-w-[600px] flex-col"
            >
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
                onDoneNext={doneAndNext}
                onDirty={onDirty}
              />
            </div>
          </>
        )}
      </div>

      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title="Leave with unsaved edits?"
          body="Your changes to the draft text haven’t been saved. Leaving drops them."
          confirmLabel="Leave"
          danger
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      )}
    </div>
  );
}
