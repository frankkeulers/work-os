import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Lane } from '@work-os/shared';
import { api, type InboxView, type ItemSummary } from '../api';
import { CorrectForm, FutureCommitmentCard, ItemCard, SourceIcon, itemPath, type CardHandle } from '../components/ItemCard';
import { Icon } from '../components/icons';
import { useShell } from '../components/Shell';
import { Banner, Button, IconButton, Kbd, PhaseTag, PopoverPanel, Segmented, Spinner, cx, phaseToast, usePopover } from '../components/ui';
import { useNow } from '../hooks/useNow';
import { fmtDayDate, fmtIn, fmtMoney, fmtTime, plural } from '../lib/format';
import { LANE_META } from '../lib/lanes';
import { usePrefs } from '../store/prefs';
import { errorToast, toast } from '../store/toasts';

const TOP_LANES = ['now', 'today', 'file'] as const satisfies Lane[];
const isTop = (i: ItemSummary) => (TOP_LANES as readonly Lane[]).includes(i.lane);

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
  if (inbox.dryRun)
    out.push(
      <Banner key="dry" tone="dry" icon="flask" action={<Link to="/settings/writing#dry-run" className="text-[13px] font-medium">Dry-run setting</Link>}>
        <strong>Dry-run is on.</strong> Approved writes go to a sandbox folder, not to your vault or Confluence.
      </Banner>,
    );
  return out.length ? <div className="flex flex-col gap-2">{out}</div> : null;
}

// ---------- Lanes ----------

function LaneBox({ lane, count, children, layout }: { lane: (typeof TOP_LANES)[number]; count: number; children: ReactNode; layout: 'board' | 'list' }) {
  const m = LANE_META[lane];
  return (
    <section aria-label={`${m.name} lane`} data-lane={lane} className={cx('flex flex-col rounded-xl border border-transparent bg-lane p-3', layout === 'board' ? 'gap-2.5' : 'gap-1.5')}>
      <div className={cx('flex items-center gap-2 px-1 py-0.5', layout === 'list' && 'pb-1.5')}>
        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: m.dot }} />
        <h2 className="m-0 text-[15px] font-semibold">{m.name}</h2>
        <span className="font-mono text-xs text-muted">{count}</span>
      </div>
      {count === 0 ? <div className="px-1 py-3 text-[13px] text-muted">Nothing here.</div> : children}
    </section>
  );
}

function CommitmentsLane({ layout }: { layout: 'board' | 'list' }) {
  return (
    <section aria-label="Commitments lane (P3)" className={cx('flex flex-col rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-lane p-3', layout === 'board' ? 'gap-2.5' : 'gap-1.5')}>
      <div className="flex items-center gap-2 px-1 py-0.5">
        <span className="h-2.5 w-2.5 rounded-[3px] bg-violet-dot" />
        <h2 className="m-0 text-[15px] font-semibold">Commitments</h2>
        <span className="font-mono text-xs text-muted">2</span>
        <span className="flex-1" />
        <PhaseTag phase="P3" />
      </div>
      <FutureCommitmentCard where="from #mvi-launch" when="Fri 9 Oct" summary="Send MVI V2 release notes to Sales." reason="“I’ll send the notes by Friday.”" />
      <FutureCommitmentCard where="from DM" when="Wed 7 Oct" summary="Review the PSPD-112 PRD draft." reason="“Will review before Wednesday.”" />
    </section>
  );
}

function Collapsible({
  id,
  dot,
  title,
  count,
  note,
  tone,
  children,
  defaultOpen = false,
}: {
  id: string;
  dot: string;
  title: string;
  count: number;
  note?: ReactNode;
  tone?: 'red';
  children: ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section aria-label={title} data-section={id} className={cx('flex flex-col rounded-xl border bg-surface', tone === 'red' ? 'border-red-line' : 'border-line')}>
      <div className="flex flex-wrap items-center gap-2.5 px-3.5 py-2.5">
        <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: dot }} />
        <h2 className="m-0 text-[15px] font-semibold">{title}</h2>
        <span className="font-mono text-xs text-muted">{count}</span>
        <span className="min-w-0 flex-[1_1_200px] text-[13px] text-ink-2">{note}</span>
        <Button onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </Button>
      </div>
      {open && <div className="flex flex-col border-t border-line">{children}</div>}
    </section>
  );
}

function Row({ item, children, meta }: { item: ItemSummary; children?: ReactNode; meta?: ReactNode }) {
  return (
    <div data-row={item.id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-b border-line-soft-2 px-3.5 py-2.5 text-[13px] last:border-b-0">
      <span className="flex w-[170px] min-w-0 items-center gap-1.5 font-mono text-xs text-muted">
        <SourceIcon kind={item.kind} />
        <span className="truncate">{item.title}</span>
      </span>
      <Link to={itemPath(item.id)} className="min-w-0 flex-[1_1_240px] !text-ink-2 no-underline hover:underline">
        {item.summary}
      </Link>
      {meta && <span className="font-mono text-[11px] text-muted">{meta}</span>}
      {children}
    </div>
  );
}

function ElseRow({ item }: { item: ItemSummary }) {
  const { open: pOpen, setOpen: setPOpen, close: closeP, trigger: pTrigger, panel: pPanel } = usePopover();
  return (
    <Row item={item} meta={item.triage?.by === 'rule' ? 'by rule' : item.triage?.by === 'user' ? 'corrected' : undefined}>
      <div className="relative">
        <Button size="sm" ref={pTrigger} aria-expanded={pOpen} onClick={() => setPOpen(!pOpen)}>
          Correct triage
        </Button>
        {pOpen && (
          <PopoverPanel panelRef={pPanel} label="Correct triage">
            <CorrectForm
              compact
              item={item}
              onDone={(n, lane) => {
                closeP(false);
                toast(`Correction saved · moved to ${lane} · labelled set now ${n}`, { tone: 'success' });
              }}
            />
          </PopoverPanel>
        )}
      </div>
    </Row>
  );
}

function FailedRow({ item }: { item: ItemSummary }) {
  const [busy, setBusy] = useState(false);
  return (
    <Row item={item} meta="output invalid twice · shown untriaged">
      <Button
        size="sm"
        disabled={busy || item.triageState === 'pending'}
        onClick={async () => {
          setBusy(true);
          try {
            await api.retryTriage(item.id);
          } catch (e) {
            errorToast(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy || item.triageState === 'pending' ? (
          <>
            <Spinner size={12} /> Retrying…
          </>
        ) : (
          'Retry'
        )}
      </Button>
    </Row>
  );
}

function WaitingRows({ items }: { items: ItemSummary[] }) {
  const now = useNow(5_000);
  return items.map((i) => (
    <Row key={i.id} item={i} meta={i.modelPaused ? 'paused · triage budget reached' : i.quietUntil && Date.parse(i.quietUntil) > now.getTime() ? `quiet ${fmtIn(i.quietUntil, now)}` : 'next poll'} />
  ));
}

// ---------- Empty and first-run states ----------

function FirstRun({ inbox }: { inbox: InboxView }) {
  const busy = inbox.poll.phase !== 'idle';
  return (
    <div className="flex flex-col items-start gap-4 rounded-xl border border-line bg-surface px-8 py-10">
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
    <div className="flex flex-col items-center gap-2 rounded-xl border border-line bg-surface px-8 py-12 text-center" data-testid="inbox-zero">
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

// ---------- Keyboard ----------

function useKeyboard(order: string[], handleFor: (id: string) => CardHandle | undefined) {
  const [focusId, setFocusId] = useState<string | null>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"]')) return;
      if (!order.length) return;
      const idx = focusId ? order.indexOf(focusId) : -1;
      const move = (to: number) => {
        const id = order[Math.max(0, Math.min(order.length - 1, to))];
        setFocusId(id);
        const el = document.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`);
        el?.focus({ preventScroll: true });
        el?.scrollIntoView({ block: 'nearest' });
      };
      const handle = focusId ? handleFor(focusId) : undefined;
      switch (e.key) {
        case 'j':
          e.preventDefault();
          move(idx + 1);
          break;
        case 'k':
          e.preventDefault();
          move(idx < 0 ? 0 : idx - 1);
          break;
        case 'Enter':
          if (handle && t.tagName !== 'BUTTON' && t.tagName !== 'A') {
            e.preventDefault();
            navigate(itemPath(focusId!));
          }
          break;
        case 'e':
          if (handle) {
            e.preventDefault();
            // Keep the cursor on the same position after the item leaves.
            const next = order[idx + 1] ?? order[idx - 1] ?? null;
            handle.done();
            setFocusId(next);
            if (next) document.querySelector<HTMLElement>(`[data-card="${CSS.escape(next)}"]`)?.focus({ preventScroll: true });
          }
          break;
        case 's':
          if (handle) {
            e.preventDefault();
            handle.snooze();
          }
          break;
        case 'c':
          if (handle) {
            e.preventDefault();
            handle.correct();
          }
          break;
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [order, focusId, handleFor, navigate]);
  // Drop focus when the item leaves the lanes.
  const current = focusId && order.includes(focusId) ? focusId : null;
  return { focusId: current, setFocusId };
}

// ---------- Page ----------

export function InboxPage() {
  const { inbox: q } = useShell();
  const inbox = q.data;
  const view = usePrefs((s) => s.view);
  const setView = usePrefs((s) => s.setView);
  const full = usePrefs((s) => s.scope === 'full');
  const { held, heldIds, showHeld, fresh } = useHeldItems(inbox?.items);
  const cards = useRef(new Map<string, CardHandle>());
  const handleFor = useCallback((id: string) => cards.current.get(id), []);
  const registerCard = useCallback((id: string, h: CardHandle | null) => {
    if (h) cards.current.set(id, h);
    else cards.current.delete(id);
  }, []);

  const items = useMemo(() => (inbox?.items ?? []).filter((i) => !heldIds.has(i.id)), [inbox, heldIds]);
  const by = useMemo(() => {
    const m: Record<Lane, ItemSummary[]> = { now: [], today: [], file: [], else: [], failed: [], waiting: [], snoozed: [], done: [] };
    for (const i of items) m[i.lane].push(i);
    m.snoozed.sort((a, b) => (a.snoozedUntil ?? '').localeCompare(b.snoozedUntil ?? ''));
    m.done.sort((a, b) => (b.doneAt ?? '').localeCompare(a.doneAt ?? ''));
    return m;
  }, [items]);
  const order = useMemo(() => TOP_LANES.flatMap((l) => by[l].map((i) => i.id)), [by]);
  const { focusId, setFocusId } = useKeyboard(order, handleFor);

  useEffect(() => {
    document.title = 'Inbox · Work OS';
  }, []);

  if (!inbox) return <div className="p-8 text-muted">{q.error ? 'Could not load the inbox.' : 'Loading…'}</div>;

  const topCount = order.length;
  const draftsHit = inbox.budgets.drafts.hit;
  const renderLane = (lane: (typeof TOP_LANES)[number]) => (
    <LaneBox key={lane} lane={lane} count={by[lane].length} layout={view}>
      {by[lane].map((i) => (
        <ItemCard key={i.id} ref={(h) => registerCard(i.id, h)} item={i} layout={view} draftsBudgetHit={draftsHit} focused={focusId === i.id} fresh={fresh.has(i.id)} onFocus={() => setFocusId(i.id)} />
      ))}
    </LaneBox>
  );

  return (
    <div className="flex flex-col gap-[18px] px-8 pb-12 pt-6">
      <header className="flex flex-wrap items-center gap-3">
        <div className="flex flex-[1_1_240px] flex-col gap-1">
          <h1 className="m-0 text-[26px] font-semibold tracking-[-0.015em]">Inbox</h1>
          <div className="font-mono text-xs text-muted" data-testid="poll-line">
            <PollLine inbox={inbox} />
          </div>
        </div>
        {full && (
          <label className="flex min-h-10 flex-[0_1_280px] items-center gap-2 rounded-lg border-[1.5px] border-dashed border-violet-line bg-surface px-3 text-muted">
            <Icon name="search" />
            <span className="sr-only">Search items, decisions and vault</span>
            <input type="search" placeholder="Search" className="min-w-0 flex-1 border-0 bg-transparent text-[13px] text-ink outline-none" onFocus={(e) => (e.currentTarget.blur(), phaseToast('P4', 'Search'))} />
            <span className="font-mono text-[10px] text-violet-fg">P4</span>
          </label>
        )}
        <Segmented
          label="View style"
          value={view}
          onChange={setView}
          options={[
            { value: 'board', label: 'Board' },
            { value: 'list', label: 'List' },
          ]}
        />
        <PollButton inbox={inbox} />
        <UsagePopover inbox={inbox} />
      </header>

      {full && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border-[1.5px] border-dashed border-violet-line bg-violet-wash py-2 pl-3.5 pr-2 text-[13px]">
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

      {held.length > 0 && (
        <div className="sticky top-3 z-30 flex justify-center">
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
      ) : topCount === 0 && held.length === 0 ? (
        <InboxZero inbox={inbox} />
      ) : view === 'board' ? (
        <section aria-label="Triage lanes" className="grid items-start gap-4 [grid-template-columns:repeat(auto-fit,minmax(264px,1fr))]">
          {TOP_LANES.map(renderLane)}
          {full && <CommitmentsLane layout="board" />}
        </section>
      ) : (
        <section aria-label="Triage lanes, list view" className="flex flex-col gap-4">
          {TOP_LANES.map(renderLane)}
          {full && <CommitmentsLane layout="list" />}
        </section>
      )}

      {!inbox.firstRun && (
        <div className="flex flex-col gap-3">
          {by.failed.length > 0 && (
            <Collapsible id="failed" dot="var(--red)" title="Failed" tone="red" count={by.failed.length} note="Triage output was invalid twice. Shown untriaged." defaultOpen>
              {by.failed.map((i) => (
                <FailedRow key={i.id} item={i} />
              ))}
            </Collapsible>
          )}
          {by.waiting.length > 0 && (
            <Collapsible id="waiting" dot="var(--gray-mid)" title="Waiting for quiet window" count={by.waiting.length} note="Still active. Triage runs once each thread has been quiet for a while.">
              <WaitingRows items={by.waiting} />
            </Collapsible>
          )}
          <Collapsible id="else" dot="var(--gray-mid)" title="Everything else" count={by.else.length} note="No action and nothing to file. Correct any that are wrong.">
            {by.else.length ? by.else.map((i) => <ElseRow key={i.id} item={i} />) : <div className="px-3.5 py-3 text-[13px] text-muted">Nothing here.</div>}
          </Collapsible>
          {by.snoozed.length > 0 && (
            <Collapsible id="snoozed" dot="var(--gray-mid)" title="Snoozed" count={by.snoozed.length} note="Each comes back at its snooze time, or early if a new reply makes it Now.">
              {by.snoozed.map((i) => (
                <Row key={i.id} item={i} meta={i.snoozedUntil && `until ${fmtDayDate(i.snoozedUntil)} ${fmtTime(i.snoozedUntil)}`}>
                  <Button size="sm" onClick={() => void api.reopen(i.id).catch(errorToast)}>
                    Unsnooze
                  </Button>
                </Row>
              ))}
            </Collapsible>
          )}
          {by.done.length > 0 && (
            <Collapsible id="done" dot="var(--green)" title="Done" count={by.done.length} note="Comes back if someone other than you replies.">
              {by.done.map((i) => (
                <Row key={i.id} item={i} meta={i.doneAt && `done ${fmtDayDate(i.doneAt)} ${fmtTime(i.doneAt)}`}>
                  <Button size="sm" onClick={() => void api.reopen(i.id).catch(errorToast)}>
                    Reopen
                  </Button>
                </Row>
              ))}
            </Collapsible>
          )}
        </div>
      )}

      {!inbox.firstRun && topCount > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" aria-label="Keyboard shortcuts">
          <span>
            <Kbd>j</Kbd> <Kbd>k</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> open
          </span>
          <span>
            <Kbd>e</Kbd> done
          </span>
          <span>
            <Kbd>s</Kbd> snooze
          </span>
          <span>
            <Kbd>c</Kbd> correct triage
          </span>
          <span>
            <Kbd>Esc</Kbd> close
          </span>
        </div>
      )}
    </div>
  );
}
