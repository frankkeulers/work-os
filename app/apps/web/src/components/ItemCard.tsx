import { forwardRef, useImperativeHandle, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { ActionType, Attention } from '@work-os/shared';
import { api, type ItemSummary } from '../api';
import { useNow } from '../hooks/useNow';
import { fmtAgo, fmtDayDate, fmtTime } from '../lib/format';
import { cardActions, type DraftButton } from '../lib/lanes';
import { tomorrowAt9 } from '../lib/time';
import { usePrefs } from '../store/prefs';
import { errorToast, toast } from '../store/toasts';
import { Icon, MoreIcon } from './icons';
import { Button, IconButton, MenuItem, PhaseTag, PopoverPanel, Segmented, cx, inputClass, phaseToast, usePopover } from './ui';

export const itemPath = (id: string, q = '') => `/item/${encodeURIComponent(id)}${q}`;

export function SourceIcon({ kind }: { kind: ItemSummary['kind'] }) {
  return <Icon name={kind === 'dm' ? 'dm' : kind === 'email' ? 'mail' : kind === 'meeting' ? 'meet' : 'hash'} size={14} />;
}

export function openInSlack(item: { permalink: string; title: string }) {
  toast(`Opens ${item.title} in Slack. The prototype doesn’t launch Slack.`, {
    action: {
      label: 'Copy link',
      run: () => {
        void navigator.clipboard?.writeText(item.permalink).catch(() => undefined);
        toast('Permalink copied.');
      },
    },
  });
}

export async function markDoneWithUndo(item: ItemSummary) {
  try {
    await api.markDone(item.id);
    toast(`Done · ${item.title}`, {
      action: {
        label: 'Undo',
        run: () => void api.reopen(item.id).catch(errorToast),
      },
    });
  } catch (e) {
    errorToast(e);
  }
}

/** Markers that explain why a card looks the way it does. */
export function ItemMarkers({ item }: { item: ItemSummary }) {
  const m: ReactNode[] = [];
  if (item.backFromSnooze) m.push(<Marker key="snz" tone="accent" icon="clock">Back from snooze</Marker>);
  if (item.newReplies && item.triageState === 'pending') m.push(<Marker key="nr" tone="accent">New replies · re-triage pending</Marker>);
  else if (item.newReplies) m.push(<Marker key="nr" tone="accent">New replies</Marker>);
  if (item.modelPaused) m.push(<Marker key="mp" tone="warn">Model triage paused (budget)</Marker>);
  if (item.correctedFrom) m.push(<Marker key="cf" tone="neutral">Re-triaged after new replies · you had set {cap(item.correctedFrom)}</Marker>);
  else if (item.triage?.by === 'user') m.push(<Marker key="c" tone="neutral">Corrected by you</Marker>);
  const stale = Object.values(item.actions).some((a) => a?.stale);
  if (stale) m.push(<Marker key="st" tone="warn">Draft out of date</Marker>);
  return m.length ? <div className="flex flex-wrap gap-1">{m}</div> : null;
}

const cap = (a: Attention) => (a === 'none' ? 'None' : a === 'now' ? 'Now' : 'Today');

function Marker({ tone, icon, children }: { tone: 'accent' | 'warn' | 'neutral'; icon?: 'clock'; children: ReactNode }) {
  const tones = { accent: 'bg-accent-wash text-accent-ink', warn: 'bg-amber-wash text-amber-fg', neutral: 'bg-bg text-ink-2' };
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', tones[tone])}>
      {icon && <Icon name={icon} size={11} />}
      {children}
    </span>
  );
}

// ---------- Draft button ----------

function DraftActionButton({ itemId, b, primary }: { itemId: string; b: DraftButton; primary?: boolean }) {
  const navigate = useNavigate();
  const go = () => navigate(itemPath(itemId, b.state === 'none' ? `?draft=${b.type}` : `?tab=${b.type}`));
  const icon = b.state === 'done' ? 'check' : b.state === 'failed' ? 'alert' : undefined;
  return (
    <span title={b.disabledReason} className="inline-flex">
      <Button
        variant={primary ? 'tonal' : 'secondary'}
        disabled={!!b.disabledReason && b.state === 'none'}
        onClick={go}
        icon={icon}
        className={cx(b.state === 'done' && 'text-teal-ink', b.state === 'failed' && 'text-red-fg', (b.state === 'ready' || b.state === 'stale') && !primary && 'border-accent-line text-accent')}
      >
        {(b.state === 'drafting' || b.state === 'writing') && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-current" />}
        {b.label}
      </Button>
    </span>
  );
}

// ---------- Popovers ----------

export function SnoozeMenu({ onPick, now }: { onPick: (iso: string) => void; now: Date }) {
  const [custom, setCustom] = useState(false);
  const inHour = new Date(now.getTime() + 3600_000).toISOString();
  const tomorrow = tomorrowAt9(now);
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [value, setValue] = useState(local(new Date(now.getTime() + 3 * 3600_000)));
  return (
    <div className="flex w-[240px] flex-col">
      <MenuItem onClick={() => onPick(inHour)} hint={<span className="font-mono text-[11px] text-muted">{fmtTime(inHour)}</span>}>
        1 hour
      </MenuItem>
      <MenuItem onClick={() => onPick(tomorrow)} hint={<span className="font-mono text-[11px] text-muted">{fmtDayDate(tomorrow)}</span>}>
        Tomorrow 09:00
      </MenuItem>
      {!custom ? (
        <MenuItem onClick={() => setCustom(true)}>Custom…</MenuItem>
      ) : (
        <form
          className="flex flex-col gap-2 px-2.5 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            onPick(new Date(value).toISOString());
          }}
        >
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-2">
            Snooze until
            <input type="datetime-local" className={cx(inputClass, 'min-h-9 text-[13px]')} value={value} min={local(now)} onChange={(e) => setValue(e.target.value)} />
          </label>
          <Button type="submit" variant="solid" size="sm">
            Snooze
          </Button>
        </form>
      )}
    </div>
  );
}

export function CorrectForm({ item, onDone, compact }: { item: ItemSummary; onDone: (labelCount: number, lane: string) => void; compact?: boolean }) {
  const t = item.triage;
  const [attention, setAttention] = useState<Attention>(t?.attention ?? 'none');
  const [conf, setConf] = useState(!!t?.confluence);
  const [vault, setVault] = useState(!!t?.vault);
  const [busy, setBusy] = useState(false);
  const toggle = (on: boolean, label: string, set: (v: boolean) => void, disabled?: string) => (
    <button
      type="button"
      aria-pressed={on}
      disabled={!!disabled}
      title={disabled}
      onClick={() => set(!on)}
      className={cx('min-h-10 rounded-lg border px-3.5 text-[13px] font-medium cursor-pointer disabled:cursor-not-allowed disabled:opacity-50', on ? 'border-teal bg-teal-wash text-ink' : 'border-line-strong bg-surface text-ink')}
    >
      {label}
    </button>
  );
  const lane = attention === 'now' ? 'Now' : attention === 'today' ? 'Today' : conf || vault ? 'File' : 'Everything else';
  return (
    <div className={cx('flex flex-col gap-3', compact ? 'w-[300px] p-2' : '')}>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-2">Attention</span>
        <Segmented<Attention>
          label="Attention"
          value={attention}
          onChange={setAttention}
          options={[
            { value: 'now', label: 'Now' },
            { value: 'today', label: 'Today' },
            { value: 'none', label: 'None' },
          ]}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-ink-2">File to</span>
        <div className="flex gap-2">
          {toggle(conf, 'Confluence', setConf, item.containsPeopleObservations ? 'Mentions named people: vault only' : undefined)}
          {toggle(vault, 'Vault', setVault)}
        </div>
      </div>
      <div className="text-xs leading-relaxed text-muted">
        Moves to <strong className="text-ink">{lane}</strong> and adds one line to the labelled set.
      </div>
      <Button
        variant="solid"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api.correctTriage(item.id, { attention, confluence: conf, vault });
            onDone(r.labelCount, lane);
          } catch (e) {
            errorToast(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Save correction
      </Button>
    </div>
  );
}

// ---------- Card ----------

export interface CardHandle {
  done: () => void;
  snooze: () => void;
  correct: () => void;
  open: () => void;
}

export const ItemCard = forwardRef<
  CardHandle,
  { item: ItemSummary; layout: 'board' | 'list'; draftsBudgetHit: boolean; focused?: boolean; fresh?: boolean; onFocus?: () => void }
>(function ItemCard({ item, layout, draftsBudgetHit, focused, fresh, onFocus }, ref) {
  const now = useNow();
  const navigate = useNavigate();
  const full = usePrefs((s) => s.scope === 'full');
  const { open: snoozeOpen, setOpen: setSnoozeOpen, close: closeSnooze, trigger: snoozeTrigger, panel: snoozePanel } = usePopover();
  const { open: moreOpen, setOpen: setMoreOpen, close: closeMore, trigger: moreTrigger, panel: morePanel } = usePopover();
  const { open: correctOpen, setOpen: setCorrectOpen, close: closeCorrect, trigger: correctTrigger, panel: correctPanel } = usePopover();
  const actions = cardActions(item, draftsBudgetHit);

  useImperativeHandle(ref, () => ({
    done: () => void markDoneWithUndo(item),
    snooze: () => setSnoozeOpen(true),
    correct: () => setCorrectOpen(true),
    open: () => navigate(itemPath(item.id)),
  }));

  const pickSnooze = async (iso: string) => {
    closeSnooze();
    try {
      await api.snooze(item.id, iso);
      toast(`Snoozed until ${fmtDayDate(iso)} ${fmtTime(iso)} · ${item.title}`, {
        action: { label: 'Undo', run: () => void api.reopen(item.id).catch(errorToast) },
      });
    } catch (e) {
      errorToast(e);
    }
  };

  const shownTypes = new Set<ActionType>([actions.primary.kind === 'draft' ? actions.primary.button.type : undefined, actions.secondary?.type].filter(Boolean) as ActionType[]);

  const buttons = (
    <div className={cx('relative flex flex-wrap items-center gap-1.5', layout === 'board' ? 'pt-0.5' : 'ml-auto justify-end')}>
      {actions.primary.kind === 'slack' ? (
        <Button variant="tonal" onClick={() => openInSlack(item)}>
          Open in Slack
        </Button>
      ) : (
        <DraftActionButton itemId={item.id} b={actions.primary.button} primary />
      )}
      {actions.secondary && <DraftActionButton itemId={item.id} b={actions.secondary} />}
      {!actions.secondary && full && (item.lane === 'now' || item.lane === 'today') && (
        <Button variant="future" onClick={() => phaseToast('P3', 'Draft reply')}>
          Draft reply<span className="font-mono text-[10px]">P3</span>
        </Button>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        <IconButton label="Done" icon="check" size={32} onClick={() => void markDoneWithUndo(item)} />
        <div className="relative">
          <IconButton label="Snooze" icon="clock" size={32} ref={snoozeTrigger} active={snoozeOpen} aria-haspopup="dialog" aria-expanded={snoozeOpen} onClick={() => setSnoozeOpen(!snoozeOpen)} />
          {snoozeOpen && (
            <PopoverPanel panelRef={snoozePanel} label="Snooze" role="menu">
              <SnoozeMenu now={now} onPick={pickSnooze} />
            </PopoverPanel>
          )}
        </div>
        <div className="relative">
          <IconButton label="More actions" size={32} ref={(el) => (moreTrigger(el), correctTrigger(el))} active={moreOpen} aria-haspopup="menu" aria-expanded={moreOpen} onClick={() => setMoreOpen(!moreOpen)}>
            <MoreIcon />
          </IconButton>
          {moreOpen && (
            <PopoverPanel panelRef={morePanel} label="More actions" role="menu" className="min-w-[250px]">
              <MenuItem
                onClick={() => {
                  closeMore(false);
                  setCorrectOpen(true);
                }}
              >
                Correct triage
              </MenuItem>
              {actions.overflowDrafts
                .filter((d) => !shownTypes.has(d.type))
                .map((d) => (
                  <MenuItem
                    key={d.type}
                    disabled={!!d.disabledReason && d.state === 'none'}
                    onClick={() => navigate(itemPath(item.id, d.state === 'none' ? `?draft=${d.type}` : `?tab=${d.type}`))}
                    hint={d.disabledReason && d.state === 'none' ? <Icon name="lock" size={12} className="text-muted" /> : undefined}
                  >
                    <span className="flex flex-col">
                      {d.label}
                      {d.disabledReason && d.state === 'none' && <span className="text-[11px] leading-snug text-muted">{d.disabledReason}</span>}
                    </span>
                  </MenuItem>
                ))}
              {actions.primary.kind !== 'slack' && <MenuItem onClick={() => (closeMore(), openInSlack(item))}>Open in Slack</MenuItem>}
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
          {correctOpen && (
            <PopoverPanel panelRef={correctPanel} label="Correct triage">
              <CorrectForm
                compact
                item={item}
                onDone={(n, lane) => {
                  closeCorrect(false);
                  toast(`Correction saved · moved to ${lane} · labelled set now ${n}`, { tone: 'success' });
                }}
              />
            </PopoverPanel>
          )}
        </div>
      </div>
    </div>
  );

  const where = (
    <div className="flex min-w-0 items-center gap-1.5 text-xs text-ink-2">
      <SourceIcon kind={item.kind} />
      <span className="truncate font-medium">{item.title}</span>
    </div>
  );

  const body = (
    <div className="flex min-w-0 flex-col gap-1">
      <Link to={itemPath(item.id)} className="text-sm font-medium leading-snug !text-ink no-underline hover:underline">
        {item.summary}
      </Link>
      {item.reason && <div className="text-xs leading-[1.45] text-muted">{item.reason}</div>}
      <ItemMarkers item={item} />
    </div>
  );

  return (
    <article
      tabIndex={-1}
      data-card={item.id}
      onFocus={onFocus}
      aria-label={item.summary}
      className={cx(
        'rounded-[10px] border bg-surface outline-none transition-shadow',
        layout === 'board' ? 'flex flex-col gap-2 px-3.5 pb-2.5 pt-3.5' : 'flex flex-wrap items-center gap-x-5 gap-y-2.5 px-3.5 py-3',
        focused ? 'border-accent shadow-[0_0_0_2px_var(--accent-line-2)]' : 'border-line',
        fresh && 'shadow-[0_0_0_2px_var(--accent-light)]',
      )}
    >
      {layout === 'board' ? (
        <>
          <div className="flex items-center gap-2">
            {where}
            <span className="flex-1" />
            {fresh && <span className="rounded bg-accent-bg px-1.5 py-px text-[10px] font-semibold text-on-solid">New</span>}
            <span className="font-mono text-[11px] text-muted">{fmtAgo(item.lastActivityAt, now)}</span>
          </div>
          {body}
          {buttons}
        </>
      ) : (
        <>
          <div className="flex w-[170px] min-w-0 flex-col gap-1">
            {where}
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-muted">{fmtAgo(item.lastActivityAt, now)}</span>
              {fresh && <span className="rounded bg-accent-bg px-1.5 py-px text-[10px] font-semibold text-on-solid">New</span>}
            </div>
          </div>
          <div className="min-w-0 flex-[1_1_340px]">{body}</div>
          {buttons}
        </>
      )}
    </article>
  );
});

// ---------- Commitments placeholder lane (P3) ----------

export function FutureCommitmentCard({ where, when, summary, reason }: { where: string; when: string; summary: string; reason: string }) {
  return (
    <article className="flex flex-col gap-2 rounded-[10px] border-[1.5px] border-dashed border-violet-line bg-violet-wash px-3.5 pb-2.5 pt-3.5">
      <div className="flex items-center gap-2 text-xs text-ink-2">
        <Icon name="commit" size={14} />
        <span className="font-medium">{where}</span>
        <span className="flex-1" />
        <PhaseTag phase="P3" />
        <span className="font-mono text-[11px] text-muted">{when}</span>
      </div>
      <div className="text-sm font-medium leading-snug">{summary}</div>
      <div className="text-xs text-muted">{reason}</div>
      <div className="flex items-center gap-1.5">
        <Button variant="future" className="bg-violet-wash-2 font-semibold" onClick={() => phaseToast('P3', 'Commitments')}>
          Open message<span className="font-mono text-[10px] font-normal">P3</span>
        </Button>
      </div>
    </article>
  );
}
