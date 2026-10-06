import { useState, type ReactNode } from 'react';
import { Icon } from '../../components/icons';
import { FutureButton, PhaseTag, cx, inputBase, type Phase } from '../../components/ui';

// Building blocks for the settings views. See DESIGN.md: one surface, hairline dividers,
// label left and control right, wide controls stacked under their label.

export function SectionHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start gap-x-6 gap-y-3 border-b border-line pb-5">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
        <h2 className="m-0 text-lg font-semibold tracking-[-0.01em]">{title}</h2>
        {description && <p className="m-0 text-[13px] leading-normal text-muted">{description}</p>}
      </div>
      {action}
    </div>
  );
}

/** A titled run of rows inside a section. */
export function Group({ title, aside, children }: { title?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col">
      {title && (
        <div className="flex items-center gap-3 border-b border-line-soft pb-2 pt-8">
          <h3 className="m-0 flex-1 text-[13px] font-semibold text-ink">{title}</h3>
          {aside}
        </div>
      )}
      {children}
    </div>
  );
}

/**
 * One setting. Inline rows put a compact control at the right edge; stacked rows put a wide
 * control under the label at full width.
 */
export function Row({
  label,
  help,
  htmlFor,
  error,
  children,
  id,
  tone,
  stacked,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  error?: string;
  children: ReactNode;
  id?: string;
  tone?: 'warn';
  stacked?: boolean;
}) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div
      id={id}
      className={cx(
        'flex scroll-mt-24 gap-x-10 gap-y-3 border-b border-line-soft py-5 last:border-b-0',
        stacked ? 'flex-col' : 'flex-col sm:flex-row sm:items-center',
        tone === 'warn' && '-mx-4 rounded-lg border-b-0 bg-amber-wash px-4',
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <Label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {label}
        </Label>
        {help && <div className="max-w-[560px] text-[13px] leading-normal text-muted">{help}</div>}
      </div>
      <div className={cx('flex min-w-0 flex-col gap-1.5', stacked ? 'items-stretch' : 'shrink-0 items-start sm:items-end')}>
        {children}
        {error && <span className="text-xs text-red-fg">{error}</span>}
      </div>
    </div>
  );
}

export function NumInput({
  id,
  label,
  value,
  onChange,
  onBlur,
  invalid,
  suffix,
  prefix,
  step,
  width = 'w-20',
  placeholder,
}: {
  id?: string;
  label: string;
  value: number | null;
  onChange: (v: number | null) => void;
  onBlur: () => void;
  invalid?: boolean;
  suffix?: string;
  prefix?: string;
  step?: string;
  width?: string;
  placeholder?: string;
}) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-muted">
      {prefix}
      <input
        id={id}
        type="number"
        step={step}
        aria-label={label}
        aria-invalid={invalid}
        placeholder={placeholder}
        className={cx(inputBase, width, 'text-right text-ink')}
        value={value === null || Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        onBlur={onBlur}
      />
      {suffix}
    </span>
  );
}

export function ChipInput({ label, items, onChange, channel, placeholder = 'Add…' }: { label: string; items: string[]; onChange: (v: string[]) => void; channel?: boolean; placeholder?: string }) {
  const [text, setText] = useState('');
  const add = () => {
    let v = text.trim().replace(/,$/, '');
    if (!v) return;
    if (channel && !v.startsWith('#')) v = `#${v}`;
    if (!items.includes(v)) onChange([...items, v]);
    setText('');
  };
  return (
    <div className="flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent">
      {items.map((it) => (
        <span key={it} className="inline-flex items-center gap-0.5 rounded-md bg-track py-0.5 pl-2 pr-0.5 text-[13px]">
          {it}
          <button type="button" aria-label={`Remove ${it}`} className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-track-2 hover:text-ink cursor-pointer" onClick={() => onChange(items.filter((x) => x !== it))}>
            <Icon name="x" size={12} />
          </button>
        </span>
      ))}
      <input
        aria-label={`Add to ${label}`}
        placeholder={items.length ? 'Add…' : placeholder}
        className="min-w-[140px] flex-1 border-0 bg-transparent px-1 text-[13px] text-ink outline-none"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') {
            e.preventDefault();
            add();
          } else if (e.key === 'Backspace' && !text && items.length) onChange(items.slice(0, -1));
        }}
        onBlur={add}
      />
    </div>
  );
}

export function Meter({ used, limit, text }: { used: number; limit: number; text: string }) {
  const pct = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      {text}
      <span className="h-1 w-16 overflow-hidden rounded-full bg-track">
        <span className={cx('block h-full rounded-full', pct >= 1 ? 'bg-red' : pct >= 0.8 ? 'bg-amber' : 'bg-accent')} style={{ width: `${pct * 100}%` }} />
      </span>
    </span>
  );
}

/** A later-phase setting, shown only in Full scope. */
export function FutureRow({ title, phase, children, cta }: { title: string; phase: Phase; children: ReactNode; cta?: string }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border-[1.5px] border-dashed border-violet-line bg-violet-wash px-4 py-3.5">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          <PhaseTag phase={phase} />
        </div>
        <div className="text-[13px] leading-normal text-ink-2">{children}</div>
      </div>
      {cta && <FutureButton phase={phase} label={cta} size="sm" />}
    </div>
  );
}
