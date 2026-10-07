import { useState } from 'react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Rule as RuleSchema, isValidRegex, type NamedList, type Rule, type RuleCondition, type RuleOutcome } from '@work-os/shared';
import { ChannelPicker } from './ChannelPicker';
import { DragIcon, Icon } from './icons';
import { Button, ConfirmDialog, Dialog, Field, IconButton, Segmented, Switch, cx, inputBase, inputClass } from './ui';

export const LIST_LABEL: Record<NamedList, string> = {
  vips: 'VIPs',
  includeChannels: 'Included channels',
  excludeChannels: 'Excluded channels',
  customerChannels: 'Customer channels',
};

export function conditionText(c: RuleCondition): string {
  switch (c.type) {
    case 'is_dm':
      return 'is DM';
    case 'mentions_me':
      return 'mentions you';
    case 'keyword':
      return `keyword ${c.pattern}`;
    case 'sender_in':
    case 'channel_in': {
      const what = c.type === 'sender_in' ? 'sender' : 'channel';
      const parts = [c.list ? LIST_LABEL[c.list] : '', ...c.values].filter(Boolean);
      return `${what} in ${parts.join(', ') || '…'}`;
    }
  }
}

export function outcomeText(o: RuleOutcome): string {
  if (o.type === 'model') return o.min ? `Model, at least ${o.min === 'now' ? 'Now' : 'Today'}` : 'Model';
  if (o.type === 'file') return 'File';
  return o.type === 'now' ? 'Now' : o.type === 'today' ? 'Today' : 'Drop';
}

const OUTCOME_CLS: Record<RuleOutcome['type'], string> = {
  now: 'bg-orange-wash text-orange-fg',
  today: 'bg-accent-wash-3 text-accent-ink',
  model: 'bg-accent-wash text-accent-ink',
  drop: 'bg-line-soft text-ink-2',
  file: 'bg-teal-wash text-teal-ink',
};

// ---------- List ----------

function RuleRow({
  rule,
  n,
  hits,
  error,
  onToggle,
  onEdit,
}: {
  rule: Rule;
  n: number;
  hits: number | undefined;
  error?: string;
  onToggle: (v: boolean) => void;
  onEdit: () => void;
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: rule.id });
  return (
    <div
      ref={setNodeRef}
      data-rule={rule.id}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cx('relative flex items-center gap-3 border-b border-line-soft bg-surface py-3.5', isDragging && 'z-10 shadow-[0_8px_24px_rgba(20,23,28,0.18)]', error && 'bg-red-line/10')}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        aria-label={`Reorder ${rule.id}`}
        title="Drag to reorder, or focus and use the arrow keys"
        className="inline-flex h-9 w-7 shrink-0 items-center justify-center rounded text-faint cursor-grab hover:bg-track active:cursor-grabbing"
        {...attributes}
        {...listeners}
      >
        <DragIcon />
      </button>
      <span className="w-5 shrink-0 text-center font-mono text-xs text-muted">{n}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className={cx('flex flex-wrap items-center gap-1.5', !rule.enabled && 'opacity-55')}>
          <span className="text-[13px] font-semibold text-muted">If</span>
          {rule.conditions.map((c, i) => (
            <span key={i} className="inline-flex min-h-7 items-center gap-1.5 rounded-md bg-surface-2 px-2.5 text-[13px] ring-1 ring-line-soft ring-inset">
              {i > 0 && <span className="text-[11px] font-semibold uppercase text-muted">and</span>}
              {conditionText(c)}
            </span>
          ))}
          <Icon name="arrow" size={14} className="text-muted" />
          <span className={cx('inline-flex min-h-7 items-center rounded-md px-2.5 text-[13px] font-semibold', OUTCOME_CLS[rule.outcome.type])}>{outcomeText(rule.outcome)}</span>
        </div>
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
          <span className="font-mono">{rule.id}</span>
          <span aria-hidden>·</span>
          <span>{!rule.enabled ? 'Off' : hits === undefined ? 'Not run yet' : `${hits} ${hits === 1 ? 'match' : 'matches'} today`}</span>
        </div>
        {error && <span className="text-xs text-red-fg">{error}. Open the rule to fix it.</span>}
      </div>
      <Switch checked={rule.enabled} onChange={onToggle} label={`Enable ${rule.id}`} />
      <IconButton label={`Edit ${rule.id}`} icon="edit" onClick={onEdit} />
    </div>
  );
}

export type RuleEdit = { index: number | null; rule: Rule } | null;

export const newRuleEdit = (): RuleEdit => ({ index: null, rule: { id: '', enabled: true, conditions: [{ type: 'mentions_me' }], outcome: { type: 'model', min: 'today' } } });

export function RulesList({
  rules,
  hits,
  errorFor,
  onChange,
  editing,
  setEditing,
}: {
  rules: Rule[];
  hits: Record<string, number>;
  errorFor: (index: number) => string | undefined;
  onChange: (rules: Rule[]) => void;
  /** The rule dialog, controlled so the section header can hold the Add rule button. */
  editing: RuleEdit;
  setEditing: (e: RuleEdit) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const onDragEnd = (e: DragEndEvent) => {
    if (!e.over || e.active.id === e.over.id) return;
    const from = rules.findIndex((r) => r.id === e.active.id);
    const to = rules.findIndex((r) => r.id === e.over!.id);
    onChange(arrayMove(rules, from, to));
  };
  return (
    <>
      <div className="flex flex-col" aria-label="Rules, in order">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd} accessibility={{ screenReaderInstructions: { draggable: 'Press space to pick up a rule, the arrow keys to move it, and space again to drop it.' } }}>
          <SortableContext items={rules.map((r) => r.id)} strategy={verticalListSortingStrategy}>
            {rules.map((r, i) => (
              <RuleRow
                key={r.id}
                rule={r}
                n={i + 1}
                hits={hits[r.id]}
                error={errorFor(i)}
                onToggle={(v) => onChange(rules.map((x, j) => (j === i ? { ...x, enabled: v } : x)))}
                onEdit={() => setEditing({ index: i, rule: structuredClone(r) })}
              />
            ))}
          </SortableContext>
        </DndContext>
        <div className="flex items-center gap-3 py-3.5">
          <span className="w-7 shrink-0" />
          <span className="w-5 shrink-0 text-center font-mono text-xs text-muted">∞</span>
          <span className="flex-1 text-[13px] text-muted">No rule matched → batched Haiku triage after the quiet window</span>
          <span className="text-xs text-muted">Always last</span>
        </div>
      </div>
      {editing && (
        <RuleDialog
          initial={editing.rule}
          isNew={editing.index === null}
          otherIds={rules.filter((_, i) => i !== editing.index).map((r) => r.id)}
          onCancel={() => setEditing(null)}
          onDelete={() => {
            onChange(rules.filter((_, i) => i !== editing.index));
            setEditing(null);
          }}
          onApply={(rule) => {
            onChange(editing.index === null ? [...rules, rule] : rules.map((x, i) => (i === editing.index ? rule : x)));
            setEditing(null);
          }}
        />
      )}
    </>
  );
}

// ---------- Editor ----------

const COND_TYPES: { value: RuleCondition['type']; label: string }[] = [
  { value: 'sender_in', label: 'Sender in' },
  { value: 'channel_in', label: 'Channel in' },
  { value: 'mentions_me', label: 'Mentions you' },
  { value: 'is_dm', label: 'Is a DM' },
  { value: 'keyword', label: 'Keyword (regex)' },
];

function blankCondition(type: RuleCondition['type']): RuleCondition {
  if (type === 'sender_in') return { type, list: 'vips', values: [] };
  if (type === 'channel_in') return { type, list: 'customerChannels', values: [] };
  if (type === 'keyword') return { type, pattern: '' };
  return { type };
}

function ConditionEditor({ c, onChange, onRemove, error, canRemove, index }: { c: RuleCondition; onChange: (c: RuleCondition) => void; onRemove: () => void; error?: string; canRemove: boolean; index: number }) {
  const listOptions = (c.type === 'sender_in' ? ['vips'] : ['includeChannels', 'excludeChannels', 'customerChannels']) as NamedList[];
  return (
    <div className="flex flex-col gap-2 rounded-[10px] border border-line bg-surface-2 p-3" data-condition={index}>
      <div className="flex flex-wrap items-end gap-2.5">
        {index > 0 && <span className="pb-2.5 text-[11px] font-semibold uppercase text-muted">and</span>}
        <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          Condition
          <select className={cx(inputBase, 'w-[180px]')} value={c.type} onChange={(e) => onChange(blankCondition(e.target.value as RuleCondition['type']))}>
            {COND_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        {(c.type === 'sender_in' || c.type === 'channel_in') && (
          <>
            <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
              Named list
              <select className={cx(inputBase, 'w-[190px]')} value={c.list ?? ''} onChange={(e) => onChange({ ...c, list: (e.target.value || undefined) as NamedList | undefined })}>
                <option value="">None, use values</option>
                {listOptions.map((l) => (
                  <option key={l} value={l}>
                    {LIST_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            {c.type === 'sender_in' && (
              <label className="flex min-w-[200px] flex-1 flex-col gap-1 text-xs font-medium text-ink-2">
                {c.list ? 'Also these (comma-separated)' : 'Values (comma-separated)'}
                <input
                  className={inputClass}
                  aria-invalid={!!error}
                  value={c.values.join(', ')}
                  placeholder="Name, Name"
                  onChange={(e) =>
                    onChange({
                      ...c,
                      values: e.target.value
                        .split(',')
                        .map((v) => v.trim())
                        .filter((v, i, a) => v || i === a.length - 1),
                    })
                  }
                  onBlur={() => onChange({ ...c, values: c.values.filter(Boolean) })}
                />
              </label>
            )}
          </>
        )}
        {c.type === 'keyword' && (
          <label className="flex min-w-[240px] flex-1 flex-col gap-1 text-xs font-medium text-ink-2">
            Pattern
            <input className={cx(inputClass, 'font-mono')} aria-invalid={!!error} value={c.pattern} placeholder="/blocked|urgent/i" onChange={(e) => onChange({ ...c, pattern: e.target.value })} />
          </label>
        )}
        <span className="flex-1" />
        {canRemove && <IconButton label="Remove condition" icon="x" onClick={onRemove} />}
      </div>
      {c.type === 'channel_in' && (
        // Its own full-width line, for room to search and hold several chips. A div, not a label:
        // a label would pass clicks on its text to the first chip's remove button.
        <div className="flex flex-col gap-1 text-xs font-medium text-ink-2">
          {c.list ? 'Also these channels' : 'Channels'}
          <ChannelPicker label={c.list ? 'Also these channels' : 'Channels'} values={c.values} invalid={!!error} onChange={(values) => onChange({ ...c, values })} />
        </div>
      )}
      {error ? (
        <span className="text-xs text-red-fg">{error}</span>
      ) : c.type === 'keyword' && c.pattern && isValidRegex(c.pattern) ? (
        <span className="text-xs text-teal-ink">Valid pattern. Matches against every message in the thread.</span>
      ) : null}
    </div>
  );
}

type OutcomeKey = RuleOutcome['type'];

function RuleDialog({
  initial,
  isNew,
  otherIds,
  onCancel,
  onApply,
  onDelete,
}: {
  initial: Rule;
  isNew: boolean;
  otherIds: string[];
  onCancel: () => void;
  onApply: (r: Rule) => void;
  onDelete: () => void;
}) {
  const [rule, setRule] = useState<Rule>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState(false);

  const apply = () => {
    const e: Record<string, string> = {};
    const parsed = RuleSchema.safeParse(rule);
    if (!parsed.success) for (const i of parsed.error.issues) e[i.path.join('.')] ??= i.message;
    if (otherIds.includes(rule.id)) e.id = `A rule called "${rule.id}" already exists`;
    rule.conditions.forEach((c, i) => {
      if ((c.type === 'sender_in' || c.type === 'channel_in') && !c.list && c.values.filter(Boolean).length === 0) e[`conditions.${i}.values`] = 'Pick a named list or add at least one value';
    });
    setErrors(e);
    if (Object.keys(e).length === 0 && parsed.success) onApply(parsed.data);
  };

  const condError = (i: number) => Object.entries(errors).find(([k]) => k.startsWith(`conditions.${i}.`))?.[1];
  const outcomeKey: OutcomeKey = rule.outcome.type;

  return (
    <>
      <Dialog
        title={isNew ? 'Add rule' : `Edit rule ${initial.id}`}
        onClose={onCancel}
        width={680}
        footer={
          <>
            {!isNew && (
              <Button variant="danger" className="mr-auto" onClick={() => setConfirmDelete(true)}>
                Delete rule
              </Button>
            )}
            <Button onClick={onCancel}>Cancel</Button>
            <Button variant="solid" onClick={apply}>
              {isNew ? 'Add rule' : 'Apply'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Rule id" error={errors.id} help="Lower-case letters, digits and hyphens. Shown in triage decisions and the event log.">
            <input className={cx(inputClass, 'font-mono')} aria-invalid={!!errors.id} value={rule.id} placeholder="e.g. customer-escalations" onChange={(e) => setRule({ ...rule, id: e.target.value })} />
          </Field>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">If all of these match</span>
            {rule.conditions.map((c, i) => (
              <ConditionEditor
                key={i}
                index={i}
                c={c}
                error={condError(i)}
                canRemove={rule.conditions.length > 1}
                onChange={(nc) => setRule({ ...rule, conditions: rule.conditions.map((x, j) => (j === i ? nc : x)) })}
                onRemove={() => setRule({ ...rule, conditions: rule.conditions.filter((_, j) => j !== i) })}
              />
            ))}
            {errors.conditions && <span className="text-xs text-red-fg">{errors.conditions}</span>}
            <Button className="self-start" icon="plus" onClick={() => setRule({ ...rule, conditions: [...rule.conditions, blankCondition('keyword')] })}>
              Add condition
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-[13px] font-medium">Then</span>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented<OutcomeKey>
                label="Outcome"
                value={outcomeKey}
                onChange={(v) => setRule({ ...rule, outcome: v === 'model' ? { type: 'model', min: 'today' } : { type: v } })}
                options={[
                  { value: 'now', label: 'Now' },
                  { value: 'today', label: 'Today' },
                  { value: 'model', label: 'Ask the model' },
                  { value: 'file', label: 'File' },
                  { value: 'drop', label: 'Drop' },
                ]}
              />
              {rule.outcome.type === 'model' && (
                <label className="flex items-center gap-2 text-[13px]">
                  at least
                  <select className={cx(inputBase, 'w-[120px]')} value={rule.outcome.min ?? ''} onChange={(e) => setRule({ ...rule, outcome: { type: 'model', min: (e.target.value || undefined) as 'today' | 'now' | undefined } })}>
                    <option value="">no minimum</option>
                    <option value="today">Today</option>
                    <option value="now">Now</option>
                  </select>
                </label>
              )}
            </div>
            <span className="text-xs leading-normal text-muted">
              {rule.outcome.type === 'drop'
                ? 'Dropped threads are never stored or triaged.'
                : rule.outcome.type === 'model'
                  ? 'The thread still goes to batched model triage; the result is raised to the minimum if lower.'
                  : rule.outcome.type === 'file'
                    ? 'The model still summarises the thread and suggests where to file it (the vault if it suggests nowhere), then it goes to File for review. Put rules for mentions and VIPs above this one, or they won’t reach Now or Today.'
                    : 'A fixed outcome skips the model call entirely.'}
            </span>
          </div>
        </div>
      </Dialog>
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete rule ${initial.id}?`}
          body="The rule stops running straight away. You can still undo it from the “Changes saved” message."
          confirmLabel="Delete rule"
          danger
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            setConfirmDelete(false);
            onDelete();
          }}
        />
      )}
    </>
  );
}
