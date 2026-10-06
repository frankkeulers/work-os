import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiErrorBody, HealthView, InboxView, ItemView } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryKeychain, SLACK_TOKEN_ACCOUNT } from './config/keychain';
import type { Exec } from './runtime/checks';
import type { Clock } from './runtime/power';
import { slackFactory } from './sources/slack/adapter';
import { SlackApi } from './sources/slack/api';
import { SlackDirectory } from './sources/slack/directory';
import { FakeSlack } from './sources/slack/fakeSlack';
import { isoToTs } from './sources/slack/normalise';
import { run, type RunResult } from './start';

// The server end to end against a fake Slack: poll, inbox, item, done, reopen, snooze and the snooze
// return (M1 step 10). The clock is fake; ticks are driven by hand.

const START = Date.parse('2026-10-06T08:00:00Z'); // Tuesday 09:00 London
const MIN = 60_000;
let dir: string;
let res: Extract<RunResult, { running: true }>;
let slack: FakeSlack;
let wall: number;
let mono: number;
const clock: Clock = { now: () => new Date(wall), mono: () => mono };
const exec: Exec = async (cmd) => ({ code: 0, stdout: cmd.endsWith('fdesetup') ? 'FileVault is On.\n' : '' });
const P = isoToTs(START - 50 * MIN);

async function call<T>(method: string, url: string, body?: object): Promise<{ status: number; body: T }> {
  const r = await res.server.app.inject({ method: method as 'GET', url, headers: { authorization: `Bearer ${res.token}` }, ...(body && { payload: body }) });
  return { status: r.statusCode, body: (r.body ? r.json() : undefined) as T };
}
const inbox = async () => (await call<InboxView>('GET', '/api/inbox')).body;
async function tick(ms = 5000) {
  wall += ms;
  mono += ms;
  await res.runtime.tick();
  await res.runtime.settled();
}

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), 'workos-cmd-')), 'data');
  wall = START;
  mono = 0;
  slack = new FakeSlack();
  slack.users.set('U02DANA', 'Dana Lee');
  slack.channel({ id: 'C01PROD', name: 'product' }).channel({ id: 'D01DANA', is_im: true, user: 'U02DANA' });
  slack
    .post('C01PROD', { ts: P, user: 'U02DANA', text: 'Release notes draft is up' })
    .post('C01PROD', { ts: isoToTs(START - 40 * MIN), thread_ts: P, user: 'U02DANA', text: '@Frank can you check the ETA wording?' })
    .post('D01DANA', { ts: isoToTs(START - 20 * MIN), user: 'U02DANA', text: 'Quick one before standup' });
  const secrets = memoryKeychain({ [SLACK_TOKEN_ACCOUNT]: slack.token });
  const directory = new SlackDirectory(new SlackApi(secrets, slack.fetch));
  const r = await run({
    env: { WORKOS_INSTANCE: 'dev', WORKOS_DATA_DIR: dir, WORKOS_PORT: '0' },
    secrets,
    clock,
    exec,
    wakeTime: () => 'boot',
    followZone: () => undefined,
    fetch: slack.fetch,
    sources: { slack: slackFactory(directory) },
  });
  if (!r.running) throw new Error('expected a start');
  res = r;
  await res.runtime.settled(); // the first tick polls
});
afterEach(async () => {
  await res.lifecycle.stop('test');
  await rm(dir, { recursive: true, force: true });
});

describe('poll to inbox', () => {
  it('polls on start and serves the items, with Frank’s identity', async () => {
    const box = await inbox();
    expect(box.items.map((i) => i.title).sort()).toEqual(['#product', 'Dana Lee']);
    expect(box.source).toMatchObject({ status: 'healthy', lastPollAt: new Date(START).toISOString(), nextPollAt: new Date(START + 10 * MIN).toISOString() });
    expect(box.poll.phase).toBe('idle');
    expect(box.firstRun).toBe(false);
    const id = `slack:C01PROD:${P}`;
    const item = await call<ItemView>('GET', `/api/items/${encodeURIComponent(id)}`);
    expect(item.body.item.messages).toHaveLength(2);
    expect(item.body.meId).toBe('UFRANK');
    expect((await call<HealthView>('GET', '/api/health')).body.deps.find((d) => d.id === 'slack')?.state).toBe('ok');
  });

  it('polls again on schedule and on "Poll now", picking up only new messages', async () => {
    slack.post('C01PROD', { ts: isoToTs(START + 2 * MIN), thread_ts: P, user: 'U02DANA', text: 'Any thoughts?' });
    expect((await call('POST', '/api/poll')).status).toBe(202);
    await res.runtime.settled();
    const id = `slack:C01PROD:${P}`;
    expect((await call<ItemView>('GET', `/api/items/${encodeURIComponent(id)}`)).body.item.messages).toHaveLength(3);
    const searches = slack.count('search.messages');
    for (let i = 0; i < 10 * 12; i++) await tick();
    expect(slack.count('search.messages')).toBe(searches + 1); // one scheduled poll in 10 minutes
  });

  it('refuses "Poll now" while Slack rejects the token', async () => {
    slack.token = 'rotated';
    await call('POST', '/api/poll');
    await res.runtime.settled();
    const r = await call<ApiErrorBody>('POST', '/api/poll');
    expect(r.status).toBe(403);
    expect(r.body.code).toBe('forbidden');
    expect((await inbox()).source.status).toBe('auth_failed');
  });

  it('shows Slack offline, not failed, when the network is down', async () => {
    slack.fail('search.messages', { throws: new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }) });
    slack.fail('api.test', { throws: new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }) });
    slack.fail('https://api.anthropic.com/', { throws: new TypeError('fetch failed') }); // the other probe
    await call('POST', '/api/poll');
    await res.runtime.settled();
    expect((await inbox()).source.status).toBe('offline');
    expect((await call<HealthView>('GET', '/api/health')).body.mode).toBe('degraded');
  });
});

describe('done, reopen and snooze (FR-8.2, FR-8.3)', () => {
  const id = `slack:C01PROD:${P}`;
  const url = (cmd: string) => `/api/items/${encodeURIComponent(id)}/${cmd}`;
  const status = async () => (await inbox()).items.find((i) => i.id === id)?.status;

  it('marks done and reopens', async () => {
    expect((await call('POST', url('done'))).status).toBe(204);
    expect(await status()).toBe('done');
    expect((await call('POST', url('reopen'))).status).toBe(204);
    expect(await status()).toBe('open');
  });

  it('snoozes until a time, and the item comes back on the tick after it', async () => {
    const bad = await call<ApiErrorBody>('POST', url('snooze'), { until: new Date(START - MIN).toISOString() });
    expect(bad.status).toBe(422);
    expect(bad.body.issues?.[0].path).toBe('until');
    expect((await call('POST', url('snooze'), { until: 'tomorrow' })).status).toBe(422);
    expect((await call('POST', url('snooze'), { until: new Date(START + 30 * MIN).toISOString() })).status).toBe(204);
    expect(await status()).toBe('snoozed');
    await tick(29 * MIN);
    expect(await status()).toBe('snoozed');
    await tick(MIN);
    expect(await status()).toBe('open');
    expect((await inbox()).items.find((i) => i.id === id)?.backFromSnooze).toBe(true);
  });

  it('answers 404 for an unknown item', async () => {
    const r = await call<ApiErrorBody>('POST', '/api/items/slack%3AC9%3A1/done');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('not_found');
  });
});
