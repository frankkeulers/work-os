import { useState, type KeyboardEvent } from 'react';
import type { TodoEdit, TodoSummary } from '@work-os/shared';
import { api } from '../../api';
import { Button, PopoverPanel, cx, inputBase, type usePopover } from '../../components/ui';
import { errorToast } from '../../store/toasts';

// A To Do's plan on its row (E15, FR-16.6, FR-16.7): the estimate as a chip, dimmed when the model
// was unsure, its why on hover. The chip, or `p` on the row, opens the editor: Frank's own
// estimate and deadline, which the plan never overrides.

/** The lengths offered: on Done for how long it took (FR-16.5), and here for how long it should take. */
export const LENGTHS: readonly (readonly [number, string])[] = [
  [15, '15m'],
  [30, '30m'],
  [60, '1h'],
  [120, '2h'],
  [240, 'Half day'],
];

export const durLabel = (m: number) => LENGTHS.find(([n]) => n === m)?.[1] ?? (m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`);

/** The offered length nearest an estimate: the one Done's chips mark as Work OS's guess. */
export const nearestLength = (m: number) => LENGTHS.reduce((best, [n]) => (Math.abs(Math.log(n / m)) < Math.abs(Math.log(best / m)) ? n : best), LENGTHS[0][0]);

/** "2026-10-12T16:30" in the browser's zone, as a datetime-local input wants it. */
const local = (iso: string) => {
  const d = new Date(iso);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

type Popover = ReturnType<typeof usePopover>;

export function EstimateChip({ todo, open, setOpen, close, trigger, panel }: { todo: TodoSummary } & Popover) {
  const mine = todo.effortBy === 'you';
  const unsure = !mine && todo.confidence === 'low';
  const text = todo.effortMinutes ? `${mine ? '' : '~'}${durLabel(todo.effortMinutes)}` : todo.planning ? 'Planning…' : 'Estimate';
  const title = todo.effortMinutes
    ? mine
      ? 'Your estimate. Click to change it (p).'
      : `${unsure ? 'A rough estimate' : 'Work OS’s estimate'}${todo.estimateWhy ? `: ${todo.estimateWhy}` : ''} Click to change it (p).`
    : todo.planning
      ? 'Work OS is estimating it. Click to set it yourself (p).'
      : 'No estimate. Click to set one (p).';
  return (
    <span className="relative shrink-0">
      <button
        ref={trigger}
        type="button"
        data-todo-estimate={todo.effortMinutes ?? ''}
        aria-label={`Plan: ${todo.step}`}
        aria-expanded={open}
        title={title}
        onClick={() => setOpen(!open)}
        className={cx(
          'inline-flex h-6 items-center rounded-md border px-1.5 text-xs tabular-nums cursor-pointer hover:bg-surface-2',
          todo.effortMinutes ? 'border-line-soft text-ink-2' : 'border-dashed border-line text-muted',
          unsure && 'opacity-60',
          mine && 'font-semibold',
        )}
      >
        {text}
      </button>
      {open && (
        <PopoverPanel panelRef={panel} label={`Plan: ${todo.step}`} className="w-[300px] p-3">
          <PlanEditor todo={todo} onDone={() => close()} />
        </PopoverPanel>
      )}
    </span>
  );
}

function PlanEditor({ todo, onDone }: { todo: TodoSummary; onDone: () => void }) {
  const [minutes, setMinutes] = useState<number | undefined>(todo.effortMinutes);
  const [other, setOther] = useState(todo.effortMinutes && !LENGTHS.some(([n]) => n === todo.effortMinutes) ? String(todo.effortMinutes) : '');
  const [deadline, setDeadline] = useState(todo.deadline ? local(todo.deadline) : '');
  const [saving, setSaving] = useState(false);
  const typed = Number(other);
  const effort = other ? (Number.isInteger(typed) && typed >= 5 && typed <= 960 ? typed : undefined) : minutes;
  const badOther = !!other && effort === undefined;
  const save = async () => {
    const edit: TodoEdit = {};
    if (effort !== undefined && effort !== todo.effortMinutes) edit.effortMinutes = effort;
    const iso = deadline ? new Date(deadline).toISOString() : null;
    if (iso !== (todo.deadline ?? null)) edit.deadline = iso;
    if (edit.effortMinutes === undefined && edit.deadline === undefined) return onDone();
    setSaving(true);
    try {
      await api.editTodo(todo.id, edit);
      onDone();
    } catch (e) {
      errorToast(e);
      setSaving(false);
    }
  };
  // Keys here are the editor's, not the row's or the item panel's; Enter saves.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') return;
    e.stopPropagation();
    if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement)) {
      e.preventDefault();
      if (!badOther) void save();
    }
  };
  return (
    <div className="flex flex-col gap-3" onKeyDown={onKeyDown}>
      <div>
        <div className="mb-1.5 text-xs font-semibold text-ink-2">How long it should take</div>
        <div role="group" aria-label="How long it should take" className="flex flex-wrap gap-1">
          {LENGTHS.map(([m, label]) => (
            <button
              key={m}
              type="button"
              aria-pressed={!other && minutes === m}
              onClick={() => (setMinutes(m), setOther(''))}
              className={cx('rounded-full border px-2 py-0.5 text-xs cursor-pointer', !other && minutes === m ? 'border-violet-line bg-violet-wash font-semibold text-violet-fg' : 'border-line-soft text-ink-2 hover:bg-surface-2')}
            >
              {label}
            </button>
          ))}
          <label className="inline-flex items-center gap-1 text-xs text-muted">
            <input aria-label="Minutes" aria-invalid={badOther} inputMode="numeric" value={other} onChange={(e) => setOther(e.target.value.replace(/\D/g, ''))} placeholder="Other" className="h-6 w-14 rounded-full border border-line-strong bg-surface px-2 text-xs text-ink outline-none focus:border-accent aria-[invalid=true]:border-red" />
            min
          </label>
        </div>
        {todo.estimateWhy && todo.effortBy !== 'you' && <p className="m-0 mt-1.5 text-xs text-muted">Work OS: {todo.estimateWhy}</p>}
      </div>
      <div>
        <label className="mb-1.5 block text-xs font-semibold text-ink-2" htmlFor={`deadline-${todo.id}`}>
          Deadline
        </label>
        <div className="flex items-center gap-2">
          <input id={`deadline-${todo.id}`} type="datetime-local" value={deadline} onChange={(e) => setDeadline(e.target.value)} className={cx(inputBase, 'min-h-8 flex-1 text-xs')} />
          {deadline && (
            <button type="button" onClick={() => setDeadline('')} className="text-xs text-muted cursor-pointer hover:text-ink hover:underline">
              None
            </button>
          )}
        </div>
        {todo.ideal && <p className="m-0 mt-1.5 text-xs text-muted">Ideally sooner{todo.idealWhy ? `: ${todo.idealWhy}` : ''}. Setting a deadline replaces it.</p>}
      </div>
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" variant="solid" disabled={saving || badOther} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
