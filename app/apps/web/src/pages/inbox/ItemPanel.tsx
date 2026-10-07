import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ActionType, Message } from '@work-os/shared';
import { api, type ItemSummary, type ItemView } from '../../api';
import { ActionPanel, TYPES } from '../../components/ActionPanel';
import { BrandIcon, SourceMark } from '../../components/BrandIcon';
import { CorrectForm, ItemMarkers, SnoozeMenu, itemPath, kindLabel, markDoneWithUndo, openInSource } from '../../components/item';
import { Icon, MoreIcon } from '../../components/icons';
import { useEarlierToggle } from '../../components/Earlier';
import { MessageText } from '../../components/SlackText';
import { Button, IconButton, Kbd, MenuItem, PhaseTag, PopoverPanel, Spinner, cx, phaseToast, usePopover } from '../../components/ui';
import { useNow } from '../../hooks/useNow';
import { fmtAgo, fmtDayDate, fmtIn, fmtTime, fmtWhen, plural } from '../../lib/format';
import { TYPE_LABEL, draftButton, draftState } from '../../lib/lanes';
import { SOURCE_NAME, shownStep, suggestedSnooze } from '../../lib/next';
import { usePrefs } from '../../store/prefs';
import { errorToast, toast } from '../../store/toasts';
import { DueChip, LaneChip, NeedTag, StatusChip } from './chips';

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]');

function snoozeToast(item: ItemSummary, iso: string) {
  toast(`Snoozed until ${fmtDayDate(iso)} ${fmtTime(iso)} · ${item.title}`, {
    action: { label: 'Undo', run: () => void api.reopen(item.id).catch(errorToast) },
  });
}

async function snooze(item: ItemSummary, iso: string) {
  try {
    await api.snooze(item.id, iso);
    snoozeToast(item, iso);
  } catch (e) {
    errorToast(e);
  }
}

// ---------- Sections ----------

function Section({ title, aside, children, gap = 'gap-2.5' }: { title: string; aside?: ReactNode; children: ReactNode; gap?: string }) {
  return (
    <section aria-label={title} className={cx('flex flex-col border-t border-line-soft pt-[18px]', gap)}>
      <div className="flex items-baseline gap-2">
        <h3 className="m-0 flex-1 text-[13px] font-semibold">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** Snooze for the suggested time in one click, or pick another from the menu. */
function SnoozeSplit({ item, hint }: { item: ItemSummary; hint: { label: string; until: string } }) {
  const now = useNow(30_000);
  const { open, setOpen, close, trigger, panel } = usePopover();
  return (
    <div className="relative inline-flex">
      <Button icon="clock" className="rounded-r-none" onClick={() => void snooze(item, hint.until)}>
        {hint.label}
      </Button>
      <Button ref={trigger} aria-label="More snooze times" aria-haspopup="menu" aria-expanded={open} className="-ml-px rounded-l-none px-2" onClick={() => setOpen(!open)}>
        <Icon name="down" size={14} />
      </Button>
      {open && (
        <PopoverPanel panelRef={panel} label="Snooze for" role="menu" align="left">
          <SnoozeMenu
            now={now}
            onPick={(iso) => {
              close();
              void snooze(item, iso);
            }}
          />
        </PopoverPanel>
      )}
    </div>
  );
}

function NextStepCard({ item, draftsBudgetHit, onFile }: { item: ItemSummary; draftsBudgetHit: boolean; onFile: (t: ActionType) => void }) {
  const now = useNow(30_000);
  const step = shownStep(item, draftsBudgetHit, now);
  const hint = suggestedSnooze(item, now);
  if (!step) return <StatusCard item={item} />;
  const p = step.primary;
  return (
    <section aria-label="Next step" className="flex flex-col gap-2.5 rounded-xl border border-accent-line-2 px-[18px] py-4">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.05em] text-accent-ink">Next step</span>
        <NeedTag>{step.need}</NeedTag>
        {step.due && <DueChip due={step.due} />}
        {step.blocks && <StatusChip tone="block">{step.blocks}</StatusChip>}
      </div>
      <div className="flex flex-col gap-[3px]">
        <div className="text-base font-semibold">{step.step}</div>
        {step.why && <div className="text-[13px] leading-normal text-ink-2">{step.why}</div>}
      </div>
      <div className="flex flex-wrap gap-2">
        {p.kind === 'open' ? (
          <Button variant="solid" icon={item.kind === 'dm' || item.kind === 'chat' ? 'dm' : 'external'} onClick={() => openInSource(item)}>
            {p.label}
          </Button>
        ) : (
          <span title={p.button.disabledReason} className="inline-flex">
            <Button
              variant="solid"
              icon={p.button.type === 'vault_note' ? 'vault' : 'confluence'}
              disabled={!!p.button.disabledReason && p.button.state === 'none'}
              onClick={() => onFile(p.button.type)}
            >
              {(p.button.state === 'drafting' || p.button.state === 'writing') && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
              {p.button.label}
            </Button>
          </span>
        )}
        <SnoozeSplit item={item} hint={hint} />
      </div>
    </section>
  );
}

/** For items with nothing to do: why they're here and how to bring them back. */
function StatusCard({ item }: { item: ItemSummary }) {
  const now = useNow(5_000);
  const [busy, setBusy] = useState(false);
  let title: string;
  let body: ReactNode;
  let action: ReactNode = null;
  if (item.status === 'done') {
    title = item.doneAt ? `Done ${fmtWhen(item.doneAt, now)}` : 'Done';
    body = 'It comes back if someone other than you replies.';
  } else if (item.status === 'snoozed') {
    title = item.snoozedUntil ? `Snoozed until ${fmtDayDate(item.snoozedUntil)} ${fmtTime(item.snoozedUntil)}` : 'Snoozed';
    body = 'It comes back at the snooze time, or early if a new reply makes it Now.';
  } else if (item.triageState === 'failed') {
    title = 'Triage failed. Shown untriaged.';
    body = 'The model’s output was invalid twice. Retry, or set the triage yourself.';
    action = (
      <Button
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await api.retryTriage(item.id).catch(errorToast);
          setBusy(false);
        }}
      >
        {busy && <Spinner size={12} />} Retry triage
      </Button>
    );
  } else if (item.lane === 'waiting') {
    title = item.modelPaused ? 'Model triage paused: budget reached' : 'Waiting for the quiet window';
    body = item.modelPaused
      ? 'Rules still run. Model triage resumes tomorrow, or when the budget is raised.'
      : item.quietUntil && Date.parse(item.quietUntil) > now.getTime()
        ? `The thread is still active. Triage runs once it has been quiet, ${fmtIn(item.quietUntil, now)}.`
        : 'Quiet now. It is triaged on the next poll.';
  } else {
    title = 'Nothing to do';
    body = 'No reply needed and nothing to file. Correct the triage if that’s wrong.';
  }
  return (
    <section aria-label="Status" className={cx('flex flex-col gap-1.5 rounded-xl border px-[18px] py-4', item.triageState === 'failed' ? 'border-red-line' : 'border-line')}>
      <div className="text-[15px] font-semibold">{title}</div>
      <div className="text-[13px] leading-normal text-ink-2">{body}</div>
      {action && <div className="pt-1.5">{action}</div>}
    </section>
  );
}

function ActionItems({ items }: { items: string[] }) {
  // UI-only for the prototype: ticking an action item isn't stored yet.
  const [done, setDone] = useState<Record<number, boolean>>({});
  return (
    <Section title="Action items for you">
      {items.map((a, i) => (
        <label key={a} className="flex min-h-10 items-center gap-2.5 rounded-lg border border-line px-3 text-[13px] cursor-pointer">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent-bg)]" checked={!!done[i]} onChange={(e) => setDone({ ...done, [i]: e.target.checked })} />
          <span className={cx(done[i] && 'text-muted line-through')}>{a}</span>
        </label>
      ))}
    </Section>
  );
}

function Messages({ view }: { view: ItemView }) {
  const now = useNow(60_000);
  const [all, setAll] = useState(false);
  const { item, meId } = view;
  const { controls, before: shownBefore, people } = useEarlierToggle(item);
  const name = (id: string) => (id === meId ? 'You' : ([...item.participants, ...people].find((p) => p.id === id)?.name ?? id));
  const title = item.kind === 'email' ? 'Email' : item.kind === 'meeting' ? 'From the transcript' : item.kind === 'dm' || item.kind === 'chat' ? (item.messages.length === 1 ? 'Message' : 'Messages') : 'Latest in the thread';
  if (item.contentExpired)
    return (
      <Section title={title}>
        <div className="flex flex-col gap-1 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <Icon name="clock" size={14} /> Content removed after 30 days
          </span>
          Retention removed the text from the local store. The summary, decision and permalink are kept (FR-12.1).
        </div>
      </Section>
    );
  const shown = all ? item.messages : item.messages.slice(-3);
  const row = (m: Message, muted: boolean) => (
    <div key={m.id} className={cx('flex flex-col gap-0.5 border-t border-line-soft-2 py-2.5 first-of-type:mt-1', muted && 'opacity-75')}>
      <span className="text-xs">
        <strong className="font-semibold">{name(m.authorId)}</strong> <span className="font-mono text-[11px] text-muted">{fmtWhen(m.ts, now)}</span>
      </span>
      <MessageText item={item} meId={meId} people={people} text={m.text} className={cx('text-[13px] leading-normal', muted ? 'text-ink-2' : 'text-ink-strong')} />
    </div>
  );
  const more = item.messageCount - item.messages.length;
  return (
    <Section
      title={title}
      gap="gap-0"
      aside={
        item.messageCount > 3 &&
        (all && more > 0 ? (
          <button type="button" className="min-h-7 px-2 text-[13px] font-medium text-accent hover:underline cursor-pointer" onClick={() => openInSource(view.summary)}>
            {more} more in {SOURCE_NAME[item.source]}
          </button>
        ) : (
          !all && (
            <button type="button" className="min-h-7 rounded-lg px-2 text-[13px] font-medium text-accent hover:bg-accent-wash cursor-pointer" onClick={() => setAll(true)}>
              Show all {item.messageCount}
            </button>
          )
        ))
      }
    >
      {controls && <div className="mt-1">{controls}</div>}
      {shownBefore.map((m) => row(m, true))}
      {shownBefore.length > 0 && <div className="pt-3 pb-1.5 font-mono text-[11px] text-muted">This item</div>}
      {shown.map((m) => row(m, false))}
    </Section>
  );
}

function FileIt({ item, draftsBudgetHit, onFile }: { item: ItemSummary; draftsBudgetHit: boolean; onFile: (t: ActionType) => void }) {
  return (
    <Section title="File it">
      {TYPES.map((t) => {
        const b = draftButton(item, t, draftsBudgetHit);
        const suggested = t === 'vault_note' ? item.triage?.vault : item.triage?.confluence;
        const target = t === 'vault_note' ? item.targetHints.vault : item.targetHints.confluence;
        const hint =
          b.state === 'none'
            ? (b.disabledReason ?? (suggested ? `Suggested by triage${target ? ` · ${target}` : ''}` : 'Not suggested'))
            : b.state === 'ready'
              ? `Draft ready${target ? ` · ${target}` : ''}`
              : b.state === 'stale'
                ? 'Draft out of date: new messages since'
                : b.state === 'done'
                  ? 'Filed'
                  : b.state === 'failed'
                    ? 'The last draft failed'
                    : b.state === 'drafting'
                      ? 'Drafting…'
                      : 'Writing…';
        return (
          <div key={t} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line px-3 py-2.5">
            <BrandIcon brand={t === 'vault_note' ? 'obsidian' : 'confluence'} size={16} decorative />
            <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
              <span className="text-[13px] font-medium">{TYPE_LABEL[t].short}</span>
              <span className="text-xs text-muted">{hint}</span>
            </span>
            <Button className="min-h-9" disabled={!!b.disabledReason && b.state === 'none'} onClick={() => onFile(t)}>
              {b.state === 'none' ? TYPE_LABEL[t].draft : b.state === 'done' ? 'View' : 'Review'}
            </Button>
          </div>
        );
      })}
    </Section>
  );
}

function MetaLine({ view }: { view: ItemView }) {
  const now = useNow(60_000);
  const { decision: d, correction, batch, summary: s } = view;
  let text = '';
  if (s.triage?.by === 'user' && correction) text = `Corrected by you ${fmtWhen(correction.correctedAt, now)} · in the labelled set · revision ${correction.itemRevision}`;
  else if (d?.decidedBy === 'rule') text = `Triaged ${fmtWhen(d.decidedAt, now)} by rule ${d.ruleId} · no model call · revision ${d.itemRevision}`;
  else if (d)
    text = [`Triaged ${fmtWhen(d.decidedAt, now)} by model`, d.model, d.promptVersion, batch && `batch of ${plural(batch.threads, 'thread')}`, `revision ${d.itemRevision}`].filter(Boolean).join(' · ');
  return text ? <div className="pt-1 font-mono text-[11px] text-muted">{text}</div> : null;
}

// ---------- Panel ----------

export function ItemPanel({
  item,
  view,
  pos,
  total,
  filing,
  setFiling,
  draftsBudgetHit,
  onPrev,
  onNext,
  onClose,
  onDoneNext,
  onDirty,
}: {
  item: ItemSummary;
  view?: ItemView;
  pos: number;
  total: number;
  filing?: ActionType;
  setFiling: (t: ActionType | undefined) => void;
  draftsBudgetHit: boolean;
  onPrev: () => void;
  onNext: () => void;
  onClose: () => void;
  onDoneNext: () => void;
  onDirty: (dirty: boolean) => void;
}) {
  const now = useNow();
  const full = usePrefs((s) => s.scope === 'full');
  const [correcting, setCorrecting] = useState(false);
  const [forId, setForId] = useState(item.id);
  if (forId !== item.id) {
    setForId(item.id);
    setCorrecting(false);
  }
  const { open: snoozeOpen, setOpen: setSnoozeOpen, close: closeSnooze, trigger: snoozeTrigger, panel: snoozePanel } = usePopover();
  const { open: moreOpen, setOpen: setMoreOpen, close: closeMore, trigger: moreTrigger, panel: morePanel } = usePopover();
  const body = useRef<HTMLDivElement>(null);
  const filingRef = useRef<HTMLDivElement>(null);
  const open = item.status === 'open';

  const file = (t: ActionType) => {
    if (draftState(item, t) === 'none' && !draftButton(item, t, draftsBudgetHit).disabledReason) void api.requestDraft(item.id, t).catch(errorToast);
    setFiling(t);
  };
  useEffect(() => {
    if (filing) filingRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [filing]);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [item.id]);

  // e Done, ⇧E Done and next, s Snooze, c Correct triage, o open as a full page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'E' && open) {
        e.preventDefault();
        onDoneNext();
      } else if (e.key === 'e' && open) {
        e.preventDefault();
        void markDoneWithUndo(item);
      } else if (e.key === 's' && open) {
        e.preventDefault();
        setSnoozeOpen(true);
      } else if (e.key === 'c') {
        e.preventDefault();
        setCorrecting((c) => !c);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [item, open, onDoneNext, setSnoozeOpen]);

  const reopen = () => void api.reopen(item.id).then(() => toast(item.status === 'snoozed' ? 'Unsnoozed.' : 'Reopened.'), errorToast);
  const ago = fmtAgo(item.lastActivityAt, now);
  // A DM's header names everyone in it, not only who wrote in this item.
  const others = view?.item.id === item.id ? view.members?.filter((m) => m.id !== view.meId) : undefined;
  const group = !!others && others.length > 1;
  const who = others?.length ? others.map((m) => m.name).join(', ') : item.title;

  return (
    <aside aria-label="Item panel" className="flex h-full min-h-0 flex-col border-l border-line bg-surface shadow-[-12px_0_32px_rgba(20,23,28,0.06)]">
      <div className="flex items-center gap-1 border-b border-line-soft px-4 py-2.5">
        <IconButton label="Previous item" title="Previous item (k)" icon="up" onClick={onPrev} disabled={pos <= 1} />
        <IconButton label="Next item" title="Next item (j)" icon="down" onClick={onNext} disabled={pos >= total} />
        <span className="pl-1 font-mono text-xs text-muted" data-testid="panel-pos">
          {pos > 0 ? `${pos} of ${total}` : `${total} in the list`}
        </span>
        <span className="flex-1" />
        <Link to={itemPath(item.id)} aria-label="Open as a full page" title="Open as a full page (o)" className="inline-flex h-9 w-9 items-center justify-center rounded-lg !text-ink-2 hover:bg-track">
          <Icon name="expand" size={17} />
        </Link>
        <IconButton label="Close panel" title="Close panel (Esc)" icon="x" onClick={onClose} />
      </div>

      <div ref={body} className="flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto px-6 pb-6 pt-5">
        <div className="flex flex-wrap items-center gap-2">
          <SourceMark source={item.source} size={20} />
          <span className="min-w-0 flex-[1_1_200px] text-[13px] text-ink-2">
            <strong className="font-semibold text-ink" title={who}>
              {who}
            </strong>{' '}
            · {group ? 'Group DM' : kindLabel(item.kind)} · {ago === 'now' ? 'just now' : /^\d+[mh]$/.test(ago) ? `${ago} ago` : ago}
            {item.source !== 'slack' && <PhaseTag phase="P2" className="ml-2" />}
          </span>
          <Button size="sm" icon="external" onClick={() => openInSource(item)}>
            Open in {SOURCE_NAME[item.source]}
          </Button>
          <div className="relative">
            <IconButton label="More actions" size={32} ref={moreTrigger} active={moreOpen} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
              <MoreIcon />
            </IconButton>
            {moreOpen && (
              <PopoverPanel panelRef={morePanel} label="More actions" role="menu" className="min-w-[230px]">
                <MenuItem onClick={() => (closeMore(), setCorrecting(true))} hint={<Kbd>c</Kbd>}>
                  {item.triageState === 'triaged' ? 'Correct triage…' : 'Set triage…'}
                </MenuItem>
                <MenuItem
                  onClick={() => {
                    closeMore();
                    void navigator.clipboard?.writeText(item.permalink).catch(() => undefined);
                    toast('Permalink copied.');
                  }}
                >
                  Copy link
                </MenuItem>
                {full &&
                  (['Draft reply', 'Create JPD idea', 'Create Jira task'] as const).map((l) => (
                    <MenuItem key={l} tone="future" onClick={() => (closeMore(), phaseToast('P3', l))} hint={<span className="font-mono text-[10px] text-violet-fg">P3</span>}>
                      {l}
                    </MenuItem>
                  ))}
              </PopoverPanel>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h2 className="m-0 text-[19px] font-semibold leading-[1.35]">{item.summary}</h2>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px] text-ink-2">
            <LaneChip lane={item.lane} />
            {item.reason && <span>{item.reason}</span>}
          </div>
          <ItemMarkers item={item} />
        </div>

        {correcting && (
          <CorrectForm
            key={item.id}
            layout="panel"
            item={item}
            onCancel={() => setCorrecting(false)}
            onDone={(n, lane) => {
              setCorrecting(false);
              toast(`Correction saved · moved to ${lane} · labelled set now ${n}`, { tone: 'success' });
            }}
          />
        )}

        <NextStepCard item={item} draftsBudgetHit={draftsBudgetHit} onFile={file} />

        {item.next?.actionItems?.length ? <ActionItems key={item.id} items={item.next.actionItems} /> : null}
        {view ? <Messages key={item.id} view={view} /> : <div className="text-[13px] text-muted">Loading…</div>}

        {filing && view ? (
          <div ref={filingRef} className="flex scroll-mt-4 flex-col gap-2.5 border-t border-line-soft pt-[18px]">
            <div className="flex items-baseline gap-2">
              <h3 className="m-0 flex-1 text-[13px] font-semibold">File it</h3>
              <button type="button" className="inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-accent hover:bg-accent-wash cursor-pointer" onClick={() => setFiling(undefined)}>
                <Icon name="back" size={14} />
                Back to filing options
              </button>
            </div>
            <ActionPanel key={item.id} embedded view={view} type={filing} setType={setFiling} onDirty={onDirty} onDoneNext={onDoneNext} />
          </div>
        ) : (
          <FileIt item={item} draftsBudgetHit={draftsBudgetHit} onFile={file} />
        )}

        {view && <MetaLine view={view} />}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface px-6 py-3">
        {open ? (
          <>
            <Button className="min-h-10 px-3.5" icon="check" onClick={() => void markDoneWithUndo(item)}>
              Done <Kbd>e</Kbd>
            </Button>
            <div className="relative">
              <Button className="min-h-10 px-3.5" icon="clock" ref={snoozeTrigger} aria-haspopup="menu" aria-expanded={snoozeOpen} onClick={() => setSnoozeOpen(!snoozeOpen)}>
                Snooze <Kbd>s</Kbd>
              </Button>
              {snoozeOpen && (
                <PopoverPanel panelRef={snoozePanel} label="Snooze" role="menu" align="left" side="top">
                  <SnoozeMenu
                    now={now}
                    onPick={(iso) => {
                      closeSnooze();
                      void snooze(item, iso);
                    }}
                  />
                </PopoverPanel>
              )}
            </div>
            <span className="flex-1" />
            <Button className="min-h-10 px-3.5" icon="arrow" onClick={onDoneNext}>
              Done and next <Kbd>⇧e</Kbd>
            </Button>
          </>
        ) : (
          <>
            <Button className="min-h-10 px-3.5" icon="undo" onClick={reopen}>
              {item.status === 'snoozed' ? 'Unsnooze' : 'Reopen'}
            </Button>
            <span className="flex-1" />
            <Button className="min-h-10 px-3.5" icon="arrow" onClick={onNext} disabled={pos >= total}>
              Next item <Kbd>j</Kbd>
            </Button>
          </>
        )}
      </div>
    </aside>
  );
}
