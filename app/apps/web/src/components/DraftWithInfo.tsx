import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ADDITIONAL_INFO_MAX, type ActionType } from '@work-os/shared';
import { TYPE_LABEL } from '../lib/lanes';
import { errorToast } from '../store/toasts';
import { Icon, type IconName } from './icons';
import { Button, Dialog, Field, Kbd, MenuItem, PopoverPanel, cx, inputClass, usePopover } from './ui';

// Draft with additional information (FR-9.12): each draft button keeps its one click, and a menu
// beside it asks for what Frank knows that the thread doesn't (who spoke, the approach, the
// timeline) before drafting. A re-draft opens it with the text the last draft used.

const NOTE: Record<ActionType, string> = {
  vault_note: 'Sonnet drafts the note from the thread and this.',
  confluence_entry: 'Sonnet drafts the entry from the thread and this. Confluence entries still name no one: names here only help it tell who said what.',
  todo: 'Haiku writes the to-do from your open steps and this, so it counts against the drafts budget.',
};

/** The text box. `redraft`: starts from the last draft's text, and an empty box drops it. */
export function AdditionalInfoDialog({
  type,
  redraft,
  initial = '',
  warning,
  onSubmit,
  onClose,
}: {
  type: ActionType;
  redraft?: boolean;
  initial?: string;
  /** Said above the box: a re-draft that would lose Frank's edits. */
  warning?: string;
  onSubmit: (text: string | null) => Promise<unknown>;
  onClose: () => void;
}) {
  const [text, setText] = useState(initial);
  const [busy, setBusy] = useState(false);
  // Straight into the box, at the end of the text: after Dialog's own focus, as this effect runs after its.
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = box.current;
    el?.focus();
    el?.setSelectionRange(el.value.length, el.value.length);
  }, []);
  const trimmed = text.trim();
  const tooLong = trimmed.length > ADDITIONAL_INFO_MAX;
  const canSubmit = !busy && !tooLong && (!!trimmed || (!!redraft && !!initial));
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await onSubmit(trimmed || null);
      onClose();
    } catch (e) {
      errorToast(e);
      setBusy(false);
    }
  };
  const action = redraft ? 'Re-draft' : TYPE_LABEL[type].draft;
  return (
    <Dialog
      title={`${action} with additional information`}
      onClose={onClose}
      footer={
        <>
          <span className="mr-auto inline-flex items-center gap-1.5 text-xs text-muted">
            <Kbd>⌘↵</Kbd> {redraft ? 're-drafts' : type === 'todo' ? 'adds' : 'drafts'}
          </span>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="solid" disabled={!canSubmit} onClick={() => void submit()}>
            {redraft && !trimmed ? 'Re-draft without it' : action}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {warning && <p className="m-0 rounded-md bg-amber-wash px-3 py-2 text-[13px] text-amber-fg">{warning}</p>}
        <Field
          label="Additional information"
          error={tooLong ? `Up to ${ADDITIONAL_INFO_MAX} characters.` : undefined}
          help={
            <span className="flex justify-between gap-3">
              <span>{NOTE[type]}</span>
              <span className="shrink-0 tabular-nums">
                {trimmed.length}/{ADDITIONAL_INFO_MAX}
              </span>
            </span>
          }
        >
          <textarea
            ref={box}
            aria-label="Additional information"
            aria-invalid={tooLong}
            className={cx(inputClass, 'min-h-32 resize-y py-2 leading-relaxed')}
            rows={6}
            value={text}
            placeholder="e.g. Speaker 1 is Anna (Ops) and Speaker 2 is me. The rollout is planned for Q1, not Q4."
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
          />
        </Field>
        {redraft && initial && <p className="m-0 text-xs text-muted">Clear the box to re-draft without it.</p>}
      </div>
    </Dialog>
  );
}

/**
 * A draft button with a menu beside it: one click drafts as before; "… with additional information"
 * opens the text box first. `onInfo` gets the text, or null to drop the last draft's (re-draft only).
 */
export function DraftSplit({
  type,
  children,
  onDraft,
  onInfo,
  redraft,
  initial,
  warning,
  variant = 'secondary',
  size = 'md',
  icon,
  disabled,
  infoDisabledReason,
  title,
  label,
  className,
}: {
  type: ActionType;
  children?: ReactNode;
  onDraft: () => void;
  onInfo: (text: string | null) => Promise<unknown>;
  redraft?: boolean;
  initial?: string;
  warning?: string;
  variant?: 'secondary' | 'solid';
  size?: 'sm' | 'md';
  icon?: IconName;
  disabled?: boolean;
  /** Why drafting with information can't happen now (the drafts budget); the menu item says so. */
  infoDisabledReason?: string;
  title?: string;
  /** The main button's name when it shows only its icon. */
  label?: string;
  className?: string;
}) {
  const { open, setOpen, close, trigger, panel } = usePopover();
  const [asking, setAsking] = useState(false);
  // Stable: Dialog moves focus whenever its onClose changes, and the panel re-renders as items update.
  const stopAsking = useCallback(() => setAsking(false), []);
  const item = redraft ? 'Re-draft with additional information…' : `${type === 'todo' ? 'Add' : 'Draft'} with additional information…`;
  return (
    <div className={cx('relative inline-flex', className)}>
      <Button variant={variant} size={size} icon={icon} className={cx('rounded-r-none', !children && 'px-2.5')} aria-label={label} disabled={disabled} title={title ?? label} onClick={onDraft}>
        {children}
      </Button>
      <Button
        ref={trigger}
        variant={variant}
        size={size}
        // Not "Re-draft …": the button beside it keeps that name to itself.
        aria-label={redraft ? 'Draft again with additional information' : item.replace('…', '')}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={cx('rounded-l-none px-2', variant === 'solid' ? 'border-l border-white/30' : '-ml-px')}
        onClick={() => setOpen(!open)}
      >
        <Icon name="down" size={14} />
      </Button>
      {open && (
        <PopoverPanel panelRef={panel} label={redraft ? 'Re-draft options' : 'Draft options'} role="menu" align="left" className="w-max max-w-[320px]">
          <MenuItem
            disabled={!!infoDisabledReason}
            hint={infoDisabledReason && <span className="text-xs text-muted">{infoDisabledReason}</span>}
            onClick={() => {
              close(false);
              setAsking(true);
            }}
          >
            {item}
          </MenuItem>
        </PopoverPanel>
      )}
      {asking && <AdditionalInfoDialog type={type} redraft={redraft} initial={initial} warning={warning} onSubmit={onInfo} onClose={stopAsking} />}
    </div>
  );
}

/** Under a draft's heading: the information it was drafted with, behind a disclosure. */
export function DraftedWithInfo({ text, drafting }: { text: string; drafting?: boolean }) {
  return (
    <details data-additional-info className="group rounded-lg border border-line-soft bg-surface-2 px-3 py-2 text-[13px]">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
        <Icon name="info" size={14} />
        {drafting ? 'Drafting with your information' : 'Drafted with your information'}
        <Icon name="down" size={12} className="transition-transform group-open:rotate-180" />
      </summary>
      <p className="m-0 mt-2 whitespace-pre-wrap leading-relaxed text-ink">{text}</p>
    </details>
  );
}
