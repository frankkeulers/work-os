import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The built web app against the real server, Slack and Claude faked (M1 step 11, M2 step 15): the
// seeded threads are triaged into their lanes, a poll adds a thread that waits for its quiet
// window, a correction moves an item, Done sticks, after a server restart the page goes
// reconnecting, then up, a vault note is drafted and written to the sandbox, and a Confluence entry
// is drafted and its write logged in dry-run.

const APP = resolve(import.meta.dirname, '../../..');
const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = 'workos-fakes-token-0123456789abcdefghijklmnop'; // fakes.ts FAKE_API_TOKEN
const auth = { authorization: `Bearer ${TOKEN}` };

let dir: string;
let server: ChildProcess | undefined;
let output = '';

async function startServer() {
  output = '';
  server = spawn(join(APP, 'node_modules/.bin/tsx'), [join(APP, 'apps/server/src/main.ts'), '--fakes'], {
    env: { ...process.env, WORKOS_INSTANCE: 'dev', WORKOS_DATA_DIR: join(dir, 'data'), WORKOS_PORT: String(PORT), WORKOS_WEB_DIR: join(APP, 'apps/web/dist') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (b) => (output += b));
  server.stderr?.on('data', (b) => (output += b));
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    if (server.exitCode !== null) throw new Error(`The server exited (${server.exitCode}):\n${output}`);
    const ok = await fetch(`${BASE}/api/health`, { headers: auth }).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The server did not answer within 20 s:\n${output}`);
}

async function stopServer() {
  const s = server;
  server = undefined;
  if (!s || s.exitCode !== null) return;
  const exited = new Promise((r) => s.once('exit', r));
  s.kill('SIGTERM');
  await exited;
}

const stillActive = (page: Page, n: number) => page.getByRole('button', { name: `${n} still active` });
const group = (page: Page, name: 'Needs you' | 'To file') => page.getByRole('region', { name, exact: true });
const lane = (page: Page, name: 'now' | 'today') => group(page, 'Needs you').locator(`[data-row][data-lane="${name}"]`);

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-e2e-server-'));
  await startServer();
});
test.afterAll(async () => {
  await stopServer();
  await rm(dir, { recursive: true, force: true });
});

test('inbox, poll, correction, done, a restart, a vault note, a Confluence entry and an eval against the real server', async ({ page, request }) => {
  await page.goto('/');
  // The fake model triages the three quiet threads: Matt's go/no-go is Now, the #product review is
  // Today, and the #mvi-launch licensing note is To file (Confluence).
  await expect(lane(page, 'now')).toHaveCount(1);
  await expect(lane(page, 'now')).toContainText('Matt M.');
  await expect(lane(page, 'today')).toHaveCount(1);
  await expect(lane(page, 'today')).toContainText('#product');
  await expect(group(page, 'To file').locator('[data-row]')).toHaveCount(1);
  await expect(group(page, 'To file')).toContainText('#mvi-launch');
  await expect(page.getByRole('link', { name: /Dry-run on/ })).toBeVisible();
  await page.screenshot({ path: join(APP, 'screenshots/server-inbox-light.png') });

  // A new message in Slack, then Poll now: the thread arrives over SSE and waits for its quiet window.
  const posted = await request.post(`${BASE}/api/fake/slack/messages`, { headers: auth, data: { channel: 'C02LAUNCH', text: 'Pricing page copy needs a decision today.', user: 'U02DANA' } });
  expect(posted.status()).toBe(201);
  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect(stillActive(page, 1)).toBeVisible();
  await stillActive(page, 1).click();
  const waiting = page.getByRole('region', { name: 'Waiting for quiet window' });
  await expect(waiting.locator('[data-row]')).toHaveCount(1);
  await expect(waiting).toContainText('#mvi-launch');

  // Correct triage: the launch note moves to Today and the labelled set gains it (FR-6.2).
  const panel = page.getByRole('complementary', { name: 'Item panel' });
  await group(page, 'To file').locator('[data-row]').click();
  await panel.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Correct triage/ }).click();
  await panel.getByRole('group', { name: 'Attention' }).getByRole('button', { name: 'Today' }).click();
  await panel.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Correction saved · moved to Today · labelled set now 1')).toBeVisible();
  await expect(lane(page, 'today')).toHaveCount(2);

  // Done on #product sticks on the server.
  await lane(page, 'today').filter({ hasText: '#product' }).click();
  await panel.getByRole('button', { name: /^Done e$/ }).click();
  await expect(panel.getByRole('region', { name: 'Status' })).toContainText('Done');
  const inbox = (await (await request.get(`${BASE}/api/inbox`, { headers: auth })).json()) as { items: { title: string; status: string }[] };
  expect(inbox.items.find((i) => i.title === '#product')?.status).toBe('done');

  // Restart: the page notices, waits, and comes back with the same state.
  await stopServer();
  await expect(page.getByRole('heading', { name: /Reconnecting to Work OS|Can’t reach the Work OS server/ })).toBeVisible({ timeout: 20_000 });
  await startServer();
  await expect(stillActive(page, 1)).toBeVisible({ timeout: 20_000 });
  await expect(lane(page, 'now')).toHaveCount(1);
  await expect(lane(page, 'today')).toHaveCount(1);
  await expect(lane(page, 'today').getByText('Corrected by you')).toBeVisible();

  // A vault note (Story 9.1): drafted against the fake vault, approved, written to the sandbox.
  const items = ((await (await request.get(`${BASE}/api/inbox`, { headers: auth })).json()) as { items: { id: string; title: string }[] }).items;
  await page.goto(`/item/${encodeURIComponent(items.find((i) => i.title === 'Matt M.')!.id)}`);
  const action = page.getByRole('region', { name: 'Action' });
  await action.getByRole('tab', { name: /Vault note/ }).click();
  await action.getByRole('button', { name: 'Draft vault note' }).click();
  await expect(action.getByText('Inbox/Matt M.md', { exact: true })).toBeVisible({ timeout: 20_000 });
  await action.getByRole('button', { name: 'Approve and write to sandbox' }).click();
  await expect(action.getByRole('status')).toContainText('Dry-run: Created', { timeout: 20_000 });
  await expect(action.getByRole('status')).toContainText('/sandbox/vault/Inbox/Matt M.md');
  await page.screenshot({ path: join(APP, 'screenshots/server-vault-light.png') });

  // A Confluence entry (Story 10.1): drafted from the fake allow-listed page, people-checked,
  // approved; dry-run only logs the write and saves the would-be page in the sandbox.
  await action.getByRole('tab', { name: /Confluence entry/ }).click();
  await action.getByRole('button', { name: 'Draft Confluence entry' }).click();
  await expect(action.getByRole('link', { name: 'MVI V2 PRD' })).toBeVisible({ timeout: 20_000 });
  await expect(action.getByText('Decisions', { exact: true })).toBeVisible();
  await action.getByRole('button', { name: 'Approve and write to sandbox' }).click();
  await expect(action.getByRole('status')).toContainText('Dry-run: write logged only. MVI V2 PRD stays at v', { timeout: 20_000 });
  await page.screenshot({ path: join(APP, 'screenshots/server-confluence-light.png') });

  // Usage from the real usage log, and an eval over the one label (FR-6.1, FR-7.2).
  await page.goto('/usage');
  await expect(page.getByRole('heading', { name: 'Usage & health', level: 1 })).toBeVisible();
  await expect(page.getByText('No eval run yet')).toBeVisible();
  await page.getByRole('button', { name: 'Run eval' }).click();
  await expect(page.getByText(/Last eval .* on 1 labels/)).toBeVisible();
  // The fake model still says none for the launch note, so there is no Now or Today prediction to score.
  await expect(page.locator('[data-criterion="S1"]')).toContainText('No now or today predictions');
  await expect(page.locator('[data-criterion="S2"]')).toContainText('No now labels');
  await page.screenshot({ path: join(APP, 'screenshots/server-usage-light.png'), fullPage: true });
  await page.getByRole('link', { name: 'View report' }).click();
  await expect(page.getByRole('heading', { name: 'Eval report' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Attention confusion matrix' })).toBeVisible();
});

test('a proxy answering 502 (Vite with the server down) shows the reconnecting screen, then the inbox once it is back', async ({ page }) => {
  // Every API call answers as Vite's proxy does when nothing listens behind it.
  await page.route('**/api/**', (route) => route.fulfill({ status: 502, body: '' }));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Reconnecting to Work OS…' })).toBeVisible();
  // More than 15 s without a connection: the screen says how to start the server.
  await expect(page.getByRole('heading', { name: 'Can’t reach the Work OS server' })).toBeVisible({ timeout: 25_000 });
  await page.screenshot({ path: join(APP, 'screenshots/server-unreachable-light.png') });
  // The server is back: the page finds it on its own.
  await page.unroute('**/api/**');
  await expect(lane(page, 'now')).toHaveCount(1, { timeout: 20_000 });
});

test('the prompt and guidance files are listed from the data directory, and a saved edit lands in the file (FR-1.7)', async ({ page }) => {
  await page.goto('/settings/prompts');
  await expect(page.getByRole('heading', { name: 'Prompts', level: 2 })).toBeVisible();
  // Written on first run from the built-in defaults.
  await expect(page.locator('[data-prompt="confluence-routing"]')).toContainText('confluence-routing v2#');
  await expect(page.locator('[data-prompt="vault-conventions"]')).toContainText('vault-conventions v2#');
  await page.screenshot({ path: join(APP, 'screenshots/server-prompts-light.png') });

  await page.getByRole('button', { name: 'Edit Vault conventions' }).click();
  const text = page.getByLabel('Vault conventions text');
  await expect(text).toHaveValue(/Split hubs/);
  await text.fill('<!-- prompt: vault-conventions v3 -->\nFile meetings under Work/Meetings.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-prompt="vault-conventions"]')).toContainText('vault-conventions v3#');
  expect(await readFile(join(dir, 'data/config/vault-conventions.md'), 'utf8')).toBe('<!-- prompt: vault-conventions v3 -->\nFile meetings under Work/Meetings.\n');

  // Back to the default, for whatever runs next.
  await page.getByRole('button', { name: 'Edit Vault conventions' }).click();
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await page.getByRole('dialog', { name: 'Reset Vault conventions?' }).getByRole('button', { name: 'Reset to default' }).click();
  await expect(page.locator('[data-prompt="vault-conventions"]')).toContainText('vault-conventions v2#');
});
