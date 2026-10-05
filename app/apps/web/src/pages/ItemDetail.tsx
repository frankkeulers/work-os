import { useEffect, useState, type ReactNode } from 'react';
import { Link, useBlocker, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Action, ActionType, ConfluenceDraft, Draft, VaultAppendDraft, VaultNewDraft } from '@work-os/shared';
import { api, isApiError, type ItemView } from '../api';
import { CorrectForm, SnoozeMenu, SourceIcon, itemPath, markDoneWithUndo, openInSlack } from '../components/ItemCard';
import { Icon, type IconName } from '../components/icons';
import { Banner, Button, Chip, ConfirmDialog, IconButton, PhaseTag, PopoverPanel, Spinner, cx, phaseToast, usePopover } from '../components/ui';
import { useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { fmtAgo, fmtDayDate, fmtIn, fmtTime, fmtTokens, fmtWhen, plural } from '../lib/format';
import { LANE_META, TYPE_LABEL, draftState, type DraftState } from '../lib/lanes';
import { usePrefs } from '../store/prefs';
import { errorToast, toast } from '../store/toasts';

const TYPES: ActionType[] = ['confluence_entry', 'vault_note'];

/** Accepts the short and long forms used by links: vault, vault_note, confluence, confluence_entry. */
function parseType(v: string | null): ActionType | undefined {
  if (v === 'vault' || v === 'vault_note') return 'vault_note';
  if (v === 'confluence' || v === 'confluence_entry') return 'confluence_entry';
  return undefined;
}

const STATUS_BADGE: Record<DraftState, { label: string; cls: string } | null> = {
  none: null,
  drafting: { label: 'Drafting', cls: 'bg-accent-wash text-accent-ink' },
  ready: { label: 'Ready', cls: 'bg-accent-wash text-accent-ink' },
  stale: { label: 'Out of date', cls: 'bg-amber-wash text-amber-fg' },
  writing: { label: 'Writing', cls: 'bg-accent-wash text-accent-ink' },
  done: { label: 'Filed', cls: 'bg-teal-wash-2 text-teal-ink' },
  failed: { label: 'Failed', cls: 'bg-red-line/40 text-red-fg' },
};

const ACTIVE = new Set<Action['status']>(['drafting', 'ready', 'approved', 'executing']);

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
  const others = item.participants.length;
  const reopen = () => void api.reopen(item.id).then(() => toast('Reopened.'), errorToast);
  return (
    <header className="flex flex-wrap items-start gap-4">
      <div className="flex flex-[1_1_420px] flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
          <SourceIcon kind={item.kind} />
          <span className="font-medium">{item.title}</span>
          <span className="text-muted">
            · {item.kind === 'dm' ? 'direct message' : 'thread'} · {plural(others, 'participant')} · {lastActive(item.lastActivityAt, now)}
          </span>
        </div>
        <h1 className="m-0 text-2xl font-semibold leading-[1.3] tracking-[-0.015em]">{s.summary}</h1>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="lg" className="min-h-10 px-3.5 text-[13px] font-normal" icon="external" onClick={() => openInSlack(item)}>
          Open in Slack
        </Button>
        {s.status === 'open' ? (
          <>
            <IconButton label="Done" icon="check" bordered size={40} onClick={() => void markDoneWithUndo(s)} />
            <div className="relative">
              <IconButton label="Snooze" icon="clock" bordered size={40} ref={snoozeTrigger} active={snoozeOpen} aria-haspopup="dialog" aria-expanded={snoozeOpen} onClick={() => setSnoozeOpen(!snoozeOpen)} />
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
          <Button size="lg" className="min-h-10 px-3.5 text-[13px]" icon="undo" onClick={reopen}>
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
          <div className="border-t border-line pt-3.5">
            <CorrectForm inline item={s} onDone={(n, lane) => (setCorrecting(false), toast(`Correction saved · moved to ${lane} · labelled set now ${n}`, { tone: 'success' }))} />
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
    meta = [decision.model, decision.promptVersion?.replace('triage-', 'triage '), batch && `batch ${fmtTime(batch.at)} (${plural(batch.threads, 'thread')}, ${plural(batch.calls, 'call')})`, `revision ${decision.itemRevision}`]
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
          <Button className="ml-2 border-off" onClick={() => setCorrecting(!correcting)} aria-expanded={correcting}>
            {correcting ? 'Close' : 'Correct triage'}
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
        <div className="border-t pt-3.5" style={{ borderColor: m.band.line }}>
          <CorrectForm inline item={s} onDone={(n, lane) => (setCorrecting(false), toast(`Correction saved · moved to ${lane} · labelled set now ${n}`, { tone: 'success' }))} />
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

// ---------- Draft previews ----------

const Inline = ({ text }: { text: string }) => (
  <>
    {text.split(/(`[^`]+`)/g).map((part, i) =>
      part.startsWith('`') && part.endsWith('`') ? (
        <code key={i} className="font-mono text-[13px]">
          {part.slice(1, -1)}
        </code>
      ) : (
        part
      ),
    )}
  </>
);

function ConfluencePreview({ d, item }: { d: ConfluenceDraft; item: ItemView['item'] }) {
  const paras = d.content.split(/\n{2,}/);
  return (
    <div className="rounded-[10px] bg-tray p-5">
      <article className="flex flex-col gap-2.5 rounded-md border border-line bg-surface px-6 py-[22px]">
        <div className="font-mono text-[11px] text-teal">+ new entry</div>
        <div className="text-base font-semibold">{d.title}</div>
        {paras.map((p, i) => (
          <p key={i} className="m-0 whitespace-pre-line text-sm leading-relaxed text-ink-strong">
            <Inline text={p} />
          </p>
        ))}
        {!paras.some((p) => p.startsWith('Source:')) && <div className="text-xs text-muted">Source: Slack {item.title} thread</div>}
      </article>
    </div>
  );
}

function VaultAppendPreview({ d }: { d: VaultAppendDraft }) {
  return (
    <div className="overflow-x-auto rounded-[10px] border border-line bg-surface-3 py-3 font-mono text-[13px] leading-relaxed">
      {d.context.map((l, i) => (
        <div key={`c${i}`} className="whitespace-pre px-4 text-muted">
          {'  '}
          {l}
        </div>
      ))}
      {d.content.split('\n').map((l, i) => (
        <div key={`a${i}`} className="whitespace-pre bg-teal-wash px-4 text-teal-deep">
          + {l}
        </div>
      ))}
    </div>
  );
}

function VaultNewPreview({ d }: { d: VaultNewDraft }) {
  return (
    <pre className="m-0 max-h-[420px] overflow-auto whitespace-pre-wrap rounded-[10px] border border-line bg-surface-3 px-4 py-3 font-mono text-[13px] leading-relaxed text-ink-strong">
      {d.content}
    </pre>
  );
}

function TargetLine({ d, allowListed }: { d: Draft; allowListed: boolean }) {
  if (d.kind === 'confluence')
    return (
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px]">
        <span className="text-muted">Append to</span>
        <span className="font-semibold">{d.pageTitle}</span>
        <span className="text-muted">under</span>
        <span className="font-semibold">{d.section}</span>
        <span className="font-mono text-[11px] text-muted">
          page {d.pageId} · base v{d.baseVersion}
        </span>
        {!allowListed && <span className="sr-only">Not on the allow-list</span>}
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px]">
      <span className="text-muted">{d.kind === 'vault_new' ? 'New note' : 'Append to'}</span>
      <span className="break-all font-mono text-[12px] font-semibold">{d.path}</span>
      {d.kind === 'vault_append' && (
        <>
          <span className="text-muted">under</span>
          <span className="font-semibold">{d.heading}</span>
        </>
      )}
    </div>
  );
}

function SafetyChips({ d, allowListed, dryRun }: { d: Draft; allowListed: boolean; dryRun: boolean }) {
  return (
    <div className="flex flex-wrap gap-2">
      {d.kind === 'confluence' ? (
        <>
          {allowListed ? (
            <Chip tone="ok" icon="check">
              Page on allow-list
            </Chip>
          ) : (
            <Chip tone="bad" icon="alert">
              Page not on allow-list
            </Chip>
          )}
          <Chip icon="lock">Version check at write</Chip>
          <Chip tone="ok" icon="check">
            People check passed
          </Chip>
        </>
      ) : (
        <>
          <Chip tone="ok" icon="check">
            Follows vault conventions
          </Chip>
          <Chip icon="lock">{d.kind === 'vault_append' ? 'File hash check at write' : 'Refuses to overwrite an existing note'}</Chip>
        </>
      )}
      {dryRun && (
        <Chip tone="warn" icon="flask">
          Dry-run: sandbox only
        </Chip>
      )}
      {d.edited && <Chip tone="accent" icon="edit">Edited</Chip>}
    </div>
  );
}

// ---------- Action panel ----------

type Confirm = { title: string; body: string; label: string; danger?: boolean; run: () => void } | null;

function DraftingProgress({ action, view }: { action: Action; view: ItemView }) {
  const p = view.progress[action.id];
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!p) return;
    const tick = () => setElapsed(Math.max(0, Math.round((Date.now() - p.startedAt) / 1000)));
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [p]);
  const stages = p?.stages ?? ['Reading thread', 'Drafting'];
  const stage = p?.stage ?? 0;
  return (
    <div className="flex flex-col gap-4" data-testid="drafting">
      <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
        {stages.map((name, i) => (
          <li key={name} className={cx('flex items-center gap-2.5 text-sm', i > stage ? 'text-muted' : 'text-ink')}>
            <span className="flex h-5 w-5 items-center justify-center">
              {i < stage ? <Icon name="check" size={16} strokeWidth={2.5} className="text-teal" /> : i === stage ? <Spinner size={15} /> : <span className="h-2 w-2 rounded-full bg-line-strong" />}
            </span>
            {name}
            {i === stage && '…'}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={() => void api.cancelDraft(action.id).catch(errorToast)}>Cancel</Button>
        <span className="font-mono text-xs text-muted">{elapsed}s elapsed · usually 30–60 s with the real model</span>
      </div>
    </div>
  );
}

function ActionPanel({ view, type, setType, onDirty }: { view: ItemView; type: ActionType; setType: (t: ActionType) => void; onDirty: (dirty: boolean) => void }) {
  const navigate = useNavigate();
  const { summary: s, item } = view;
  const [editing, setEditing] = useState<{ actionId: string; text: string; original: string } | null>(null);
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [busy, setBusy] = useState(false);

  const latest = view.actions.find((a) => a.type === type);
  const action = latest && latest.status !== 'discarded' ? latest : undefined;
  const draft = action ? view.drafts[action.id] : undefined;
  const prev = action?.supersedes ? view.actions.find((a) => a.id === action.supersedes) : undefined;
  const state = draftState(s, type);
  const peopleBlocked = type === 'confluence_entry' && s.containsPeopleObservations;
  const budgetHit = view.budgets.drafts.hit;
  const allowListed = draft?.kind === 'confluence' ? view.allowListedPageIds.includes(draft.pageId) : true;
  const stale = action?.status === 'ready' && action.itemRevision < item.revision;
  const dirty = !!editing && editing.text !== editing.original;

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const request = (t: ActionType) => run(() => api.requestDraft(item.id, t));
  const guard = (c: NonNullable<Confirm>) => (dirty || draft?.edited ? setConfirm(c) : c.run());
  const redraft = () =>
    action &&
    guard({
      title: 'Re-draft and lose your edits?',
      body: 'A new draft replaces this one, including the changes you made to its text.',
      label: 'Re-draft',
      run: () => (setEditing(null), void run(() => api.redraft(action.id))),
    });
  const discard = () =>
    action &&
    guard({
      title: 'Discard this draft?',
      body: 'The draft and your edits are dropped. Nothing is written. You can draft again later.',
      label: 'Discard',
      danger: true,
      run: () => (setEditing(null), void run(() => api.discardAction(action.id))),
    });

  const markDoneAndNext = async () => {
    try {
      const inbox = await api.getInbox();
      const order = ['now', 'today', 'file'];
      const next = inbox.items.filter((i) => order.includes(i.lane) && i.id !== item.id).sort((a, b) => order.indexOf(a.lane) - order.indexOf(b.lane))[0];
      if (s.status === 'open') await api.markDone(item.id);
      toast(`Done · ${item.title}`, { action: { label: 'Undo', run: () => void api.reopen(item.id).catch(errorToast) } });
      navigate(next ? itemPath(next.id) : '/');
    } catch (e) {
      errorToast(e);
    }
  };

  let heading = `Draft a ${TYPE_LABEL[type].short.toLowerCase().replace('confluence', 'Confluence')}`;
  if (action?.status === 'drafting') heading = `Drafting the ${type === 'vault_note' ? 'vault note' : 'Confluence entry'}`;
  else if (action?.status === 'ready') heading = 'Review and approve the draft';
  else if (action?.status === 'approved' || action?.status === 'executing') heading = 'Writing…';
  else if (action?.status === 'done') heading = view.dryRun ? 'Written to the sandbox' : 'Written';
  else if (action?.status === 'failed') heading = action.failureReason === 'allow_list' ? 'Write refused' : action.failureReason === 'conflict' ? 'Changed since draft' : 'Draft blocked';

  let body: ReactNode;
  if (!action) {
    const hint = type === 'vault_note' ? s.targetHints.vault : s.targetHints.confluence;
    const suggested = type === 'vault_note' ? s.triage?.vault : s.triage?.confluence;
    body = peopleBlocked ? (
      <div className="flex flex-col gap-3">
        <Banner tone="warn" icon="lock">
          <strong>Vault only.</strong> This thread contains observations about named people, so it can’t go to Confluence (FR-10.1). Your private vault is fine.
        </Banner>
        <div>
          <Button variant="solid" disabled={budgetHit || busy} onClick={() => (setType('vault_note'), void request('vault_note'))}>
            Draft vault note instead
          </Button>
        </div>
      </div>
    ) : (
      <div className="flex flex-col gap-3">
        <p className="m-0 text-sm leading-relaxed text-ink-2">
          {suggested ? (
            <>
              Triage suggests filing this{hint ? <> to <strong className="text-ink">{hint}</strong></> : null}. Sonnet drafts it from the thread; nothing is written until you approve.
            </>
          ) : (
            <>Triage didn’t suggest this, but you can still draft one. Nothing is written until you approve.</>
          )}
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="solid" icon={type === 'vault_note' ? 'vault' : 'confluence'} disabled={budgetHit || busy} onClick={() => void request(type)}>
            {TYPE_LABEL[type].draft}
          </Button>
          {budgetHit && <span className="text-xs text-amber-fg">Drafts budget reached for today ({view.budgets.drafts.used}/{view.budgets.drafts.limit}).</span>}
        </div>
      </div>
    );
  } else if (action.status === 'drafting') {
    body = <DraftingProgress action={action} view={view} />;
  } else if (action.status === 'failed') {
    const msg = view.results[action.id] ?? action.error;
    body =
      action.failureReason === 'people_check' ? (
        <div className="flex flex-col gap-3">
          <Banner tone="bad" icon="alert">
            <strong>People check blocked this entry.</strong> {msg}
          </Banner>
          <div className="flex flex-wrap gap-2">
            <Button variant="solid" disabled={budgetHit || busy} onClick={() => (setType('vault_note'), void request('vault_note'))}>
              Draft vault note instead
            </Button>
            <Button onClick={discard}>Dismiss</Button>
          </div>
        </div>
      ) : action.failureReason === 'allow_list' ? (
        <div className="flex flex-col gap-3">
          <Banner tone="bad" icon="lock" action={<Link to="/settings#targets" className="text-[13px] font-medium">Settings › Write targets</Link>}>
            <strong>Not written.</strong> {msg}
          </Banner>
          <div className="flex flex-wrap gap-2">
            <Button disabled={budgetHit || busy} onClick={redraft}>
              Re-draft
            </Button>
            <Button onClick={discard}>Discard</Button>
          </div>
        </div>
      ) : action.failureReason === 'conflict' ? (
        <Banner tone="warn" icon="alert">
          <strong>Changed since draft.</strong> {msg} <Spinner size={12} />
        </Banner>
      ) : (
        <div className="flex flex-col gap-3">
          <Banner tone="bad" icon="alert">
            <strong>The model didn’t return a usable draft.</strong> {msg}
          </Banner>
          <div className="flex flex-wrap gap-2">
            <Button variant="solid" disabled={budgetHit || busy} onClick={redraft}>
              Retry
            </Button>
            <Button onClick={discard}>Discard</Button>
          </div>
        </div>
      );
  } else if (draft) {
    const isEditing = editing?.actionId === action.id;
    body = (
      <div className="flex flex-col gap-3.5">
        <TargetLine d={draft} allowListed={allowListed} />
        <SafetyChips d={draft} allowListed={allowListed} dryRun={view.dryRun} />
        {prev?.failureReason === 'conflict' && action.status === 'ready' && (
          <Banner tone="info" icon="info">
            Re-drafted after a conflict: {view.results[prev.id] ?? prev.error}
          </Banner>
        )}
        {stale && (
          <Banner
            tone="warn"
            icon="info"
            action={
              <Button size="sm" disabled={budgetHit || busy} onClick={redraft}>
                Re-draft
              </Button>
            }
          >
            <strong>New replies since this draft</strong> (revision {action.itemRevision} → {item.revision}). You can still approve it as it is.
          </Banner>
        )}
        {!allowListed && action.status === 'ready' && (
          <Banner tone="bad" icon="lock" action={<Link to="/settings#targets" className="text-[13px] font-medium">Write targets</Link>}>
            Page {draft.kind === 'confluence' && draft.pageId} isn’t on the Confluence allow-list. The executor will refuse this write.
          </Banner>
        )}
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <label className="text-xs font-medium text-ink-2" htmlFor="draft-editor">
              Draft text
            </label>
            <textarea
              id="draft-editor"
              className="min-h-[260px] w-full resize-y rounded-[10px] border border-line-strong bg-surface p-3.5 font-mono text-[13px] leading-relaxed text-ink outline-none focus:border-accent"
              value={editing.text}
              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            />
          </div>
        ) : draft.kind === 'confluence' ? (
          <ConfluencePreview d={draft} item={item} />
        ) : draft.kind === 'vault_append' ? (
          <VaultAppendPreview d={draft} />
        ) : (
          <VaultNewPreview d={draft} />
        )}
        {action.status === 'done' && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-[10px] border border-teal-line bg-teal-wash px-4 py-3 text-[13px] text-teal-ink">
            <Icon name="check" strokeWidth={2.5} />
            <span className="min-w-0 flex-[1_1_300px] text-ink">{view.results[action.id]}</span>
            {s.status === 'open' && (
              <Button variant="solid" onClick={() => void markDoneAndNext()}>
                Mark done and next item
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  const footer =
    action && draft && (action.status === 'ready' || action.status === 'approved' || action.status === 'executing') ? (
      <div className="flex flex-wrap items-center gap-2 border-t border-line-soft bg-surface-3 px-6 py-3.5">
        {editing?.actionId === action.id ? (
          <>
            <Button
              variant="solid"
              disabled={busy || !dirty}
              onClick={() =>
                void run(async () => {
                  await api.saveDraftEdit(action.id, editing.text);
                  setEditing(null);
                  toast('Edits saved. The draft is marked as edited.');
                })
              }
            >
              Save edits
            </Button>
            <Button onClick={() => (dirty ? setConfirm({ title: 'Discard your edits?', body: 'The draft goes back to the last saved text.', label: 'Discard edits', run: () => setEditing(null) }) : setEditing(null))}>Cancel</Button>
          </>
        ) : (
          <>
            <Button variant="solid" size="lg" icon={action.status === 'ready' ? 'check' : undefined} disabled={busy || action.status !== 'ready'} onClick={() => void run(() => api.approveAction(action.id))}>
              {action.status === 'ready' ? (
                view.dryRun ? (
                  'Approve and write to sandbox'
                ) : (
                  'Approve and write'
                )
              ) : (
                <>
                  <Spinner /> {action.status === 'approved' ? 'Approved…' : 'Writing…'}
                </>
              )}
            </Button>
            <Button disabled={action.status !== 'ready'} onClick={() => setEditing({ actionId: action.id, text: draft.content, original: draft.content })}>
              Edit text
            </Button>
            <Button disabled={action.status !== 'ready' || budgetHit || busy} onClick={redraft} title={budgetHit ? 'Drafts budget reached for today' : undefined}>
              Re-draft
            </Button>
            <Button disabled={action.status !== 'ready'} onClick={discard}>
              Discard
            </Button>
          </>
        )}
        <span className="flex-1" />
        <span className="font-mono text-[11px] text-muted">
          {draft.model} · {Math.round(draft.durationMs / 1000)}s · {fmtTokens(draft.tokens)} tokens
        </span>
      </div>
    ) : null;

  return (
    <section aria-label="Action" className="flex min-w-0 flex-[2_1_600px] flex-col overflow-hidden rounded-[14px] border border-accent-line-2 bg-surface shadow-[0_1px_2px_rgba(20,23,28,0.06),0_12px_32px_rgba(29,78,216,0.10)]">
      <div className="flex flex-col gap-[18px] px-6 pb-5 pt-[22px]">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-[1_1_260px] flex-col gap-0.5">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-accent">Action</span>
            <h2 className="m-0 text-xl font-semibold tracking-[-0.01em]">{heading}</h2>
          </div>
          <div role="tablist" aria-label="Draft target" className="inline-flex gap-1 rounded-[10px] bg-track-2 p-1">
            {TYPES.map((t) => {
              const on = t === type;
              const badge = STATUS_BADGE[draftState(s, t)];
              return (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  disabled={!!editing && !on}
                  onClick={() => setType(t)}
                  className={cx(
                    'inline-flex min-h-9 items-center gap-1.5 rounded-[7px] px-3.5 text-[13px] font-semibold cursor-pointer disabled:cursor-not-allowed disabled:opacity-60',
                    on ? 'bg-seg-on text-accent shadow-[0_1px_2px_rgba(20,23,28,0.12)]' : 'text-ink-2',
                  )}
                >
                  {t === 'confluence_entry' && s.containsPeopleObservations && <Icon name="lock" size={12} />}
                  {TYPE_LABEL[t].short}
                  {badge && <span className={cx('rounded px-1.5 py-px text-[10px] font-semibold', badge.cls)}>{badge.label}</span>}
                </button>
              );
            })}
          </div>
        </div>
        {state === 'none' && latest?.status === 'discarded' && <div className="-mt-2 text-xs text-muted">The last draft was discarded.</div>}
        {body}
      </div>
      {footer}
      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm.run();
            setConfirm(null);
          }}
        />
      )}
    </section>
  );
}

// ---------- Aside ----------

function Thread({ view }: { view: ItemView }) {
  const now = useNow();
  const { item, meId } = view;
  const name = (id: string) => (id === meId ? 'You' : (item.participants.find((p) => p.id === id)?.name ?? id));
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
        item.messages.map((m, i) => {
          const n = name(m.authorId);
          const gap = i > 0 && shown < item.messageCount && i === Math.ceil(shown / 2);
          return (
            <div key={m.id} className="flex flex-col gap-3">
              {gap && <div className="text-center font-mono text-[11px] text-muted">· · · {item.messageCount - shown} more in Slack · · ·</div>}
              <div className="flex gap-2.5">
                <div aria-hidden="true" className={cx('flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold', n === 'You' ? 'bg-accent-wash text-accent-ink' : 'bg-track text-ink-2')}>
                  {initials(n)}
                </div>
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-baseline gap-2">
                    <span className="text-[13px] font-semibold">{n}</span>
                    <span className="font-mono text-[11px] text-muted">{fmtWhen(m.ts, now)}</span>
                  </div>
                  <div className="text-[13px] leading-normal text-ink-2">{m.text}</div>
                </div>
              </div>
            </div>
          );
        })
      )}
      <button type="button" className="self-start text-[13px] font-medium text-accent hover:underline cursor-pointer" onClick={() => openInSlack(item)}>
        Open full thread in Slack
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

/** The tab to open: an action in flight first, then the suggested filing (Confluence first), then the vault. */
function defaultType(view: ItemView): ActionType {
  const s = view.summary;
  return (
    TYPES.find((t) => view.actions.some((a) => a.type === t && ACTIVE.has(a.status))) ??
    TYPES.find((t) => (t === 'vault_note' ? s.triage?.vault : s.triage?.confluence && !s.containsPeopleObservations)) ??
    'vault_note'
  );
}

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
        <Link to="/" className="inline-flex min-h-9 items-center gap-1.5 self-start text-[13px] no-underline">
          <Icon name="back" /> Back to inbox
        </Link>
        {children}
      </div>
    </div>
  );
}
