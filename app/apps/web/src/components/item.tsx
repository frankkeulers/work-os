import { useState, type ReactNode } from 'react';
import type { Attention, SourceId } from '@work-os/shared';
import { api, type ItemSummary } from '../api';
import { fmtDayDate, fmtTime } from '../lib/format';
import { SOURCE_NAME } from '../lib/next';
import { tomorrowAt9 } from '../lib/time';
import { errorToast, toast } from '../store/toasts';
import { Icon } from './icons';
import { Button, MenuItem, Segmented, cx, inputClass } from './ui';

// Item helpers shared by the Inbox list, the item panel and Item detail.

export const itemPath = (id: string, q = '') => `/item/${encodeURIComponent(id)}${q}`;

const KIND_LABEL: Record<ItemSummary['kind'], string> = { thread: 'Thread', dm: 'DM', email: 'Email', meeting: 'Meeting', chat: 'Chat' };
export const kindLabel = (k: ItemSummary['kind']) => KIND_LABEL[k];

export function openInSource(item: { permalink: string; title: string; source: SourceId }) {
  const app = SOURCE_NAME[item.source];
  toast(`Opens ${item.title} in ${app}. The prototype doesn’t launch ${app}.`, {
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
  return m.length ? <span className="flex flex-wrap gap-1">{m}</span> : null;
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

/** Correct the triage (FR-6.2). "inline" sits in Item detail's triage band; "panel" in the Inbox item panel. */
export function CorrectForm({ item, onDone, layout = 'inline' }: { item: ItemSummary; onDone: (labelCount: number, lane: string) => void; layout?: 'inline' | 'panel' }) {
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
      className={cx(
        'min-h-10 rounded-lg border px-3.5 text-[13px] font-medium cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
        on ? 'border-teal bg-teal-wash text-ink' : 'border-line-strong bg-surface text-ink',
      )}
    >
      {label}
    </button>
  );
  const lane = attention === 'now' ? 'Now' : attention === 'today' ? 'Today' : conf || vault ? 'File' : 'Everything else';
  const fields = (
    <>
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
    </>
  );
  const note = (
    <>
      Moves to <strong className="text-ink">{lane}</strong> straight away and adds one line to the labelled set.
    </>
  );
  const save = (
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
  );
  if (layout === 'panel')
    return (
      <div className="flex flex-col gap-3 rounded-[10px] bg-surface-2 px-4 py-3.5">
        <div className="flex flex-wrap items-end gap-4">{fields}</div>
        <div className="flex flex-wrap items-center gap-2.5">
          {save}
          <span className="text-xs leading-relaxed text-muted">{note}</span>
        </div>
      </div>
    );
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
      {fields}
      <div className="flex-[1_1_200px] self-center text-xs leading-relaxed text-muted">{note}</div>
      {save}
    </div>
  );
}
