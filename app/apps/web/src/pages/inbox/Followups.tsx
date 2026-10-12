import { useEffect, useRef, useState } from 'react';
import { FOLLOWUP_LABEL, type Followup, type TodoSummary } from '@work-os/shared';
import { api } from '../../api';
import { Kbd, cx } from '../../components/ui';
import { Icon } from '../../components/icons';
import { onTopics, useApiQuery } from '../../hooks/useApiQuery';
import { errorToast, toast } from '../../store/toasts';

// Follow-ups on Done (E15, FR-16.11–16.12): what usually comes next once a To Do is done, under its
// Done toast (keys 1 to 3 while it shows) and on its row under Done today until answered. Each is
// Frank's to do, with one click: Work OS never sends anything (NF-4).
// - A reply is copied, and its conversation opens: paste it and send it yourself. Edit it first if
//   you like.
// - Closing the item is the item's own Done, with Undo.
// - A next To Do is written to the Tasks note at once: the card shows the exact line, so the
//   click is the approval.
// - A note to file starts the usual vault draft, which you still approve.
// Frank's answer is sent before the follow-up is done, so doing it himself never reads as missed.

/** The card that takes keys 1 to 3: the newest. */
let keyOwner = 0;
let cards = 0;

/** Does one follow-up, and records Frank's answer first. `text`: his own words for a reply. */
export async function runFollowup(todo: TodoSummary, index: number, f: Followup, opts: { text?: string; onOpen?: (itemId: string) => void } = {}) {
  try {
    const edited = f.kind === 'reply' && opts.text !== undefined && opts.text.trim() !== f.reply?.text;
    await api.answerFollowup(todo.id, index, edited ? { answer: 'edited', text: opts.text!.trim() } : { answer: 'accepted' });
    if (f.kind === 'reply') {
      const text = edited ? opts.text!.trim() : f.reply!.text;
      await navigator.clipboard?.writeText(text).catch(() => undefined);
      if (todo.permalink) window.open(todo.permalink, '_blank', 'noopener,noreferrer');
      toast('Reply copied', { description: `Paste it in ${todo.sourceTitle} and send it yourself.` });
    } else if (f.kind === 'mark_source_done') {
      await api.markDone(todo.itemId);
      toast(`Done · ${todo.sourceTitle}`, { action: { label: 'Undo', run: () => void api.reopen(todo.itemId).catch(errorToast) } });
    } else if (f.kind === 'add_todo') {
      const a = await api.requestDraft(todo.itemId, 'todo', { steps: [f.todo!.step] });
      await api.approveAction(a.id);
      toast('To Do added', { description: f.todo!.step });
    } else {
      await api.requestDraft(todo.itemId, 'vault_note');
      opts.onOpen?.(todo.itemId);
      toast('Drafting a vault note', { description: 'Review it in the item before it is filed.' });
    }
  } catch (e) {
    errorToast(e);
  }
}

const dismiss = (todo: TodoSummary, index: number) => void api.answerFollowup(todo.id, index, { answer: 'dismissed' }).catch(errorToast);

function Suggestion({ todo, f, index, n, keys, onOpen }: { todo: TodoSummary; f: Followup; index: number; n: number; keys: boolean; onOpen?: (itemId: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(f.reply?.text ?? '');
  return (
    <li data-followup={f.kind} className="flex flex-col gap-1 rounded-lg border border-line-soft bg-surface-2/60 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => void runFollowup(todo, index, f, { ...(editing && { text }), onOpen })} className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-accent cursor-pointer hover:underline">
          {keys && (
            <span aria-hidden>
              <Kbd>{n}</Kbd>
            </span>
          )}
          {FOLLOWUP_LABEL[f.kind]}
        </button>
        {f.kind === 'reply' && !editing && (
          <button type="button" onClick={() => setEditing(true)} className="text-xs text-muted cursor-pointer hover:text-ink hover:underline">
            Edit
          </button>
        )}
        <button type="button" aria-label={`Not this: ${FOLLOWUP_LABEL[f.kind]}`} title="Not this one" onClick={() => dismiss(todo, index)} className="ml-auto inline-flex h-5 w-5 items-center justify-center rounded text-muted cursor-pointer hover:bg-surface-2 hover:text-ink">
          <Icon name="x" size={12} />
        </button>
      </div>
      {f.kind === 'reply' &&
        (editing ? (
          <textarea aria-label="Your reply" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.stopPropagation()} rows={3} className="w-full resize-y rounded-md border border-line-strong bg-surface px-2 py-1 text-[13px] text-ink outline-none focus:border-accent" />
        ) : (
          <p className="m-0 whitespace-pre-wrap border-l-2 border-line pl-2 text-[13px] text-ink-2">{f.reply?.text}</p>
        ))}
      {f.kind === 'add_todo' && <p className="m-0 border-l-2 border-line pl-2 text-[13px] text-ink-2">{f.todo?.step}</p>}
      <p className="m-0 text-xs text-muted">{f.why}</p>
    </li>
  );
}

/** The follow-ups still to answer on a done To Do; "Suggesting follow-ups…" while they come. */
export function FollowupList({ todo, keys = false, onOpen }: { todo: TodoSummary; keys?: boolean; onOpen?: (itemId: string) => void }) {
  const open = (todo.followups ?? []).flatMap((f, index) => (f.answer ? [] : [{ f, index }]));
  const me = useRef(0);
  useEffect(() => {
    if (!keys) return;
    me.current = ++cards;
    keyOwner = me.current;
    return () => {
      if (keyOwner === me.current) keyOwner = 0;
    };
  }, [keys]);
  useEffect(() => {
    if (!keys || !open.length) return;
    const onKey = (e: KeyboardEvent) => {
      if (keyOwner !== me.current || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]')) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > open.length) return;
      e.preventDefault();
      const { f, index } = open[n - 1];
      void runFollowup(todo, index, f, { onOpen });
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [keys, open, todo, onOpen]);
  if (todo.followupsPending) return <p className="m-0 mt-1.5 text-xs text-muted">Suggesting follow-ups…</p>;
  if (!open.length) return null;
  return (
    <div aria-label="Follow-ups" role="group" className="mt-2 flex flex-col gap-1.5">
      <span className="text-xs font-semibold text-ink-2">Next</span>
      <ul className={cx('m-0 flex list-none flex-col gap-1.5 p-0')}>
        {open.map(({ f, index }, i) => (
          <Suggestion key={index} todo={todo} f={f} index={index} n={i + 1} keys={keys} onOpen={onOpen} />
        ))}
      </ul>
    </div>
  );
}

/** Under the Done toast: the To Do as the inbox has it now, so the follow-ups show as they arrive. */
export function DoneFollowups({ todoId, onOpen }: { todoId: string; onOpen?: (itemId: string) => void }) {
  const todo = useApiQuery(() => api.getInbox(), onTopics('inbox'), []).data?.todos.find((t) => t.id === todoId);
  if (!todo || todo.status !== 'done') return null;
  return <FollowupList todo={todo} keys onOpen={onOpen} />;
}
