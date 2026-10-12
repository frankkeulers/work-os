import { useState, type ReactNode } from 'react';
import { todoGroups, type TodoGroup as Group, type TodoSummary } from '@work-os/shared';
import { SourceMark } from '../../components/BrandIcon';
import { Icon } from '../../components/icons';
import { cx } from '../../components/ui';
import { useNow } from '../../hooks/useNow';
import { fmtTime } from '../../lib/format';
import { dueInfo } from '../../lib/next';
import { DueChip } from './chips';

// To Dos on the inbox (E15, FR-16.2): every line Frank wrote to the Tasks note, with where it came
// from and when it is due. The list layout has a To do group after Needs you; the cockpit puts
// what is overdue or due today in Needs you and the rest in Later. A row opens its source item.

const HEAD: Record<Exclude<Group, 'done'>, string> = { overdue: 'Overdue', today: 'Today', upcoming: 'Upcoming' };

function TodoRow({ todo, now, onOpen }: { todo: TodoSummary; now: Date; onOpen: (itemId: string) => void }) {
  const done = todo.status === 'done';
  const due = !done && todo.deadline ? dueInfo({ dueAt: todo.deadline }, now) : undefined;
  return (
    <div data-todo={todo.id} data-todo-status={todo.status} className="flex items-center gap-3 border-t border-line-soft px-6 py-2.5">
      <Icon name="commit" size={16} aria-hidden className={cx('shrink-0', done ? 'text-green-fg' : 'text-violet-fg')} />
      <div className="min-w-0 flex-1">
        <div className={cx('truncate text-[13px]', done ? 'text-muted line-through' : 'font-medium text-ink')} title={todo.step}>
          {todo.step}
        </div>
        <div className="flex min-w-0 items-center gap-2 text-xs text-muted">
          <button type="button" data-open-item onClick={() => onOpen(todo.itemId)} title="Open the item it came from" className="inline-flex min-w-0 items-center gap-1 truncate cursor-pointer hover:text-ink-2 hover:underline">
            <SourceMark source={todo.source} size={12} decorative />
            <span className="truncate">{todo.sourceTitle}</span>
          </button>
          {done && todo.doneAt && <span className="shrink-0">· {todo.doneBy === 'tasks_note' ? 'ticked in Obsidian' : 'done'} {fmtTime(todo.doneAt)}</span>}
          {todo.inNote === false && (
            <span className="shrink-0 text-amber-fg" title="Its line isn't in the Tasks note any more. It may have been moved or deleted in Obsidian.">
              · not in the Tasks note
            </span>
          )}
        </div>
      </div>
      {due && <DueChip due={due} />}
    </div>
  );
}

/** "3 done today", folded until clicked. */
function DoneToday({ done, now, onOpen }: { done: TodoSummary[]; now: Date; onOpen: (itemId: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!done.length) return null;
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 border-t border-line-soft px-6 py-2 text-left text-xs text-muted cursor-pointer hover:bg-surface-2 hover:text-ink-2">
        <Icon name="check" size={13} />
        {done.length} done today
        <Icon name="down" size={12} className={cx('transition-transform', !open && '-rotate-90')} />
      </button>
      {open && done.map((t) => <TodoRow key={t.id} todo={t} now={now} onOpen={onOpen} />)}
    </>
  );
}

function SubHead({ group, count }: { group: Exclude<Group, 'done'>; count: number }) {
  return (
    <h3 data-todo-head={group} className={cx('m-0 border-t px-6 py-1.5 text-xs font-semibold tracking-[0.04em]', group === 'overdue' ? 'border-red-line bg-red-wash text-red-fg' : 'border-line-soft bg-surface-2 text-violet-fg')}>
      {HEAD[group].toUpperCase()} · {count}
    </h3>
  );
}

function Groups({ g, show, now, onOpen }: { g: Record<Group, TodoSummary[]>; show: readonly Exclude<Group, 'done'>[]; now: Date; onOpen: (itemId: string) => void }) {
  return show.map((k) =>
    g[k].length ? (
      <div key={k}>
        <SubHead group={k} count={g[k].length} />
        {g[k].map((t) => (
          <TodoRow key={t.id} todo={t} now={now} onOpen={onOpen} />
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

/** The list layout's To do group: overdue, today, upcoming, then those done today, folded. */
export function TodoGroup({ todos, onOpen }: { todos: readonly TodoSummary[]; onOpen: (itemId: string) => void }) {
  const now = useNow(30_000);
  const g = todoGroups(todos, now);
  const open = g.overdue.length + g.today.length + g.upcoming.length;
  if (!open && !g.done.length) return null;
  return (
    <section aria-label="To do" data-group="todo" className="flex flex-col pb-3">
      <Head count={open} />
      <div className="border-b border-line-soft">
        {open ? <Groups g={g} show={['overdue', 'today', 'upcoming']} now={now} onOpen={onOpen} /> : <div className="border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing left to do.</div>}
        <DoneToday done={g.done} now={now} onOpen={onOpen} />
      </div>
    </section>
  );
}

/** The cockpit's Needs you (CK-3.8): To Dos overdue or due today, under Now and Today. */
export function TodoNeeds({ todos, onOpen }: { todos: readonly TodoSummary[]; onOpen: (itemId: string) => void }) {
  const now = useNow(30_000);
  const g = todoGroups(todos, now);
  const count = g.overdue.length + g.today.length;
  if (!count) return null;
  return (
    <section aria-label="To do today" data-group="todo-today" className="flex flex-col">
      <h3 className="m-0 border-t border-violet-line bg-violet-wash px-6 py-1.5 text-xs font-semibold tracking-[0.04em] text-violet-fg">TO DO · {count}</h3>
      {[...g.overdue, ...g.today].map((t) => (
        <TodoRow key={t.id} todo={t} now={now} onOpen={onOpen} />
      ))}
      <div className="border-t border-line-soft" />
    </section>
  );
}

/** The cockpit's Later (CK-3.11): upcoming To Dos, and those done today. */
export function TodoLater({ todos, onOpen }: { todos: readonly TodoSummary[]; onOpen: (itemId: string) => void }) {
  const now = useNow(30_000);
  const g = todoGroups(todos, now);
  if (!g.upcoming.length && !g.done.length) return null;
  return (
    <section aria-label="To do" data-group="todo" className="mt-2 flex flex-col">
      <div className="flex min-h-11 items-center border-t border-line px-6 py-2">
        <span aria-hidden className="mr-2 size-2 shrink-0 rounded-full" style={{ background: 'var(--violet-dot)' }} />
        <h3 className="m-0 text-[13px] font-semibold">To do</h3>
        <span className="ml-1.5 text-xs text-muted tabular-nums">{g.upcoming.length}</span>
      </div>
      {g.upcoming.length ? g.upcoming.map((t) => <TodoRow key={t.id} todo={t} now={now} onOpen={onOpen} />) : <p className="m-0 border-t border-line-soft px-6 py-3 text-[13px] text-muted">Nothing due later.</p>}
      <DoneToday done={g.done} now={now} onOpen={onOpen} />
    </section>
  );
}
