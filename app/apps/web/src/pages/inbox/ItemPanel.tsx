import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ActionType, FilingFeedbackBody, Message, TopicPiece } from '@work-os/shared';
import { api, type ItemSummary, type ItemView } from '../../api';
import { ActionPanel, TYPES } from '../../components/ActionPanel';
import { DraftSplit } from '../../components/DraftWithInfo';
import { BrandIcon, SourceMark } from '../../components/BrandIcon';
import { JoinTeams } from '../../components/JoinTeams';
import { CategoryTags, CorrectForm, ItemMarkers, OnCalendar, SnoozeMenu, itemPath, kindLabel, markDoneWithUndo, openInSource, ruleOverride } from '../../components/item';
import { Icon, MoreIcon } from '../../components/icons';
import { useEarlierToggle } from '../../components/Earlier';
import { MessageText, Recipients } from '../../components/SlackText';
import { Button, IconButton, Kbd, MenuItem, PhaseTag, PopoverPanel, Spinner, cx, phaseToast, usePopover } from '../../components/ui';
import { useNow } from '../../hooks/useNow';
import { fmtAgo, fmtDayDate, fmtIn, fmtTime, fmtWhen, plural } from '../../lib/format';
import { TYPE_LABEL, TYPE_NOUN, canFile, draftButton, draftState } from '../../lib/lanes';
import { SOURCE_NAME, dueInfo, isLive, needLabel, shownStep, suggestedSnooze, topicAsks } from '../../lib/next';
import { usePrefs } from '../../store/prefs';
import { errorToast, toast } from '../../store/toasts';
import { DueChip, LaneChip, NeedTag, StatusChip } from './chips';
import { ReplyNote } from './cockpit/rows';
import { tally, type Batch } from './batch';
import { sweepTally, type Sweep } from './sweep';

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

/**
 * What to do, and the doing of it: the next step (or, with nothing to do, the item's status) on top,
 * and under it either the filing options or the open draft (`workflow`) with its progress and review.
 */
/** Under Reply in …: that a reply closes the item by itself, when closing on reply is on (cockpit CK-2.5). */
function CloseNote({ item }: { item: ItemSummary }) {
  const where = item.kind === 'dm' || item.kind === 'chat' ? 'the conversation' : item.kind === 'email' ? 'the email' : 'the thread';
  const text = !item.next || item.next.need === 'reply' ? `Closes by itself when you reply in ${where}.` : 'Closes when your reply settles it.';
  // Only Slack is read again after the click (CK-2.4).
  const checked = item.source === 'slack' ? ` Checked 2 min after you open ${SOURCE_NAME[item.source]}.` : '';
  return (
    <div data-close-note className="flex items-center gap-2 rounded-md bg-green-wash px-2.5 py-2 text-[13px] text-green-fg">
      <Icon name="check" size={14} strokeWidth={2.25} className="shrink-0" />
      <span>
        {text}
        {checked}
      </span>
    </div>
  );
}

/**
 * Others' messages look to have settled what was asked of Frank (cockpit CK-2.10): why, and his
 * answer. Done and Not finished are both labels for the finish eval.
 */
function FinishCallout({ item }: { item: ItemSummary }) {
  const [busy, setBusy] = useState(false);
  const f = item.looksFinished;
  if (!f || item.status !== 'open') return null;
  const notFinished = async () => {
    setBusy(true);
    await api.notFinished(item.id).then((r) => toast(`Kept in Today · labelled set now ${r.labelCount}`, { tone: 'success' }), errorToast);
    setBusy(false);
  };
  return (
    <section aria-label="Looks finished" data-finish-callout className="flex flex-col gap-2.5 rounded-xl bg-green-wash px-[18px] py-4 text-green-fg">
      <div className="flex items-center gap-2">
        <Icon name="check" size={14} strokeWidth={2.25} className="shrink-0" />
        <span className="text-[15px] font-semibold">Looks finished</span>
      </div>
      {f.why && <div className="text-[13px] leading-normal">{f.why}</div>}
      <div className="flex flex-wrap gap-2">
        <Button variant="solid" icon="check" disabled={busy} onClick={() => void markDoneWithUndo(item)}>
          Done
        </Button>
        <Button disabled={busy} onClick={() => void notFinished()}>
          {busy && <Spinner size={12} />} Not finished
        </Button>
      </div>
    </section>
  );
}

function NextStepCard({
  item,
  draftsBudgetHit,
  closesOnReply,
  onFile,
  onFileWith,
  onReplied,
  workflow,
}: {
  item: ItemSummary;
  draftsBudgetHit: boolean;
  closesOnReply: boolean;
  onFile: (t: ActionType) => void;
  /** Draft with additional information (FR-9.12). */
  onFileWith: (t: ActionType, info: string) => Promise<unknown>;
  /** In a sweep (UX-10), replying moves it on. */
  onReplied?: () => void;
  workflow?: ReactNode;
}) {
  const now = useNow(30_000);
  const step = shownStep(item, draftsBudgetHit, now);
  const hint = suggestedSnooze(item, now);
  if (!step) return <StatusCard item={item}>{workflow ?? (canFile(item) && <FileIt item={item} draftsBudgetHit={draftsBudgetHit} onFile={onFile} onFileWith={onFileWith} />)}</StatusCard>;
  const p = step.primary;
  // A draft as the primary action leaves the filing options; once a draft is open, its tabs take over.
  const draft = p.kind === 'draft' && !workflow ? p.button : undefined;
  const target = draft && targetOf(item, draft.type);
  const draftHint = draft && (draft.disabledReason ?? (draft.state === 'stale' ? 'Draft out of date: new messages since' : target ? `To ${target}` : undefined));
  return (
    <section aria-label="Next step" className="flex flex-col rounded-xl border border-accent-line-2">
      <div className="flex flex-col gap-2.5 px-[18px] py-4">
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
            <Button
              variant="solid"
              icon={item.kind === 'dm' || item.kind === 'chat' ? 'dm' : 'external'}
              onClick={() => {
                openInSource(item, { replying: true });
                onReplied?.();
              }}
            >
              {p.label}
            </Button>
          ) : (
            draft &&
            (draft.state === 'none' ? (
              <span title={draft.disabledReason} className="inline-flex">
                <DraftSplit
                  type={draft.type}
                  variant="solid"
                  icon={draft.type === 'vault_note' ? 'vault' : 'confluence'}
                  disabled={!!draft.disabledReason}
                  infoDisabledReason={draftsBudgetHit ? 'Drafts budget reached' : undefined}
                  onDraft={() => onFile(draft.type)}
                  onInfo={(text) => onFileWith(draft.type, text!)}
                >
                  {draft.label}
                </DraftSplit>
              </span>
            ) : (
              <Button variant="solid" icon={draft.type === 'vault_note' ? 'vault' : 'confluence'} onClick={() => onFile(draft.type)}>
                {(draft.state === 'drafting' || draft.state === 'writing') && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
                {draft.label}
              </Button>
            ))
          )}
          <SnoozeSplit item={item} hint={hint} />
        </div>
        {draftHint && <div className="-mt-1 text-xs text-muted">{draftHint}</div>}
        {p.kind === 'open' && closesOnReply && <CloseNote item={item} />}
        <ReplyNote item={item} wrap finish={false} />
      </div>
      {workflow ?? (canFile(item) && <FileIt item={item} draftsBudgetHit={draftsBudgetHit} onFile={onFile} onFileWith={onFileWith} skip={draft?.type} />)}
    </section>
  );
}

/** For items with nothing to do: why they're here and how to bring them back, then the filing area. */
function StatusCard({ item, children }: { item: ItemSummary; children: ReactNode }) {
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
  } else if (item.lane === 'follow') {
    title = 'Waiting on others';
    body = (
      <>
        You own the outcome and someone else has the next move. It moves up when a reply hands it back to you, and to Low priority once it’s resolved.
        {item.replyCheck?.handedOn && item.replyCheck.why && <span className="mt-1 block text-ink">You handed it on: {item.replyCheck.why}</span>}
      </>
    );
  } else {
    title = 'Nothing to do';
    body = 'No reply needed and nothing to file. Correct the triage if that’s wrong.';
  }
  return (
    <section aria-label="Status" className={cx('flex flex-col rounded-xl border', item.triageState === 'failed' ? 'border-red-line' : 'border-line')}>
      <div className="flex flex-col gap-1.5 px-[18px] py-4">
        <div className="text-[15px] font-semibold">{title}</div>
        <div className="text-[13px] leading-normal text-ink-2">{body}</div>
        {action && <div className="pt-1.5">{action}</div>}
      </div>
      {children}
    </section>
  );
}

/**
 * The to-do the filing policy suggests (FR-15.6): `a` adds it as a to-do to review, × dismisses it.
 * Nothing goes to Tasks until Frank approves the to-do.
 */
function SuggestedTodo({ item, onAdd }: { item: ItemSummary; onAdd: () => Promise<void> }) {
  const now = useNow(60_000);
  const [busy, setBusy] = useState(false);
  const t = item.todoSuggestion;
  if (!t) return null;
  const due = dueInfo({ dueAt: t.dueAt }, now);
  const add = async () => {
    setBusy(true);
    await onAdd();
    setBusy(false);
  };
  return (
    <section aria-label="Suggested to-do" className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line px-3 py-2 text-[13px]">
      <Icon name="commitments" size={16} className="text-ink-2" />
      <span className="min-w-0 flex-[1_1_200px]">
        <span className="text-muted">Add to-do: </span>
        <span className="font-medium">{t.step}</span>
      </span>
      {due && <DueChip due={due} />}
      {t.rule && (
        <span className="font-mono text-[11px] text-muted" title={`Suggested by filing policy rule ${t.rule}`}>
          {t.rule}
        </span>
      )}
      <Button size="sm" icon="plus" disabled={busy} onClick={() => void add()}>
        Add <Kbd>a</Kbd>
      </Button>
      <IconButton label="Dismiss the suggested to-do" icon="x" size={28} onClick={() => void api.dismissTodo(item.id).catch(errorToast)} />
    </section>
  );
}

/**
 * A meeting's action items for Frank (UX-5): pick the ones to track, and they go to the Tasks note
 * as a to-do to review and approve. They are ticked off in Obsidian, not here.
 */
function ActionItems({ item, items, onAdd }: { item: ItemSummary; items: string[]; onAdd: (steps: string[]) => Promise<void> }) {
  const [picked, setPicked] = useState<Record<number, boolean>>(() => Object.fromEntries(items.map((_, i) => [i, true])));
  const [busy, setBusy] = useState(false);
  const steps = items.filter((_, i) => picked[i]);
  const state = draftState(item, 'todo');
  const add = async () => {
    setBusy(true);
    await onAdd(steps);
    setBusy(false);
  };
  return (
    <Section
      title="Action items for you"
      aside={state === 'done' ? <span className="text-xs text-teal-ink">Added to Tasks</span> : state === 'ready' || state === 'stale' ? <span className="text-xs text-muted">To-do ready to review</span> : undefined}
    >
      {items.map((a, i) => (
        <label key={a} className="flex min-h-10 items-center gap-2.5 rounded-lg border border-line px-3 text-[13px] cursor-pointer">
          <input type="checkbox" className="h-4 w-4 accent-[var(--accent-bg)]" aria-label={`Add to Tasks: ${a}`} checked={!!picked[i]} onChange={(e) => setPicked({ ...picked, [i]: e.target.checked })} />
          <span className={cx(!picked[i] && 'text-muted')}>{a}</span>
        </label>
      ))}
      <div className="flex flex-wrap items-center gap-3 pt-1">
        <Button icon="commitments" disabled={busy || !steps.length} onClick={() => void add()}>
          {busy && <Spinner size={12} />} {steps.length === items.length ? 'Add to Tasks' : `Add ${steps.length} to Tasks`}
        </Button>
        <span className="text-xs text-muted">You review the tasks before they’re written.</span>
      </div>
    </Section>
  );
}

/** A topic's checklist (topics): every ask the triage found, ticked off one at a time. */
function Asks({ item }: { item: ItemSummary }) {
  const now = useNow(30_000);
  const [ticking, setTicking] = useState<string>();
  const asks = topicAsks(item);
  if (!asks.length) return null;
  const open = asks.filter((a) => !a.done).length;
  const tick = async (id: string, step: string) => {
    setTicking(id);
    await api.markAskDone(item.id, id).then(() => toast(`Ticked off · ${step}`), errorToast);
    setTicking(undefined);
  };
  return (
    <Section title="Asks in this topic" aside={<span className="font-mono text-[11px] text-muted">{open} of {asks.length} open</span>}>
      {asks.map(({ ask, id, done }) => {
        const due = done ? undefined : dueInfo(ask, now);
        return (
          <label key={id} data-ask={id} className="flex min-h-10 items-center gap-2.5 rounded-lg border border-line px-3 py-1.5 text-[13px] cursor-pointer has-[:disabled]:cursor-default">
            <input
              type="checkbox"
              className="h-4 w-4 shrink-0 accent-[var(--accent-bg)]"
              aria-label={`Done: ${ask.step}`}
              checked={done || ticking === id}
              disabled={done || !!ticking}
              onChange={() => void tick(id, ask.step)}
            />
            <NeedTag>{needLabel(ask)}</NeedTag>
            <span className={cx('min-w-0 flex-1', done && 'text-muted line-through')}>{ask.step}</span>
            {due && <DueChip due={due} />}
          </label>
        );
      })}
    </Section>
  );
}

/** One thread or stretch of chat in a topic: what it is, where to open it, and a way out of the topic. */
function PieceHead({ piece, messages }: { piece: TopicPiece; messages: Message[] }) {
  const [busy, setBusy] = useState(false);
  const first = messages[0]?.ts;
  const last = messages.at(-1)?.ts;
  const label =
    piece.kind === 'thread'
      ? `Thread · ${plural(piece.messageCount, 'message')}`
      : `Chat · ${first ? fmtTime(first) : ''}${last && last !== first ? `–${fmtTime(last)}` : ''}`;
  const split = async () => {
    setBusy(true);
    await api.splitPiece(piece.id).then(() => toast('Split out · it gets its own entry once triaged'), errorToast);
    setBusy(false);
  };
  return (
    <div data-piece={piece.id} className="flex items-center gap-1.5 pt-3.5 pb-0.5">
      <Icon name={piece.kind === 'thread' ? 'hash' : 'dm'} size={12} className="text-muted" />
      <span className="font-mono text-[11px] text-muted">{label}</span>
      <span className="flex-1" />
      <a href={piece.openUrl ?? piece.permalink} target="_blank" rel="noreferrer" className="inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted hover:bg-track hover:text-ink">
        <Icon name="external" size={11} /> Open
      </a>
      {!piece.anchor && (
        <button
          type="button"
          disabled={busy}
          title="Take this out of the topic: it is triaged on its own and never put back here"
          className="inline-flex min-h-6 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium text-muted hover:bg-track hover:text-ink disabled:opacity-60 cursor-pointer"
          onClick={() => void split()}
        >
          {busy ? <Spinner size={11} /> : <Icon name="split" size={11} />} Not this topic
        </button>
      )}
    </div>
  );
}

function Messages({ view }: { view: ItemView }) {
  const now = useNow(60_000);
  const [all, setAll] = useState(false);
  const { item, meId } = view;
  const { controls, before: shownBefore, people } = useEarlierToggle(item);
  const name = (id: string) => (id === meId ? 'You' : ([...item.participants, ...people].find((p) => p.id === id)?.name ?? id));
  const title = view.pieces
    ? `In this topic · ${plural(view.pieces.length, 'part')}`
    : item.kind === 'email'
      ? 'Email'
      : item.kind === 'event'
        ? 'The invitation'
        : item.kind === 'meeting'
          ? item.source === 'wispr'
            ? 'From the meeting notes'
            : 'From the transcript'
          : item.kind === 'dm' || item.kind === 'chat'
            ? item.messages.length === 1
              ? 'Message'
              : 'Messages'
            : 'Latest in the thread';
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
  const pieces = view.pieces;
  const row = (m: Message, muted: boolean) => (
    <div key={m.id} className={cx('flex flex-col gap-0.5 border-t border-line-soft-2 py-2.5 first-of-type:mt-1', muted && 'opacity-75')}>
      <span className="text-xs">
        <strong className="font-semibold">{name(m.authorId)}</strong> <span className="font-mono text-[11px] text-muted">{fmtWhen(m.ts, now)}</span>
      </span>
      <Recipients m={m} name={name} />
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
      {pieces
        ? // A topic: each piece under its own heading, its latest two messages until Show all.
          pieces.map((p) => {
            const ids = new Set(p.messageIds);
            const msgs = item.messages.filter((m) => ids.has(m.id));
            return (
              <div key={p.id} className="flex flex-col">
                <PieceHead piece={p} messages={msgs} />
                {(all ? msgs : msgs.slice(-2)).map((m) => row(m, false))}
              </div>
            );
          })
        : shown.map((m) => row(m, false))}
    </Section>
  );
}

const targetOf = (item: ItemSummary, t: ActionType) => (t === 'vault_note' ? item.targetHints.vault : t === 'confluence_entry' ? item.targetHints.confluence : undefined);

/** The filing targets, as the lower half of the Next step or Status card. `skip` is already the card's primary action. */
function FileIt({
  item,
  draftsBudgetHit,
  onFile,
  onFileWith,
  skip,
}: {
  item: ItemSummary;
  draftsBudgetHit: boolean;
  onFile: (t: ActionType) => void;
  onFileWith: (t: ActionType, info: string) => Promise<unknown>;
  skip?: ActionType;
}) {
  const title = skip ? 'Also file' : 'File it';
  return (
    <section aria-label={title} className="flex flex-col border-t border-line-soft px-[18px] pb-2 pt-3">
      <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
      {TYPES.filter((t) => t !== skip).map((t) => {
        const b = draftButton(item, t, draftsBudgetHit);
        const suggested = t === 'vault_note' ? item.triage?.vault : t === 'confluence_entry' ? item.triage?.confluence : false;
        const target = targetOf(item, t);
        const a = item.actions[t];
        // From the second entry on, the draft names its version: "v2 draft ready".
        const v = a && a.version > 1 ? `v${a.version}` : '';
        const draftWord = v ? `${v} draft` : 'Draft';
        const hint =
          b.state === 'none'
            ? (b.disabledReason ?? (t === 'todo' ? 'Your open steps, as tasks in Obsidian' : suggested ? `Suggested by triage${target ? ` · ${target}` : ''}` : 'Not suggested'))
            : b.state === 'ready'
              ? `${draftWord} ready${target ? ` · ${target}` : ''}`
              : b.state === 'stale'
                ? `${draftWord} out of date: new messages since`
                : b.state === 'done'
                  ? `${v ? `${v} ${t === 'todo' ? 'added' : 'filed'}` : t === 'todo' ? 'Added to Tasks' : 'Filed'}${a?.repliesSince ? ' · new replies since' : ''}`
                  : b.state === 'failed'
                    ? a?.failedWhile === 'writing'
                      ? `Not written to ${TYPE_LABEL[t].target}`
                      : `The last ${draftWord.toLowerCase()} failed`
                    : b.state === 'drafting'
                      ? `Drafting${v && ` ${v}`}…`
                      : 'Writing…';
        return (
          <div key={t} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-line-soft-2 py-2.5 first-of-type:border-t-0">
            {t === 'todo' ? <Icon name="commitments" size={16} className="text-ink-2" /> : <BrandIcon brand={t === 'vault_note' ? 'obsidian' : 'confluence'} size={16} decorative />}
            <span className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
              <span className="text-[13px] font-medium">{TYPE_LABEL[t].short}</span>
              <span className="text-xs text-muted">{hint}</span>
            </span>
            {b.state === 'none' ? (
              <DraftSplit
                type={t}
                disabled={!!b.disabledReason}
                infoDisabledReason={draftsBudgetHit ? 'Drafts budget reached' : undefined}
                onDraft={() => onFile(t)}
                onInfo={(text) => onFileWith(t, text!)}
              >
                {TYPE_LABEL[t].draft}
                {t === 'todo' && <Kbd>a</Kbd>}
              </DraftSplit>
            ) : (
              <Button className="min-h-9" onClick={() => onFile(t)}>
                {b.state === 'done' ? 'View' : 'Review'}
              </Button>
            )}
          </div>
        );
      })}
    </section>
  );
}

// How the item was triaged, behind a disclosure (cockpit CK-1.6): who decided it at a glance, the
// model, prompt version, batch, revision and time when opened. Open or closed is kept per browser.
function MetaLine({ view }: { view: ItemView }) {
  const now = useNow(60_000);
  const open = usePrefs((p) => p.triageDetailsOpen);
  const setOpen = usePrefs((p) => p.setTriageDetailsOpen);
  const { decision: d, correction, batch, summary: s } = view;
  let by = '';
  let text = '';
  if (s.triage?.by === 'user' && correction) {
    by = 'corrected by you';
    text = `Corrected by you ${fmtWhen(correction.correctedAt, now)} · in the labelled set · revision ${correction.itemRevision}`;
  } else if (d?.decidedBy === 'rule') {
    by = `rule ${d.ruleId}`;
    text = `Triaged ${fmtWhen(d.decidedAt, now)} by rule ${d.ruleId} · no model call · revision ${d.itemRevision}`;
  } else if (d) {
    // A rule that overrode the model shows on the closed row too: the reason is the model's (FR-4.3).
    const override = ruleOverride(d);
    by = override ?? 'model';
    text = [`Triaged ${fmtWhen(d.decidedAt, now)} by model`, override, d.model, d.promptVersion, batch && `batch of ${plural(batch.threads, 'thread')}`, `revision ${d.itemRevision}`].filter(Boolean).join(' · ');
  }
  if (!text) return null;
  return (
    <div className="pt-1" data-testid="triage-details">
      <button type="button" aria-expanded={open} className="inline-flex min-h-7 items-center gap-1.5 text-[13px] text-muted hover:text-ink cursor-pointer" onClick={() => setOpen(!open)}>
        <Icon name="forward" size={14} className={cx('transition-transform motion-reduce:transition-none', open && 'rotate-90')} />
        Triage details · {by}
      </button>
      {open && <div className="pl-5 font-mono text-[11px] text-muted">{text}</div>}
    </div>
  );
}

// ---------- Triage was right ----------

/** A model's or a rule's decision on the thread as it is now: what "Triage was right" can label. */
const canConfirm = (item: ItemSummary) => item.triageState === 'triaged' && !!item.triage && item.triage.by !== 'user' && !item.confirmed;

const confirmTriage = (item: ItemSummary) =>
  api.confirmTriage(item.id).then((r) => toast(`Labelled as right · labelled set now ${r.labelCount}`, { tone: 'success' }), errorToast);

/**
 * Beside the decision: says triage got it right, so the labelled set holds what it gets right as
 * well as Frank's corrections, and the eval scores both (FR-6.1).
 */
function TriageRight({ item }: { item: ItemSummary }) {
  if (item.confirmed)
    return (
      <span data-confirmed className="inline-flex items-center gap-1 text-[13px] text-green-fg">
        <Icon name="check" size={13} strokeWidth={2.5} /> Right · labelled
      </span>
    );
  if (!canConfirm(item)) return null;
  return (
    <button type="button" title="Add this decision to the labelled set as right (y)" className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted hover:bg-track hover:text-ink cursor-pointer" onClick={() => void confirmTriage(item)}>
      <Icon name="check" size={13} /> Triage was right <Kbd>y</Kbd>
    </button>
  );
}

// ---------- Filing feedback ----------

type FilingType = Exclude<ActionType, 'todo'>;
const FILING_TYPES: FilingType[] = ['vault_note', 'confluence_entry'];
const FIELD: Record<FilingType, 'vault' | 'confluence'> = { vault_note: 'vault', confluence_entry: 'confluence' };

/**
 * Beside the decision (E14, FR-15.7): Frank's word on the filing policy's call, for the filing eval
 * and the policy proposals. "Not for filing" and "Should be filed" correct the item as well; the
 * rest only teach the policy.
 */
function FilingFeedback({ item }: { item: ItemSummary }) {
  const { open, setOpen, close, trigger, panel } = usePopover();
  const t = item.triage;
  if (item.triageState !== 'triaged' || !t || item.status !== 'open') return null;
  const on = FILING_TYPES.filter((f) => t[FIELD[f]]);
  const off = FILING_TYPES.filter((f) => !t[FIELD[f]]);
  const send = (body: FilingFeedbackBody, done: string) => {
    close();
    void api.filingFeedback(item.id, body).then((r) => toast(`${done} · filing labels now ${r.labelCount}`, { tone: 'success' }), errorToast);
  };
  const fileIt = (f: FilingType) => {
    close();
    void api.correctTriage(item.id, { attention: t.attention, confluence: t.confluence || f === 'confluence_entry', vault: t.vault || f === 'vault_note' }).then(() => toast(`Suggested for the ${TYPE_NOUN[f]} · noted for the filing policy`, { tone: 'success' }), errorToast);
  };
  return (
    <div className="relative inline-flex">
      <button
        type="button"
        ref={trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Tell the filing policy what it got wrong"
        className="inline-flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted hover:bg-track hover:text-ink cursor-pointer"
        onClick={() => setOpen(!open)}
      >
        <Icon name="flask" size={13} /> Filing…
      </button>
      {open && (
        <PopoverPanel panelRef={panel} label="Filing feedback" role="menu" align="left" className="w-[260px]">
          {on.length > 0 && (
            <MenuItem onClick={() => send({ signal: 'not_for_filing' }, 'Taken out of To file')}>Not for filing</MenuItem>
          )}
          {on.map((f) => {
            const plan = item.filing?.[f];
            return (
              <div key={f} role="group" aria-label={TYPE_LABEL[f].short} className="flex flex-col border-t border-line-soft pt-1 mt-1">
                <span aria-hidden className="px-2.5 pb-0.5 pt-1 text-[11px] font-medium text-muted">
                  {TYPE_LABEL[f].short}
                  {plan?.rule && ` · ${plan.rule}`}
                </span>
                {plan?.predraft && <MenuItem onClick={() => send({ signal: 'no_predraft', type: f }, 'Won’t be drafted ahead')}>Don’t draft items like this ahead</MenuItem>}
                {plan?.ready ? (
                  <MenuItem onClick={() => send({ signal: 'not_ready', type: f }, 'Marked not ready to approve')}>Shouldn’t be ready to approve</MenuItem>
                ) : (
                  <MenuItem onClick={() => send({ signal: 'should_be_ready', type: f }, 'Marked ready to approve')}>Should be ready to approve</MenuItem>
                )}
              </div>
            );
          })}
          {off.map((f) => (
            <MenuItem key={f} onClick={() => fileIt(f)}>{f === 'vault_note' ? 'Should be filed to the vault' : 'Should be filed to Confluence'}</MenuItem>
          ))}
        </PopoverPanel>
      )}
    </div>
  );
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
  batch,
  sweep,
}: {
  item: ItemSummary;
  view?: ItemView;
  pos: number;
  total: number;
  /** Filing in a batch (cockpit CK-4.1–4.3): where it is, Skip (→), and what an approval does. */
  batch?: { pos: number; total: number; ready?: boolean; onSkip: () => void; onApproved: (t: ActionType) => void };
  /** The end-of-day sweep (UX-10): where it is, Skip (→), and what a reply or an approval does. Done and Snooze move it on by themselves. */
  sweep?: { pos: number; total: number; onSkip: () => void; onReplied: () => void; onApproved: (t: ActionType) => void };
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

  const file = useCallback(
    (t: ActionType) => {
      if (draftState(item, t) === 'none' && !draftButton(item, t, draftsBudgetHit).disabledReason) void api.requestDraft(item.id, t).catch(errorToast);
      setFiling(t);
    },
    [item, draftsBudgetHit, setFiling],
  );
  // From the additional-information box (FR-9.12): an error stays in the box, which shows it.
  const fileWith = useCallback((t: ActionType, additionalInfo: string) => api.requestDraft(item.id, t, { additionalInfo }).then(() => setFiling(t)), [item.id, setFiling]);
  // An edit in progress holds the panel on its draft: `a` doesn't switch it away.
  const dirtyNow = useRef(false);
  const dirty = useCallback(
    (d: boolean) => {
      dirtyNow.current = d;
      onDirty(d);
    },
    [onDirty],
  );
  const addTodo = (steps: string[]) =>
    api.requestDraft(item.id, 'todo', { steps }).then(
      () => setFiling('todo'),
      (e: unknown) => void errorToast(e),
    );
  const addSuggested = useCallback(
    () =>
      api.requestDraft(item.id, 'todo', { suggested: true }).then(
        () => setFiling('todo'),
        (e: unknown) => void errorToast(e),
      ),
    [item.id, setFiling],
  );
  useEffect(() => {
    if (filing) filingRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [filing]);
  useEffect(() => {
    body.current?.scrollTo({ top: 0 });
  }, [item.id]);

  // e Done, ⇧E Done and next, s Snooze, c Correct triage, r Reply in the source, f / v / a file to
  // Confluence, the vault or Tasks, o open as a full page.
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
      } else if (e.key === 'y' && canConfirm(item)) {
        e.preventDefault();
        void confirmTriage(item);
      } else if (e.key === 'a' && item.todoSuggestion && !dirtyNow.current) {
        // The suggested to-do (FR-15.6) first; once added or dismissed, a adds the open steps as before.
        e.preventDefault();
        void addSuggested();
      } else if ((e.key === 'a' || e.key === 'f' || e.key === 'v') && canFile(item) && !dirtyNow.current) {
        e.preventDefault();
        file(e.key === 'a' ? 'todo' : e.key === 'f' ? 'confluence_entry' : 'vault_note');
      } else if (e.key === 'r') {
        e.preventDefault();
        openInSource(item, { replying: open });
        if (open) sweep?.onReplied();
      } else if (e.key === 'ArrowRight' && (batch || sweep)) {
        e.preventDefault();
        (batch ?? sweep)!.onSkip();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [item, open, onDoneNext, setSnoozeOpen, batch, sweep, file, addSuggested]);

  const reopen = () => void api.reopen(item.id).then(() => toast(item.status === 'snoozed' ? 'Unsnoozed.' : 'Reopened.'), errorToast);
  const ago = fmtAgo(item.lastActivityAt, now);
  // A DM's header names everyone in it, not only who wrote in this item.
  const others = view?.item.id === item.id ? view.members?.filter((m) => m.id !== view.meId) : undefined;
  const group = !!others && others.length > 1;
  const who = others?.length ? others.map((m) => m.name).join(', ') : item.title;

  return (
    <aside aria-label="Item panel" className="flex h-full min-h-0 flex-col border-l border-line bg-surface shadow-[-12px_0_32px_rgba(20,23,28,0.06)]">
      <div className="flex items-center gap-1 border-b border-line-soft px-4 py-2.5">
        {batch ? (
          <>
            <span className="pl-2 text-[13px] font-semibold text-teal-ink" data-testid="batch-pos">
              {batch.ready ? 'Ready' : 'Filing'} {batch.pos} of {batch.total}
            </span>
            <span className="flex-1" />
            <Button size="sm" icon="forward" title="Skip: leave it in To file (→)" onClick={batch.onSkip}>
              Skip <Kbd>→</Kbd>
            </Button>
          </>
        ) : sweep ? (
          <>
            <span className="pl-2 text-[13px] font-semibold text-orange-fg" data-testid="sweep-pos">
              Sweep {sweep.pos} of {sweep.total}
            </span>
            <span className="hidden min-w-0 flex-1 items-center justify-center gap-1 truncate text-xs text-muted min-[1100px]:flex">
              <Kbd>e</Kbd> done <Kbd>s</Kbd> snooze <Kbd>r</Kbd> reply <Kbd>f</Kbd>
              <Kbd>v</Kbd> file
            </span>
            <span className="flex-1 min-[1100px]:hidden" />
            <Button size="sm" icon="forward" title="Skip: leave it in Needs you (→)" onClick={sweep.onSkip}>
              Skip <Kbd>→</Kbd>
            </Button>
          </>
        ) : (
          <>
            <IconButton label="Previous item" title="Previous item (k)" icon="up" onClick={onPrev} disabled={pos <= 1} />
            <IconButton label="Next item" title="Next item (j)" icon="down" onClick={onNext} disabled={pos >= total} />
            <span className="pl-1 font-mono text-xs text-muted" data-testid="panel-pos">
              {pos > 0 ? `${pos} of ${total}` : `${total} in the list`}
            </span>
            <span className="flex-1" />
          </>
        )}
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
            {!isLive(item.source) && <PhaseTag phase="P2" className="ml-2" />}
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
            <TriageRight item={item} />
            <FilingFeedback item={item} />
          </div>
          <ItemMarkers item={item} />
          {item.source === 'calendar' && view?.item.meeting && <JoinTeams joinUrl={view.item.meeting.calendar?.joinUrl} end={view.item.meeting.end} />}
          {item.source === 'wispr' && view?.item.meeting?.calendar && <OnCalendar calendar={view.item.meeting.calendar} />}
          {view?.calendarCategories && <CategoryTags tags={view.calendarCategories} />}
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

        <FinishCallout key={`finish:${item.id}`} item={item} />
        <NextStepCard
          item={item}
          draftsBudgetHit={draftsBudgetHit}
          closesOnReply={!!view?.closesOnReply}
          onFile={file}
          onFileWith={fileWith}
          onReplied={sweep?.onReplied}
          workflow={
            filing && view ? (
              <div ref={filingRef} className="scroll-mt-4">
                <ActionPanel key={item.id} embedded view={view} type={filing} setType={setFiling} onDirty={dirty} onDoneNext={onDoneNext} onClose={() => setFiling(undefined)} onApproved={batch?.onApproved ?? sweep?.onApproved} />
              </div>
            ) : undefined
          }
        />
        <SuggestedTodo key={`todo:${item.id}`} item={item} onAdd={addSuggested} />
        <Asks key={`asks:${item.id}`} item={item} />

        {item.next?.actionItems?.length ? <ActionItems key={`actions:${item.id}`} item={item} items={item.next.actionItems} onAdd={addTodo} /> : null}
        {view ? <Messages key={`messages:${item.id}`} view={view} /> : <div className="text-[13px] text-muted">Loading…</div>}


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
                    suggested={suggestedSnooze(item, now)}
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

/** The end of a batch (CK-4.3): what was filed and skipped, until Esc. */
export function BatchDone({ batch, onClose }: { batch: Batch; onClose: () => void }) {
  return (
    <aside aria-label="Filing done" className="flex h-full min-h-0 flex-col border-l border-line bg-surface shadow-[-12px_0_32px_rgba(20,23,28,0.06)]">
      <div className="flex items-center gap-1 border-b border-line-soft px-4 py-2.5">
        <span className="pl-2 text-[13px] font-semibold text-teal-ink">Filed in a batch</span>
        <span className="flex-1" />
        <IconButton label="Close panel" title="Close panel (Esc)" icon="x" onClick={onClose} />
      </div>
      <div className="flex flex-col items-start gap-3 px-6 pt-8">
        <span className="inline-flex size-10 items-center justify-center rounded-full bg-teal-wash text-teal-ink">
          <Icon name="check" size={20} strokeWidth={2.5} />
        </span>
        <h2 className="m-0 text-[19px] font-semibold" data-testid="batch-tally">
          {tally(batch)}
        </h2>
        <p className="m-0 max-w-[460px] text-sm leading-relaxed text-ink-2">
          Each filed item goes to Done once its writes land. Skipped items stay in To file.
        </p>
        <Button onClick={onClose}>
          Close <Kbd>Esc</Kbd>
        </Button>
      </div>
    </aside>
  );
}

/** The end of a sweep (UX-10): what happened to Needs you, and what is left, until Esc. */
export function SweepDone({ sweep, left, onClose }: { sweep: Sweep; left: number; onClose: () => void }) {
  return (
    <aside aria-label="Sweep done" className="flex h-full min-h-0 flex-col border-l border-line bg-surface shadow-[-12px_0_32px_rgba(20,23,28,0.06)]">
      <div className="flex items-center gap-1 border-b border-line-soft px-4 py-2.5">
        <span className="pl-2 text-[13px] font-semibold text-orange-fg">Swept Needs you</span>
        <span className="flex-1" />
        <IconButton label="Close panel" title="Close panel (Esc)" icon="x" onClick={onClose} />
      </div>
      <div className="flex flex-col items-start gap-3 px-6 pt-8">
        <span className={cx('inline-flex size-10 items-center justify-center rounded-full', left ? 'bg-orange-wash text-orange-fg' : 'bg-teal-wash text-teal-ink')}>
          <Icon name={left ? 'clock' : 'check'} size={20} strokeWidth={2.5} />
        </span>
        <h2 className="m-0 text-[19px] font-semibold" data-testid="sweep-tally">
          {sweepTally(sweep)}
        </h2>
        <p className="m-0 max-w-[460px] text-sm leading-relaxed text-ink-2">
          {left ? `${plural(left, 'item')} still in Needs you. Replies you sent close their items once they settle them.` : 'Needs you is clear. Replies you sent close their items once they settle them.'}
        </p>
        <Button onClick={onClose}>
          Close <Kbd>Esc</Kbd>
        </Button>
      </div>
    </aside>
  );
}
