import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { Action, ActionType, ConfluenceDraft, Draft, VaultAppendDraft, VaultNewDraft } from '@work-os/shared';
import { api, type ItemView } from '../api';
import { fmtTokens } from '../lib/format';
import { TYPE_LABEL, draftState, type DraftState } from '../lib/lanes';
import { SOURCE_NAME } from '../lib/next';
import { errorToast, toast } from '../store/toasts';
import { Icon } from './icons';
import { itemPath } from './item';
import { Banner, Button, Chip, ConfirmDialog, Spinner, cx } from './ui';

// The draft → review → approve panel (FR-9.x, FR-10.x). Used full width on Item detail and,
// embedded, in the Inbox item panel.

export const TYPES: ActionType[] = ['confluence_entry', 'vault_note'];

/** Accepts the short and long forms used by links: vault, vault_note, confluence, confluence_entry. */
export function parseType(v: string | null): ActionType | undefined {
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
        {!paras.some((p) => p.startsWith('Source:')) && <div className="text-xs text-muted">Source: {SOURCE_NAME[item.source]} {item.title}</div>}
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

export function ActionPanel({
  view,
  type,
  setType,
  onDirty,
  embedded,
  onDoneNext,
}: {
  view: ItemView;
  type: ActionType;
  setType: (t: ActionType) => void;
  onDirty: (dirty: boolean) => void;
  /** Inside the Inbox item panel: a lighter frame, and "Done and next" moves the panel on. */
  embedded?: boolean;
  onDoneNext?: () => void;
}) {
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
          <Banner tone="bad" icon="lock" action={<Link to="/settings/writing" className="text-[13px] font-medium">Settings › Write targets</Link>}>
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
            <strong>Re-drafted after a conflict.</strong> {(view.results[prev.id] ?? prev.error ?? '').replace(/ Re-drafting instead of writing\.$/, '')} Review this new draft before approving.
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
          <Banner tone="bad" icon="lock" action={<Link to="/settings/writing" className="text-[13px] font-medium">Write targets</Link>}>
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
              <Button variant="solid" onClick={() => (onDoneNext ? onDoneNext() : void markDoneAndNext())}>
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
      <div className={cx('flex flex-wrap items-center gap-2 border-t border-line-soft bg-surface-3 py-3.5', embedded ? 'px-4' : 'px-6')}>
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
    <section
      aria-label="Action"
      className={cx(
        'flex min-w-0 flex-col overflow-hidden border bg-surface',
        embedded ? 'rounded-xl border-accent-line-2' : 'flex-[2_1_600px] rounded-[14px] border-accent-line-2 shadow-[0_1px_2px_rgba(20,23,28,0.06),0_12px_32px_rgba(29,78,216,0.10)]',
      )}
    >
      <div className={cx('flex flex-col', embedded ? 'gap-4 px-4 pb-4 pt-4' : 'gap-[18px] px-6 pb-5 pt-[22px]')}>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-[1_1_260px] flex-col gap-0.5">
            <span className="text-xs font-semibold uppercase tracking-[0.06em] text-accent">Action</span>
            <h2 className={cx('m-0 font-semibold tracking-[-0.01em]', embedded ? 'text-base' : 'text-xl')}>{heading}</h2>
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

/** The tab to open: an action in flight first, then the suggested filing (Confluence first), then the vault. */
export function defaultType(view: ItemView): ActionType {
  const s = view.summary;
  return (
    TYPES.find((t) => view.actions.some((a) => a.type === t && ACTIVE.has(a.status))) ??
    TYPES.find((t) => (t === 'vault_note' ? s.triage?.vault : s.triage?.confluence && !s.containsPeopleObservations)) ??
    'vault_note'
  );
}
