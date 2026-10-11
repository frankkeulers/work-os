import { inTimeRange, needsNotification, type ActionType, type EventDraft, type Notice, type Settings, type WorkEvent } from '@work-os/shared';
import type { Logger } from 'pino';
import type { ItemFiles } from '../store/items';
import type { Store } from '../store/store';
import type { Notifier } from './macos';

// Notifications for new Now items (FR-11.1, FR-11.2). A decision that makes an item Now (the
// model's or a rule's) puts it in `pending`. The runtime flushes after each triage run, so what one
// run decides goes out together: three or more after a wake or reconnect catch-up become a single
// summary. Each item is notified at most once, recorded as `item.notified` before anything is
// shown, so a restart never repeats one. Quiet hours and the off switch still record the item, as
// suppressed, and show nothing; it is in the inbox either way.

/** After this long, pending items go out even if no triage run finished (Claude may be down). */
export const HOLD_MS = 2 * 60_000;
export const SUMMARY_MIN = 3;

const DRAFT_LABEL: Record<ActionType, string> = { vault_note: 'Vault note', confluence_entry: 'Confluence entry', todo: 'To-do' };
const FILE_PARAM: Record<ActionType, string> = { vault_note: 'vault', confluence_entry: 'confluence', todo: 'todo' };

/** A click opens the item in the inbox panel, on the draft's filing (UX-6); the inbox opens the full page for one it doesn't show. */
const inboxUrl = (base: string, itemId: string, type?: ActionType) => `${base}/?${new URLSearchParams({ item: itemId, ...(type && { file: FILE_PARAM[type] }) })}`;

/** A draft Frank asked for is ready, or failed (FR-11.6). */
export interface DraftNotification {
  itemId: string;
  type: ActionType;
  title: string;
  outcome: 'ready' | 'failed';
  message?: string;
}

export interface NotificationDeps {
  store: Store;
  items: ItemFiles;
  notifier: Notifier;
  settings: () => Settings;
  now: () => Date;
  /** The UI's address, once the server is listening. */
  baseUrl: () => string | undefined;
  publish: (n: Notice) => void;
  logger?: Logger;
}

export class Notifications {
  private pending = new Map<string, number>(); // item id → when it became Now
  private flushing?: Promise<void>;
  private sending = new Set<Promise<void>>();
  private unsubscribe: () => void;

  constructor(private readonly d: NotificationDeps) {
    this.unsubscribe = d.store.subscribe((events) => this.collect(events));
  }

  private collect(events: WorkEvent[]) {
    for (const e of events) {
      if (e.type !== 'triage.decided' || !e.itemId) continue;
      const it = this.d.store.projection.items[e.itemId];
      if (it && needsNotification(it) && !this.pending.has(e.itemId)) this.pending.set(e.itemId, this.d.now().getTime());
    }
  }

  /** A triage run finished: what it made Now goes out, as one summary after a catch-up. */
  afterTriage(catchUp: boolean) {
    return this.flush(catchUp, () => true);
  }

  /** On every tick: items that have waited too long for a triage run go out on their own. */
  tick() {
    if (!this.pending.size) return Promise.resolve();
    const cutoff = this.d.now().getTime() - HOLD_MS;
    return this.flush(false, (at) => at <= cutoff);
  }

  /**
   * A draft is ready or failed (FR-11.6): Frank asked for it and may have moved on. Each action is
   * drafted once, so this can't repeat; nothing is recorded. Quiet hours and the off switch hold it
   * back, and the bell lists it either way. A click opens the item.
   */
  draft(n: DraftNotification): Promise<void> {
    const s = this.d.settings().notifications;
    if (!s.enabled || inTimeRange(this.d.now(), s.quietHours)) return Promise.resolve();
    const base = this.d.baseUrl();
    const p = this.d.notifier
      .notify({
        title: `${DRAFT_LABEL[n.type]} draft ${n.outcome === 'ready' ? 'ready' : 'failed'}`,
        message: n.outcome === 'ready' ? n.title || 'Ready to review.' : `${n.title}${n.message ? `: ${n.message}` : ''}`,
        group: `work-os-draft-${n.itemId}`,
        ...(base && { url: inboxUrl(base, n.itemId, n.type) }),
      })
      .catch((err) => this.d.logger?.error({ err }, 'Could not send a draft notification'))
      .finally(() => this.sending.delete(p));
    this.sending.add(p);
    return p;
  }

  /** Waits for the notifications in progress. For tests and shutdown. */
  async settled() {
    while (this.flushing || this.sending.size) await Promise.all([this.flushing, ...this.sending]);
  }

  stop() {
    this.unsubscribe();
  }

  private flush(catchUp: boolean, due: (at: number) => boolean): Promise<void> {
    const run = async () => {
      await prev;
      const ids = [...this.pending].filter(([, at]) => due(at)).map(([id]) => id);
      for (const id of ids) this.pending.delete(id);
      // Still Now, not yet notified, and not already done or snoozed by Frank.
      const items = ids.map((id) => this.d.store.projection.items[id]).filter((it) => it && needsNotification(it) && it.status === 'open');
      if (!items.length) return;
      const n = this.d.settings().notifications;
      const suppressed = !n.enabled ? 'disabled' : inTimeRange(this.d.now(), n.quietHours) ? 'quiet_hours' : undefined;
      const summary = catchUp && items.length >= SUMMARY_MIN;
      const kind = summary ? 'summary' : 'now';
      // Recorded first: a crash after this shows nothing rather than showing it twice.
      await this.d.store.append(...items.map((it): EventDraft => ({ type: 'item.notified', itemId: it.id, data: { kind, ...(suppressed && { suppressed }) } })));
      if (suppressed) return;
      const base = this.d.baseUrl();
      if (summary) {
        await this.d.notifier.notify({ title: `${items.length} items need you now`, message: items.map((it) => it.title).join(', '), group: 'work-os-now', ...(base && { url: base }) });
      }
      for (const it of items) {
        const text = (await this.d.items.read(it.source, it.id).catch(() => undefined))?.text?.summary ?? '';
        this.d.publish({ topic: 'notification', itemId: it.id, title: it.title, summary: text });
        if (!summary) await this.d.notifier.notify({ title: it.title, message: text || 'Needs you now.', group: `work-os-${it.id}`, ...(base && { url: inboxUrl(base, it.id) }) });
      }
    };
    const prev = this.flushing ?? Promise.resolve();
    const p = run().catch((err) => this.d.logger?.error({ err }, 'Could not send notifications'));
    const tracked: Promise<void> = p.finally(() => {
      if (this.flushing === tracked) this.flushing = undefined;
    });
    this.flushing = tracked;
    return tracked;
  }
}
