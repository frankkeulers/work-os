import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { currentAction, entryVersion, isFiledDraft, type Action, type ActionType, type ConfluenceDraft, type ConfluenceFiledDraft, type Draft, type VaultFiledDraft, type VaultMultiDraft } from '@work-os/shared';
import { api, type ItemView } from '../api';
import { useOnline } from '../hooks/useConnection';
import { fmtTokens } from '../lib/format';
import { confluencePageUrl, obsidianNoteUrl } from '../lib/links';
import { TYPE_LABEL, draftState, type DraftState } from '../lib/lanes';
import { SOURCE_NAME } from '../lib/next';
import { forgetEdit, keepEdit, keptEdit } from '../store/draftEdits';
import { errorToast, toast } from '../store/toasts';
import { BrandIcon } from './BrandIcon';
import { GuideLink } from './GuideLink';
import { Icon } from './icons';
import { itemPath } from './item';
import type { DocMode } from './MarkdownDoc';
import { Banner, Button, ConfirmDialog, Segmented, Spinner, cx } from './ui';

// The draft → review → approve panel (FR-9.x, FR-10.x). Used full width on Item detail and,
// embedded, inside the Next step card of the Inbox item panel.

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

/** A link styled as a secondary button. */
const linkButton =
  'inline-flex min-h-9 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-3 text-[13px] font-medium !text-ink no-underline hover:bg-surface-2';

// ---------- Draft previews ----------

const MarkdownDoc = lazy(() => import('./MarkdownDoc'));

/** Plain paragraphs while the editor's code loads. */
function PlainText({ text }: { text: string }) {
  return (
    <div className="flex flex-col gap-2.5">
      {text.split(/\n{2,}/).map((p, i) => (
        <p key={i} className="m-0 whitespace-pre-line text-sm leading-relaxed text-ink-strong">
          {p.split(/(`[^`]+`)/g).map((part, j) =>
            part.startsWith('`') && part.endsWith('`') ? (
              <code key={j} className="font-mono text-[13px]">
                {part.slice(1, -1)}
              </code>
            ) : (
              part
            ),
          )}
        </p>
      ))}
    </div>
  );
}

type DocProps = { value: string; editing: boolean; onChange: (md: string) => void; mode: DocMode; label?: string };

function Doc({ label = 'Draft text', ...props }: Omit<DocProps, 'onChange'> & { onChange?: DocProps['onChange']; label?: string }) {
  return (
    <Suspense fallback={<PlainText text={props.value} />}>
      <MarkdownDoc label={label} {...props} />
    </Suspense>
  );
}

type FrameProps = Omit<Parameters<typeof DraftFrame>[0], 'label' | 'className' | 'children' | 'context'>;

function ConfluencePreview({ d, item, doc, frame }: { d: ConfluenceDraft; item: ItemView['item']; doc: DocProps; frame: FrameProps }) {
  return (
    <div className="rounded-[10px] bg-tray p-4">
      <DraftFrame {...frame} label="+ new entry" className="rounded-md border border-line bg-surface px-5 pb-5 pt-3">
        <div className="flex flex-col gap-2.5">
          <div className="text-base font-semibold">{d.title}</div>
          <Doc {...doc} />
          {!/^\W*Source:/m.test(doc.value) && <div className="text-xs text-muted">Source: {SOURCE_NAME[item.source]} {item.title}</div>}
        </div>
      </DraftFrame>
    </div>
  );
}

/**
 * The lines an append adds, under the note's existing lines (faded) so you see where they land.
 * A teal bar marks what's new, in both views and while editing.
 */
function VaultAppendDoc({ context, doc, frame }: { context: string[]; doc: DocProps; frame: FrameProps }) {
  return (
    <DraftFrame
      {...frame}
      label="+ new lines"
      className="rounded-[10px] border border-line bg-surface px-5 pb-4 pt-2.5"
      context={
        context.length > 0 && (
          <div className="opacity-60">
            <Doc label="Existing lines" value={context.join('\n')} editing={false} mode={doc.mode} />
          </div>
        )
      }
    >
      <div className={cx('border-l-[3px] border-teal pl-3', !doc.editing && 'rounded-r-md bg-teal-wash py-2 pr-3')}>
        <Doc {...doc} />
      </div>
    </DraftFrame>
  );
}

function VaultDoc({ doc, frame }: { doc: DocProps; frame: FrameProps }) {
  return (
    <DraftFrame {...frame} label="+ new note" className="rounded-[10px] border border-line bg-surface px-5 pb-4 pt-2.5">
      <Doc {...doc} />
    </DraftFrame>
  );
}

/**
 * A thread or meeting filed into several notes (FR-9.7): each note with where it lands and its own
 * text to read and edit. Approving writes them all.
 */
function VaultMultiDoc({ d, doc, frame, links }: { d: VaultMultiDraft; doc: (part: number) => DocProps; frame: (part: number) => FrameProps; links: TargetLinks }) {
  return (
    <ol className="m-0 flex list-none flex-col gap-4 p-0" aria-label="Notes in this draft">
      {d.parts.map((p, i) => (
        <li key={`${p.path}#${i}`} className="flex flex-col gap-2">
          <NoteTarget kind={p.kind} path={p.path} heading={p.kind === 'append' ? p.heading : undefined} links={links} />
          {p.kind === 'append' ? <VaultAppendDoc context={p.context} doc={doc(i)} frame={frame(i)} /> : <VaultDoc doc={doc(i)} frame={frame(i)} />}
        </li>
      ))}
    </ol>
  );
}

/** Names one note's text, so each reads apart from the others. */
const partLabel = (p: VaultMultiDraft['parts'][number]) => `Draft text for ${p.path}${p.kind === 'append' ? ` under ${p.heading.replace(/^#+\s*/, '')}` : ''}`;

/** Nothing to file (FR-9.6, FR-10.7): the check found the note or section that already holds it. */
function FiledDoc({ d }: { d: VaultFiledDraft | ConfluenceFiledDraft }) {
  return (
    <div className="flex items-start gap-2.5 rounded-[10px] border border-line bg-surface px-5 py-4 text-sm leading-relaxed text-ink-strong">
      <Icon name="check" size={16} strokeWidth={2.5} className="mt-0.5 shrink-0 text-teal-ink" />
      <p className="m-0">
        <strong>Nothing new to file.</strong> {d.why}
      </p>
    </div>
  );
}

/** A link out to the page or note. Confluence opens in a new tab; obsidian:// hands over to the app. */
function TargetLink({ href, title, children }: { href: string; title: string; children: ReactNode }) {
  const web = href.startsWith('http');
  return (
    <a
      href={href}
      title={title}
      target={web ? '_blank' : undefined}
      rel={web ? 'noreferrer' : undefined}
      className="inline-flex min-w-0 items-center gap-1 font-semibold underline decoration-accent/35 decoration-1 underline-offset-[3px] hover:decoration-accent"
    >
      <span className="min-w-0 break-all">{children}</span>
      <Icon name="external" size={12} className="shrink-0" />
    </a>
  );
}

/** "under <heading>", kept together so the line wraps before it rather than inside it. The heading's
 *  markdown hashes are dropped: they're how it's stored, not what it's called. */
function Under({ heading }: { heading: string }) {
  return (
    <span className="min-w-0">
      <span className="text-muted">under</span> <span className="font-semibold">{heading.replace(/^#+\s*/, '')}</span>
    </span>
  );
}

function TargetLine({ d, inScope, links }: { d: Draft; inScope: boolean; links: TargetLinks }) {
  if (d.kind === 'confluence' || d.kind === 'confluence_filed')
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
        <span className="text-muted">{d.kind === 'confluence_filed' ? 'Already on' : 'Append to'}</span>
        <BrandIcon brand="confluence" size={14} decorative />
        <TargetLink href={links.page(d.pageId)} title={`Open page ${d.pageId} in Confluence`}>
          {d.pageTitle}
        </TargetLink>
        <Under heading={d.section} />
        {!inScope && <span className="sr-only">Excluded from the Confluence scope</span>}
      </div>
    );
  if (d.kind === 'vault_multi') {
    const added = new Set(d.parts.filter((p) => p.kind === 'append').map((p) => p.path)).size;
    const created = d.parts.filter((p) => p.kind === 'new').length;
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
        <span className="text-muted">Files into</span>
        <BrandIcon brand="obsidian" size={14} decorative />
        <span className="font-semibold">{[added && `${added} existing ${added === 1 ? 'note' : 'notes'}`, created && `${created} new ${created === 1 ? 'note' : 'notes'}`].filter(Boolean).join(' and ')}</span>
      </div>
    );
  }
  return <NoteTarget kind={d.kind === 'vault_new' ? 'new' : d.kind === 'vault_filed' ? 'filed' : 'append'} path={d.path} heading={d.kind === 'vault_append' ? d.heading : undefined} links={links} />;
}

/** Where a vault note lands: a new note, an append under a heading, or the note that already holds it. */
function NoteTarget({ kind, path, heading, links }: { kind: 'new' | 'append' | 'filed'; path: string; heading?: string; links: TargetLinks }) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-[13px]">
      <span className="text-muted">{kind === 'new' ? 'New note' : kind === 'filed' ? 'Already in' : 'Append to'}</span>
      <BrandIcon brand="obsidian" size={14} decorative />
      {kind !== 'new' || links.noteExists ? (
        <TargetLink href={links.note(path)} title="Open the note in Obsidian">
          <span className="font-mono text-[12px]">{path}</span>
        </TargetLink>
      ) : (
        <span className="break-all font-mono text-[12px] font-semibold" title="The note is created when you approve">
          {path}
        </span>
      )}
      {heading && <Under heading={heading} />}
    </div>
  );
}

type TargetLinks = { page: (id: string) => string; note: (path: string) => string; noteExists: boolean };

type Check = { ok: boolean | 'info' | 'warn' | 'caution'; label: string; detail?: string };

function checksFor(d: Draft, inScope: boolean, dryRun: boolean): Check[] {
  if (isFiledDraft(d))
    return [
      { ok: true, label: d.kind === 'vault_filed' ? 'Checked the vault for this thread or meeting' : 'Checked the page for this thread' },
      { ok: 'info', label: 'Nothing is written' },
    ];
  // FR-9.6, FR-10.7: what the check for an earlier filing found.
  const found = d.kind === 'vault_append' ? undefined : d.possibleDuplicates;
  const dupes: Check = found?.length
    ? { ok: 'caution', label: d.kind === 'confluence' ? 'The page already links to this thread' : 'A note may already hold this', detail: `${found.length} found` }
    : { ok: true, label: d.kind === 'confluence' ? 'Checked the page for this thread' : 'Checked the vault for an existing note' };
  const c: Check[] =
    d.kind === 'confluence'
      ? [
          inScope ? { ok: true, label: 'Page in scope', detail: `page ${d.pageId}, checked again at write` } : { ok: false, label: 'Page excluded from scope', detail: `page ${d.pageId}` },
          { ok: 'info', label: 'Version check at write', detail: `base v${d.baseVersion}` },
          { ok: true, label: 'People check passed' },
          dupes,
        ]
      : [
          { ok: true, label: 'Follows vault conventions' },
          dupes,
          d.kind === 'vault_multi'
            ? { ok: 'info', label: 'Every note checked before any is written', detail: `${new Set(d.parts.map((p) => p.path)).size} notes` }
            : d.kind === 'vault_append'
              ? { ok: 'info', label: 'File hash check at write' }
              : { ok: 'info', label: 'Refuses to overwrite an existing note' },
        ];
  if (dryRun) c.push({ ok: 'warn', label: 'Dry-run: writes go to the sandbox only' });
  return c;
}

const CHECK_ICON = {
  true: { icon: 'check', cls: 'text-teal-ink' },
  false: { icon: 'alert', cls: 'text-red-fg' },
  info: { icon: 'lock', cls: 'text-muted' },
  warn: { icon: 'flask', cls: 'text-amber-fg' },
  caution: { icon: 'alert', cls: 'text-amber-fg' },
} as const;

/** The safety checks folded into one line: they matter when one fails, not when all pass. */
function ChecksToggle({ checks, open, onToggle }: { checks: Check[]; open: boolean; onToggle: () => void }) {
  const failed = checks.filter((c) => c.ok === false).length;
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls="draft-checks"
      onClick={onToggle}
      className={cx('-ml-1.5 inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs font-medium cursor-pointer hover:bg-track', failed ? 'text-red-fg' : 'text-teal-ink')}
    >
      <Icon name={failed ? 'alert' : 'check'} size={13} strokeWidth={2.5} />
      {failed ? `${failed} check failed` : 'Checks passed'}
      <Icon name={open ? 'up' : 'down'} size={13} className="text-muted" />
    </button>
  );
}

function ChecksDetail({ checks, d }: { checks: Check[]; d: Draft }) {
  return (
    <div id="draft-checks" className="flex flex-col gap-1.5 rounded-lg bg-surface-2 px-3 py-2.5 text-xs">
      {checks.map((c) => {
        const i = CHECK_ICON[String(c.ok) as keyof typeof CHECK_ICON];
        return (
          <div key={c.label} className="flex items-center gap-2">
            <Icon name={i.icon} size={13} strokeWidth={2.5} className={cx('shrink-0', i.cls)} />
            <span className="flex-1 text-ink-2">{c.label}</span>
            {c.detail && <span className="font-mono text-[11px] text-muted">{c.detail}</span>}
          </div>
        );
      })}
      <div className="mt-0.5 border-t border-line-soft pt-1.5 font-mono text-[11px] text-muted">
        Drafted by {d.model} · {d.promptVersion} · {Math.round(d.durationMs / 1000)}s · {fmtTokens(d.tokens)} tokens
      </div>
    </div>
  );
}

/**
 * The draft with its controls: the Rich text / Markdown view and Edit in the corner (or click the
 * text), and Save / Cancel under the editor. You read and edit in the same place and the same view.
 */
function DraftFrame({
  label,
  edited,
  editing,
  canEdit,
  onEdit,
  editActions,
  mode,
  setMode,
  context,
  className,
  children,
}: {
  label: string;
  edited: boolean;
  editing: boolean;
  canEdit: boolean;
  onEdit: () => void;
  editActions: ReactNode;
  mode: DocMode;
  setMode: (m: DocMode) => void;
  /** Read-only text above the draft, outside the click-to-edit area. */
  context?: ReactNode;
  className: string;
  children: ReactNode;
}) {
  const clickToEdit = canEdit && !editing;
  return (
    <div className={cx('group flex flex-col gap-2', className)}>
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        <span className="font-mono text-[11px] text-teal">{label}</span>
        {edited && <span className="rounded bg-accent-wash px-1.5 py-px text-[10px] font-semibold text-accent-ink">Edited</span>}
        <span className="flex-1" />
        <Segmented<DocMode>
          label="Draft view"
          size="sm"
          className="gap-0.5 rounded-lg p-0.5 [&>button]:min-h-7 [&>button]:rounded-md [&>button]:px-2.5 [&>button]:text-xs"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'rich', label: 'Rich text' },
            { value: 'markdown', label: 'Markdown' },
          ]}
        />
        {clickToEdit && (
          <Button size="sm" variant="ghost" icon="edit" aria-label="Edit text" title="Edit text" className="-mr-1.5" onClick={onEdit}>
            Edit
          </Button>
        )}
      </div>
      {context}
      {/* A mouse shortcut for the Edit button: click the text to start editing. Links still open. */}
      <div className={cx(clickToEdit && 'cursor-text')} onClick={clickToEdit ? (e) => !(e.target as HTMLElement).closest('a') && onEdit() : undefined}>
        {children}
      </div>
      {editing && <div className="flex flex-wrap items-center gap-2 pt-1">{editActions}</div>}
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
        <Button icon="x" onClick={() => void api.cancelDraft(action.id).catch(errorToast)}>
          Cancel
        </Button>
        <span className="font-mono text-xs text-muted">{elapsed}s elapsed · usually 30–60 s with the real model</span>
      </div>
    </div>
  );
}

/** The text Frank edits: one note's, for a draft that files into several. */
const draftText = (d: Draft, part?: number) => (isFiledDraft(d) ? '' : d.kind === 'vault_multi' ? (d.parts[part ?? 0]?.content ?? '') : d.content);

type Editing = { actionId: string; part?: number; text: string; original: string };

/** An edit kept from before the panel last went away (store/draftEdits), if its draft hasn't changed since. */
function restoreEdit(view: ItemView, type: ActionType): Editing | null {
  const a = currentAction(view.actions, type);
  const d = a && view.drafts[a.id];
  if (!a || a.status !== 'ready' || !d || isFiledDraft(d)) return null;
  for (const part of d.kind === 'vault_multi' ? d.parts.map((_, i) => i) : [undefined]) {
    const kept = keptEdit(a.id, part);
    if (!kept) continue;
    if (kept.original === draftText(d, part)) return { actionId: a.id, part, ...kept };
    forgetEdit(a.id, part); // the draft changed since: the copy is stale
  }
  return null;
}

export function ActionPanel({
  view,
  type,
  setType,
  onDirty,
  embedded,
  onDoneNext,
  onClose,
  onApproved,
}: {
  view: ItemView;
  type: ActionType;
  setType: (t: ActionType) => void;
  onDirty: (dirty: boolean) => void;
  /** Filing in a batch (cockpit CK-4.3): the approval marks the item done once filed, then the batch moves on. */
  onApproved?: (t: ActionType) => void;
  /** Inside the Inbox item panel's Next step card: no frame of its own, and "Done and next" moves the panel on. */
  embedded?: boolean;
  onDoneNext?: () => void;
  /** Embedded only: folds the panel back to the filing options. */
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const { summary: s, item } = view;
  // `part`: which note, for a draft that files into several (FR-9.7).
  const [editing, setEditing] = useState<Editing | null>(() => restoreEdit(view, type));
  const [confirm, setConfirm] = useState<Confirm>(null);
  const [working, setBusy] = useState(false);
  // While the server is away nothing that changes state can be sent; the buttons wait, the edit stays.
  const online = useOnline();
  const busy = working || !online;
  const [checksOpen, setChecksOpen] = useState(false);
  const [docMode, setDocMode] = useState<DocMode>('rich');

  const newest = view.actions.find((a) => a.type === type);
  // The action the item summary (tabs, rows, next step) stands for too: a filed entry comes back when its next version is discarded.
  const action = currentAction(view.actions, type);
  const version = action ? entryVersion(view.actions, action) : 1;
  const draft = action ? view.drafts[action.id] : undefined;
  const prev = action?.supersedes ? view.actions.find((a) => a.id === action.supersedes) : undefined;
  const budgetHit = view.budgets.drafts.hit;
  // Picked from the live catalogue, so in scope when drafted; excluded since if it or a page above
  // it is now on the exclude list. The executor checks the full scope again at write time.
  const inScope = draft?.kind === 'confluence' ? ![draft.pageId, ...(draft.ancestorIds ?? [])].some((id) => view.excludedPageIds.includes(id)) : true;
  const stale = action?.status === 'ready' && action.itemRevision < item.revision;
  const dirty = !!editing && editing.text !== editing.original;

  useEffect(() => onDirty(dirty), [dirty, onDirty]);

  // The edit in progress is kept (store/draftEdits), and comes back when the panel does: after the
  // server was away, or a reload. Leaving on purpose while connected drops it.
  const stopEditing = () => setEditing((e) => (e && forgetEdit(e.actionId, e.part), null));
  useEffect(() => {
    if (editing) keepEdit(editing.actionId, editing.part, { text: editing.text, original: editing.original });
  }, [editing]);
  const editingNow = useRef(editing);
  useEffect(() => {
    editingNow.current = editing;
  });
  useEffect(
    () => () => {
      const e = editingNow.current;
      if (e && api.connection === 'up') forgetEdit(e.actionId, e.part); // left on purpose, not taken away
    },
    [],
  );

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
      run: () => (stopEditing(), void run(() => api.redraft(action.id))),
    });
  const discard = () =>
    action &&
    guard({
      title: 'Discard this draft?',
      body: 'The draft and your edits are dropped. Nothing is written. You can draft again later.',
      label: 'Discard',
      danger: true,
      run: () => (stopEditing(), void run(() => api.discardAction(action.id))),
    });

  // A failed write is written again as drafted, once Frank has fixed the cause: no new draft (FR-14.5).
  const retryWrite = () => action && void run(() => api.retryWrite(action.id));
  const canRetryWrite = action?.status === 'failed' && action.failedWhile === 'writing' && (action.failureReason === 'unreachable' || action.failureReason === 'allow_list');
  const budgetNote = budgetHit && <span className="text-xs text-amber-fg">Drafts budget reached for today ({view.budgets.drafts.used}/{view.budgets.drafts.limit}).</span>;

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
  else if (draft && isFiledDraft(draft) && (action?.status === 'ready' || action?.status === 'done')) heading = 'Already filed';
  else if (action?.status === 'ready') heading = 'Review and approve the draft';
  else if (action?.status === 'approved' || action?.status === 'executing') heading = 'Writing…';
  else if (action?.status === 'done') heading = view.dryRun ? 'Written to the sandbox' : 'Written';
  else if (action?.status === 'failed')
    heading =
      action.failureReason === 'allow_list' ? 'Write refused' : action.failureReason === 'conflict' ? 'Changed since draft' : action.failureReason === 'no_fit' ? 'Nothing to file' : action.failedWhile === 'writing' ? 'Not written' : 'Draft blocked';

  let body: ReactNode;
  if (!action) {
    const hint = type === 'vault_note' ? s.targetHints.vault : s.targetHints.confluence;
    const suggested = type === 'vault_note' ? s.triage?.vault : s.triage?.confluence;
    body = (
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
            <Button variant="solid" icon="redraft" disabled={budgetHit || busy} onClick={redraft}>
              Re-draft
            </Button>
            <Button icon="vault" disabled={budgetHit || busy} onClick={() => (setType('vault_note'), void request('vault_note'))}>
              Draft vault note instead
            </Button>
            <Button icon="x" onClick={discard}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : action.failureReason === 'no_fit' ? (
        <div className="flex flex-col gap-3">
          <Banner tone="warn" icon="confluence"
            action={
              <div className="flex items-center gap-3">
                <GuideLink topic="noFit" />
                <Link to="/settings/writing" className="text-[13px] font-medium">
                  Settings › Write targets
                </Link>
              </div>
            }
          >
            <strong>No page in scope fits.</strong> {msg}
          </Banner>
          <div className="flex flex-wrap gap-2">
            <Button variant="solid" icon="vault" disabled={budgetHit || busy} onClick={() => (setType('vault_note'), void request('vault_note'))}>
              Draft vault note instead
            </Button>
            <Button icon="redraft" disabled={budgetHit || busy} onClick={redraft}>
              Re-draft
            </Button>
            <Button icon="x" onClick={discard}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : action.failureReason === 'allow_list' ? (
        <div className="flex flex-col gap-3">
          <Banner tone="bad" icon="lock"
            action={
              <div className="flex items-center gap-3">
                <GuideLink topic="refusedWrites" />
                <Link to="/settings/writing" className="text-[13px] font-medium">
                  Settings › Write targets
                </Link>
              </div>
            }
          >
            <strong>Not written.</strong> {msg}
          </Banner>
          <div className="flex flex-wrap items-center gap-2">
            {canRetryWrite && (
              <Button variant="solid" icon="poll" disabled={busy} onClick={retryWrite}>
                Retry write
              </Button>
            )}
            <Button icon="redraft" disabled={budgetHit || busy} onClick={redraft}>
              Re-draft
            </Button>
            <Button variant="danger" icon="trash" onClick={discard}>
              Discard
            </Button>
          </div>
        </div>
      ) : action.failureReason === 'conflict' ? (
        // Re-drafted at once while the budget allows; otherwise, or if that failed, Frank decides.
        view.actions.some((b) => b.type === type && b.id !== action.id && b.status === 'drafting' && b.createdAt >= action.createdAt) ? (
          <Banner tone="warn" icon="alert">
            <strong>Changed since draft.</strong> {msg} <Spinner size={12} />
          </Banner>
        ) : (
          <div className="flex flex-col gap-3">
            <Banner tone="warn" icon="alert">
              <strong>Changed since draft.</strong> {msg?.replace(/ Re-drafting instead of (writing|overwriting it)\.$/, '')} Nothing was written{budgetHit ? ', and it can’t be re-drafted until the drafts budget resets' : ''}.
            </Banner>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="solid" icon="redraft" disabled={budgetHit || busy} onClick={redraft}>
                Re-draft
              </Button>
              <Button variant="danger" icon="trash" onClick={discard}>
                Discard
              </Button>
              {budgetNote}
            </div>
          </div>
        )
      ) : action.failedWhile === 'writing' ? (
        <div className="flex flex-col gap-3">
          <Banner tone="bad" icon="alert">
            <strong>Not written.</strong> {msg}
          </Banner>
          <div className="flex flex-wrap items-center gap-2">
            {canRetryWrite && (
              <Button variant="solid" icon="poll" disabled={busy} onClick={retryWrite}>
                Retry write
              </Button>
            )}
            <Button variant={canRetryWrite ? 'secondary' : 'solid'} icon="redraft" disabled={budgetHit || busy} onClick={redraft}>
              Re-draft
            </Button>
            <Button variant="danger" icon="trash" onClick={discard}>
              Discard
            </Button>
            {budgetNote}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Banner tone="bad" icon="alert">
            <strong>The model didn’t return a usable draft.</strong> {msg}
          </Banner>
          <div className="flex flex-wrap gap-2">
            <Button variant="solid" icon="redraft" disabled={budgetHit || busy} onClick={redraft}>
              Retry
            </Button>
            <Button variant="danger" icon="trash" onClick={discard}>
              Discard
            </Button>
          </div>
        </div>
      );
  } else if (draft) {
    const textOf = (part?: number) => draftText(draft, part);
    const isEditing = (part?: number) => editing?.actionId === action.id && editing.part === part;
    const dupes = (!isFiledDraft(draft) && draft.kind !== 'vault_append' && draft.possibleDuplicates) || [];
    const docFor = (part?: number): DocProps => ({
      value: isEditing(part) ? editing!.text : textOf(part),
      editing: isEditing(part),
      onChange: (text) => setEditing((e) => (e ? { ...e, text } : e)),
      mode: docMode,
      ...(draft.kind === 'vault_multi' && { label: partLabel(draft.parts[part ?? 0]) }),
    });
    const doc = docFor();
    const written = action.status === 'done' && !view.dryRun;
    const links: TargetLinks = {
      page: (id) => confluencePageUrl(view.targets.confluenceSite, view.targets.spaceKey, id),
      note: (path) => obsidianNoteUrl(view.targets.vaultPath, path),
      noteExists: written,
    };
    const checks = checksFor(draft, inScope, view.dryRun);
    const cancelEdit = () =>
      dirty ? setConfirm({ title: 'Discard your edits?', body: 'The draft goes back to the last saved text.', label: 'Discard edits', danger: true, run: stopEditing }) : stopEditing();
    const frameFor = (part?: number): FrameProps => ({
      edited: draft.kind === 'vault_multi' ? !!draft.parts[part ?? 0]?.edited : draft.edited,
      editing: isEditing(part),
      canEdit: action.status === 'ready' && !editing,
      onEdit: () => setEditing({ actionId: action.id, part, text: textOf(part), original: textOf(part) }),
      mode: docMode,
      setMode: setDocMode,
      editActions: (
        <>
          <Button
            variant="solid"
            icon="check"
            disabled={busy || !dirty}
            onClick={() =>
              void run(async () => {
                await api.saveDraftEdit(action.id, editing!.text, part);
                stopEditing();
                toast('Edits saved. The draft is marked as edited.');
              })
            }
          >
            Save edits
          </Button>
          <Button icon="x" onClick={cancelEdit}>
            Cancel
          </Button>
        </>
      ),
    });
    const frame = frameFor();
    body = (
      <div className="flex flex-col gap-3">
        <TargetLine d={draft} inScope={inScope} links={links} />
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
              <Button size="sm" icon="redraft" disabled={budgetHit || busy} onClick={redraft}>
                Re-draft
              </Button>
            }
          >
            <strong>New replies since this draft</strong> (revision {action.itemRevision} → {item.revision}). You can still approve it as it is.
          </Banner>
        )}
        {dupes.length > 0 && action.status === 'ready' && (
          <Banner
            tone="warn"
            icon="alert"
            action={
              <Button size="sm" icon="redraft" disabled={budgetHit || busy} onClick={redraft}>
                Re-draft
              </Button>
            }
          >
            <strong>{draft.kind === 'confluence' ? 'This page may already have it.' : 'This may already be in the vault.'}</strong>{' '}
            {dupes.map((p, i) => (
              <span key={p.path ?? `${p.pageId}-${p.section}`}>
                {i > 0 && '; '}
                {p.path ? (
                  <TargetLink href={links.note(p.path)} title="Open the note in Obsidian">
                    {p.path}
                  </TargetLink>
                ) : (
                  <TargetLink href={links.page(p.pageId ?? '')} title="Open the page in Confluence">
                    {p.pageTitle} › {p.section}
                  </TargetLink>
                )}{' '}
                ({p.why})
              </span>
            ))}
            . Re-draft to add to it instead, or approve to file this anyway.
          </Banner>
        )}
        {!inScope && action.status === 'ready' && (
          <Banner tone="bad" icon="lock" action={<Link to="/settings/writing" className="text-[13px] font-medium">Write targets</Link>}>
            Page {draft.kind === 'confluence' && draft.pageId} is excluded from the Confluence scope. The executor will refuse this write.
          </Banner>
        )}
        {isFiledDraft(draft) ? (
          <FiledDoc d={draft} />
        ) : draft.kind === 'confluence' ? (
          <ConfluencePreview d={draft} item={item} doc={doc} frame={frame} />
        ) : draft.kind === 'vault_multi' ? (
          <VaultMultiDoc d={draft} doc={docFor} frame={frameFor} links={links} />
        ) : draft.kind === 'vault_append' ? (
          <VaultAppendDoc context={draft.context} doc={doc} frame={frame} />
        ) : (
          <VaultDoc doc={doc} frame={frame} />
        )}
        {/* About the draft as a whole: whether it's safe to write, and asking for another. */}
        <div className="-mt-1 flex flex-col gap-2">
          <div className="flex min-h-8 items-center gap-2">
            <ChecksToggle checks={checks} open={checksOpen} onToggle={() => setChecksOpen(!checksOpen)} />
            <span className="flex-1" />
            {action.status === 'ready' && !editing && (
              <Button size="sm" variant="ghost" icon="redraft" className="-mr-1.5" disabled={budgetHit || busy} onClick={redraft} title={budgetHit ? 'Drafts budget reached for today' : 'Ask for a fresh draft'}>
                Re-draft
              </Button>
            )}
          </div>
          {checksOpen && <ChecksDetail checks={checks} d={draft} />}
        </div>
        {action.status === 'done' && action.itemRevision < item.revision && (
          <Banner
            tone="info"
            icon="info"
            action={
              <Button size="sm" icon="redraft" disabled={budgetHit || busy} title={budgetHit ? 'Drafts budget reached for today' : undefined} onClick={() => void request(type)}>
                Draft v{version + 1}
              </Button>
            }
          >
            <strong>New replies since this entry was drafted.</strong> Draft a v{version + 1} to file what’s new.
          </Banner>
        )}
        {action.status === 'done' && (
          <div role="status" className="flex flex-wrap items-center gap-3 rounded-[10px] border border-teal-line bg-teal-wash px-4 py-3 text-[13px] text-teal-ink">
            <Icon name="check" strokeWidth={2.5} />
            <span className="min-w-0 flex-[1_1_300px] text-ink">{view.results[action.id]}</span>
            {draft.kind === 'confluence' || draft.kind === 'confluence_filed' ? (
              <a href={links.page(draft.pageId)} target="_blank" rel="noreferrer" className={linkButton}>
                <BrandIcon brand="confluence" size={14} decorative /> Open page
              </a>
            ) : (
              draft.kind !== 'vault_multi' &&
              (written || draft.kind === 'vault_filed') && (
                <a href={links.note(draft.path)} className={linkButton}>
                  <BrandIcon brand="obsidian" size={14} decorative /> Open note
                </a>
              )
            )}
            {s.status === 'open' && (
              <Button variant="solid" icon="check" onClick={() => (onDoneNext ? onDoneNext() : void markDoneAndNext())}>
                Mark done and next item
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }

  // Approve and Discard only: Edit lives on the draft and Re-draft under it. While editing,
  // Save and Cancel sit under the editor and this row steps aside.
  const footer =
    action && draft && !editing && (action.status === 'ready' || action.status === 'approved' || action.status === 'executing') ? (
      <div className={cx('flex flex-wrap items-center gap-2 border-t border-line-soft bg-surface-3 py-3', embedded ? 'rounded-b-[11px] px-[18px]' : 'px-6')}>
        <Button variant="solid" size="lg" icon={action.status === 'ready' ? 'check' : undefined} disabled={busy || action.status !== 'ready'} onClick={() => void run(async () => (await api.approveAction(action.id, onApproved && { markDoneWhenFiled: true }), onApproved?.(type)))}>
          {action.status === 'ready' ? (
            isFiledDraft(draft) ? (
              'Mark as filed'
            ) : view.dryRun ? (
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
        <span className="flex-1" />
        <Button variant="danger" icon="trash" disabled={action.status !== 'ready'} onClick={discard}>
          Discard
        </Button>
      </div>
    ) : null;

  const versionTag = version > 1 && (
    <span title={`Version ${version}: ${version - 1} filed before it`} className="rounded bg-accent-wash px-1.5 py-px font-mono text-[11px] font-semibold tracking-normal text-accent-ink">
      v{version}
    </span>
  );

  const tabs = (
    <div className="flex items-center gap-2">
      <div role="tablist" aria-label="Draft target" className="inline-flex gap-1 rounded-[10px] bg-track-2 p-1">
        {TYPES.map((t) => {
          const on = t === type;
          const badge = STATUS_BADGE[draftState(s, t)];
          const v = s.actions[t]?.version ?? 1;
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
              {TYPE_LABEL[t].short}
              {badge && <span className={cx('rounded px-1.5 py-px text-[10px] font-semibold', badge.cls)}>{v > 1 ? `v${v} · ${badge.label}` : badge.label}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );

  return (
    <section
      aria-label="Action"
      className={cx(
        'flex min-w-0 flex-col',
        embedded
          ? 'border-t border-line-soft'
          : 'flex-[2_1_600px] overflow-hidden rounded-[14px] border border-accent-line-2 bg-surface shadow-[0_1px_2px_rgba(20,23,28,0.06),0_12px_32px_rgba(29,78,216,0.10)]',
      )}
    >
      <div className={cx('flex flex-col', embedded ? 'gap-3.5 px-[18px] pb-4 pt-3.5' : 'gap-[18px] px-6 pb-5 pt-[22px]')}>
        {embedded ? (
          // The Next step card above says what to do; this part says where the filing has got to.
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="m-0 flex flex-1 items-center gap-2 text-[15px] font-semibold">
                {heading}
                {versionTag}
              </h3>
              {onClose && (
                <button type="button" className="-mr-2 inline-flex min-h-7 items-center gap-1 rounded-lg px-2 text-[13px] font-medium text-ink-2 hover:bg-track hover:text-ink cursor-pointer" onClick={onClose}>
                  <Icon name="back" size={14} />
                  Back to filing options
                </button>
              )}
            </div>
            {tabs}
          </>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex flex-[1_1_260px] flex-col gap-0.5">
              <span className="text-xs font-semibold uppercase tracking-[0.06em] text-accent">Action</span>
              <h2 className="m-0 flex items-center gap-2 text-xl font-semibold tracking-[-0.01em]">
                {heading}
                {versionTag}
              </h2>
            </div>
            {tabs}
          </div>
        )}
        {newest?.status === 'discarded' && (!action || action.status === 'done') && <div className="-mt-2 text-xs text-muted">The last draft was discarded.</div>}
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
    TYPES.find((t) => (t === 'vault_note' ? s.triage?.vault : s.triage?.confluence)) ??
    'vault_note'
  );
}
