import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode, type Ref } from 'react';
import { Icon, type IconName } from './icons';
import { toast } from '../store/toasts';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

// ---------- Buttons (design guide: card action hierarchy) ----------

// Colour follows what the action does, not how important it is:
//   solid       the one commit action (Approve, Save)
//   secondary   neutral, reversible actions (Edit, Re-draft, Cancel)
//   danger      throws work away (Discard, Delete). Red text and a soft red edge, so it reads as
//               "careful" without competing with the primary. The confirm dialog is where red goes solid.
//   dangerSolid the confirming button in a destructive dialog only
type Variant = 'tonal' | 'secondary' | 'solid' | 'ghost' | 'danger' | 'dangerSolid' | 'future' | 'inverse';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  tonal: 'bg-accent-tonal text-accent font-semibold hover:brightness-95',
  secondary: 'border border-line-strong bg-surface text-ink font-medium hover:bg-surface-2 [&>svg]:text-ink-2',
  solid: 'bg-accent-bg text-on-solid font-semibold hover:brightness-110',
  ghost: 'text-ink-2 hover:bg-track',
  danger: 'border border-red-line bg-surface text-red-fg font-medium hover:bg-red-wash',
  dangerSolid: 'bg-red text-white font-semibold hover:brightness-110',
  future: 'border-[1.5px] border-dashed border-violet-line bg-surface text-violet-fg',
  inverse: 'bg-surface text-ink font-semibold',
};
const SIZES: Record<Size, string> = {
  sm: 'min-h-8 px-2.5 text-xs',
  md: 'min-h-9 px-3 text-[13px]',
  lg: 'min-h-11 px-5 text-sm',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  className,
  children,
  ...rest
}: { variant?: Variant; size?: Size; icon?: IconName; ref?: Ref<HTMLButtonElement> } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-lg whitespace-nowrap transition-[filter,background-color] cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:brightness-100',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {icon && <Icon name={icon} size={size === 'lg' ? 16 : 14} strokeWidth={variant === 'solid' ? 2.5 : 2} />}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  icon,
  size = 36,
  bordered,
  active,
  className,
  children,
  ...rest
}: { label: string; icon?: IconName; size?: number; bordered?: boolean; active?: boolean; ref?: Ref<HTMLButtonElement> } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      style={{ width: size, height: size }}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-lg text-ink-2 cursor-pointer hover:bg-track disabled:opacity-40 disabled:cursor-not-allowed',
        bordered && 'border border-line-strong bg-surface',
        active && 'bg-track',
        className,
      )}
      {...rest}
    >
      {icon ? <Icon name={icon} size={18} /> : children}
    </button>
  );
}

// ---------- Scope tags ----------

export type Phase = 'P2' | 'P3' | 'P4';

export function PhaseTag({ phase, className }: { phase: Phase; className?: string }) {
  return (
    <span className={cx('rounded border border-dashed border-violet-line px-1.5 py-px font-mono text-[10px] text-violet-fg', className)}>{phase}</span>
  );
}

export function MvpTag({ children = 'MVP' }: { children?: ReactNode }) {
  return <span className="rounded bg-solid px-1.5 py-0.5 font-mono text-[11px] text-on-solid">{children}</span>;
}

const PHASE_COPY: Record<Phase, string> = {
  P2: 'Planned for Phase 2 (more sources). Not part of the MVP.',
  P3: 'Planned for Phase 3 (more actions). Not part of the MVP.',
  P4: 'Planned for Phase 4 (Work OS). Not part of the MVP.',
};

export const phaseToast = (phase: Phase, what: string) => toast(`${what}: ${PHASE_COPY[phase]}`);

/** A dashed, non-interactive placeholder button for later phases. */
export function FutureButton({ phase, label, primary, size = 'md' }: { phase: Phase; label: string; primary?: boolean; size?: Size }) {
  return (
    <Button variant="future" size={size} className={cx(primary && 'bg-violet-wash-2 font-semibold')} onClick={() => phaseToast(phase, label)} aria-describedby={undefined}>
      {label}
      <span className="font-mono text-[10px] font-normal">{phase}</span>
    </Button>
  );
}

// ---------- Inputs ----------

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
  size = 'md',
}: {
  options: { value: T; label: ReactNode; icon?: IconName }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="group" aria-label={label} className={cx('inline-flex gap-1 rounded-[10px] bg-track p-1', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cx(
              'inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-[7px] px-3 text-[13px] font-medium cursor-pointer',
              size === 'sm' ? 'min-h-8' : 'min-h-9',
              on ? 'bg-seg-on text-ink shadow-[0_1px_2px_rgba(20,23,28,0.12)]' : 'text-muted hover:text-ink',
            )}
          >
            {o.icon && <Icon name={o.icon} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative h-[24px] w-[42px] shrink-0 rounded-full transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
        checked ? 'bg-accent-bg' : 'bg-off',
      )}
    >
      {/* Sized in px: the root font size is 14px, so rem-based sizes would not line up with the knob offset. */}
      <span
        className="absolute left-[3px] top-[3px] h-[18px] w-[18px] rounded-full bg-knob shadow-[0_1px_2px_rgba(0,0,0,0.25)] transition-transform"
        style={{ transform: `translateX(${checked ? 18 : 0}px)` }}
      />
    </button>
  );
}

/** Input styling without a width, for fields that set their own. */
export const inputBase = 'min-h-10 rounded-lg border border-line-strong bg-surface px-2.5 text-sm text-ink outline-none focus:border-accent aria-[invalid=true]:border-red';
export const inputClass = `w-full ${inputBase}`;

export function Field({ label, help, error, children, className }: { label: ReactNode; help?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('flex flex-col gap-1.5 text-[13px] font-medium', className)}>
      {label}
      {children}
      {error ? <span className="text-xs font-normal text-red-fg">{error}</span> : help ? <span className="text-xs font-normal text-muted">{help}</span> : null}
    </label>
  );
}

// ---------- Status chips ----------

export function Chip({ tone = 'neutral', icon, children }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'accent'; icon?: IconName; children: ReactNode }) {
  const tones = {
    neutral: 'bg-bg text-ink-2',
    ok: 'bg-teal-wash-2 text-teal-ink',
    warn: 'bg-amber-wash text-amber-fg',
    bad: 'bg-red-line/40 text-red-fg',
    accent: 'bg-accent-wash text-accent-ink',
  };
  return (
    <span className={cx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs', tones[tone])}>
      {icon && <Icon name={icon} size={12} strokeWidth={2.5} />}
      {children}
    </span>
  );
}

export function Dot({ color, hollow }: { color: string; hollow?: boolean }) {
  return hollow ? (
    <span className="inline-block h-2 w-2 shrink-0 rounded-full border-[1.5px] border-gray-mid" />
  ) : (
    <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Banner({
  tone,
  icon,
  children,
  action,
  onDismiss,
}: {
  tone: 'warn' | 'bad' | 'info' | 'dry' | 'ok';
  icon?: IconName;
  children: ReactNode;
  action?: ReactNode;
  onDismiss?: () => void;
}) {
  const tones = {
    warn: 'bg-amber-wash border-amber/40 text-ink',
    dry: 'bg-amber-wash border-amber/30 text-ink',
    bad: 'bg-surface border-red-line text-ink',
    info: 'bg-accent-wash border-accent-line text-ink',
    ok: 'bg-teal-wash border-teal-line text-ink',
  };
  const iconColour = { warn: 'text-amber-fg', dry: 'text-amber-fg', bad: 'text-red-fg', info: 'text-accent', ok: 'text-teal-ink' };
  return (
    <div role="status" className={cx('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border px-3.5 py-2 text-[13px]', tones[tone])}>
      {icon && <Icon name={icon} className={iconColour[tone]} />}
      <div className="min-w-0 flex-[1_1_260px]">{children}</div>
      {action}
      {onDismiss && <IconButton label="Dismiss" icon="x" size={30} onClick={onDismiss} />}
    </div>
  );
}

// ---------- Popover & dialog ----------

/**
 * Open state for a popover that closes on outside click and Esc, returning focus to its trigger.
 * Pass `trigger` and `panel` as callback refs.
 */
export function usePopover() {
  const [open, setOpen] = useState(false);
  const [triggerEl, trigger] = useState<HTMLElement | null>(null);
  const [panelEl, panel] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !panelEl) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (panelEl.contains(t) || triggerEl?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        triggerEl?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    panelEl.querySelector<HTMLElement>('button:not(:disabled), input, [tabindex]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, panelEl, triggerEl]);
  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) triggerEl?.focus();
  };
  return { open, setOpen, close, trigger, panel };
}

export function PopoverPanel({
  panelRef,
  children,
  className,
  role = 'dialog',
  label,
  align = 'right',
  side = 'bottom',
}: {
  panelRef: Ref<HTMLDivElement>;
  children: ReactNode;
  className?: string;
  role?: 'dialog' | 'menu';
  label: string;
  align?: 'left' | 'right';
  side?: 'top' | 'bottom';
}) {
  return (
    <div
      ref={panelRef}
      role={role}
      aria-label={label}
      className={cx(
        'absolute z-40 rounded-[10px] border border-line bg-surface p-1.5 shadow-[0_12px_32px_rgba(20,23,28,0.14)]',
        side === 'bottom' ? 'top-[calc(100%+4px)]' : 'bottom-[calc(100%+4px)]',
        align === 'right' ? 'right-0' : 'left-0',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function MenuItem({ children, onClick, disabled, tone, hint }: { children: ReactNode; onClick: () => void; disabled?: boolean; tone?: 'future' | 'default'; hint?: ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex min-h-9 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] cursor-pointer hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50',
        tone === 'future' ? 'text-violet-fg' : 'text-ink',
      )}
    >
      <span className="flex-1">{children}</span>
      {hint}
    </button>
  );
}

export function Dialog({ title, children, onClose, footer, width = 560 }: { title: string; children: ReactNode; onClose: () => void; footer?: ReactNode; width?: number }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      prev?.focus();
    };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-[rgba(15,17,21,0.45)] px-4 py-[8vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={id} className="flex w-full flex-col rounded-[14px] border border-line bg-surface shadow-[0_24px_64px_rgba(20,23,28,0.25)]" style={{ maxWidth: width }}>
        <div className="flex items-center gap-2 border-b border-line-soft px-5 py-4">
          <h2 id={id} className="m-0 flex-1 text-[17px] font-semibold">
            {title}
          </h2>
          <IconButton label="Close" icon="x" onClick={onClose} />
        </div>
        <div className="px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-soft bg-surface-3 px-5 py-3 rounded-b-[14px]">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      width={440}
      footer={
        <>
          <Button onClick={onCancel}>Cancel</Button>
          <Button variant={danger ? 'dangerSolid' : 'solid'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="text-sm leading-relaxed text-ink-2">{body}</div>
    </Dialog>
  );
}

export function SectionCard({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx('rounded-xl border border-line bg-surface', className)}>{children}</section>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded border border-b-2 border-line-strong bg-surface px-[3px] font-mono text-[10px] leading-none text-muted">
      {children}
    </kbd>
  );
}
