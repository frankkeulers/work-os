import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Item } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { KeychainError, memoryKeychain, WISPR_OAUTH_ACCOUNT } from '../../config/keychain';
import { SourceError } from '../errors';
import { CONCURRENCY, FIRST_POLL_MS, PAGE_SIZE, TRANSCRIPT_MAX_CHARS, WisprAdapter } from './adapter';
import { FakeWispr } from './fakeWispr';
import meetingFixture from './fixtures/get_meeting.json';
import participantsFixture from './fixtures/get_meeting_participants_enriched.json';
import { classifyWispr, httpConnector, WisprMcp } from './mcp';
import { APP_LINK, buildItem, cursorKey, fixedTs, ME_ID, participantsOf, SUMMARY_AUTHOR } from './normalise';
import { SignInNeeded, WisprAuth } from './oauth';
import { WisprMeeting, WisprParticipants } from './types';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const ctx = (over: { refetch?: string[] } = {}) => ({ signal: new AbortController().signal, now: NOW, reason: 'scheduled' as const, ...over });
const ts = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString().replace('Z', '123Z'); // microseconds, as Wispr sends
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function setup(fake = new FakeWispr()) {
  const mcp = new WisprMcp(fake.connector);
  return { fake, mcp, adapter: new WisprAdapter({ mcp }) };
}

async function failure(p: Promise<unknown>) {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(SourceError);
  return err as SourceError;
}

describe('normalise (R2.3, P0-11)', () => {
  const meeting = WisprMeeting.parse(meetingFixture);
  const people = participantsOf(WisprParticipants.parse(participantsFixture), 'Frank Keulers');

  it('turns a meeting into a valid item: summary and notes, no transcript', () => {
    const item = Item.parse(buildItem(meeting, people));
    expect(item).toMatchObject({ id: `wispr:${meeting.id}`, source: 'wispr', kind: 'meeting', title: 'Fleet data partner sync', permalink: meeting.share_link, messageCount: 2 });
    expect(item.messages.map((m) => [m.id, m.authorId])).toEqual([
      ['summary', SUMMARY_AUTHOR],
      ['notes', ME_ID],
    ]);
    expect(item.messages[0].text).toContain('### Next Steps');
    expect(JSON.stringify(item)).not.toContain('Speaker 1: Yes');
    expect(item.lastActivityAt).toBe('2026-10-07T13:44:02.517Z');
  });

  it('names Frank once and keeps the other speakers', () => {
    expect(people).toEqual([
      { id: ME_ID, name: 'Frank Keulers' },
      { id: 'wispr:name:speaker 1', name: 'Speaker 1' },
    ]);
    expect(participantsOf(undefined, undefined)).toEqual([{ id: ME_ID, name: 'Me' }]);
  });

  it('falls back to the app link, a title and Wispr to-dos when they are missing', () => {
    const item = Item.parse(buildItem({ ...meeting, share_link: null, title: ' ', todos: ['Send the sample', { text: 'Book the trial' }, { odd: 1 }] }, people));
    expect(item.permalink).toBe(APP_LINK);
    expect(item.title).toBe('Untitled meeting');
    expect(item.messages.at(-1)).toMatchObject({ id: 'todos', text: 'Action items:\n- Send the sample\n- Book the trial' });
  });

  it('keys cursors so they sort as text, whatever the fraction', () => {
    expect(fixedTs('2026-10-07T13:44:02Z')).toBe('2026-10-07T13:44:02.000000Z');
    expect(fixedTs('2026-10-07 13:44:02.5 +00:00')).toBe('2026-10-07 13:44:02.5 +00:00'); // not ISO: left alone
    expect(fixedTs('2026-10-07T13:44:02.5+00:00')).toBe('2026-10-07T13:44:02.500000Z');
    expect(cursorKey({ id: 'b', modified_at: '2026-10-07T13:44:02.517309Z' }) > cursorKey({ id: 'a', modified_at: '2026-10-07T13:44:02.5Z' })).toBe(true);
  });
});

describe('Wispr Flow source (R2.7)', () => {
  it('first poll: finalised meetings of the last week, cursor at the newest seen', async () => {
    const { fake, adapter } = setup();
    fake
      .add({ id: uuid(1), modified_at: ts(2), title: 'Standup' })
      .add({ id: uuid(2), modified_at: ts(1), finalized: false, summary: '' }) // still processing
      .add({ id: uuid(3), modified_at: ts(FIRST_POLL_MS / 3_600_000 + 1) }); // older than a week
    const r = await adapter.fetchSince(undefined, ctx());
    expect(r.items.map((i) => i.id)).toEqual([`wispr:${uuid(1)}`]);
    expect(r.nextCursor).toBe(cursorKey(fake.meetings.get(uuid(2))!));
    for (const i of r.items) Item.parse(i);
    expect(adapter.identity()).toEqual({ id: ME_ID, name: 'Frank Keulers' });
  });

  it('pages back only as far as the cursor', async () => {
    const { fake, adapter } = setup();
    for (let n = 1; n <= 2 * PAGE_SIZE + 10; n++) fake.add({ id: uuid(n), modified_at: ts(200 - n) });
    const cursor = cursorKey(fake.meetings.get(uuid(PAGE_SIZE + 5))!); // 55 newer meetings
    const r = await adapter.fetchSince(cursor, ctx());
    expect(r.items).toHaveLength(2 * PAGE_SIZE + 10 - (PAGE_SIZE + 5));
    expect(fake.calls.filter((c) => c.tool === 'search_meetings')).toHaveLength(2);
    expect(r.nextCursor).toBe(cursorKey(fake.meetings.get(uuid(2 * PAGE_SIZE + 10))!));
  });

  it('a quiet poll keeps the cursor and reads nothing', async () => {
    const { fake, adapter } = setup();
    fake.add({ id: uuid(1), modified_at: ts(5) });
    const cursor = cursorKey(fake.meetings.get(uuid(1))!);
    const r = await adapter.fetchSince(cursor, ctx());
    expect(r).toEqual({ items: [], nextCursor: cursor });
    expect(fake.calls.map((c) => c.tool)).toEqual(['get_account_info', 'search_meetings']);
  });

  it('skips a finalised meeting with nothing to triage yet, and picks it up once it has', async () => {
    const { fake, adapter } = setup();
    fake.add({ id: uuid(1), modified_at: ts(3), summary: '', content: '' });
    const first = await adapter.fetchSince(undefined, ctx());
    expect(first.items).toEqual([]);
    fake.add({ id: uuid(1), modified_at: ts(1), summary: '### Next Steps\n- Frank to reply' });
    const again = await adapter.fetchSince(first.nextCursor, ctx());
    expect(again.items.map((i) => i.messages[0].text)).toEqual(['### Next Steps\n- Frank to reply']);
  });

  it('reads asked-for items again, whatever the cursor', async () => {
    const { fake, adapter } = setup();
    fake.add({ id: uuid(1), modified_at: ts(30) });
    const r = await adapter.fetchSince(`${fixedTs(NOW.toISOString())}|`, ctx({ refetch: [`wispr:${uuid(1)}`, 'slack:C1:1.2'] }));
    expect(r.items.map((i) => i.id)).toEqual([`wispr:${uuid(1)}`]);
  });

  it('reads a transcript for drafting: whole, without fences, in ranges, cut at the cap', async () => {
    const { fake, adapter } = setup();
    const line = (n: number) => `Speaker ${n % 3}: point ${n} about the AIS gap report.`;
    const long = Array.from({ length: 3000 }, (_, n) => line(n)).join('\n'); // ~130k characters
    fake.add({ id: uuid(1), modified_at: ts(1), transcript: `<<<transcript start>>>\nFrank: Hello.\nSpeaker 1: Hi.\n<<<transcript end>>>` });
    fake.add({ id: uuid(2), modified_at: ts(1), transcript: long });
    fake.add({ id: uuid(3), modified_at: ts(1), transcript: null });
    const item = (n: number) => ({ id: `wispr:${uuid(n)}` }) as Item;
    const signal = new AbortController().signal;
    expect(await adapter.transcript(item(1), signal)).toBe('Frank: Hello.\nSpeaker 1: Hi.');
    const cut = (await adapter.transcript(item(2), signal))!;
    expect(cut.startsWith(line(0))).toBe(true);
    expect(cut).toContain(line(1000)); // read across the 40,000-character ranges, seamlessly
    expect(cut).not.toContain('truncated');
    expect(cut).toMatch(/\[The transcript goes on: cut at 60,000 characters\.\]$/);
    expect(cut.length).toBeLessThan(TRANSCRIPT_MAX_CHARS + 40_000);
    expect(fake.calls.filter((c) => c.tool === 'get_meeting' && c.args.meeting_id === uuid(2))).toHaveLength(2);
    expect(await adapter.transcript(item(3), signal)).toBeUndefined();
    expect(await adapter.transcript({ id: 'slack:C1:1.2' } as Item, signal)).toBeUndefined();
  });

  it('reads at most three meetings at a time', () => {
    expect(CONCURRENCY).toBe(3);
  });
});

describe('Wispr Flow failures (R2.7, FR-14.3)', () => {
  it('signed out is auth_failed, and probe says so', async () => {
    const { fake, adapter } = setup();
    fake.signedIn = false;
    const err = await failure(adapter.fetchSince(undefined, ctx()));
    expect(err).toMatchObject({ dep: 'wisprMcp', failure: { state: 'auth_failed', reason: 'signed_out' } });
    expect(await adapter.probe(new AbortController().signal)).toBe('auth_failed');
  });

  it('not connected fails before any network call', async () => {
    const auth = new WisprAuth(memoryKeychain(), 'http://127.0.0.1:4318/oauth/wispr/callback');
    let fetched = 0;
    const mcp = new WisprMcp(httpConnector(auth, 'test', async () => (fetched++, new Response('{}'))));
    const err = await failure(new WisprAdapter({ mcp }).fetchSince(undefined, ctx()));
    expect(err.failure).toMatchObject({ state: 'auth_failed', reason: 'token_missing' });
    expect(fetched).toBe(0);
  });

  it('"Too many requests" is rate_limited, with a wait', async () => {
    const { fake, adapter } = setup();
    fake.failWith = 429;
    const err = await failure(adapter.fetchSince(undefined, ctx()));
    expect(err.failure).toMatchObject({ state: 'rate_limited', retryAfterMs: 60_000 });
  });

  it('a server error is degraded', async () => {
    const { fake, adapter } = setup();
    fake.failWith = 503;
    expect((await failure(adapter.fetchSince(undefined, ctx()))).failure).toMatchObject({ state: 'degraded', reason: 'http_503' });
  });

  it('a missing tool or a changed answer is "tools changed", and nothing is called', async () => {
    const { fake, adapter } = setup();
    fake.toolsChanged = true;
    expect((await failure(adapter.fetchSince(undefined, ctx()))).failure.reason).toBe('tools_changed');
    expect(fake.calls).toEqual([]);

    const other = setup();
    other.fake.add({ id: uuid(1), modified_at: ts(1) });
    other.fake.meetings.get(uuid(1))!.finalized = 'yes' as unknown as boolean;
    expect((await failure(other.adapter.fetchSince(undefined, ctx()))).failure.reason).toBe('tools_changed');
  });

  it('classifies transport errors', () => {
    expect(classifyWispr(new StreamableHTTPError(401, 'no')).failure).toMatchObject({ state: 'auth_failed' });
    expect(classifyWispr(new StreamableHTTPError(429, 'slow down')).failure).toMatchObject({ state: 'rate_limited' });
    expect(classifyWispr(new McpError(ErrorCode.RequestTimeout, 'late')).failure).toMatchObject({ state: 'degraded', reason: 'timeout', needsProbe: true });
    expect(classifyWispr(new SignInNeeded()).failure).toMatchObject({ state: 'auth_failed', reason: 'signed_out' });
    expect(classifyWispr(new KeychainError('locked'))).toMatchObject({ dep: 'keychain', failure: { state: 'degraded' } });
    expect(classifyWispr(Object.assign(new Error('x'), { code: 'ENOTFOUND' })).failure).toMatchObject({ needsProbe: true });
  });
});

describe('Wispr Flow sign-in store (R2.7)', () => {
  const REDIRECT = 'http://127.0.0.1:4318/oauth/wispr/callback';

  it('a poll never starts a sign-in, so it cannot overwrite one in progress', async () => {
    const keychain = memoryKeychain();
    const auth = new WisprAuth(keychain, REDIRECT);
    await auth.provider(true).state!();
    const pending = JSON.parse(keychain.values[WISPR_OAUTH_ACCOUNT]).pending.state as string;
    const poll = auth.provider(false);
    await expect(Promise.resolve().then(() => poll.state!())).rejects.toBeInstanceOf(SignInNeeded);
    await expect(Promise.resolve().then(() => poll.saveCodeVerifier('v'))).rejects.toBeInstanceOf(SignInNeeded);
    expect(() => poll.redirectToAuthorization(new URL('https://example.com'))).toThrow(SignInNeeded);
    expect(JSON.parse(keychain.values[WISPR_OAUTH_ACCOUNT]).pending.state).toBe(pending);
  });

  it('keeps one Keychain item, replacing rotated tokens in order', async () => {
    const keychain = memoryKeychain();
    const auth = new WisprAuth(keychain, REDIRECT);
    const p = auth.provider(false);
    await Promise.all([p.saveClientInformation!({ client_id: 'c1', redirect_uris: [REDIRECT] }), p.saveTokens({ access_token: 'a1', token_type: 'bearer', refresh_token: 'r1' }), p.saveTokens({ access_token: 'a2', token_type: 'bearer', refresh_token: 'r2' })]);
    const stored = JSON.parse(keychain.values[WISPR_OAUTH_ACCOUNT]);
    expect(stored).toMatchObject({ client: { client_id: 'c1' }, redirect: REDIRECT, tokens: { refresh_token: 'r2' } });
    expect(await auth.status()).toEqual({ connected: true });
    // A registration for another port is not reused.
    expect(await new WisprAuth(keychain, 'http://127.0.0.1:4319/oauth/wispr/callback').provider(false).clientInformation()).toBeUndefined();
    await auth.forget();
    expect(keychain.values[WISPR_OAUTH_ACCOUNT]).toBe('{}');
    expect(await auth.status()).toEqual({ connected: false });
  });

  it('refuses a callback whose state it did not issue', async () => {
    const auth = new WisprAuth(memoryKeychain(), REDIRECT);
    await auth.provider(true).state!();
    await expect(auth.finish('code', 'forged', fetch)).rejects.toThrow('stale');
  });
});
