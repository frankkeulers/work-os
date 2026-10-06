import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiErrorBody, HealthView, InboxView, ItemView, SettingsView, UsageView } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeClaude, type FakeClaude } from './claude/fakeClaude';
import { memoryKeychain, SLACK_TOKEN_ACCOUNT } from './config/keychain';
import type { Exec } from './runtime/checks';
import type { Clock } from './runtime/power';
import { slackFactory } from './sources/slack/adapter';
import { SlackApi } from './sources/slack/api';
import { SlackDirectory } from './sources/slack/directory';
import { FakeSlack } from './sources/slack/fakeSlack';
import { isoToTs } from './sources/slack/normalise';
import { run, type RunResult } from './start';

// The server end to end against a fake Slack and a fake Claude: poll, inbox, item, done, reopen,
// snooze and the snooze return (M1 step 10), and triage (M2 step 15). The clock is fake; ticks are
// driven by hand.

const START = Date.parse('2026-10-06T08:00:00Z'); // Tuesday 09:00 London
const MIN = 60_000;
let dir: string;
let res: Extract<RunResult, { running: true }>;
let slack: FakeSlack;
let claude: FakeClaude;
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
  claude = fakeClaude();
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
    claude: claude.query,
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

describe('triage (FR-5, Story 5.1, CL-6, CL-7)', () => {
  const PROD = `slack:C01PROD:${P}`;
  const lanes = async () => Object.fromEntries((await inbox()).items.map((i) => [i.title, i.lane]));

  it('labels every quiet thread in one call, with the rule floor, and logs the usage', async () => {
    expect(claude.calls).toHaveLength(1);
    // "@Frank" makes the mention rule send it to the model with a floor of Today.
    expect(await lanes()).toEqual({ '#product': 'today', 'Dana Lee': 'else' });
    const prod = (await inbox()).items.find((i) => i.id === PROD)!;
    expect(prod).toMatchObject({ triageState: 'triaged', summary: 'Release notes draft is up', reason: 'Fake triage for tests.', triage: { attention: 'today', vault: true } });
    // CL-4: no tools, no servers, no settings; the prompt file's version is logged.
    expect(claude.calls[0].options).toMatchObject({ tools: [], mcpServers: {}, settingSources: [], maxTurns: 1, persistSession: false });
    expect(claude.calls[0].system).toMatch(/^<!-- prompt: triage v1 -->/);
    const usage = (await call<UsageView>('GET', '/api/usage')).body;
    expect(usage.budgets.triage.used).toBe(1);
    expect((await call<HealthView>('GET', '/api/health')).body.deps.find((d) => d.id === 'claude')?.state).toBe('ok');
  });

  it('waits for the quiet window, then triages again; Frank’s own replies need no call', async () => {
    slack.post('C01PROD', { ts: isoToTs(START + 1 * MIN), thread_ts: P, user: 'UFRANK', text: 'Looks fine to me' });
    await call('POST', '/api/poll');
    await res.runtime.settled();
    await tick();
    expect(claude.calls).toHaveLength(1);
    slack.post('C01PROD', { ts: isoToTs(START + 2 * MIN), thread_ts: P, user: 'U02DANA', text: 'Great, shipping it. Go/no-go?' });
    await call('POST', '/api/poll');
    await res.runtime.settled();
    expect((await inbox()).items.find((i) => i.id === PROD)).toMatchObject({ triageState: 'pending', lane: 'today' }); // keeps its lane meanwhile
    for (let i = 0; i < 12 * 9; i++) await tick(); // quiet at +12 min; now about +9
    expect(claude.calls).toHaveLength(1);
    for (let i = 0; i < 12 * 4; i++) await tick();
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1].prompt).toContain('Go/no-go?');
    expect(await lanes()).toMatchObject({ '#product': 'now' });
  });

  it('stops calling once the day’s budget is spent; rules still decide (CL-6)', async () => {
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    const settings = { ...view.settings, budgets: { ...view.settings.budgets, triageCallsPerDay: 1 } };
    expect((await call('PUT', '/api/settings', { settings, rules: view.rules })).status).toBe(200);
    slack.post('C01PROD', { ts: isoToTs(START + 1 * MIN), thread_ts: P, user: 'U02DANA', text: 'One more thing?' });
    await call('POST', '/api/poll');
    await res.runtime.settled();
    for (let i = 0; i < 12 * 12; i++) await tick();
    expect(claude.calls).toHaveLength(1);
    expect((await inbox()).items.find((i) => i.id === PROD)).toMatchObject({ triageState: 'pending', modelPaused: true });
    const retry = await call<ApiErrorBody>('POST', `/api/items/${encodeURIComponent(PROD)}/retry-triage`);
    expect(retry.status).toBe(429);
    expect(retry.body.code).toBe('budget');
  });

  it('marks a batch failed after two bad answers, and "Try again" triages it (CL-7)', async () => {
    slack.post('C01PROD', { ts: isoToTs(START + 1 * MIN), thread_ts: P, user: 'U02DANA', text: 'Updated the draft' });
    claude.nextTexts.push('not json', '{"decisions":[{"id":"x"}]}');
    await call('POST', '/api/poll');
    await res.runtime.settled();
    for (let i = 0; i < 12 * 12; i++) await tick();
    expect(claude.calls).toHaveLength(3); // the first triage, then the bad answer and its retry
    // Failed, keeping the lane of its earlier decision (laneFor).
    expect((await inbox()).items.find((i) => i.id === PROD)).toMatchObject({ triageState: 'failed', lane: 'today' });
    for (let i = 0; i < 12 * 12; i++) await tick();
    expect(claude.calls).toHaveLength(3); // failed items wait for Frank
    expect((await call('POST', `/api/items/${encodeURIComponent(PROD)}/retry-triage`)).status).toBe(204);
    expect(claude.calls).toHaveLength(4);
    expect((await inbox()).items.find((i) => i.id === PROD)).toMatchObject({ triageState: 'triaged', lane: 'today' });
  });

  it('reports a lost Claude login to health and leaves the items waiting', async () => {
    slack.post('C01PROD', { ts: isoToTs(START + 1 * MIN), thread_ts: P, user: 'U02DANA', text: 'Updated the draft' });
    claude.failNext = Object.assign(new Error('Not logged in · Please run /login'), {});
    await call('POST', '/api/poll');
    await res.runtime.settled();
    for (let i = 0; i < 12 * 11; i++) await tick();
    const dep = (await call<HealthView>('GET', '/api/health')).body.deps.find((d) => d.id === 'claude');
    expect(dep?.state).toBe('auth_failed');
    expect((await inbox()).items.find((i) => i.id === PROD)?.triageState).toBe('pending');
    const retry = await call<ApiErrorBody>('POST', `/api/items/${encodeURIComponent(PROD)}/retry-triage`);
    expect(retry.status).toBe(503);
  });
});
