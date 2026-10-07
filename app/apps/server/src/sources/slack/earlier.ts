import type { EarlierView, Item } from '@work-os/shared';
import type { SlackDirectory } from './directory';
import { cmpTs, isHuman, isoToTs, mentionedIds, tsToIso } from './normalise';
import type { HistoryResponse } from './types';

// The messages in the week before a DM item. A DM is split into items at 30 minutes of quiet (FR-2.6), so
// the question an item answers is often in the one before it, or older than the first poll. They are
// read from Slack when the item is opened and never stored, so retention has nothing to remove.

/** Never further back than this before the item's first message, and never more than EARLIER_LIMIT. */
export const EARLIER_DAYS = 7;
export const EARLIER_LIMIT = 200;
const CACHE_MS = 5 * 60_000;

export class EarlierMessages {
  private cache = new Map<string, { at: number; view: EarlierView }>();

  constructor(
    private readonly directory: SlackDirectory,
    private readonly now: () => number = Date.now,
  ) {}

  async forItem(item: Item, signal?: AbortSignal): Promise<EarlierView> {
    const channel = item.id.split(':')[1];
    const first = item.messages[0]?.id ?? item.id.split(':')[2];
    if (item.source !== 'slack' || item.kind !== 'dm' || !channel || !first) return { messages: [], people: [] };
    const key = `${channel}:${first}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < CACHE_MS) return hit.view;

    const r = await this.directory.api.call<HistoryResponse>('conversations.history', { channel, latest: first, oldest: isoToTs(Date.parse(tsToIso(first)) - EARLIER_DAYS * 86_400_000), inclusive: 0, limit: EARLIER_LIMIT }, signal);
    const msgs = r.messages.filter((m) => isHuman(m) && cmpTs(m.ts, first) < 0).sort((a, b) => cmpTs(a.ts, b.ts));
    const ids = [...new Set([...msgs.map((m) => m.user!), ...mentionedIds(msgs.map((m) => m.text ?? ''))])];
    await this.directory.resolveUsers(ids, signal);
    const view: EarlierView = {
      messages: msgs.map((m) => ({ id: m.ts, authorId: m.user!, ts: tsToIso(m.ts), text: m.text ?? '' })),
      people: ids.map((id) => ({ id, name: this.directory.name(id) })).filter((p) => p.name !== p.id),
    };
    for (const [k, v] of this.cache) if (this.now() - v.at >= CACHE_MS) this.cache.delete(k);
    this.cache.set(key, { at: this.now(), view });
    return view;
  }
}
