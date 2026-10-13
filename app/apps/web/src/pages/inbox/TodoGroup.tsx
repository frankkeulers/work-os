import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { MIRROR_FAILURE, NO_SLOT, todoGroups, type TodoGroup as Group, type TodoSummary } from '@work-os/shared';
import { api } from '../../api';
import { usePrefs } from '../../store/prefs';
import { errorToast, toast } from '../../store/toasts';
import { SourceMark } from '../../components/BrandIcon';
import { Icon } from '../../components/icons';
import { IconButton, cx, usePopover } from '../../components/ui';
import { useNow } from '../../hooks/useNow';
import { fmtTime, fmtWhen } from '../../lib/format';
import { dueInfo } from '../../lib/next';
import { DueChip } from './chips';
import { DoneFollowups, FollowupList } from './Followups';
import { EstimateChip, LENGTHS, durLabel, nearestLength, slotLabel } from './TodoPlan';

// To Dos on the inbox (E15, FR-16.2): every line Frank wrote to the Tasks note, with where it came
// from and when it is due, grouped by when he'll do it: what needs a look, then today, tomorrow
// and later. The list layout has a To do group after Needs you; the cockpit has them in one place,
// the time column, as blocks on the day and as a list under its To Dos tab. A row opens its source item;
// its ✓, or `e` on it, marks it done and ticks its line in the Tasks note (FR-16.4). Its estimate,
// and when it would ideally be done, come from the model (FR-16.6); Frank can set both (FR-16.7).
// When he'll do it is free time code found in his calendar (FR-16.8), or his own (FR-16.9). Once
// done, what usually comes next is suggested under the toast and on the row (FR-16.11).

const HEAD: Record<Exclude<Group, 'done'>, string> = { look: 'Needs a look', today: 'Today', tomorrow: 'Tomorrow', later: 'Later' };
const OPEN: readonly Exclude<Group, 'done'>[] = ['look', 'today', 'tomorrow', 'later'];

const PLAN_EVENT = 'workos:todo-plan';
/** A plan asked for before its row was there: the row opens it once it mounts. */
let pendingPlan: string | undefined;

/**
 * Opens a To Do's plan from its block in the time column: the column turns to its To Dos, and the
 * row takes focus and opens the editor.
 */
export function openTodoPlan(todoId: string) {
  pendingPlan = todoId;
  const prefs = usePrefs.getState();
  prefs.setTimeCollapsed(false);
  prefs.setTimeTodos(true);
  window.dispatchEvent(new CustomEvent<string>(PLAN_EVENT, { detail: todoId }));
}

/** On the cockpit, `g d`: the time column turns to its To Dos, and the first open one takes focus. */
export function focusFirstTodo() {
  const prefs = usePrefs.getState();
  prefs.setTimeCollapsed(false);
  prefs.setTimeTodos(true);
  const focus = () => {
    const row = document.querySelector<HTMLElement>('[data-todo][data-todo-status="open"]');
    row?.focus();
    row?.scrollIntoView({ block: 'nearest' });
    return !!row;
  };
  if (!focus()) requestAnimationFrame(focus);
}

/** How many To Dos are open, and how many of those need a look, for the To Dos tab. */
export function todoCounts(todos: readonly TodoSummary[], now: Date) {
  const g = todoGroups(todos, now);
  return { open: OPEN.reduce((n, k) => n + g[k].length, 0), look: g.look.length };
}

/** When Frank will do it (FR-16.8, FR-16.9): the slot, or why there is none and when it would first fit. */
function SlotNote({ todo, now, onPlan }: { todo: TodoSummary; now: Date; onPlan: () => void }) {
  const s = todo.slot;
  if (s) {
    const mine = s.by === 'you';
    return (
      <button
        type="button"
        data-todo-slot={s.by}
        data-clash={s.clash || undefined}
        title={`${mine ? 'Your time for it' : 'Free time Work OS found for it: nothing is booked'}${s.clash ? '. A meeting is on at the same time' : ''}${s.passed ? '. This time has gone by' : ''}. Click to change it (p).`}
        onClick={onPlan}
        className={cx('inline-flex shrink-0 items-center gap-1 rounded border px-1 tabular-nums cursor-pointer hover:bg-surface-2', mine ? 'border-violet-line' : 'border-dashed border-violet-line', s.passed ? 'text-muted' : 'text-violet-fg')}
      >
        {s.clash && <span aria-label="Clashes with a meeting" className="size-1.5 rounded-full bg-red" />}
        {slotLabel(s, now)}
      </button>
    );
  }
  const none = todo.noSlot;
  if (!none || none.reason === 'no_calendar') return null;
  return (
    <span data-todo-noslot={none.reason} className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-1 text-amber-fg">
      · {NO_SLOT[none.reason]}
      {none.firstAfter && (
        <>
          <span className="text-muted">· first free {slotLabel(none.firstAfter, now)}</span>
          <button type="button" onClick={() => void api.editTodo(todo.id, { slot: none.firstAfter }).catch(errorToast)} className="font-medium text-accent-ink cursor-pointer hover:underline" title="Do it then: keep this time for it">
            Use
          </button>
        </>
      )}
    </span>
  );
}

/**
 * How long it took (FR-16.5): one tap, a second tap on the same chip takes it back. The chip
 * nearest the estimate is marked, not picked: skipping the question records nothing.
 */
function TookChips({ todoId, initial, estimate }: { todoId: string; initial?: number; estimate?: number }) {
  const guess = estimate ? nearestLength(estimate) : undefined;
  const [picked, setPicked] = useState(initial);
  const pick = (m: number) => {
    const next = picked === m ? undefined : m;
    setPicked(next);
    void api.setTodoActual(todoId, next ?? null).catch(errorToast);
  };
  return (
    <div role="group" aria-label="How long it took" className="mt-1.5 flex flex-wrap items-center gap-1">
      <span className="mr-0.5 text-xs text-muted">Took</span>
      {LENGTHS.map(([m, label]) => (
        <button
          key={m}
          type="button"
          aria-pressed={picked === m}
          title={m === guess ? 'Nearest Work OS’s estimate' : undefined}
          onClick={() => pick(m)}
          className={cx('rounded-full border px-2 py-0.5 text-xs cursor-pointer', picked === m ? 'border-violet-line bg-violet-wash font-semibold text-violet-fg' : m === guess ? 'border-dashed border-violet-line text-ink-2 hover:bg-surface-2' : 'border-line-soft text-ink-2 hover:bg-surface-2')}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/**
 * Done on a To Do (FR-16.4): its line ticked in the Tasks note, a toast that says so, with how
 * long it took to pick (FR-16.5), what comes next once suggested (FR-16.11), and Undo, which
 * unticks it.
 */
export async function markTodoDone(todo: TodoSummary, onOpen?: (itemId: string) => void) {
  try {
    const now = await api.markTodoDone(todo.id);
    const failed = now?.mirror?.failed;
    toast(`Done · ${todo.step}`, {
      description: failed ? `Not ticked: ${MIRROR_FAILURE[failed]}` : now?.mirror ? 'Ticking it in the Tasks note…' : 'Ticked in the Tasks note',
      ttl: 20_000,
      body: (
        <>
          <TookChips todoId={todo.id} initial={now?.actualMinutes} estimate={todo.effortMinutes} />
          <DoneFollowups todoId={todo.id} onOpen={onOpen} />
        </>
      ),
      action: { label: 'Undo', run: () => void api.reopenTodo(todo.id).catch(errorToast) },
    });
  } catch (e) {
    errorToast(e);
  }
}

async function reopenTodo(todo: TodoSummary) {
  try {
    const now = await api.reopenTodo(todo.id);
    const failed = now?.mirror?.failed;
    toast(`Open again · ${todo.step}`, { description: failed ? `Not unticked: ${MIRROR_FAILURE[failed]}` : 'Unticked in the Tasks note' });
  } catch (e) {
    errorToast(e);
  }
}

/** A To Do's row. Compact in the time column, which is narrow: its step on two lines, and its chips with the rest under it. */
function TodoRow({ todo, now, onOpen, compact }: { todo: TodoSummary; now: Date; onOpen: (itemId: string) => void; compact?: boolean }) {
  const done = todo.status === 'done';
  const due = !done && todo.deadline ? dueInfo({ dueAt: todo.deadline }, now) : undefined;
  const pop = usePopover();
  const { setOpen } = pop;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const plan = () => {
      if (pendingPlan !== todo.id || done) return;
      pendingPlan = undefined;
      ref.current?.scrollIntoView({ block: 'nearest' });
      ref.current?.focus();
      setOpen(true);
    };
    plan(); // asked for before this row was there
    window.addEventListener(PLAN_EVENT, plan);
    return () => window.removeEventListener(PLAN_EVENT, plan);
  }, [todo.id, done, setOpen]);
  // Keys on a focused row are its own (`g d` focuses the first): the item panel's don't see them.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.key === 'e' || e.key === 'E') && !done) void markTodoDone(todo, onOpen);
    else if (e.key === 'p' && !done) setOpen(true);
    else if (e.key === 'Enter') onOpen(todo.itemId);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };
  return (
    <div
      ref={ref}
      data-todo={todo.id}
      data-todo-status={todo.status}
      tabIndex={0}
      aria-label={`To do: ${todo.step}`}
      onKeyDown={onKeyDown}
      className="group/todo flex items-center gap-3 border-t border-line-soft px-6 py-2.5 outline-none focus-visible:bg-surface-2 focus-visible:shadow-[inset_3px_0_0_var(--violet-dot)]"
    >
      <Icon name="commit" size={16} aria-hidden className={cx('shrink-0', done ? 'text-green-fg' : 'text-violet-fg')} />
      <div className="min-w-0 flex-1">
        <div className={cx('text-[13px]', compact ? 'line-clamp-2' : 'truncate', done ? 'text-muted line-through' : 'font-medium text-ink')} title={todo.step}>
          {todo.step}
        </div>
        <div className={cx('flex min-w-0 items-center gap-2 text-xs text-muted', compact && 'mt-1 flex-wrap gap-y-1')}>
          <button type="button" data-open-item onClick={() => onOpen(todo.itemId)} title="Open the item it came from" className={cx('inline-flex min-w-0 items-center gap-1 truncate cursor-pointer hover:text-ink-2 hover:underline', compact && 'max-w-full')}>
            <SourceMark source={todo.source} size={12} decorative />
            <span className="truncate">{todo.sourceTitle}</span>
          </button>
          {!done && <SlotNote todo={todo} now={now} onPlan={() => setOpen(true)} />}
          {compact && !done && <EstimateChip todo={todo} {...pop} />}
          {compact && due && <DueChip due={due} />}
          {done && todo.doneAt && <span className="shrink-0">· {todo.doneBy === 'tasks_note' ? 'ticked in Obsidian' : 'done'} {fmtTime(todo.doneAt)}</span>}
          {done && todo.actualMinutes && <span className="shrink-0">· took {durLabel(todo.actualMinutes)}</span>}
          {!done && todo.ideal && (
            <span data-todo-ideal className="shrink-0 text-violet-fg" title={todo.idealWhy ? `Work OS: ${todo.idealWhy}` : undefined}>
              · ideally {fmtWhen(todo.ideal, now)}
            </span>
          )}
          {todo.mirror?.failed ? (
            <span data-todo-mirror="failed" className="shrink-0 text-amber-fg" title={`Work OS tries again every 10 minutes: ${MIRROR_FAILURE[todo.mirror.failed]}.`}>
              · not {todo.mirror.want === 'ticked' ? 'ticked' : 'unticked'} in the Tasks note
            </span>
          ) : (
            todo.inNote === false && (
              <span className="shrink-0 text-amber-fg" title="Its line isn't in the Tasks note any more. It may have been moved or deleted in Obsidian.">
                · not in the Tasks note
              </span>
            )
          )}
        </div>
        {done && todo.followups && <FollowupList todo={todo} onOpen={onOpen} />}
      </div>
      {!compact && !done && <EstimateChip todo={todo} {...pop} />}
      {!compact && due && <DueChip due={due} />}
      {/* As an item row's Done: faint until the row is hovered or focused. */}
      {done ? (
        <IconButton label={`Open again: ${todo.step}`} title="Open again, and untick it in the Tasks note" icon="undo" size={32} className="-mr-2 text-muted opacity-60 hover:text-ink hover:opacity-100 focus-visible:opacity-100 group-hover/todo:opacity-100" onClick={() => void reopenTodo(todo)} />
      ) : (
        <IconButton label={`Done: ${todo.step}`} title="Done, and tick it in the Tasks note (e)" icon="check" size={32} className="-mr-2 text-muted opacity-60 hover:text-ink hover:opacity-100 focus-visible:opacity-100 group-hover/todo:opacity-100 group-focus-visible/todo:opacity-100" onClick={() => void markTodoDone(todo, onOpen)} />
      )}
    </div>
  );
}

/** "3 done today", folded until clicked. */
function DoneToday({ done, now, onOpen, compact }: { done: TodoSummary[]; now: Date; onOpen: (itemId: string) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  if (!done.length) return null;
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 border-t border-line-soft px-6 py-2 text-left text-xs text-muted cursor-pointer hover:bg-surface-2 hover:text-ink-2">
        <Icon name="check" size={13} />
        {done.length} done today
        <Icon name="down" size={12} className={cx('transition-transform', !open && '-rotate-90')} />
      </button>
      {open && done.map((t) => <TodoRow key={t.id} todo={t} now={now} onOpen={onOpen} compact={compact} />)}
    </>
  );
}

function SubHead({ group, count }: { group: Exclude<Group, 'done'>; count: number }) {
  return (
    <h3 data-todo-head={group} className={cx('m-0 border-t px-6 py-1.5 text-xs font-semibold tracking-[0.04em]', group === 'look' ? 'border-red-line bg-red-wash text-red-fg' : 'border-line-soft bg-surface-2 text-violet-fg')}>
      {HEAD[group].toUpperCase()} · {count}
    </h3>
  );
}

function Groups({ g, show, now, onOpen, compact }: { g: Record<Group, TodoSummary[]>; show: readonly Exclude<Group, 'done'>[]; now: Date; onOpen: (itemId: string) => void; compact?: boolean }) {
  return show.map((k) =>
    g[k].length ? (
      <div key={k} data-todo-group={k}>
        <SubHead group={k} count={g[k].length} />
        {g[k].map((t) => (
          <TodoRow key={t.id} todo={t} now={now} onOpen={onOpen} compact={compact} />
        ))}
      </div>
    ) : null,
  );
}

function Head({ count, children }: { count: number; children?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-6 pb-2 pt-3">
      <span className="h-[9px] w-[9px] shrink-0 self-center rounded-[3px]" style={{ background: 'var(--violet-dot)' }} />
      <h2 className="m-0 text-[15px] font-semibold">To do</h2>
      <span className="font-mono text-xs text-muted">{count}</span>
      {children}
    </div>
  );
}

/** The list layout's To do group: what needs a look, today, tomorrow, later, then those done today, folded. */
export function TodoGroup({ todos, onOpen }: { todos: readonly TodoSummary[]; onOpen: (itemId: string) => void }) {
  const now = useNow(30_000);
  const g = todoGroups(todos, now);
  const open = OPEN.reduce((n, k) => n + g[k].length, 0);
  if (!open && !g.done.length) return null;
  return (
    <section aria-label="To do" data-group="todo" className="flex flex-col pb-3">
      <Head count={open} />
      <div className="border-b border-line-soft">
        {open ? <Groups g={g} show={OPEN} now={now} onOpen={onOpen} /> : <div className="border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing left to do.</div>}
        <DoneToday done={g.done} now={now} onOpen={onOpen} />
      </div>
    </section>
  );
}

/** The cockpit's To Dos (FR-16.2): every one, under the time column's To Dos tab, grouped as the list layout's. */
export function TodoDrawer({ todos, onOpen }: { todos: readonly TodoSummary[]; onOpen: (itemId: string) => void }) {
  const now = useNow(30_000);
  const g = todoGroups(todos, now);
  const open = OPEN.reduce((n, k) => n + g[k].length, 0);
  return (
    <section aria-label="To Dos" data-testid="todo-drawer" className="-mx-5 -mt-4 min-h-0 flex-1 overflow-y-auto pb-4">
      {open ? <Groups g={g} show={OPEN} now={now} onOpen={onOpen} compact /> : <p className="m-0 px-6 py-3 text-[13px] text-muted">Nothing to do.</p>}
      <DoneToday done={g.done} now={now} onOpen={onOpen} compact />
      <div className="border-t border-line-soft" />
    </section>
  );
}
