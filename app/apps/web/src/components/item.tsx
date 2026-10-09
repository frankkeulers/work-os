import { useState, type ReactNode } from 'react';
import { OUTLOOK_COLORS, type Attention, type CategoryTag, type ItemMeeting, type OutlookColor, type SourceId } from '@work-os/shared';
import { API_MODE, api, type ItemSummary } from '../api';
import { SOURCE_NAME } from '../lib/next';
import { snoozeOptions } from '../lib/snooze';
import { errorToast, toast } from '../store/toasts';
import { Icon } from './icons';
import { Button, MenuItem, Segmented, cx, inputClass } from './ui';

// Item helpers shared by the Inbox list, the item panel and Item detail.

export const itemPath = (id: string, q = '') => `/item/${encodeURIComponent(id)}${q}`;

const KIND_LABEL: Record<ItemSummary['kind'], string> = { thread: 'Thread', dm: 'DM', email: 'Email', meeting: 'Meeting', chat: 'Chat', event: 'Invite' };
export const kindLabel = (k: ItemSummary['kind']) => KIND_LABEL[k];

/**
 * Opens the item in a new tab (FR-8.2): Slack's web client, or the permalink, which hands over to
 * the desktop app, as the Slack settings say.
 */
export function openInSource(item: { permalink: string; openUrl?: string; title: string; source: SourceId }) {
  if (API_MODE === 'http') {
    window.open(item.openUrl ?? item.permalink, '_blank', 'noopener,noreferrer');
    return;
  }
  // The mock's permalinks lead nowhere.
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

/** Marks a set of items done in one write, e.g. a channel's run or all of Low priority, with Undo. */
export async function markManyDoneWithUndo(items: ItemSummary[], what: string) {
  const ids = items.filter((i) => i.status !== 'done').map((i) => i.id);
  if (!ids.length) return;
  try {
    const { count } = await api.markDoneMany(ids);
    toast(`Done · ${count} ${count === 1 ? 'item' : 'items'} in ${what}`, {
      action: { label: 'Undo', run: () => void api.reopenMany(ids).catch(errorToast) },
    });
  } catch (e) {
    errorToast(e);
  }
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
/** A Wispr Flow meeting's calendar event (R2.8): its title, opening Outlook, who organised it and how many were asked. */
/** An Outlook category's colour, as a dot (R2.8). */
export function CategoryDot({ color, size = 8 }: { color: OutlookColor; size?: number }) {
  return <span aria-hidden className="inline-block shrink-0 rounded-full ring-1 ring-line" style={{ width: size, height: size, background: OUTLOOK_COLORS[color] }} />;
}

/** A calendar event's Outlook categories, each in the colour given it in Settings › Outlook. */
export function CategoryTags({ tags }: { tags: CategoryTag[] }) {
  return (
    <ul aria-label="Outlook categories" data-testid="calendar-categories" className="m-0 flex list-none flex-wrap gap-1.5 p-0">
      {tags.map((t) => (
        <li key={t.name} data-category={t.name} data-color={t.color} className="inline-flex items-center gap-1.5 rounded-full border border-line-soft bg-surface px-2 py-0.5 text-xs text-ink-2">
          <CategoryDot color={t.color} />
          {t.name}
        </li>
      ))}
    </ul>
  );
}

export function OnCalendar({ calendar: c }: { calendar: NonNullable<ItemMeeting['calendar']> }) {
  const invited = c.invitees.map((p) => p.name).join(', ');
  return (
    <p data-testid="on-calendar" className="m-0 text-[13px] leading-relaxed text-ink-2">
      <Icon name="calendar" size={14} className="mr-1.5 inline-block align-[-2px] text-muted" />
      On your calendar:{' '}
      {c.link ? (
        <a href={c.link} target="_blank" rel="noreferrer" className="font-medium">
          {c.title}
        </a>
      ) : (
        <span className="font-medium text-ink">{c.title}</span>
      )}
      {c.organizer && ` · organised by ${c.organizer.name}`}
      {c.invitees.length > 0 && (
        <>
          {' · '}
          <span title={invited}>{c.invitees.length} invited</span>
        </>
      )}
    </p>
  );
}

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
  const local = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const [value, setValue] = useState(local(new Date(now.getTime() + 3 * 3600_000)));
  return (
    <div className="flex w-[240px] flex-col">
      {snoozeOptions(now).map((o) => (
        <MenuItem key={o.label} onClick={() => onPick(o.until)} hint={<span className="font-mono text-[11px] text-muted">{o.hint}</span>}>
          {o.label}
        </MenuItem>
      ))}
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
export function CorrectForm({
  item,
  onDone,
  onCancel,
  layout = 'inline',
}: {
  item: ItemSummary;
  onDone: (labelCount: number, lane: string) => void;
  onCancel?: () => void;
  layout?: 'inline' | 'panel';
}) {
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
      size={layout === 'panel' ? 'sm' : 'md'}
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
  if (layout === 'panel') {
    const check = (on: boolean, label: string, set: (v: boolean) => void, disabled?: string) => (
      <label title={disabled} className={cx('inline-flex min-h-8 items-center gap-2 text-[13px]', disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer')}>
        <input type="checkbox" className="h-4 w-4 accent-[var(--accent-bg)]" checked={on} disabled={!!disabled} onChange={(e) => set(e.target.checked)} />
        {label}
      </label>
    );
    return (
      <section aria-label="Correct triage" className="flex flex-col gap-3 rounded-xl border border-line px-4 py-3.5">
        <div className="flex flex-col gap-1">
          <h3 className="m-0 text-[13px] font-semibold">{item.triageState === 'triaged' ? 'Correct triage' : 'Set triage'}</h3>
          <p className="m-0 text-xs leading-relaxed text-ink-2">
            Overrides the model for this item: it moves to the lane you pick straight away. The correction is also saved as a test case for the triage eval; it doesn’t retrain triage, and new replies are triaged afresh.
          </p>
        </div>
        <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2">
          <span className="text-xs font-medium text-ink-2">Attention</span>
          <Segmented<Attention>
            label="Attention"
            size="sm"
            value={attention}
            onChange={setAttention}
            options={[
              { value: 'now', label: 'Now' },
              { value: 'today', label: 'Today' },
              { value: 'none', label: 'No action' },
            ]}
          />
          <span className="text-xs font-medium text-ink-2">Suggest filing</span>
          <span className="flex flex-wrap gap-x-4">
            {check(conf, 'Confluence', setConf, item.containsPeopleObservations ? 'Mentions named people: vault only' : undefined)}
            {check(vault, 'Vault', setVault)}
          </span>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="flex-1 text-xs text-muted">
            Moves to <strong className="text-ink">{lane}</strong>
          </span>
          {onCancel && (
            <Button size="sm" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          {save}
        </div>
      </section>
    );
  }
  return (
    <div className="flex flex-wrap items-end gap-x-5 gap-y-3">
      {fields}
      <div className="flex-[1_1_200px] self-center text-xs leading-relaxed text-muted">{note}</div>
      {save}
    </div>
  );
}
