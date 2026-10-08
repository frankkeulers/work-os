import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Action, ApiErrorBody, EvalReport, HealthView, InboxView, ItemView, SettingsView, UsageView } from '@work-os/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { fakeClaude, type FakeClaude } from './claude/fakeClaude';
import { CONFLUENCE_TOKEN_ACCOUNT, memoryKeychain, SLACK_TOKEN_ACCOUNT } from './config/keychain';
import { FAKE_CONFLUENCE_CREDS, FakeConfluence } from './actions/fakeConfluence';
import type { Notification } from './notify/macos';
import type { Exec } from './runtime/checks';
import type { Clock } from './runtime/power';
import { slackFactory } from './sources/slack/adapter';
import { SlackApi } from './sources/slack/api';
import { SlackDirectory } from './sources/slack/directory';
import { FakeSlack } from './sources/slack/fakeSlack';
import { isoToTs } from './sources/slack/normalise';
import { TRANSCRIPT_MISSING } from './actions/vaultDrafter';
import { wisprFactory } from './sources/wispr/adapter';
import { FakeWispr } from './sources/wispr/fakeWispr';
import { WisprMcp } from './sources/wispr/mcp';
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
let wispr: FakeWispr;
let confluence: FakeConfluence;
let instance = 'dev';
let notes: Notification[];
let wall: number;
let wakeTime = 'boot';
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
  wakeTime = 'boot';
  notes = [];
  slack = new FakeSlack();
  slack.users.set('U02DANA', 'Dana Lee');
  slack.channel({ id: 'C01PROD', name: 'product' }).channel({ id: 'D01DANA', is_im: true, user: 'U02DANA' });
  slack
    .post('C01PROD', { ts: P, user: 'U02DANA', text: 'Release notes draft is up' })
    .post('C01PROD', { ts: isoToTs(START - 40 * MIN), thread_ts: P, user: 'U02DANA', text: '@Frank can you check the ETA wording?' })
    .post('D01DANA', { ts: isoToTs(START - 20 * MIN), user: 'U02DANA', text: 'Quick one before standup' });
  confluence = new FakeConfluence()
    .page('1100000', 'MVI Context', '<p>Index of the MVI pages.</p>')
    .page('1234567', 'MVI V2 PRD', '<h1>MVI V2</h1><h2>Decisions</h2><ul><li>Bulk export first.</li></ul><h2>Open questions</h2><p>Pricing.</p>', 7, { parent: '1100000' });
  const secrets = memoryKeychain({ [SLACK_TOKEN_ACCOUNT]: slack.token, [CONFLUENCE_TOKEN_ACCOUNT]: FAKE_CONFLUENCE_CREDS });
  claude = fakeClaude();
  wispr = new FakeWispr(); // off until a test turns it on in settings
  const directory = new SlackDirectory(new SlackApi(secrets, slack.fetch));
  const r = await run({
    env: { WORKOS_INSTANCE: instance, WORKOS_DATA_DIR: dir, WORKOS_PORT: '0' },
    secrets,
    clock,
    exec,
    wakeTime: () => wakeTime,
    followZone: () => undefined,
    fetch: slack.fetch,
    sources: { slack: slackFactory(directory), wispr: wisprFactory(new WisprMcp(wispr.connector)) },
    claude: claude.query,
    confluenceFetch: (url, init) => confluence.fetch(url, init),
    notifier: { notify: async (n) => void notes.push(n) },
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

describe('a fixed Slack token (FR-12.2)', () => {
  const slackHealth = async () => (await call<HealthView>('GET', '/api/health')).body.deps.find((d) => d.id === 'slack');

  it('"Check again" polls a source stuck on its token, so the fix shows at once', async () => {
    const good = slack.token;
    slack.token = 'xoxp-revoked'; // Slack no longer accepts ours
    await call('POST', '/api/poll');
    await res.runtime.settled();
    expect(await slackHealth()).toMatchObject({ state: 'auth_failed' });
    // Poll now is refused while it is stuck, and says what to do instead.
    const refused = await call<ApiErrorBody>('POST', '/api/poll');
    expect(refused).toMatchObject({ status: 403, body: { message: expect.stringMatching(/Check again/) } });
    slack.token = good; // fixed in the Keychain
    const polls = slack.calls.length;
    expect((await call('POST', '/api/health/recheck')).status).toBe(204);
    await res.runtime.settled();
    expect(slack.calls.length).toBeGreaterThan(polls);
    expect(await slackHealth()).toMatchObject({ state: 'ok' });
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
    expect(claude.calls[0].system).toMatch(/^<!-- prompt: triage v4 -->/);
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

  it('sends a File rule’s threads to the model, then to File with attention None and a destination', async () => {
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    const rules = [
      { id: 'product-signals', enabled: true, conditions: [{ type: 'channel_in', values: ['#product'] }], outcome: { type: 'file' } },
      { id: 'dms-to-file', enabled: true, conditions: [{ type: 'is_dm' }], outcome: { type: 'file' } },
      ...view.rules,
    ];
    expect((await call('PUT', '/api/settings', { settings: view.settings, rules })).status).toBe(200);
    slack.post('C01PROD', { ts: isoToTs(START + 1 * MIN), thread_ts: P, user: 'U02DANA', text: '@Frank one more thing?' });
    slack.post('D01DANA', { ts: isoToTs(START + 1 * MIN), user: 'U02DANA', text: 'And another' });
    await call('POST', '/api/poll');
    await res.runtime.settled();
    for (let i = 0; i < 12 * 12; i++) await tick();
    expect(claude.calls).toHaveLength(2);
    // The mention would make it Today; the File rule wins and keeps the model's vault suggestion.
    expect(await lanes()).toEqual({ '#product': 'file', 'Dana Lee': 'file' });
    const items = (await inbox()).items;
    expect(items.find((i) => i.id === PROD)).toMatchObject({ triage: { attention: 'none', vault: true, confluence: false } });
    // The model suggested no filing for the DM, so the vault is suggested for it.
    expect(items.find((i) => i.title === 'Dana Lee')).toMatchObject({ triage: { attention: 'none', vault: true, confluence: false } });
  });

  it('lists people for the VIP search: humans from Slack, without Frank, bots or the deactivated', async () => {
    slack.users.set('U03SAM', 'Sam Okafor');
    slack.users.set('U09GONG', 'Gong');
    slack.bots.add('U09GONG');
    const r = await call<{ name: string }[]>('GET', '/api/people');
    expect(r.status).toBe(200);
    expect(r.body.map((p) => p.name)).toEqual(['Dana Lee', 'Sam Okafor']);
  });

  it('lists channel names for the rule editor, from Slack and the inbox', async () => {
    slack.channel({ id: 'C02SIG', name: 'product-signals' });
    const r = await call<string[]>('GET', '/api/channels');
    expect(r.status).toBe(200);
    expect(r.body).toEqual(expect.arrayContaining(['#product', '#product-signals']));
    expect(r.body.some((c) => !c.startsWith('#'))).toBe(false);
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

describe('topics (amendment)', () => {
  const A = isoToTs(START + 1 * MIN);
  const B = isoToTs(START + 2 * MIN);
  const idOf = (ts: string) => `slack:C01PROD:${ts}`;
  const enc = encodeURIComponent;
  const settleAfter = async (mins: number) => {
    wall += mins * MIN;
    mono += mins * MIN;
    await call('POST', '/api/poll');
    await res.runtime.settled();
    await tick();
  };

  it('routes two posts on one PR into one topic, shows its pieces, ticks an ask and splits a piece out', async () => {
    slack.post('C01PROD', { ts: A, user: 'U02DANA', text: 'PR 63 adds GOVERNANCE-RULES.md for the contract checks' });
    slack.post('C01PROD', { ts: B, user: 'U02DANA', text: 'PR 63: the security scheme lands on the wrong module, can you check?' });
    await settleAfter(12);
    const routing = claude.calls.filter((c) => c.prompt.includes('<conversations>'));
    expect(routing).toHaveLength(1);
    const topic = (await inbox()).items.find((i) => i.id === idOf(A))!;
    expect(topic).toMatchObject({ pieces: 2, triageState: 'triaged' });
    expect((await inbox()).items.some((i) => i.id === idOf(B))).toBe(false);

    const view = (await call<ItemView>('GET', `/api/items/${enc(idOf(B))}`)).body; // a part opens as its topic
    expect(view.summary.id).toBe(idOf(A));
    expect(view.item.messages.map((m) => m.text)).toEqual([expect.stringMatching(/^PR 63 adds/), expect.stringMatching(/^PR 63: the security/)]);
    expect(view.pieces?.map((p) => [p.id, p.kind, p.anchor])).toEqual([
      [idOf(A), 'chat', true],
      [idOf(B), 'chat', false],
    ]);

    expect((await call('POST', `/api/items/${enc(idOf(A))}/asks/abc123/done`)).status).toBe(204);
    expect((await inbox()).items.find((i) => i.id === idOf(A))?.asksDone).toEqual(['abc123']);

    expect((await call<ApiErrorBody>('POST', `/api/items/${enc(idOf(A))}/split`)).body.code).toBe('conflict');
    expect((await call('POST', `/api/items/${enc(idOf(B))}/split`)).status).toBe(204);
    await tick();
    const items = (await inbox()).items;
    expect(items.find((i) => i.id === idOf(A))).toMatchObject({ pieces: 1, triageState: 'triaged' });
    expect(items.find((i) => i.id === idOf(B))).toMatchObject({ pieces: 1, triageState: 'triaged' });
  });

  it('regroups topics that routing left apart', async () => {
    slack.post('C01PROD', { ts: A, user: 'U02DANA', text: 'PR 63 adds GOVERNANCE-RULES.md for the contract checks' });
    await settleAfter(12);
    slack.post('C01PROD', { ts: isoToTs(START + 14 * MIN), user: 'U02DANA', text: 'PR 63 is merged' });
    claude.nextTexts.push('not json', 'still not json'); // routing fails: the piece stays on its own
    await settleAfter(12);
    expect((await inbox()).items.filter((i) => i.title === '#product')).toHaveLength(3);

    const r = await call<{ merged: number }>('POST', '/api/topics/regroup', { conversation: 'C01PROD' });
    expect(r).toMatchObject({ status: 200, body: { merged: 1 } });
    await res.runtime.settled();
    const prod = (await inbox()).items.filter((i) => i.title === '#product');
    expect(prod).toHaveLength(2);
    expect(prod.find((i) => i.id === idOf(A))).toMatchObject({ pieces: 2, triageState: 'triaged' });
    expect((await call<ApiErrorBody>('POST', '/api/topics/regroup', {})).body.code).toBe('validation');
  });
});

describe('corrections, labels and the eval (FR-6, FR-7.2, Story 6.1)', () => {
  const PROD = `slack:C01PROD:${P}`;
  const DM = `slack:D01DANA:${isoToTs(START - 20 * MIN)}`;
  const correct = (id: string, body: object) => call<{ labelCount: number } & ApiErrorBody>('POST', `/api/items/${encodeURIComponent(id)}/correction`, body);
  const labelLines = async () => (await readFile(join(dir, 'labels/triage.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean);

  it('moves a corrected item and adds one line to the labelled set', async () => {
    expect((await inbox()).items.find((i) => i.id === DM)?.lane).toBe('else');
    const r = await correct(DM, { attention: 'today', confluence: false, vault: false });
    expect(r).toMatchObject({ status: 200, body: { labelCount: 1 } });
    expect((await inbox()).items.find((i) => i.id === DM)?.lane).toBe('today');
    expect((await inbox()).labelCount).toBe(1);
    const lines = await labelLines();
    expect(lines).toHaveLength(1);
    const label = JSON.parse(lines[0]);
    expect(label).toMatchObject({ origin: 'correction', itemId: DM, source: 'slack', label: { attention: 'today' }, was: { attention: 'none', by: 'model' } });
    expect(label.thread).toMatchObject({ id: DM, kind: 'dm', messages: [{ author: 'Dana Lee' }] });
    // Correcting it again adds a line, but it is still one labelled thread.
    await correct(DM, { attention: 'now', confluence: false, vault: false });
    expect(await labelLines()).toHaveLength(2);
    expect((await call<SettingsView>('GET', '/api/settings')).body).toMatchObject({ labelCount: 1, correctionCount: 2 });
  });

  it('refuses a malformed correction and an unknown item', async () => {
    expect((await correct(DM, { attention: 'soon', confluence: false, vault: false })).status).toBe(422);
    expect((await correct('slack:nope', { attention: 'now', confluence: false, vault: false })).status).toBe(404);
    expect(await labelLines()).toHaveLength(0);
  });

  it('runs the eval over the labels, saves the report and shows it in usage (FR-6.1, FR-6.3)', async () => {
    expect((await call<ApiErrorBody>('POST', '/api/evals')).status).toBe(409);
    await correct(DM, { attention: 'today', confluence: false, vault: false }); // the fake says none
    await correct(PROD, { attention: 'today', confluence: false, vault: true }); // the fake agrees
    expect((await call('POST', '/api/evals')).status).toBe(202);
    expect((await call<UsageView>('GET', '/api/usage')).body.evalRunning).toBe(true);
    await res.evals.settled();
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1].prompt).toContain('these 2 threads');
    const reports = (await call<EvalReport[]>('GET', '/api/evals')).body;
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      labelCount: 2,
      model: 'haiku-5.5',
      confusion: [
        [0, 0, 0],
        [0, 1, 1],
        [0, 0, 0],
      ],
      categories: { today: { precision: 1, recall: 0.5, support: 2 }, vault: { precision: 1, recall: 1, support: 1 } },
    });
    expect((await readdir(join(dir, 'logs'))).filter((f) => f.startsWith('eval-'))).toHaveLength(1);
    const usage = (await call<UsageView>('GET', '/api/usage')).body;
    expect(usage).toMatchObject({ evalRunning: false, lastEval: { id: reports[0].id } });
    expect(usage.byPurpose.map((r) => r.purpose).sort()).toEqual(['eval', 'triage']);
    expect(usage.criteria.find((c) => c.id === 'S1')).toMatchObject({ value: '100%', status: 'on_track' });
  });
});

describe('usage view (FR-7.2)', () => {
  it('counts today’s calls, threads and tokens by purpose and model', async () => {
    const u = (await call<UsageView>('GET', '/api/usage')).body;
    expect(u.today).toMatchObject({ triageCalls: 1, threadsTriaged: 2, tokens: { input: 1200, output: 180, cache: 0, total: 1380 } });
    expect(u.byPurpose).toEqual([{ purpose: 'triage', model: 'haiku-5.5', calls: 1, tokens: 1380, costEquivalent: 0.0012 }]);
    expect(u.days).toHaveLength(7);
    expect(u.days.at(-1)).toMatchObject({ date: '2026-10-06', triage: 0.0012, drafts: 0 });
    // A poll that leaves nothing eligible makes no call, and counts as skipped; a tick doesn't.
    await tick();
    expect((await call<UsageView>('GET', '/api/usage')).body.today.pollsSkipped).toBe(0);
    await call('POST', '/api/poll');
    await res.runtime.settled();
    expect((await call<UsageView>('GET', '/api/usage')).body.today.pollsSkipped).toBe(1);
  });
});

describe('vault note action (FR-9.x, Story 9.1, FR-14.5)', () => {
  const PROD = `slack:C01PROD:${P}`;
  const NOTE = '# Product\n\n## Decisions\n\n- Bulk export first.\n';
  let vault: string;

  // Never the real vault: every test here points at a temp folder, created only by useVault().
  beforeEach(async () => {
    vault = join(dir, '..', 'vault');
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    expect((await call('PUT', '/api/settings', { settings: { ...view.settings, vaultPath: vault }, rules: view.rules })).status).toBe(200);
  });
  const useVault = () => mkdir(join(vault, 'Projects'), { recursive: true });
  const item = async (id = PROD) => (await call<ItemView>('GET', `/api/items/${encodeURIComponent(id)}`)).body;
  const request = async (type = 'vault_note') => {
    const r = await call<Action & ApiErrorBody>('POST', `/api/items/${encodeURIComponent(PROD)}/actions`, { type });
    await res.actions.settled();
    return r;
  };

  it('drafts a new note, and on approval code writes it to the sandbox in dry-run', async () => {
    await useVault();
    const r = await request();
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ itemId: PROD, type: 'vault_note' });
    let v = await item();
    expect(v.actions[0]).toMatchObject({ id: r.body.id, status: 'ready', target: { path: 'Inbox/product.md' } });
    expect(v.drafts[r.body.id]).toMatchObject({ kind: 'vault_new', path: 'Inbox/product.md', model: 'sonnet-5.5' });
    // The call could read the vault, and nothing else (FR-9.1).
    const draftCall = claude.calls.at(-1)!;
    expect(draftCall.options).toMatchObject({ tools: ['Read', 'Grep', 'Glob'], cwd: vault });
    expect(draftCall.system).toMatch(/^<!-- prompt: draft-vault v3 -->/);
    // The vault conventions written on first run go with the request.
    expect(draftCall.prompt).toMatch(/<vault-conventions>\n<!-- prompt: vault-conventions v2 -->/);

    // Frank edits, then approves; the outbox writes once it may.
    expect((await call('PUT', `/api/actions/${r.body.id}/draft`, { content: '# Product\n\nEdited.\n' })).status).toBe(204);
    expect((await call('POST', `/api/actions/${r.body.id}/approve`)).status).toBe(202);
    await res.actions.settled();
    v = await item();
    expect(v.actions[0].status).toBe('done');
    const written = join(dir, 'sandbox/vault/Inbox/product.md');
    expect(await readFile(written, 'utf8')).toBe('# Product\n\nEdited.\n');
    expect(v.results[r.body.id]).toBe(`Dry-run: Created ${written}. Logged action.executed.`);
    await expect(readFile(join(vault, 'Inbox/product.md'))).rejects.toThrow(); // the vault is untouched
    expect((await call<ApiErrorBody>('POST', `/api/actions/${r.body.id}/approve`)).status).toBe(409);
  });

  it('re-drafts instead of writing when the note changed after drafting', async () => {
    await useVault();
    await writeFile(join(vault, 'Projects/Product.md'), NOTE);
    claude.nextTexts.push(JSON.stringify({ kind: 'append', path: 'Projects/Product.md', heading: '## Decisions', content: '- ETA wording agreed.' }));
    const r = await request();
    expect((await item()).drafts[r.body.id]).toMatchObject({ kind: 'vault_append', heading: '## Decisions', context: ['# Product', '## Decisions', '- Bulk export first.'] });
    await writeFile(join(vault, 'Projects/Product.md'), `${NOTE}- Added in Obsidian.\n`);
    await call('POST', `/api/actions/${r.body.id}/approve`);
    await res.actions.settled();
    const v = await item();
    const old = v.actions.find((a) => a.id === r.body.id)!;
    expect(old).toMatchObject({ status: 'failed', failureReason: 'conflict', error: expect.stringMatching(/changed after drafting/) });
    expect(v.actions[0]).toMatchObject({ supersedes: r.body.id, status: 'ready' });
    await expect(readFile(join(dir, 'sandbox/vault/Projects/Product.md'))).rejects.toThrow(); // nothing written
  });

  it('fails a draft that targets a heading the note does not have, and one whose file is lost', async () => {
    await useVault();
    await writeFile(join(vault, 'Projects/Product.md'), NOTE);
    claude.nextTexts.push(JSON.stringify({ kind: 'append', path: 'Projects/Product.md', heading: '## Actions', content: 'x' }));
    const bad = await request();
    expect((await item()).actions[0]).toMatchObject({ id: bad.body.id, status: 'failed', failureReason: 'model_error', error: expect.stringMatching(/no such heading/) });
    const ok = await request();
    await rm(join(dir, 'drafts', `${ok.body.id}.json`));
    await res.actions.recover();
    expect((await item()).actions[0]).toMatchObject({ id: ok.body.id, status: 'failed', failureReason: 'draft_missing' });
  });

  it('refuses Confluence with nothing in scope, and a vault that is not there', async () => {
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    const confluence = { ...view.settings.confluence, roots: [], labels: [], pages: [] };
    expect((await call('PUT', '/api/settings', { settings: { ...view.settings, confluence }, rules: view.rules })).status).toBe(200);
    expect((await request('confluence_entry')).status).toBe(409);
    const r = await request();
    expect(r.status).toBe(503);
    expect(r.body.message).toMatch(/vault folder/);
  });

  it('holds an approved write through a Power Nap wake until 45 s awake (FR-14.2)', async () => {
    await useVault();
    const r = await request();
    wall += 3 * 60 * MIN; // asleep: the wall clock moves, the monotonic clock doesn't
    wakeTime = 'wake-1';
    await tick();
    expect(res.runtime.canUseClaude()).toBe(false);
    await call('POST', `/api/actions/${r.body.id}/approve`);
    await res.actions.settled();
    expect((await item()).actions[0].status).toBe('approved');
    for (let i = 0; i < 8; i++) await tick(); // 40 s awake
    await res.actions.settled();
    expect((await item()).actions[0].status).toBe('approved');
    await tick(); // 45 s
    await res.actions.settled();
    expect((await item()).actions[0].status).toBe('done');
  });

  it('cancels a draft waiting for Claude, and drafts once Claude is back (FR-14.4)', async () => {
    await useVault();
    claude.failNext = Object.assign(new Error('Not logged in · Please run /login'), {});
    const r = await request();
    expect((await item()).actions[0].status).toBe('drafting');
    expect((await call<HealthView>('GET', '/api/health')).body.deps.find((d) => d.id === 'claude')?.state).toBe('auth_failed');
    expect((await call('POST', `/api/actions/${r.body.id}/cancel`)).status).toBe(204);
    expect((await item()).actions[0].status).toBe('discarded');
  });
});

// The fake tree: the MVI Context index, with the MVI V2 PRD below it.
const PICK = JSON.stringify({ candidates: [{ pageId: '1234567', why: 'The PRD.' }] });
const SCOPE = { siteUrl: 'https://fake.atlassian.net', spaceKey: 'MVI', roots: [{ id: '1100000', title: 'MVI Context' }], labels: [], exclude: [], pages: [] };

describe('Confluence entry action (FR-10.x, Story 10.1, FR-14.5)', () => {
  const PROD = `slack:C01PROD:${P}`;
  const item = async () => (await call<ItemView>('GET', `/api/items/${encodeURIComponent(PROD)}`)).body;
  const request = async () => {
    const r = await call<Action & ApiErrorBody>('POST', `/api/items/${encodeURIComponent(PROD)}/actions`, { type: 'confluence_entry' });
    await res.actions.settled();
    return r;
  };
  const approve = async (id: string) => {
    const r = await call('POST', `/api/actions/${id}/approve`);
    await res.actions.settled();
    return r;
  };

  beforeEach(async () => {
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    const settings = { ...view.settings, confluence: SCOPE };
    expect((await call('PUT', '/api/settings', { settings, rules: view.rules })).status).toBe(200);
  });

  it('picks a page from the live catalogue, drafts against it, checks for people, and in dry-run only logs the write', async () => {
    const r = await request();
    expect(r.status).toBe(201);
    let v = await item();
    expect(v.actions[0]).toMatchObject({ status: 'ready', target: { pageId: '1234567', baseVersion: 7 } });
    expect(v.drafts[r.body.id]).toMatchObject({ kind: 'confluence', pageTitle: 'MVI V2 PRD', section: 'Decisions', baseVersion: 7, title: '#product update' });
    expect(v.drafts[r.body.id]).toMatchObject({ ancestorIds: ['1100000'] });
    // The picker saw the catalogue (the index marked as a hub), the draft call only the picked page;
    // neither had tools. Then a Haiku people check.
    const [pickCall, draftCall, check] = claude.calls.slice(-3);
    expect(confluence.searches[0]).toBe('space = "MVI" AND type = page AND (id in (1100000) OR ancestor in (1100000))');
    expect(pickCall.options).toMatchObject({ tools: [], mcpServers: {} });
    expect(pickCall.system).toMatch(/^<!-- prompt: pick-confluence v2 -->/);
    expect(pickCall.prompt).toContain('<confluence-catalogue>\n{"id":"1100000","path":"MVI Context","hub":true}\n{"id":"1234567","path":"MVI Context › MVI V2 PRD"}\n</confluence-catalogue>');
    expect(pickCall.prompt).toMatch(/<routing-guidance>\n<!-- prompt: confluence-routing v3 -->/);
    expect(draftCall.options).toMatchObject({ tools: [], mcpServers: {} });
    expect(draftCall.prompt).toContain('"pageId":"1234567"');
    expect(draftCall.prompt).not.toContain('"pageId":"1100000"');
    expect(draftCall.system).toMatch(/^<!-- prompt: draft-confluence v4 -->/);
    expect(draftCall.prompt).toMatch(/<routing-guidance>\n<!-- prompt: confluence-routing v3 -->/);
    expect(check.system).toMatch(/^<!-- prompt: people-check v1 -->/);
    expect(check.options.model).toBe('claude-haiku-5-5');

    expect((await approve(r.body.id)).status).toBe(202);
    v = await item();
    expect(v.actions[0].status).toBe('done');
    expect(v.results[r.body.id]).toBe('Dry-run: write logged only. MVI V2 PRD stays at v7. Logged action.executed.');
    expect(confluence.pages.get('1234567')!.version).toBe(7); // only read
    expect(confluence.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
    const preview = await readFile(join(dir, 'sandbox/confluence', `1234567-${r.body.id}.html`), 'utf8');
    expect(preview).toContain('<h3>#product update</h3><p>Release notes draft is up</p>');
  });

  it('blocks a draft the people check flags, and refuses items with people observations (FR-10.1, FR-10.4)', async () => {
    claude.nextTexts.push(PICK, JSON.stringify({ pageId: '1234567', section: 'Decisions', title: 'Release', content: 'Dana has been unreliable on reviews.' }));
    const r = await request();
    expect((await item()).actions[0]).toMatchObject({ id: r.body.id, status: 'failed', failureReason: 'people_check', error: expect.stringMatching(/people check found/) });
  });

  it('fails as no_fit, without reading pages or a people check, when the picker finds no home in the catalogue', async () => {
    const before = claude.calls.length;
    claude.nextTexts.push(JSON.stringify({ noFit: true, reason: 'The thread is about DP pricing, which is not in the catalogue.', suggestedHome: 'DP - Pricing' }));
    const r = await request();
    expect((await item()).actions[0]).toMatchObject({ id: r.body.id, status: 'failed', failureReason: 'no_fit', error: expect.stringMatching(/^The thread is about DP pricing, which is not in the catalogue. Suggested home: DP - Pricing./) });
    expect(claude.calls.length - before).toBe(1); // the pick only
    expect(confluence.calls).toHaveLength(0); // no page read
  });

  it('fails as no_fit when the draft call declines the picked pages', async () => {
    claude.nextTexts.push(PICK, JSON.stringify({ noFit: true, reason: 'The PRD is about one build, not context.' }));
    const r = await request();
    expect((await item()).actions[0]).toMatchObject({ id: r.body.id, status: 'failed', failureReason: 'no_fit', error: expect.stringMatching(/^The PRD is about one build/) });
  });

  it('drops picks outside the catalogue, and fails as allow_list when none is left', async () => {
    claude.nextTexts.push(JSON.stringify({ candidates: [{ pageId: '7654321' }] }));
    const r = await request();
    expect((await item()).actions[0]).toMatchObject({ id: r.body.id, status: 'failed', failureReason: 'allow_list', error: expect.stringMatching(/not in the Confluence scope/) });
    expect(confluence.calls).toHaveLength(0);
  });

  it('offers a page added to the tree since the last draft, with no settings change', async () => {
    confluence.page('1300000', 'MVI V3 PRD', '<h1>MVI V3</h1><h2>Scope</h2><p>Next.</p>', 2, { parent: '1100000' });
    claude.nextTexts.push(JSON.stringify({ candidates: [{ pageId: '1300000' }] }));
    const r = await request();
    expect((await item()).drafts[r.body.id]).toMatchObject({ pageId: '1300000', pageTitle: 'MVI V3 PRD', section: 'Scope', baseVersion: 2 });
  });

  it('refuses a draft when nothing is in scope, before any call', async () => {
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    await call('PUT', '/api/settings', { settings: { ...view.settings, confluence: { ...SCOPE, roots: [] } }, rules: view.rules });
    const r = await request();
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/Nothing is in the Confluence scope/);
  });

  it('re-drafts instead of writing when the page was edited after drafting', async () => {
    const r = await request();
    confluence.edit('1234567', '<h1>MVI V2</h1><h2>Decisions</h2><p>Edited.</p>');
    await approve(r.body.id);
    const v = await item();
    expect(v.actions.find((a) => a.id === r.body.id)).toMatchObject({ status: 'failed', failureReason: 'conflict', error: expect.stringMatching(/v7 → v8/) });
    expect(v.actions[0]).toMatchObject({ supersedes: r.body.id, status: 'ready', target: { baseVersion: 8 } });
  });

  it('refuses at write time a page excluded after drafting, or no longer under a root (FR-10.6)', async () => {
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    for (const confluenceNow of [
      { ...SCOPE, exclude: [{ id: '1100000', title: 'MVI Context' }] }, // excluded with everything under it
      { ...SCOPE, roots: [{ id: '1999999', title: 'Elsewhere' }] },
    ]) {
      await call('PUT', '/api/settings', { settings: { ...view.settings, confluence: SCOPE }, rules: view.rules });
      const r = await request();
      await call('PUT', '/api/settings', { settings: { ...view.settings, confluence: confluenceNow }, rules: view.rules });
      await approve(r.body.id);
      expect((await item()).actions.find((a) => a.id === r.body.id)).toMatchObject({ status: 'failed', failureReason: 'allow_list', error: expect.stringMatching(/not in the Confluence scope/) });
      await call('POST', `/api/actions/${r.body.id}/discard`);
    }
    expect(confluence.calls.filter((c) => c.method === 'PUT')).toHaveLength(0);
  });

  it('shows the excluded pages in the item view, for the panel’s warning', async () => {
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    await call('PUT', '/api/settings', { settings: { ...view.settings, confluence: { ...SCOPE, exclude: [{ id: '1300000', title: 'X' }] } }, rules: view.rules });
    expect((await item()).excludedPageIds).toEqual(['1300000']);
  });

  it('waits for Confluence when it fails to draft, and drafts once it is back', async () => {
    confluence.failNext.push(503);
    const r = await request();
    expect((await item()).actions[0]).toMatchObject({ id: r.body.id, status: 'drafting' });
    expect((await call<HealthView>('GET', '/api/health')).body.deps.find((d) => d.id === 'confluence')?.state).toBe('degraded');
    for (let i = 0; i < 5; i++) await tick(); // 25 s: not yet
    await res.actions.settled();
    expect((await item()).actions[0].status).toBe('drafting');
    await tick();
    await res.actions.settled();
    expect((await item()).actions[0]).toMatchObject({ id: r.body.id, status: 'ready' });
    expect((await call<HealthView>('GET', '/api/health')).body.deps.find((d) => d.id === 'confluence')?.state).toBe('ok');
  });
});

describe('Confluence writes outside dry-run (FR-10.5, FR-14.5, NF-5)', () => {
  const PROD = `slack:C01PROD:${P}`;
  const item = async () => (await call<ItemView>('GET', `/api/items/${encodeURIComponent(PROD)}`)).body;
  const puts = () => confluence.calls.filter((c) => c.method === 'PUT');
  const drafted = async () => {
    const r = await call<Action>('POST', `/api/items/${encodeURIComponent(PROD)}/actions`, { type: 'confluence_entry' });
    await res.actions.settled();
    return r.body.id;
  };
  const approve = async (id: string) => {
    await call('POST', `/api/actions/${id}/approve`);
    await res.actions.settled();
  };

  beforeAll(() => {
    instance = 'prod'; // dev forces dry-run; the data dir is still a temp dir
  });
  afterAll(() => {
    instance = 'dev';
  });
  beforeEach(async () => {
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    const settings = { ...view.settings, dryRun: false, confluence: SCOPE };
    expect((await call('PUT', '/api/settings', { settings, rules: view.rules })).status).toBe(200);
  });

  it('writes the next version under the section, marked with the action id', async () => {
    const id = await drafted();
    await approve(id);
    const v = await item();
    expect(v.actions[0].status).toBe('done');
    expect(v.results[id]).toBe('Written to MVI V2 PRD, now v8. Logged action.executed.');
    const page = confluence.pages.get('1234567')!;
    expect(page).toMatchObject({ version: 8, message: `Work OS ${id}` });
    expect(page.storage).toMatch(/<h2>Decisions<\/h2><ul><li>Bulk export first.<\/li><\/ul><h3>#product update<\/h3>.*<h2>Open questions<\/h2>/);
  });

  it('treats a write whose answer was lost as done when the page carries its marker', async () => {
    const id = await drafted();
    const real = confluence.fetch;
    confluence.fetch = async (url, init) => {
      const r = await real(url, init);
      if (init?.method === 'PUT') throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
      return r;
    };
    await approve(id);
    confluence.fetch = real;
    expect((await item()).actions[0].status).toBe('executing');
    for (let i = 0; i < 12; i++) await tick();
    await res.actions.settled();
    expect((await item()).actions[0].status).toBe('done');
    expect(puts()).toHaveLength(1); // reconciled, not written twice
    expect(confluence.pages.get('1234567')!.version).toBe(8);
  });

  it('re-reads after losing a save race (409) and writes on the next attempt', async () => {
    const id = await drafted();
    confluence.failNext.push(0, 0, 409); // the scope search and the GET pass, the PUT loses
    await approve(id);
    expect((await item()).actions[0].status).toBe('executing');
    for (let i = 0; i < 12; i++) await tick();
    await res.actions.settled();
    const v = await item();
    expect(v.actions[0].status).toBe('done');
    expect(v.results[id]).toBe('Written to MVI V2 PRD, now v8. Logged action.executed.');
    expect(puts()).toHaveLength(1); // the forced 409 is not recorded as a call
  });

  it('keeps an approved write through dropped connections without using up its attempts (FR-14.5)', async () => {
    const id = await drafted();
    const real = confluence.fetch;
    let dropped = 0;
    confluence.fetch = async (url, init) => {
      if (init?.method !== 'PUT') return real(url, init);
      dropped++; // before it reaches the page
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    };
    await approve(id);
    for (let i = 0; i < 12 * 20; i++) await tick(); // 20 minutes of failures
    await res.actions.settled();
    expect(dropped).toBeGreaterThan(5); // more than MAX_ATTEMPTS writes tried
    expect((await item()).actions[0].status).toBe('executing');
    confluence.fetch = real;
    for (let i = 0; i < 12 * 15; i++) await tick();
    await res.actions.settled();
    expect((await item()).actions[0]).toMatchObject({ id, status: 'done' });
    expect(confluence.pages.get('1234567')!.version).toBe(8);
  });
});

describe('notifications (FR-11.1, FR-11.2) and health alerts', () => {
  const post = (min: number, text: string) => {
    const ts = isoToTs(START + min * MIN);
    slack.post('C01PROD', { ts, user: 'U02DANA', text });
    return `slack:C01PROD:${ts}`;
  };
  const settle = async () => {
    await res.runtime.settled();
    await res.notifications.settled();
    await res.alerts.settled();
  };
  const setNotifications = async (n: { enabled: boolean; quietHours: string }) => {
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    expect((await call('PUT', '/api/settings', { settings: { ...view.settings, notifications: n }, rules: view.rules })).status).toBe(200);
  };

  it('notifies once when an item becomes Now, and a click opens it', async () => {
    const id = post(1, 'Go/no-go on the launch before Thursday?');
    await call('POST', '/api/poll');
    for (let i = 0; i < 12 * 12; i++) await tick(); // past the quiet window
    await settle();
    expect(notes).toEqual([{ title: '#product', message: 'Go/no-go on the launch before Thursday?', group: `work-os-${id}`, url: `${res.url}/item/${encodeURIComponent(id)}` }]);
    expect(res.store.projection.items[id].notified).toBe(true);
    // Still Now after a new reply: no second notification.
    slack.post('C01PROD', { ts: isoToTs(wall), thread_ts: isoToTs(START + MIN), user: 'U02DANA', text: 'Urgent, any news?' });
    await call('POST', '/api/poll');
    for (let i = 0; i < 12 * 12; i++) await tick();
    await settle();
    expect(claude.calls.at(-1)?.prompt).toContain('Urgent, any news?');
    expect(notes).toHaveLength(1);
  });

  it('records but does not show a Now item in quiet hours, and never shows it later', async () => {
    await setNotifications({ enabled: true, quietHours: '08:00–10:00' }); // 09:00 London now
    const id = post(1, 'Go/no-go before Thursday?');
    await call('POST', '/api/poll');
    for (let i = 0; i < 12 * 12; i++) await tick();
    await settle();
    expect(res.store.projection.items[id]).toMatchObject({ notified: true });
    for (let i = 0; i < 12 * 60; i++) await tick(); // past 10:00
    await settle();
    expect(notes).toHaveLength(0);
  });

  it('turns three or more Now items from a wake catch-up into one summary', async () => {
    const ids = [post(1, 'Go/no-go on pricing?'), post(2, 'Urgent: contract question'), post(3, 'Need this ASAP please')];
    wall += 3 * 60 * MIN; // asleep: the wall clock moves, the monotonic clock doesn't
    wakeTime = 'wake-1';
    for (let i = 0; i < 14; i++) await tick(); // settle, catch-up poll, then 45 s awake for Claude
    await settle();
    expect(ids.map((id) => res.store.projection.items[id].notified)).toEqual([true, true, true]);
    expect(notes).toEqual([{ title: '3 items need you now', message: '#product, #product, #product', group: 'work-os-now', url: res.url }]);
  });

  it('alerts when the Claude login is lost, once, and says when it is back', async () => {
    claude.failNext = Object.assign(new Error('Not logged in · Please run /login'), {});
    post(1, 'Updated the draft');
    await call('POST', '/api/poll');
    for (let i = 0; i < 12 * 12; i++) await tick();
    await settle();
    expect(notes).toEqual([{ title: 'Claude needs you', message: 'Run `claude login` in Terminal, then Check again.', group: 'work-os-health-claude', url: `${res.url}/usage` }]);
    for (let i = 0; i < 12 * 30; i++) await tick(); // still failing would not repeat within 4 h
    await call('POST', '/api/health/recheck');
    for (let i = 0; i < 12 * 2; i++) await tick();
    await settle();
    expect(notes.map((n) => n.title)).toEqual(['Claude needs you', 'Claude is back']);
  });
});

describe('meeting drafts (R2.3, R2.7)', () => {
  const MEETING = '0b9e7c2a-5f41-4d8e-9a6b-3c1d2e4f5a60';
  const ID = `wispr:${MEETING}`;

  beforeEach(async () => {
    const vault = join(dir, '..', 'vault');
    await mkdir(join(vault, 'Work/Meetings'), { recursive: true });
    const view = (await call<SettingsView>('GET', '/api/settings')).body;
    const settings = { ...view.settings, vaultPath: vault, sources: { ...view.settings.sources, wispr: { enabled: true } } };
    expect((await call('PUT', '/api/settings', { settings, rules: view.rules })).status).toBe(200);
    wispr.add({
      id: MEETING,
      title: 'Fleet data partner sync',
      modified_at: new Date(START - 30 * MIN).toISOString().replace('Z', '000Z'),
      summary: '### Next Steps\n- Frank to send the AIS gap report sample by Friday.',
      transcript: '<<<transcript start>>>\nFrank: Shall we start with the gap report?\nSpeaker 1: Could we trial it on three vessels?\n<<<transcript end>>>',
    });
    await call('POST', '/api/poll');
    await res.runtime.settled();
  });
  const draft = async () => {
    const r = await call<Action>('POST', `/api/items/${encodeURIComponent(ID)}/actions`, { type: 'vault_note' });
    await res.actions.settled();
    expect(r.status).toBe(201);
    return { r, call: claude.calls.at(-1)! };
  };

  it('polls the meeting in, and a vault draft reads its transcript live', async () => {
    const box = await inbox();
    expect(box.items.find((i) => i.id === ID)).toMatchObject({ source: 'wispr', kind: 'meeting', title: 'Fleet data partner sync' });
    const files = await readdir(join(dir, 'items', 'wispr'));
    expect(files).toHaveLength(1);
    const stored = await readFile(join(dir, 'items', 'wispr', files[0]), 'utf8');
    expect(stored).toContain('AIS gap report sample');
    expect(stored).not.toContain('three vessels'); // the transcript is never stored
    const { call: c } = await draft();
    expect(c.prompt).toContain('"kind":"meeting"');
    expect(c.prompt).toContain('Speaker 1: Could we trial it on three vessels?');
    expect(c.prompt).not.toContain('<<<transcript');
    expect(wispr.calls.some((x) => x.tool === 'get_meeting' && x.args.view_transcript)).toBe(true);
  });

  it('drafts from the summary when the transcript can’t be read', async () => {
    wispr.signedIn = false;
    const { r, call: c } = await draft();
    expect((await call<ItemView>('GET', `/api/items/${encodeURIComponent(ID)}`)).body.actions.find((a) => a.id === r.body.id)?.status).toBe('ready');
    expect(c.prompt).toContain(TRANSCRIPT_MISSING);
  });
});

