import type { Item, Settings } from '@work-os/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../../config/defaults';
import { memoryKeychain, SLACK_TOKEN_ACCOUNT, type SecretStore } from '../../config/keychain';
import { SourceError } from '../errors';
import { mapLimit } from '../limit';
import { SlackAdapter } from './adapter';
import { SlackApi } from './api';
import { EarlierMessages } from './earlier';
import { FakeSlack } from './fakeSlack';
import { buildItem, channelListed, cmpTs, mentionedIds, webClientUrl, dmWindows, isHuman, isoToTs, permalinkFor, threadTsOf, tsToIso } from './normalise';

const NOW = Date.parse('2026-10-06T09:00:00Z');
const MIN = 60_000;
const ts = (minsAgo: number, n = 0) => isoToTs(NOW - minsAgo * MIN + n);

let slack: FakeSlack;
let secrets: SecretStore & { values: Record<string, string> };
let settings: Settings;

const adapter = (over: Partial<Settings['slack']> = {}) => {
  settings = defaultSettings('/tmp/x');
  settings.slack = { ...settings.slack, excludeChannels: ['#random'], ...over };
  return new SlackAdapter({ api: new SlackApi(secrets, slack.fetch), settings });
};
const ctx = (at = NOW) => ({ signal: new AbortController().signal, now: new Date(at), reason: 'scheduled' as const });
const byId = (items: Item[]) => Object.fromEntries(items.map((i) => [i.id, i]));

function workspace() {
  slack = new FakeSlack();
  slack.users.set('U02DANA', 'Dana Lee').set('U03SAM', 'Sam').set('U04MATT', 'Matt M.');
  slack
    .channel({ id: 'C01PROD', name: 'product' })
    .channel({ id: 'C02RANDOM', name: 'random' })
    .channel({ id: 'C03OTHER', name: 'other-team', member: false })
    .channel({ id: 'D01MATT', is_im: true, user: 'U04MATT' })
    .channel({ id: 'G01MPDM', name: 'mpdm-frank--dana--sam-1', is_mpim: true });
  const P = ts(120);
  slack
    .post('C01PROD', { ts: P, user: 'U02DANA', text: 'Release notes draft is up. Thoughts?' })
    .post('C01PROD', { ts: ts(60), thread_ts: P, user: 'U03SAM', text: 'Looks good' })
    .post('C01PROD', { ts: ts(30), thread_ts: P, user: 'UFRANK', text: 'One change: the ETA wording' })
    .post('C01PROD', { ts: ts(20), user: 'U02DANA', text: 'Standup moved to 10:15' })
    .post('C01PROD', { ts: ts(10), bot_id: 'B1', subtype: 'bot_message', text: 'Deploy finished' })
    .post('C01PROD', { ts: ts(9), user: 'U03SAM', subtype: 'channel_join', text: 'joined' })
    .post('C02RANDOM', { ts: ts(15), user: 'U02DANA', text: 'Lunch?' })
    .post('C03OTHER', { ts: ts(15), user: 'U03SAM', text: 'Not Frank’s channel' })
    .post('D01MATT', { ts: ts(200), user: 'U04MATT', text: 'Morning' })
    .post('D01MATT', { ts: ts(190), user: 'UFRANK', text: 'Morning Matt' })
    .post('D01MATT', { ts: ts(50), user: 'U04MATT', text: 'Go/no-go on MVI V2?' })
    .post('D01MATT', { ts: ts(45), user: 'U04MATT', text: 'Need it for the board pack' })
    .post('G01MPDM', { ts: ts(5), user: 'U03SAM', text: 'Can we sync today?' });
  return { P };
}

beforeEach(() => {
  secrets = memoryKeychain({ [SLACK_TOKEN_ACCOUNT]: 'xoxp-fake-token' });
});

describe('normalise', () => {
  it('names the users @-mentioned in the text, keeping the raw <@id> markup', () => {
    expect(mentionedIds(['cc <@U01A> and <@W02B|bea>', 'again <@U01A>'])).toEqual(['U01A', 'W02B']);
    const names: Record<string, string> = { U1: 'Dana Lee', U2: 'Sam' };
    const item = buildItem({
      channel: { id: 'D1', is_im: true, user: 'U1' },
      key: '1791277200.000100',
      messages: [{ ts: '1791277200.000100', user: 'U1', text: 'Hi <@U2> and <@U9>' }],
      title: 'Dana Lee',
      permalink: 'https://polestar.slack.com/archives/D1/p1791277200000100',
      names: (id) => names[id] ?? id,
    });
    expect(item.mentioned).toEqual([{ id: 'U2', name: 'Sam' }]); // an unresolved ID is left out
    expect(item.messages[0].text).toBe('Hi <@U2> and <@U9>');
  });

  it('converts between ts and ISO, and compares ts numerically', () => {
    expect(tsToIso('1791277200.000100')).toBe('2026-10-06T09:00:00.000Z');
    expect(tsToIso('1791277200.123456')).toBe('2026-10-06T09:00:00.123Z');
    expect(isoToTs('2026-10-06T09:00:00.123Z')).toBe('1791277200.123000');
    expect(cmpTs('999999999.000001', '1000000000.000000')).toBeLessThan(0);
    expect(cmpTs('1791277200.2', '1791277200.100000')).toBeGreaterThan(0);
  });

  it('keeps people and drops bots, joins and app messages (FR-2.10)', () => {
    expect(isHuman({ ts: '1', user: 'U1' })).toBe(true);
    expect(isHuman({ ts: '1', user: 'U1', subtype: 'thread_broadcast' })).toBe(true);
    expect(isHuman({ ts: '1', user: 'U1', bot_id: 'B1' })).toBe(false);
    expect(isHuman({ ts: '1', subtype: 'bot_message' })).toBe(false);
    expect(isHuman({ ts: '1', user: 'U1', subtype: 'channel_join' })).toBe(false);
  });

  it('matches channels by #name, name or ID', () => {
    const c = { id: 'C01', name: 'random' };
    expect(channelListed(['#random'], c)).toBe(true);
    expect(channelListed(['random'], c)).toBe(true);
    expect(channelListed(['C01'], c)).toBe(true);
    expect(channelListed(['#rand'], c)).toBe(false);
  });

  it('finds the thread in a search match’s permalink', () => {
    expect(threadTsOf({ ts: '2', permalink: 'https://x.slack.com/archives/C1/p2?thread_ts=1.000100&cid=C1' })).toBe('1.000100');
    expect(threadTsOf({ ts: '2', permalink: 'https://x.slack.com/archives/C1/p2' })).toBeUndefined();
    expect(permalinkFor('https://x.slack.com/', 'C1', '2.000200', '1.000100')).toBe('https://x.slack.com/archives/C1/p2000200?thread_ts=1.000100&cid=C1');
  });

  it('splits DMs into windows at 30 minutes of quiet (FR-2.6)', () => {
    // Gaps of 20, 30 (exactly: splits) and 29 minutes.
    const w = dmWindows([{ ts: ts(100) }, { ts: ts(80) }, { ts: ts(50) }, { ts: ts(21) }]);
    expect(w.map((x) => x.length)).toEqual([2, 2]);
    expect(dmWindows([{ ts: ts(100) }, { ts: ts(70.5) }]).length).toBe(1);
  });

  it('runs at most n at a time', async () => {
    let now = 0;
    let max = 0;
    const out = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (x) => {
      max = Math.max(max, ++now);
      await new Promise((r) => setTimeout(r, 2));
      now--;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(max).toBe(3);
  });
});

describe('Slack adapter, search mode (FR-2.3)', () => {
  it('turns a first poll into threads and DM windows, without bots or excluded channels', async () => {
    const { P } = workspace();
    const r = await adapter().fetchSince(undefined, ctx());
    const items = byId(r.items);
    expect(Object.keys(items).sort()).toEqual([`slack:C01PROD:${P}`, `slack:C01PROD:${ts(20)}`, `slack:D01MATT:${ts(200)}`, `slack:D01MATT:${ts(50)}`, `slack:G01MPDM:${ts(5)}`].sort());
    expect(items[`slack:C01PROD:${P}`]).toMatchObject({
      source: 'slack',
      kind: 'thread',
      title: '#product',
      permalink: `https://polestar.slack.com/archives/C01PROD/p${P.replace('.', '')}`,
      participants: [
        { id: 'U02DANA', name: 'Dana Lee' },
        { id: 'U03SAM', name: 'Sam' },
        { id: 'UFRANK', name: 'Frank' },
      ],
      messageCount: 3,
      lastActivityAt: tsToIso(ts(30)),
      schemaVersion: 1,
    });
    expect(items[`slack:C01PROD:${P}`].messages.map((m) => m.id)).toEqual([P, ts(60), ts(30)]);
    expect(items[`slack:D01MATT:${ts(50)}`]).toMatchObject({ kind: 'dm', title: 'Matt M.', messageCount: 2 });
    expect(items[`slack:G01MPDM:${ts(5)}`]).toMatchObject({ kind: 'dm', title: 'Sam' });
    expect(JSON.stringify(r.items)).not.toMatch(/Deploy finished|joined|Lunch|Not Frank/);
    // The cursor is the newest message seen, bot or not.
    expect(r.nextCursor).toBe(ts(5));
    // One search page; one thread fetched, because a reply pointed at it.
    expect(slack.count('search.messages')).toBe(1);
    expect(slack.count('conversations.replies')).toBe(1);
  });

  it('fetches only what changed since the cursor, looking back 15 minutes for search lag', async () => {
    const { P } = workspace();
    const a = adapter();
    const first = await a.fetchSince(undefined, ctx());
    slack.post('C01PROD', { ts: ts(-5), thread_ts: P, user: 'U02DANA', text: 'Updated, have a look' });
    slack.post('C01PROD', { ts: ts(3), user: 'U03SAM', text: 'Indexed late' }); // older than the cursor
    slack.post('D01MATT', { ts: ts(-8), user: 'U04MATT', text: 'Any news?' });
    slack.calls = [];
    const r = await a.fetchSince(first.nextCursor, ctx(NOW + 10 * MIN));
    const items = byId(r.items);
    expect(items[`slack:C01PROD:${P}`].messages).toHaveLength(4);
    expect(items[`slack:C01PROD:${ts(3)}`]).toBeDefined();
    expect(items[`slack:D01MATT:${ts(-8)}`]).toMatchObject({ messageCount: 1 }); // 53 minutes after the last: a new window
    expect(items[`slack:C01PROD:${ts(20)}`]).toBeUndefined(); // older than the look-back
    expect(r.nextCursor).toBe(ts(-8));
    expect(slack.count('auth.test') + slack.count('users.conversations')).toBe(0); // cached
  });

  it('keys a DM window by its first message, even when that came before the cursor', async () => {
    workspace();
    slack.post('D01MATT', { ts: ts(40), user: 'UFRANK', text: 'Checking now' });
    const r = await adapter().fetchSince(ts(42), ctx());
    expect(byId(r.items)[`slack:D01MATT:${ts(50)}`].messages.map((m) => m.id)).toEqual([ts(50), ts(45), ts(40)]);
  });

  it('keeps to includeChannels when set, and always to DMs', async () => {
    workspace();
    const r = await adapter({ includeChannels: ['C03OTHER'] }).fetchSince(undefined, ctx());
    const channels = new Set(r.items.map((i) => i.id.split(':')[1]));
    expect([...channels].sort()).toEqual(['C03OTHER', 'D01MATT', 'G01MPDM']);
  });

  it('stops paging once a page reaches back past the cursor', async () => {
    workspace();
    slack.channel({ id: 'C04BUSY', name: 'busy' });
    for (let i = 0; i < 400; i++) slack.post('C04BUSY', { ts: ts(i * 0.2, 1), user: 'U03SAM', text: `m${i}` });
    const r = await adapter().fetchSince(ts(30), ctx());
    // 413 matches in 5 pages of 100. The look-back starts 45 min ago; page 3 reaches past it.
    expect(slack.count('search.messages')).toBe(3);
    expect(r.items.filter((i) => i.id.includes('C04BUSY'))).toHaveLength(226); // 0–45 min ago, each 1 ms later
    // Top-level messages need no thread fetch; only #product's thread has a reply in the window.
    expect(slack.calls.filter((c) => c.method === 'conversations.replies').map((c) => c.params.channel)).toEqual(['C01PROD']);
  });

  it('fetches threads three at a time', async () => {
    workspace();
    for (let i = 0; i < 9; i++) {
      slack.post('C01PROD', { ts: ts(100 + i), user: 'U02DANA', text: `q${i}` });
      slack.post('C01PROD', { ts: ts(1 + i), thread_ts: ts(100 + i), user: 'U03SAM', text: `a${i}` });
    }
    await adapter().fetchSince(ts(20), ctx());
    expect(slack.count('conversations.replies')).toBe(10); // these 9, and #product's thread with its reply at 30 min ago

    expect(slack.maxInFlight).toBeLessThanOrEqual(3);
  });
});

describe('Group DMs and links', () => {
  it('titles a group DM with everyone in it, not only who wrote', async () => {
    workspace();
    slack.users.set('U05ANK', 'Ankush');
    slack.channels.get('G01MPDM')!.members = ['UFRANK', 'U03SAM', 'U05ANK'];
    const items = byId((await adapter().fetchSince(undefined, ctx())).items);
    expect(items[`slack:G01MPDM:${ts(5)}`].title).toBe('Sam, Ankush');
  });

  it('links to the web client: a thread in its pane, a DM at its latest messages', () => {
    expect(webClientUrl('T0POLE', 'slack:C01PROD:1791277200.000100', 'thread')).toBe('https://app.slack.com/client/T0POLE/C01PROD/thread/C01PROD-1791277200.000100');
    expect(webClientUrl('T0POLE', 'slack:D01MATT:1791277200.000100', 'dm')).toBe('https://app.slack.com/client/T0POLE/D01MATT');
  });
});

describe('Earlier messages before a DM item', () => {
  it('reads the conversation before the item from Slack, with names, and caches it', async () => {
    workspace();
    slack.post('D01MATT', { ts: ts(180), user: 'U04MATT', text: 'cc <@U02DANA>' });
    const a = adapter();
    const items = byId((await a.fetchSince(undefined, ctx())).items);
    const dm = items[`slack:D01MATT:${ts(50)}`];
    const earlier = new EarlierMessages(a.directory);
    const v = await earlier.forItem(dm);
    expect(v.messages.map((m) => m.text)).toEqual(['Morning', 'Morning Matt', 'cc <@U02DANA>']);
    expect(v.people).toEqual(expect.arrayContaining([{ id: 'U04MATT', name: 'Matt M.' }, { id: 'U02DANA', name: 'Dana Lee' }]));
    const calls = slack.count('conversations.history');
    await earlier.forItem(dm);
    expect(slack.count('conversations.history')).toBe(calls);
    // Never more than a week before the item.
    slack.post('D01MATT', { ts: ts(60 * 24 * 8), user: 'U04MATT', text: 'Last week' });
    expect((await new EarlierMessages(a.directory).forItem(dm)).messages.map((m) => m.text)).not.toContain('Last week');
    // Threads are fetched whole already: nothing before them.
    expect(await earlier.forItem(items[`slack:C01PROD:${ts(20)}`])).toEqual({ messages: [], people: [] });
  });
});

describe('Slack adapter, history mode (FR-2.4)', () => {
  it('finds new messages and threads with new replies under older parents', async () => {
    const { P } = workspace();
    const r = await adapter({ fetchMode: 'history' }).fetchSince(ts(40), ctx());
    const items = byId(r.items);
    expect(Object.keys(items).sort()).toEqual([`slack:C01PROD:${P}`, `slack:C01PROD:${ts(20)}`, `slack:D01MATT:${ts(50)}`, `slack:G01MPDM:${ts(5)}`].sort());
    expect(items[`slack:C01PROD:${P}`].messages).toHaveLength(3);
    expect(slack.calls.some((c) => c.params.channel === 'C03OTHER' || c.params.channel === 'C02RANDOM')).toBe(false);
    expect(r.nextCursor).toBe(ts(5));
  });
});

describe('Slack errors (FR-2.9)', () => {
  const failureOf = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(SourceError);
    return e as SourceError;
  };

  it('passes on Retry-After from a 429', async () => {
    workspace();
    slack.fail('search.messages', { status: 429, headers: { 'retry-after': '30' } });
    const e = await failureOf(adapter().fetchSince(undefined, ctx()));
    expect(e.failure).toEqual({ state: 'rate_limited', reason: 'http_429', retryAfterMs: 30_000 });
  });

  it('reports a revoked token, then reads the Keychain again on the next try', async () => {
    workspace();
    const a = adapter();
    slack.token = 'xoxp-new-token';
    const e = await failureOf(a.fetchSince(undefined, ctx()));
    expect(e.failure).toEqual({ state: 'auth_failed', reason: 'invalid_auth' });
    secrets.values[SLACK_TOKEN_ACCOUNT] = 'xoxp-new-token';
    await a.fetchSince(undefined, ctx());
    expect(slack.calls.at(-1)?.token).toBe('xoxp-new-token');
  });

  it('marks network errors for a probe and a portal page as offline', async () => {
    workspace();
    slack.fail('auth.test', { throws: new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }) });
    expect((await failureOf(adapter().fetchSince(undefined, ctx()))).failure).toEqual({ state: 'degraded', reason: 'enotfound', needsProbe: true });
    slack.fail('auth.test', { status: 200, headers: { 'content-type': 'text/html' }, body: '<html>Hotel Wi-Fi</html>' });
    expect((await failureOf(adapter().fetchSince(undefined, ctx()))).failure).toEqual({ state: 'offline', reason: 'captive_portal' });
  });

  it('says which Keychain entry is missing, and tells a locked Keychain apart', async () => {
    workspace();
    secrets = memoryKeychain();
    const missing = await failureOf(adapter().fetchSince(undefined, ctx()));
    expect(missing).toMatchObject({ dep: 'slack', failure: { state: 'auth_failed', reason: 'token_missing' } });
    expect(missing.message).toContain(SLACK_TOKEN_ACCOUNT);
    secrets = { get: () => Promise.reject(new Error('locked')), set: () => Promise.reject(new Error('locked')) } as unknown as typeof secrets;
    expect(await failureOf(adapter().fetchSince(undefined, ctx()))).toMatchObject({ dep: 'keychain' });
  });

  it('never puts the token in an error or a URL', async () => {
    workspace();
    slack.fail('search.messages', { status: 500 });
    const e = await failureOf(adapter().fetchSince(undefined, ctx()));
    expect(`${e.message} ${JSON.stringify(e)}`).not.toContain('xoxp');
    expect(slack.calls.every((c) => !JSON.stringify(c.params).includes('xoxp'))).toBe(true);
  });

  it('probes with auth.test', async () => {
    workspace();
    expect(await adapter().probe(new AbortController().signal)).toBe('ok');
    slack.token = 'other';
    expect(await adapter().probe(new AbortController().signal)).toBe('auth_failed');
  });
});
