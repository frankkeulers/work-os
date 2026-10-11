import { useEffect, useState, type ReactNode } from 'react';
import { Link, useBlocker, useParams, useSearchParams } from 'react-router';
import type { ActionType, Message } from '@work-os/shared';
import { api, isApiError, type ItemView } from '../api';
import { ActionPanel, defaultType, parseType } from '../components/ActionPanel';
import { SourceMark } from '../components/BrandIcon';
import { CategoryTags, CorrectForm, OnCalendar, SnoozeMenu, kindLabel, markDoneWithUndo, openInSource, ruleOverride } from '../components/item';
import { Icon, type IconName } from '../components/icons';
import { useEarlierToggle } from '../components/Earlier';
import { MessageText, Recipients } from '../components/SlackText';
import { Banner, Button, ConfirmDialog, IconButton, PhaseTag, PopoverPanel, Spinner, cx, phaseToast, usePopover } from '../components/ui';
import { useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { fmtAgo, fmtDayDate, fmtIn, fmtTime, fmtWhen, plural } from '../lib/format';
import { LANE_META } from '../lib/lanes';
import { SOURCE_NAME } from '../lib/next';
import { usePrefs } from '../store/prefs';
import { errorToast, toast } from '../store/toasts';
import { NotificationBell } from '../components/NotificationBell';

// ---------- Header ----------

function lastActive(iso: string, now: Date) {
  const ago = fmtAgo(iso, now);
  if (ago === 'now') return 'active just now';
  return /^\d+[mh]$/.test(ago) ? `${ago} ago` : `last active ${ago}`;
}

function Header({ view }: { view: ItemView }) {
  const now = useNow();
  const { summary: s, item } = view;
  const { open: snoozeOpen, setOpen: setSnoozeOpen, close: closeSnooze, trigger: snoozeTrigger, panel: snoozePanel } = usePopover();
  // A DM names everyone in it, as in the item panel; otherwise who wrote.
  const members = view.members?.filter((m) => m.id !== view.meId);
  const group = !!members && members.length > 1;
  const who = members?.length ? members.map((m) => m.name).join(', ') : s.title;
  const others = view.members?.length ?? item.participants.length;
  const reopen = () => void api.reopen(item.id).then(() => toast('Reopened.'), errorToast);
  return (
    <header className="flex flex-wrap items-start gap-4">
      <div className="flex flex-[1_1_420px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <SourceMark source={item.source} size={16} />
          <span className="font-medium">{who}</span>
          <span className="text-muted">
            · {group ? 'group DM' : item.kind === 'dm' ? 'direct message' : kindLabel(item.kind).toLowerCase()} · {plural(others, view.members ? 'member' : 'participant')} · {lastActive(item.lastActivityAt, now)}
          </span>
        </div>
        <h1 className="m-0 text-2xl font-semibold leading-[1.3] tracking-[-0.015em]">{s.summary}</h1>
        {item.source === 'wispr' && item.meeting?.calendar && <OnCalendar calendar={item.meeting.calendar} />}
        {view.calendarCategories && <CategoryTags tags={view.calendarCategories} />}
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button icon="external" onClick={() => openInSource(s)}>
          Open in {SOURCE_NAME[item.source]}
        </Button>
        {s.status === 'open' ? (
          <>
            <IconButton label="Done" icon="check" bordered size={36} onClick={() => void markDoneWithUndo(s)} />
            <div className="relative">
              <IconButton label="Snooze" icon="clock" bordered size={36} ref={snoozeTrigger} active={snoozeOpen} aria-haspopup="dialog" aria-expanded={snoozeOpen} onClick={() => setSnoozeOpen(!snoozeOpen)} />
              {snoozeOpen && (
                <PopoverPanel panelRef={snoozePanel} label="Snooze" role="menu">
                  <SnoozeMenu
                    now={now}
                    onPick={async (iso) => {
                      closeSnooze();
                      try {
                        await api.snooze(item.id, iso);
                        toast(`Snoozed until ${fmtDayDate(iso)} ${fmtTime(iso)}`, { action: { label: 'Undo', run: reopen } });
                      } catch (e) {
                        errorToast(e);
                      }
                    }}
                  />
                </PopoverPanel>
              )}
            </div>
          </>
        ) : (
          <Button icon="undo" onClick={reopen}>
            {s.status === 'snoozed' ? 'Unsnooze' : 'Reopen'}
          </Button>
        )}
      </div>
    </header>
  );
}

function StatusNote({ view }: { view: ItemView }) {
  const s = view.summary;
  if (s.status === 'done' && s.doneAt)
    return (
      <Banner tone="ok" icon="check">
        Marked done {fmtDayDate(s.doneAt)} at {fmtTime(s.doneAt)}. It comes back if someone other than you replies.
      </Banner>
    );
  if (s.status === 'snoozed' && s.snoozedUntil)
    return (
      <Banner tone="info" icon="clock">
        Snoozed until {fmtDayDate(s.snoozedUntil)} {fmtTime(s.snoozedUntil)}. It comes back early if a new reply makes it Now.
      </Banner>
    );
  return null;
}

// ---------- Triage band ----------

function TriageBand({ view }: { view: ItemView }) {
  const now = useNow(5_000);
  const [correcting, setCorrecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const { summary: s, decision, correction, batch, item } = view;
  const t = s.triage;

  if (!t || s.triageState !== 'triaged') {
    const failed = s.triageState === 'failed';
    return (
      <section aria-label="Triage decision" className={cx('flex flex-col gap-3 rounded-xl border px-5 py-[18px]', failed ? 'border-red-line bg-surface' : 'border-line-strong bg-surface-2')}>
        <div className="flex flex-wrap items-center gap-x-5 gap-y-3">
          <span className={cx('inline-flex min-h-10 items-center gap-2 rounded-lg px-3.5 text-base font-semibold text-on-solid', failed ? 'bg-red' : 'bg-gray-solid')}>{failed ? 'Failed' : 'Not triaged yet'}</span>
          <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
            <div className="text-[17px] font-semibold">{failed ? 'Triage failed. Shown untriaged.' : s.modelPaused ? 'Model triage paused: budget reached.' : 'Waiting for the quiet window.'}</div>
            <div className="text-[13px] text-ink-2">
              {failed
                ? 'The model’s output was invalid twice. Retry, or set the triage yourself.'
                : s.modelPaused
                  ? 'Rules still run. Model triage resumes tomorrow, or when the budget is raised.'
                  : s.quietUntil && Date.parse(s.quietUntil) > now.getTime()
                    ? `The thread is still active. Triage runs once it has been quiet, ${fmtIn(s.quietUntil, now)}.`
                    : 'Quiet now. It is triaged on the next poll.'}
            </div>
          </div>
          {failed && (
            <Button
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                await api.retryTriage(item.id).catch(errorToast);
                setBusy(false);
              }}
            >
              {busy ? <Spinner size={12} /> : null} Retry triage
            </Button>
          )}
          <Button onClick={() => setCorrecting(!correcting)} aria-expanded={correcting}>
            {correcting ? 'Close' : 'Set triage'}
          </Button>
        </div>
        {correcting && (
          <div className="rounded-xl bg-surface">
            <CorrectForm layout="panel" item={s} onCancel={() => setCorrecting(false)} onDone={(n, lane) => (setCorrecting(false), toast(`Correction saved · moved to ${lane} · labelled set now ${n}`, { tone: 'success' }))} />
          </div>
        )}
      </section>
    );
  }

  const laneKey = t.attention === 'now' ? 'now' : t.attention === 'today' ? 'today' : t.confluence || t.vault ? 'file' : 'else';
  const m = LANE_META[laneKey];
  const reason = t.by === 'user' ? 'You set this triage. It stands until the thread gets new replies.' : (decision?.reason ?? s.reason);
  let meta: string;
  if (t.by === 'user' && correction) meta = `corrected by you ${fmtWhen(correction.correctedAt, now)} · in the labelled set · revision ${correction.itemRevision}`;
  else if (decision?.decidedBy === 'rule') meta = `rule ${decision.ruleId} · no model call · revision ${decision.itemRevision}`;
  else if (decision)
    meta = [ruleOverride(decision), decision.model, decision.promptVersion?.replace('triage-', 'triage '), batch && `batch ${fmtTime(batch.at)} (${plural(batch.threads, 'thread')}, ${plural(batch.calls, 'call')})`, `revision ${decision.itemRevision}`]
      .filter(Boolean)
      .join(' · ');
  else meta = '';

  return (
    <section aria-label="Triage decision" className="flex flex-col gap-3.5 rounded-xl border px-5 py-[18px]" style={{ background: m.band.bg, borderColor: m.band.line }}>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-3.5">
        <div className="flex min-w-0 flex-[1_1_420px] items-center gap-3.5">
          <span className="inline-flex min-h-10 shrink-0 items-center gap-2 rounded-lg px-3.5 text-base font-semibold text-on-solid" style={{ background: m.band.badge }}>
            {m.name}
          </span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="text-[17px] font-semibold tracking-[-0.01em]">{m.headline}</div>
            <div className="text-[13px] leading-[1.45] text-ink-2">{reason}</div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-ink-2">File to</span>
          {t.confluence && <FileChip icon="confluence" line={m.band.line} label="Confluence" />}
          {t.vault && <FileChip icon="vault" line={m.band.line} label="Vault" />}
          {!t.confluence && !t.vault && <span className="text-xs text-muted">nowhere</span>}
          <Button variant="ghost" size="sm" className="ml-2" onClick={() => setCorrecting(!correcting)} aria-expanded={correcting}>
            Correct triage
          </Button>
        </div>
      </div>
      {s.correctedFrom && (
        <div className="text-xs text-ink-2">
          <Icon name="info" size={12} className="mr-1 inline align-[-1px]" />
          Re-triaged after new replies. You had set {s.correctedFrom === 'none' ? 'None' : s.correctedFrom === 'now' ? 'Now' : 'Today'}.
        </div>
      )}
      {correcting && (
        <div className="rounded-xl bg-surface">
          <CorrectForm layout="panel" item={s} onCancel={() => setCorrecting(false)} onDone={(n, lane) => (setCorrecting(false), toast(`Correction saved · moved to ${lane} · labelled set now ${n}`, { tone: 'success' }))} />
        </div>
      )}
      <div className="font-mono text-[11px] text-muted">{meta}</div>
    </section>
  );
}

function FileChip({ icon, label, line }: { icon: IconName; label: string; line: string }) {
  return (
    <span className="inline-flex min-h-[30px] items-center gap-1.5 rounded-full border bg-surface px-2.5 text-xs font-medium" style={{ borderColor: line }}>
      <Icon name={icon} size={14} />
      {label}
    </span>
  );
}

// ---------- Aside ----------

function Thread({ view }: { view: ItemView }) {
  const now = useNow();
  const { item, meId } = view;
  const { controls, before, people } = useEarlierToggle(item);
  const name = (id: string) => (id === meId ? 'You' : ([...item.participants, ...people].find((p) => p.id === id)?.name ?? id));
  const initials = (n: string) =>
    n === 'You'
      ? 'FK'
      : n
          .replace(/[^\p{L} ]/gu, '')
          .split(/\s+/)
          .map((w) => w[0])
          .join('')
          .slice(0, 2)
          .toUpperCase();
  const shown = item.messages.length;
  const message = (m: Message) => {
    const n = name(m.authorId);
    return (
      <div className="flex gap-2.5">
        <div aria-hidden="true" className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', n === 'You' ? 'bg-accent-wash text-accent-ink' : 'bg-track text-ink-2')}>
          {initials(n)}
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-baseline gap-2">
            <span className="text-[13px] font-semibold">{n}</span>
            <span className="font-mono text-[11px] text-muted">{fmtWhen(m.ts, now)}</span>
          </div>
          <Recipients m={m} name={name} />
          <MessageText item={item} meId={meId} people={people} text={m.text} className="text-[13px] leading-normal text-ink-2" />
        </div>
      </div>
    );
  };
  return (
    <section aria-label="Thread" className="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4">
      <div className="flex items-baseline gap-2">
        <h2 className="m-0 flex-1 text-[15px] font-semibold">Thread</h2>
        {!item.contentExpired && <span className="font-mono text-[11px] text-muted">{shown === item.messageCount ? plural(item.messageCount, 'message') : `${shown} of ${item.messageCount} messages`}</span>}
      </div>
      {item.contentExpired ? (
        <div className="flex flex-col gap-1.5 rounded-lg bg-surface-2 px-3 py-2.5 text-[13px] text-ink-2">
          <span className="flex items-center gap-1.5 font-medium text-ink">
            <Icon name="clock" size={14} /> Content removed after {30} days
          </span>
          Retention removed the thread text from the local store. The summary, decision and permalink are kept (FR-12.1).
        </div>
      ) : (
        <>
          {controls}
          {before.map((m) => (
            <div key={m.id} className="opacity-75">
              {message(m)}
            </div>
          ))}
          {before.length > 0 && <div className="border-t border-line-soft pt-2 font-mono text-[11px] text-muted">This item</div>}
          {item.messages.map((m, i) => {
            const gap = i > 0 && shown < item.messageCount && i === Math.ceil(shown / 2);
            return (
              <div key={m.id} className="flex flex-col gap-3">
                {gap && <div className="text-center font-mono text-[11px] text-muted">· · · {item.messageCount - shown} more in {SOURCE_NAME[item.source]} · · ·</div>}
                {message(m)}
              </div>
            );
          })}
        </>
      )}

      <button type="button" className="self-start text-[13px] font-medium text-accent hover:underline cursor-pointer" onClick={() => openInSource(view.summary)}>
        Open in {SOURCE_NAME[item.source]}
      </button>
    </section>
  );
}

function FuturePanels() {
  return (
    <>
      <section aria-label="Related (P4)" className="flex flex-col gap-2.5 rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-wash p-4">
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex-1 text-[15px] font-semibold">Related</h2>
          <PhaseTag phase="P4" />
        </div>
        {['Vault · Insights APIs v2', 'Outlook · Customer question on IMO formats', 'Confluence · Insights APIs › Decisions'].map((l) => (
          <button key={l} type="button" className="text-left text-[13px] text-violet-fg hover:underline cursor-pointer" onClick={() => phaseToast('P4', 'Related items')}>
            {l}
          </button>
        ))}
      </section>
      <section aria-label="Other actions (P3)" className="flex flex-col gap-2.5 rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-wash p-4">
        <div className="flex items-center gap-2">
          <h2 className="m-0 flex-1 text-[15px] font-semibold">Other actions</h2>
          <PhaseTag phase="P3" />
        </div>
        <div className="flex flex-wrap gap-2">
          {['Draft reply', 'Create JPD idea', 'Create Jira task', 'Queue for 17:00 batch'].map((l) => (
            <Button key={l} variant="future" onClick={() => phaseToast('P3', l)}>
              {l}
            </Button>
          ))}
        </div>
      </section>
    </>
  );
}

// ---------- Page ----------

export function ItemDetailPage() {
  const params = useParams();
  const id = params.id ?? '';
  const [search, setSearch] = useSearchParams();
  const full = usePrefs((s) => s.scope === 'full');
  const q = useApiQuery(() => api.getItem(id), (n) => (n.topic === 'item' && n.id === id) || n.topic === 'settings' || n.topic === 'usage', [id]);
  const [dirty, setDirty] = useState(false);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);

  const view = q.data;
  const requested = parseType(search.get('draft'));

  // ?draft=… starts a draft once, then the link becomes ?tab=… so a refresh doesn't draft again.
  useEffect(() => {
    if (!requested || !id) return;
    setSearch({ tab: requested === 'vault_note' ? 'vault' : 'confluence' }, { replace: true });
    void api.requestDraft(id, requested).catch(errorToast);
  }, [requested, id, setSearch]);

  // Pin the opening tab in the URL so it doesn't jump when an action finishes.
  const tabParam = parseType(search.get('tab')) ?? requested;
  useEffect(() => {
    if (view && !tabParam) setSearch({ tab: defaultType(view) === 'vault_note' ? 'vault' : 'confluence' }, { replace: true });
  }, [view, tabParam, setSearch]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  useEffect(() => {
    if (view) document.title = `${view.item.title} · Work OS`;
  }, [view]);

  if (q.error && isApiError(q.error) && q.error.code === 'not_found')
    return (
      <Frame>
        <div className="rounded-xl border border-line bg-surface p-8">
          <h1 className="m-0 text-xl font-semibold">This item no longer exists</h1>
          <p className="text-sm text-ink-2">It may have been removed by a state reset. Head back to the inbox.</p>
        </div>
      </Frame>
    );
  if (!view) return <Frame>{q.error ? <div className="text-muted">Could not load this item.</div> : <div className="text-muted">Loading…</div>}</Frame>;

  const s = view.summary;
  const type = tabParam ?? defaultType(view);
  const setType = (t: ActionType) => setSearch({ tab: t === 'vault_note' ? 'vault' : 'confluence' }, { replace: true });

  return (
    <Frame>
      <Header view={view} />
      <StatusNote view={view} />
      <TriageBand view={view} />
      <div className="flex flex-wrap items-start gap-7">
        <ActionPanel key={s.id} view={view} type={type} setType={setType} onDirty={setDirty} />
        <aside aria-label="Additional context" className="flex min-w-0 flex-[1_1_320px] flex-col gap-4">
          <div className="text-xs font-semibold uppercase tracking-[0.06em] text-muted">Additional context</div>
          <Thread view={view} />
          {full && <FuturePanels />}
        </aside>
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
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-bg">
      <div className="mx-auto flex max-w-[1360px] flex-col gap-[18px] px-8 pb-12 pt-5">
        <div className="flex items-center gap-2">
          <Link to="/" className="inline-flex min-h-9 items-center gap-1.5 text-[13px] no-underline">
            <Icon name="back" /> Back to inbox
          </Link>
          <span className="flex-1" />
          <NotificationBell />
        </div>
        {children}
      </div>
    </div>
  );
}
