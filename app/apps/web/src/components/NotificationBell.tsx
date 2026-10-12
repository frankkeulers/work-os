import { unseenCount, type AttentionEntry, type AttentionKind, type AttentionWork } from '@work-os/shared';
import { useNavigate } from 'react-router';
import { api } from '../api';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { useOpenItem } from '../hooks/useOpenItem';
import { fmtAgo } from '../lib/format';
import { TYPE_LABEL } from '../lib/lanes';
import { usePrefs } from '../store/prefs';
import { errorToast } from '../store/toasts';
import { BrandIcon } from './BrandIcon';
import { Icon, type IconName } from './icons';
import { Button, PopoverPanel, Spinner, cx, usePopover } from './ui';

// The bell (FR-11.3–11.5): what needs Frank's follow-up, in the top-right corner of every page.
// Its entries come from the server as state stands, so one goes when Frank deals with it; a
// dismissible one can also be dismissed. The count is accent while some arrived since he last
// opened it, and quiet once he has seen them; with nothing to follow up there is no count at all.

/** The views the bell is built from: it is stale whenever one of them is. */
const TOPICS = onTopics('attention', 'inbox', 'item', 'health', 'usage', 'evals', 'settings');

export function useAttention() {
  return useApiQuery(() => api.getAttention(), TOPICS, []);
}

const KIND: Record<AttentionKind, { icon: IconName; tone: string }> = {
  draft_ready: { icon: 'vault', tone: 'bg-surface-2' }, // shown with the target's brand mark, as in the panel's File it
  draft_failed: { icon: 'alert', tone: 'bg-red-line/15 text-red-fg' },
  write_failed: { icon: 'alert', tone: 'bg-red-line/15 text-red-fg' },
  fix_needed: { icon: 'lock', tone: 'bg-amber-wash text-amber-fg' },
  snooze_back: { icon: 'clock', tone: 'bg-bg text-ink-2' },
  looks_finished: { icon: 'check', tone: 'bg-teal-wash text-green-fg' },
  reply_unsettled: { icon: 'dm', tone: 'bg-amber-wash text-amber-fg' },
  eval_done: { icon: 'sparkle', tone: 'bg-bg text-ink-2' },
  guidance_changed: { icon: 'book', tone: 'bg-bg text-ink-2' },
  policy_proposed: { icon: 'sparkle', tone: 'bg-teal-wash text-green-fg' },
};


export function NotificationBell() {
  const { open, setOpen, close, trigger, panel } = usePopover();
  const view = useAttention().data;
  const seenAt = usePrefs((s) => s.bellSeenAt);
  const setSeenAt = usePrefs((s) => s.setBellSeenAt);
  const entries = view?.entries ?? [];
  const working = view?.working ?? [];
  const unseen = unseenCount(entries, seenAt);
  const label = entries.length ? `Follow-ups: ${entries.length}${unseen ? `, ${unseen} new` : ''}` : 'Follow-ups: nothing needs you';

  const toggle = () => {
    // Opening it counts as seeing what's there: the count goes quiet.
    if (!open) setSeenAt(api.now().toISOString());
    setOpen(!open);
  };

  return (
    <div className="relative">
      <button
        type="button"
        ref={trigger}
        onClick={toggle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={label}
        title="Follow-ups"
        data-testid="bell"
        className={cx('relative inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-2 cursor-pointer hover:bg-track', open && 'bg-track')}
      >
        <Icon name="bell" size={17} />
        {working.length > 0 && !entries.length && <span data-testid="bell-working" className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full border-2 border-surface bg-accent box-content" />}
        {entries.length > 0 && (
          <span
            data-testid="bell-count"
            data-unseen={unseen > 0 || undefined}
            className={cx(
              'absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full border-2 border-surface px-[3px] text-[10px] font-semibold leading-none box-content',
              unseen ? 'bg-accent-bg text-on-solid' : 'bg-track text-ink-2',
            )}
          >
            {entries.length > 99 ? '99+' : entries.length}
          </span>
        )}
      </button>
      {open && (
        <PopoverPanel panelRef={panel} label="Follow-ups" className="flex max-h-[min(640px,calc(100vh-96px))] w-[400px] max-w-[calc(100vw-32px)] flex-col whitespace-normal !p-0">
          <div className="flex items-baseline gap-2 border-b border-line px-4 py-3">
            <span className="flex-1 font-semibold">Follow-ups</span>
            <span className="text-xs text-muted">{entries.length ? `${entries.length} need${entries.length === 1 ? 's' : ''} you` : 'All clear'}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {entries.length === 0 && (
              <div className="flex items-center gap-2.5 px-4 py-5 text-[13px] text-muted">
                <Icon name="check" size={16} /> Nothing needs you.
              </div>
            )}
            {entries.length > 0 && (
              <ul className="m-0 list-none p-1.5" aria-label="Needs you">
                {entries.map((e) => (
                  <EntryRow key={e.key} e={e} isNew={!seenAt || e.at > seenAt} onDone={() => close(false)} />
                ))}
              </ul>
            )}
            {working.length > 0 && (
              <section aria-label="Working on" className="border-t border-line px-1.5 pb-1.5 pt-2">
                <h3 className="m-0 px-2.5 pb-1 text-[11px] font-semibold uppercase tracking-[0.04em] text-muted">Working on</h3>
                <ul className="m-0 list-none p-0">
                  {working.map((w) => (
                    <WorkRow key={w.actionId} w={w} onDone={() => close(false)} />
                  ))}
                </ul>
              </section>
            )}
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}

function EntryRow({ e, isNew, onDone }: { e: AttentionEntry; isNew: boolean; onDone: () => void }) {
  const navigate = useNavigate();
  const openItem = useOpenItem();
  const now = useNow(30_000);
  const k = KIND[e.kind];
  const go = () => {
    // A finished eval has done its job once its report is open.
    if (e.kind === 'eval_done') void api.dismissAttention(e.key).catch(errorToast);
    onDone();
    if (e.href) window.open(e.href, '_blank', 'noopener');
    else if (e.itemId) openItem(e.itemId, e.actionType);
    else if (e.to) navigate(e.to);
  };
  const dismiss = () => void api.dismissAttention(e.key).catch(errorToast);
  return (
    <li data-kind={e.kind} data-new={isNew || undefined} className="group relative flex gap-3 rounded-lg px-2.5 py-2.5 hover:bg-surface-2">
      <span className={cx('mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full', k.tone)}>
        {e.kind === 'draft_ready' && e.actionType ? <BrandIcon brand={e.actionType === 'vault_note' ? 'obsidian' : 'confluence'} size={14} decorative /> : <Icon name={k.icon} size={14} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-ink">{e.title}</span>
          {isNew && <span aria-label="New" className="h-1.5 w-1.5 shrink-0 self-center rounded-full bg-accent" />}
          <time dateTime={e.at} className="shrink-0 text-[11px] text-muted">
            {fmtAgo(e.at, now)}
          </time>
        </div>
        <span className="truncate text-[13px] text-ink-2">{e.subject}</span>
        {e.detail && <span className="line-clamp-2 text-xs text-muted">{e.detail}</span>}
        <div className="mt-1.5 flex items-center gap-1.5">
          <Button size="sm" variant={e.kind === 'draft_ready' ? 'tonal' : 'secondary'} icon={e.href ? 'external' : undefined} onClick={go}>
            {e.cta}
          </Button>
          {e.dismissible && (
            <Button size="sm" variant="ghost" onClick={dismiss} aria-label={`Dismiss: ${e.title}, ${e.subject}`}>
              Dismiss
            </Button>
          )}
        </div>
      </div>
    </li>
  );
}

function WorkRow({ w, onDone }: { w: AttentionWork; onDone: () => void }) {
  const openItem = useOpenItem();
  const p = w.progress;
  const status = p ? `${p.stages[p.stage] ?? 'Drafting'} · ${p.stage + 1} of ${p.stages.length}` : (w.held ?? 'Waiting its turn');
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          onDone();
          openItem(w.itemId, w.type);
        }}
        className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left cursor-pointer hover:bg-surface-2"
      >
        <span className="inline-flex h-7 w-7 shrink-0 items-center justify-center text-accent">{p ? <Spinner size={14} /> : <Icon name="clock" size={14} />}</span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] text-ink">
            <span className="font-medium">{TYPE_LABEL[w.type].short}</span> · {w.subject}
          </span>
          <span className={cx('truncate text-xs', w.held ? 'text-amber-fg' : 'text-muted')}>{status}</span>
        </span>
      </button>
    </li>
  );
}
