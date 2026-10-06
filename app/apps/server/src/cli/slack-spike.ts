import { macKeychain } from '../config/keychain';
import { SourceError } from '../sources/errors';
import { mapLimit } from '../sources/limit';
import { SlackApi } from '../sources/slack/api';
import { SlackDirectory } from '../sources/slack/directory';
import { cmpTs, isHuman, isoToTs, threadTsOf, tsToIso } from '../sources/slack/normalise';
import type { Conversation, HistoryResponse, SearchResponse, SlackMessage } from '../sources/slack/types';

// npm run spike:slack (FR-2.5): does search.messages find thread replies and DMs reliably, and how
// far behind does it run? Compares a day of search results with conversations.history for Frank's
// DMs and a sample of his channels. Prints counts only: no message text, names or channel names.
// Read-only: it uses the token's read scopes and writes nothing.

const DAY = 86_400_000;
const MAX_CHANNELS = 15;
const MAX_DMS = 30;

async function main() {
  const api = new SlackApi(macKeychain());
  const dir = new SlackDirectory(api);
  const me = await dir.identity();
  console.log(`auth.test ok: user ${me.user_id}`);

  const now = Date.now();
  const since = isoToTs(now - DAY);
  const after = new Date(now - 2 * DAY).toISOString().slice(0, 10);

  // Search: a day of matches, newest first.
  const search = new Map<string, SlackMessage & { channel: { id: string; is_im?: boolean; is_mpim?: boolean } }>();
  let pages = 0;
  const t0 = performance.now();
  for (let page = 1; page <= 20; page++) {
    const r = await api.call<SearchResponse>('search.messages', { query: `after:${after}`, sort: 'timestamp', sort_dir: 'desc', count: 100, page });
    pages++;
    for (const m of r.messages.matches) if (cmpTs(m.ts, since) > 0) search.set(`${m.channel.id}:${m.ts}`, m);
    const oldest = r.messages.matches.at(-1)?.ts;
    if (!oldest || cmpTs(oldest, since) <= 0 || page >= (r.messages.paging?.pages ?? 1)) break;
  }
  const searchMs = Math.round(performance.now() - t0);
  const matches = [...search.values()];
  const members = await dir.conversations();
  console.log(`\nsearch.messages, last 24 h: ${matches.length} matches in ${pages} page(s), ${searchMs} ms`);
  console.log(`  thread replies (thread_ts in permalink): ${matches.filter((m) => { const t = threadTsOf(m); return t && t !== m.ts; }).length}`);
  console.log(`  DMs: ${matches.filter((m) => m.channel.is_im).length}, group DMs: ${matches.filter((m) => m.channel.is_mpim).length}`);
  console.log(`  bots or system messages: ${matches.filter((m) => !isHuman(m)).length}`);
  console.log(`  in channels Frank is not a member of: ${matches.filter((m) => !members.has(m.channel.id)).length}`);
  console.log(`  match carries thread_ts itself: ${matches.filter((m) => m.thread_ts).length}`);

  // History: DMs and the channels with the most search matches, plus their threads.
  const direct = [...members.values()].filter((c) => c.is_im || c.is_mpim).slice(0, MAX_DMS);
  const perChannel = new Map<string, number>();
  for (const m of matches) if (members.has(m.channel.id) && !m.channel.is_im && !m.channel.is_mpim) perChannel.set(m.channel.id, (perChannel.get(m.channel.id) ?? 0) + 1);
  const busiest = [...perChannel.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CHANNELS)
    .map(([id]) => members.get(id)!);
  const sample: Conversation[] = [...direct, ...busiest];
  const history: { c: Conversation; m: SlackMessage }[] = [];
  await mapLimit(sample, 3, async (c) => {
    const r = await api.call<HistoryResponse>('conversations.history', { channel: c.id, oldest: isoToTs(now - 4 * DAY), limit: 200 });
    for (const m of r.messages) {
      if (cmpTs(m.ts, since) > 0) history.push({ c, m });
      if (m.latest_reply && cmpTs(m.latest_reply, since) > 0) {
        const rep = await api.call<HistoryResponse>('conversations.replies', { channel: c.id, ts: m.ts, limit: 200 });
        for (const x of rep.messages) if (x.ts !== m.ts && cmpTs(x.ts, since) > 0) history.push({ c, m: x });
      }
    }
  });
  const human = history.filter((h) => isHuman(h.m));
  const missing = human.filter((h) => !search.has(`${h.c.id}:${h.m.ts}`));
  const kind = (h: { c: Conversation; m: SlackMessage }) => (h.c.is_im || h.c.is_mpim ? 'dm' : h.m.thread_ts && h.m.thread_ts !== h.m.ts ? 'reply' : 'top');
  const by = (xs: typeof human, k: string) => xs.filter((h) => kind(h) === k).length;
  console.log(`\nconversations.history, ${direct.length} DMs and ${busiest.length} channels, last 24 h: ${human.length} human messages`);
  for (const k of ['top', 'reply', 'dm']) console.log(`  ${k.padEnd(5)} in history ${String(by(human, k)).padStart(5)}, missing from search ${String(by(missing, k)).padStart(4)}`);

  // Lag: of the messages search hasn't got, how old are they?
  const ages = missing.map((h) => (now - Date.parse(tsToIso(h.m.ts))) / 60_000);
  const bucket = (lo: number, hi: number) => ages.filter((a) => a >= lo && a < hi).length;
  console.log(`\nmissing from search, by age: <5 min ${bucket(0, 5)}, 5–15 min ${bucket(5, 15)}, 15–60 min ${bucket(15, 60)}, older ${bucket(60, Infinity)}`);
  console.log('\nRecord the outcome in specs/PLAN.md (FR-2.5, open question 1). Use history mode if replies or DMs go missing beyond 15 minutes.');
}

main().catch((err) => {
  console.error(err instanceof SourceError ? `Slack: ${err.failure.state} (${err.failure.reason}). ${err.message}` : err);
  process.exit(1);
});
