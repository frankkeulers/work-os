import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useSearchParams, type BlockerFunction } from 'react-router';
import type { ActionType, Lane } from '@work-os/shared';
import { api, type InboxView, type ItemSummary, type ItemView } from '../api';
import { parseType } from '../components/ActionPanel';
import { SourceMark } from '../components/BrandIcon';
import { ItemMarkers, itemPath, kindLabel, markDoneWithUndo } from '../components/item';
import { Icon } from '../components/icons';
import { useShell } from '../components/Shell';
import { Banner, Button, ConfirmDialog, IconButton, Kbd, PhaseTag, PopoverPanel, Spinner, cx, phaseToast, usePopover } from '../components/ui';
import { useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { fmtAgo, fmtDayDate, fmtIn, fmtMoney, fmtTime, plural } from '../lib/format';
import { dueInfo, needLabel, nextDeadline } from '../lib/next';
import { usePrefs } from '../store/prefs';
import { errorToast } from '../store/toasts';
import { DueChip, NeedTag, StatusChip } from './inbox/chips';
import { ItemPanel } from './inbox/ItemPanel';

const TOP_LANES = ['now', 'today', 'file'] as const satisfies Lane[];
const isTop = (i: ItemSummary) => (TOP_LANES as readonly Lane[]).includes(i.lane);
const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]');

// ---------- Header ----------

function PollLine({ inbox }: { inbox: InboxView }) {
  const now = useNow(5_000);
  const { poll, source } = inbox;
  if (poll.phase === 'polling')
    return (
      <span className="inline-flex items-center gap-1.5 text-accent">
        <Spinner size={12} /> Polling Slack…
      </span>
    );
  if (poll.phase === 'triaging') {
    const n = poll.triagingCount ?? 0;
    return (
      <span className="inline-flex items-center gap-1.5 text-accent">
        <Spinner size={12} /> Triaging {plural(n, 'thread')} · {plural(Math.max(1, Math.ceil(n / 25)), 'call')}
      </span>
    );
  }
  if (!poll.lastPollAt) return <span>Not polled yet</span>;
  const r = poll.lastResult;
  const recent = r && now.getTime() - Date.parse(r.at) < 3 * 60_000;
  const result = !recent ? null : r.triaged === 0 ? (r.fetched === 0 ? 'nothing new, no Claude call' : `${r.fetched} new · no Claude call needed`) : `${r.fetched} new · ${r.triaged} triaged in ${plural(r.calls, 'call')}`;
  return (
    <span>
      Last poll {fmtTime(poll.lastPollAt)}
      {result && <span className="text-ink-2"> · {result}</span>}
      {source.status === 'backoff' && source.retryAt ? (
        <span className="text-amber-fg"> · retry {fmtTime(source.retryAt)}</span>
      ) : source.status === 'auth_failed' ? (
        <span className="text-red-fg"> · polling stopped</span>
      ) : (
        poll.nextPollAt && <> · next {fmtTime(poll.nextPollAt)}</>
      )}
      {!inbox.workHours && <> · off-hours</>}
    </span>
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
        className={cx('relative inline-flex h-10 w-10 items-center justify-center rounded-lg border border-line-strong text-ink-2 cursor-pointer', pOpen ? 'bg-track' : 'bg-surface')}
      >
        <Icon name="dollar" size={18} />
        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full border-2 border-surface box-content" style={{ background: colour }} />
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
    <IconButton
      label={busy ? 'Poll in progress' : 'Poll now'}
      bordered
      size={40}
      disabled={busy}
      onClick={() => void api.pollNow().catch(errorToast)}
    >
      {busy ? <Spinner size={16} /> : <Icon name="poll" size={18} />}
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
  return out.length ? <div className="flex flex-col gap-2 px-6 pt-3">{out}</div> : null;
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
        Rules, VIPs and the quiet window are in <Link to="/settings/rules">Settings &amp; rules</Link>.
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

const GROUPS: Record<(typeof TOP_LANES)[number], { title: string; dot: string }> = {
  now: { title: 'Now', dot: 'var(--orange)' },
  today: { title: 'Today', dot: 'var(--accent-bg)' },
  file: { title: 'To file', dot: 'var(--teal-solid)' },
};

type Lower = 'failed' | 'waiting' | 'else' | 'snoozed' | 'done';

const LOWER: { id: Lower; title: string; dot: string; note: string }[] = [
  { id: 'failed', title: 'Failed', dot: 'var(--red)', note: 'Triage output was invalid twice. Shown untriaged.' },
  { id: 'waiting', title: 'Waiting for quiet window', dot: 'var(--gray-mid)', note: 'Still active. Triage runs once each thread has been quiet for a while.' },
  { id: 'else', title: 'Everything else', dot: 'var(--gray-mid)', note: 'No action and nothing to file. Correct any that are wrong.' },
  { id: 'snoozed', title: 'Snoozed', dot: 'var(--gray-mid)', note: 'Each comes back at its snooze time, or early if a new reply makes it Now.' },
  { id: 'done', title: 'Done', dot: 'var(--green)', note: 'Comes back if someone other than you replies.' },
];

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

function QueueRow({ item, selected, fresh, onPick }: { item: ItemSummary; selected: boolean; fresh: boolean; onPick: () => void }) {
  const now = useNow(30_000);
  const top = isTop(item);
  const due = top ? dueInfo(item.next, now) : undefined;
  const target = targetChip(item);
  const meta = top ? undefined : lowerMeta(item, now);
  const ago = fmtAgo(item.lastActivityAt, now);
  return (
    <button
      type="button"
      data-row={item.id}
      aria-current={selected ? 'true' : undefined}
      onClick={onPick}
      className={cx(
        'flex w-full flex-wrap items-center gap-x-3.5 gap-y-1.5 border-t border-line-soft px-6 py-[11px] text-left cursor-pointer',
        selected ? 'bg-accent-wash shadow-[inset_3px_0_0_var(--accent-bg)]' : item.lane === 'now' ? 'bg-orange-wash-2' : 'hover:bg-surface-2',
      )}
    >
      <span className="flex w-5 justify-center">
        <SourceMark source={item.source} size={18} />
      </span>
      <span className="flex min-w-[110px] flex-[0_1_170px] flex-col gap-px">
        <span className="truncate text-xs font-medium text-ink-2">{item.title}</span>
        <span className="text-[11px] text-muted">
          {kindLabel(item.kind)} · {ago}
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
          {top && <NeedTag>{item.next ? needLabel(item.next) : item.lane === 'file' ? 'File' : 'Reply'}</NeedTag>}
          {due && <DueChip due={due} />}
          {target && <StatusChip tone="file">{target}</StatusChip>}
          {item.lane === 'failed' && <StatusChip tone="bad">Triage failed</StatusChip>}
          {meta && <span className="font-mono text-[11px] text-muted">{meta}</span>}
        </span>
      </span>
    </button>
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
const NOT_OUTSIDE = '[data-row], a[href], [data-inbox-header] button, nav button, [aria-live], [data-scenarios], [data-overlay], [role="dialog"], [role="menu"]';

export function InboxPage() {
  const { inbox: q } = useShell();
  const inbox = q.data;
  const now = useNow(30_000);
  const navigate = useNavigate();
  const full = usePrefs((s) => s.scope === 'full');
  const setPanelOpen = usePrefs((s) => s.setPanelOpen);
  const [search, setSearch] = useSearchParams();
  const sel = search.get('item');
  const filing = parseType(search.get('file'));

  // Outlook and Teams are Phase 2 sources: their items only show in Full scope.
  // Holding works on every item, so switching scope never makes items look newly arrived.
  const { held: heldAll, heldIds, showHeld, fresh } = useHeldItems(inbox?.items);
  const inScope = useCallback((i: ItemSummary) => full || i.source === 'slack', [full]);
  const all = useMemo(() => (inbox?.items ?? []).filter(inScope), [inbox, inScope]);
  const held = heldAll.filter(inScope);
  const [expanded, setExpanded] = useState<Record<Lower, boolean>>({ failed: true, waiting: false, else: false, snoozed: false, done: false });

  const by = useMemo(() => {
    const m: Record<Lane, ItemSummary[]> = { now: [], today: [], file: [], else: [], failed: [], waiting: [], snoozed: [], done: [] };
    for (const i of all) if (!heldIds.has(i.id)) m[i.lane].push(i);
    m.snoozed.sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
    m.done.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
    return m;
  }, [all, heldIds]);
  // j/k walk the rows on screen: the three top groups, then any lower group that's open.
  const order = useMemo(() => [...TOP_LANES.flatMap((l) => by[l]), ...LOWER.filter((g) => expanded[g.id]).flatMap((g) => by[g.id])].map((i) => i.id), [by, expanded]);
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

  const topCount = TOP_LANES.reduce((n, l) => n + by[l].length, 0);
  const deadline = nextDeadline(all, now);
  const row = (i: ItemSummary) => <QueueRow key={i.id} item={i} selected={i.id === sel} fresh={fresh.has(i.id)} onPick={() => pick(i.id)} />;
  const view = detail.data && detail.data.summary.id === sel ? detail.data : undefined;
  if (selItem && (shown?.item !== selItem || shown.view !== view || shown.pos !== idx + 1)) setShown({ item: selItem, view, pos: idx + 1 });
  const closing = !selItem && !!shown;
  const panel = selItem ? { item: selItem, view, pos: idx + 1 } : shown;

  return (
    <div className="flex h-screen min-h-0 flex-col bg-surface">
      <header data-inbox-header className="flex flex-wrap items-center gap-3 border-b border-line px-6 py-[18px]">
        <div className="flex min-w-0 flex-[1_1_260px] flex-col gap-0.5">
          <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">Inbox</h1>
          <div className="font-mono text-xs text-muted">
            {fmtDayDate(now)} · {fmtTime(now)}
            {deadline && <> · next deadline {deadline}</>} ·{' '}
            <span data-testid="poll-line">
              <PollLine inbox={inbox} />
            </span>
          </div>
        </div>
        <span className="hidden text-xs text-muted 2xl:inline">
          Click any row. <Kbd>j</Kbd> <Kbd>k</Kbd> move, <Kbd>Esc</Kbd> closes the panel.
        </span>
        {inbox.dryRun && (
          <Link
            to="/settings/writing#dry-run"
            title="Approved writes go to a sandbox folder, not to your vault or Confluence."
            className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-2.5 text-[13px] font-medium !text-amber-fg no-underline hover:bg-amber-wash"
          >
            <Icon name="flask" size={14} /> Dry-run on
          </Link>
        )}
        {full && (
          <label className="flex min-h-10 flex-[0_1_240px] items-center gap-2 rounded-lg border-[1.5px] border-dashed border-violet-line bg-surface px-3 text-muted">
            <Icon name="search" />
            <span className="sr-only">Search items, decisions and vault</span>
            <input type="search" placeholder="Search" className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none" onFocus={(e) => (e.currentTarget.blur(), phaseToast('P4', 'Search'))} />
            <span className="font-mono text-[10px] text-violet-fg">P4</span>
          </label>
        )}
        <PollButton inbox={inbox} />
        <UsagePopover inbox={inbox} />
      </header>

      {full && (
        <div className="mx-6 mt-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border-[1.5px] border-dashed border-violet-line bg-violet-wash py-2 pl-3.5 pr-2 text-[13px]">
          <Icon name="calendar" className="text-violet-fg" />
          <span className="font-semibold">14:00</span>
          <span className="flex-[1_1_240px] text-ink-2">[Customer] renewal call. Account brief ready.</span>
          <span className="font-mono text-[10px] text-violet-fg">P4</span>
          <Button variant="future" onClick={() => phaseToast('P4', 'Meeting briefs')}>
            Open brief
          </Button>
        </div>
      )}
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
                TOP_LANES.map((l) => (
                  <section key={l} aria-label={GROUPS[l].title} data-group={l} className="flex flex-col pb-3">
                    <div className="flex items-baseline gap-2 px-6 pb-2 pt-3">
                      <GroupHead dot={GROUPS[l].dot} title={GROUPS[l].title} count={by[l].length} />
                    </div>
                    <div className="border-b border-line-soft">{by[l].length ? by[l].map(row) : <div className="border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing here.</div>}</div>
                  </section>
                ))
              )}
              {full && <CommitmentsGroup />}
              <div className="flex flex-col pt-2">
                {LOWER.filter((g) => g.id === 'else' || by[g.id].length > 0).map((g) => (
                  <section key={g.id} aria-label={g.title} data-group={g.id} className="flex flex-col">
                    <button
                      type="button"
                      aria-expanded={expanded[g.id]}
                      onClick={() => setExpanded({ ...expanded, [g.id]: !expanded[g.id] })}
                      className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-t border-line-soft px-6 py-2.5 text-left cursor-pointer hover:bg-surface-2"
                    >
                      <Icon name="down" size={14} className={cx('shrink-0 self-center text-muted transition-transform', !expanded[g.id] && '-rotate-90')} />
                      <GroupHead dot={g.dot} title={g.title} count={by[g.id].length} />
                      <span className="min-w-0 flex-[1_1_200px] pl-1 text-xs text-muted">{g.note}</span>
                    </button>
                    {expanded[g.id] && <div>{by[g.id].length ? by[g.id].map(row) : <div className="border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing here.</div>}</div>}
                  </section>
                ))}
              </div>
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
