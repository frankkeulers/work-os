import { spawn, type ChildProcess } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The built web app against the real server, Slack and Claude faked (M1 step 11, M2 step 15): the
// seeded threads are triaged into their lanes, a poll adds a thread that waits for its quiet
// window, a correction moves an item, Done sticks, after a server restart the page goes
// reconnecting, then up, a vault note is drafted and written to the sandbox, and a Confluence entry
// is drafted and its write logged in dry-run. Wispr Flow (faked) connects from Settings and its
// meetings are read and triaged.

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
    env: { ...process.env, WORKOS_INSTANCE: 'dev', WORKOS_DATA_DIR: join(dir, 'data'), WORKOS_PORT: String(PORT), WORKOS_WEB_DIR: join(APP, 'apps/web/dist'), WORKOS_GUIDE_DIR: join(dir, 'guide') },
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
  await cp(join(APP, 'docs/guide'), join(dir, 'guide'), { recursive: true }); // a copy the guide test can edit
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

  // A Confluence entry (Story 10.1): picked from the fake catalogue, drafted, people-checked,
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
  await expect(page.locator('[data-prompt="confluence-routing"]')).toContainText('confluence-routing v3#');
  await expect(page.locator('[data-prompt="pick-confluence"]')).toContainText('pick-confluence v2#');
  await expect(page.locator('[data-prompt="vault-conventions"]')).toContainText('vault-conventions v3#');
  await page.screenshot({ path: join(APP, 'screenshots/server-prompts-light.png') });

  await page.getByRole('button', { name: 'Edit Vault conventions' }).click();
  const text = page.getByLabel('Vault conventions text');
  await expect(text).toHaveValue(/Split hubs/);
  await text.fill('<!-- prompt: vault-conventions v4 -->\nFile meetings under Work/Meetings.');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('[data-prompt="vault-conventions"]')).toContainText('vault-conventions v4#');
  expect(await readFile(join(dir, 'data/config/vault-conventions.md'), 'utf8')).toBe('<!-- prompt: vault-conventions v4 -->\nFile meetings under Work/Meetings.\n');

  // Back to the default, for whatever runs next.
  await page.getByRole('button', { name: 'Edit Vault conventions' }).click();
  await page.getByRole('button', { name: 'Reset to default' }).click();
  await page.getByRole('dialog', { name: 'Reset Vault conventions?' }).getByRole('button', { name: 'Reset to default' }).click();
  await expect(page.locator('[data-prompt="vault-conventions"]')).toContainText('vault-conventions v3#');
});

test('the guide is read live from its folder: an edit shows on focus, without a deploy (FR-1.8)', async ({ page }) => {
  const file = join(dir, 'guide/shortcuts.md');
  const original = await readFile(file, 'utf8');
  await page.goto('/guide/shortcuts');
  await expect(page.getByTestId('guide-source')).toHaveText('Read live from docs/guide');

  await writeFile(file, original.replace('title: Keyboard shortcuts', 'title: Keys, edited').replace('Shortcuts work anywhere', 'Edited live. Shortcuts work anywhere'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('heading', { name: 'Keys, edited', level: 2 })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Guide pages' }).getByRole('link', { name: 'Keys, edited' })).toBeVisible();
  await expect(page.locator('.wos-guide')).toContainText('Edited live.');

  // Mid-edit, with the front matter broken: the built-in copy, and what is wrong.
  await writeFile(file, '---\ntitle: Keys\n---\nhalf done');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByText('A guide file has a problem.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts', level: 2 })).toBeVisible();

  // A page added to the folder opens straight from its URL.
  await writeFile(file, original);
  await writeFile(join(dir, 'guide/new-page.md'), '---\ntitle: A new page\ngroup: Help\norder: 95\nupdated: 2026-10-07\n---\nWritten after the build.');
  await page.goto('/guide/new-page');
  await expect(page.getByRole('heading', { name: 'A new page', level: 2 })).toBeVisible();
  await expect(page.getByText('A guide file has a problem.')).toHaveCount(0);
});

/** The inbox's items, as the API has them. */
const inboxItems = async (request: APIRequestContext) => ((await (await request.get(`${BASE}/api/inbox`, { headers: auth })).json()) as { items: { title: string; lane: string }[] }).items;
const TRIAGED = ['now', 'today', 'file', 'else'];

test('Wispr Flow: Connect in Settings, and its finished meetings are read and triaged (R2.7)', async ({ page, request }) => {
  await page.goto('/settings/wispr');
  await expect(page.getByText('Not connected')).toBeVisible();
  // The fake connects at once, as a stored sign-in does: no browser tab.
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Frank Keulers')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Read Wispr Flow meetings' })).toHaveAttribute('aria-checked', 'true');

  // Connect polls Wispr Flow at once; the launch meeting is quiet, so it is triaged straight away.
  await expect.poll(async () => (await inboxItems(request)).some((i) => i.title === 'MVI V2 launch readiness' && TRIAGED.includes(i.lane)), { timeout: 20_000 }).toBe(true);
  await page.goto('/'); // a fresh list, not the "new items" pill of one already open
  const meeting = page.locator('[data-row]').filter({ hasText: 'MVI V2 launch readiness' });
  await expect(meeting).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Wispr/ })).toBeVisible();
  await meeting.click();
  const panel = page.getByRole('complementary', { name: 'Item panel' });
  await expect(panel.getByRole('heading', { name: 'From the meeting notes' })).toBeVisible();
  await expect(panel.getByText('Frank to confirm the rollback owner by Wednesday.', { exact: false })).toBeVisible();
  // The transcript is read only for a draft, never stored with the item.
  await expect(panel.getByText('Are we still on for Thursday?')).toHaveCount(0);
  await page.screenshot({ path: join(APP, 'screenshots/server-wispr-meeting-light.png') });

  // Disconnect: the source goes off, and the meeting already read stays.
  await page.goto('/settings/wispr');
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog', { name: 'Disconnect Wispr Flow?' }).getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Not connected')).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Read Wispr Flow meetings' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await expect(meeting).toBeVisible();
});

test('Outlook: Connect in Settings finds the connector, and its mail is read and triaged, your reply as “You” (R2.5)', async ({ page, request }) => {
  await page.goto('/settings/outlook');
  await expect(page.getByText('Not connected')).toBeVisible();
  // The fake claude.ai has the Microsoft 365 connector signed in: Connect finds it and tests it.
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('outlook-account')).toHaveText('Frank Keulers · frank.keulers@polestar.example');
  await expect(page.getByRole('switch', { name: 'Read Outlook mail' })).toHaveAttribute('aria-checked', 'true');

  // Connect polls Outlook at once; both conversations are quiet, so they are triaged straight away.
  await expect.poll(async () => (await inboxItems(request)).filter((i) => i.title.includes('Nordic Star') && TRIAGED.includes(i.lane)).length, { timeout: 20_000 }).toBe(1);
  await page.goto('/'); // a fresh list, not the "new items" pill of one already open
  const email = page.locator('[data-row^="outlook:"]').filter({ hasText: 'Nordic Star' });
  await expect(email).toBeVisible();
  await expect(email).toHaveAttribute('data-lane', 'today');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Outlook/ })).toBeVisible();
  await email.click();
  const panel = page.getByRole('complementary', { name: 'Item panel' });
  await expect(panel.getByRole('heading', { name: 'Email' })).toBeVisible();
  await expect(panel.getByTestId('recipients')).toHaveText('To You · Cc Sam Okafor');
  await expect(panel.getByText('Could you check the revised ETA shows in MVI?', { exact: false })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reply in Outlook' })).toBeVisible();
  await page.screenshot({ path: join(APP, 'screenshots/server-outlook-email-light.png') });

  // Frank's reply from Sent Items shows as his, and the thread asks nothing of him (the fake model files it).
  const tiers = page.locator('[data-row^="outlook:"]').filter({ hasText: 'pricing tiers' });
  await expect(tiers).toHaveAttribute('data-lane', 'file');
  await tiers.click();
  await expect(panel.getByText('You', { exact: true })).toBeVisible();
  await expect(panel.getByText('Thanks Dana, these look right.', { exact: false })).toBeVisible();

  // A new email, then Poll now: it is read and joins the inbox.
  const posted = await request.post(`${BASE}/api/fake/outlook/messages`, { headers: auth, data: { subject: 'Port call data feed', text: 'Is the port call feed live yet?' } });
  expect(posted.status()).toBe(201);
  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect.poll(async () => (await inboxItems(request)).some((i) => i.title === 'Port call data feed'), { timeout: 20_000 }).toBe(true);
});

/** Scope lives in the account menu at the foot of the sidebar. */
async function setScope(page: Page, scope: 'MVP' | 'Full') {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Account' }).click();
  await page.getByRole('dialog', { name: 'Account' }).getByRole('group', { name: 'Scope' }).getByRole('button', { name: scope }).click();
  await page.keyboard.press('Escape');
}

test('Outlook Calendar: the agenda, an invite as an item that answering in Outlook closes, and the Wispr meeting joined to its event (R2.8)', async ({ page, request }) => {
  // Outlook is connected by the test above; the calendar is a switch of its own.
  await page.goto('/settings/outlook');
  await expect(page.getByRole('switch', { name: 'Read Outlook mail' })).toHaveAttribute('aria-checked', 'true');
  const calendar = page.getByRole('switch', { name: 'Read Outlook Calendar' });
  await calendar.click();
  await expect(calendar).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');

  type Row = { id: string; title: string; lane: string; status: string };
  const invite = async () => ((await inboxItems(request)) as Row[]).find((i) => i.title === 'Nordic Star renewal review');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect.poll(async () => (await invite())?.lane, { timeout: 30_000 }).toBe('today');

  await page.goto('/'); // a fresh list, not the "new items" pill of one already open
  await setScope(page, 'Full'); // the calendar shows in Full scope until it goes live (B7)
  const agenda = page.getByRole('region', { name: 'Agenda' });
  // The launch meeting Wispr Flow recorded is joined to its event: its notes are a click away.
  const launch = agenda.locator('[data-agenda-event]').filter({ hasText: 'MVI V2 launch readiness' });
  await expect(launch).toHaveAttribute('data-phase', 'past');
  await launch.getByRole('button', { name: 'Notes' }).click();
  const panel = page.getByRole('complementary', { name: 'Item panel' });
  await expect(panel.getByTestId('on-calendar')).toHaveText(/^On your calendar: MVI V2 launch readiness · organised by Sam Okafor/);

  const row = page.locator('[data-row^="calendar:"]').filter({ hasText: 'Nordic Star renewal review' });
  await row.click();
  await expect(panel.getByRole('button', { name: 'Respond in Outlook' })).toBeVisible();
  await expect(panel.getByText('Ahead of the renewal, could we walk through the fleet coverage', { exact: false })).toBeVisible();
  await expect(panel.getByText(/Passcode|Meeting ID/)).toHaveCount(0); // the Teams block is cut
  await expect(panel.getByRole('region', { name: /File it|Also file/ })).toHaveCount(0);
  await expect(panel.getByTestId('calendar-categories').getByRole('listitem')).toHaveText(['Customer']); // from search, its colour Frank's to pick
  await expect(launch).toHaveAttribute('data-category-color', /.+/);
  await agenda.getByRole('button', { name: 'Tomorrow' }).click();
  await expect(agenda.locator('[data-agenda-event]').filter({ hasText: 'Nordic Star renewal review' }).getByRole('button', { name: 'Not answered' })).toBeVisible();
  await page.screenshot({ path: join(APP, 'screenshots/server-calendar-light.png'), animations: 'disabled' });

  // Frank accepts in Outlook: the next poll closes the item, and the agenda no longer asks.
  const answered = await request.post(`${BASE}/api/fake/calendar/respond`, { headers: auth, data: { eventId: 'AAMkFAKEEVENTNORDIC', response: 'accepted' } });
  expect(answered.status()).toBe(204);
  await page.getByRole('button', { name: 'Poll now' }).click();
  await expect.poll(async () => (await invite())?.status, { timeout: 30_000 }).toBe('done');
  await expect(agenda.locator('[data-agenda-event]').filter({ hasText: 'Nordic Star renewal review' }).getByText('Not answered')).toHaveCount(0);
});

test('source views: each source’s whole history and the calendar week, from the real server (CK-5.1, 5.6)', async ({ page, request }) => {
  // After the tests above: an item marked done, Wispr Flow and Outlook connected, the invite answered.
  type Row = { id: string; source: string; title: string; status: string; people: string[] };
  const rows = async (source: string) => ((await (await request.get(`${BASE}/api/sources/${source}/items`, { headers: auth })).json()) as { items: Row[] }).items;
  const slack = await rows('slack');
  expect(slack.length).toBeGreaterThan(0);
  expect(slack.every((i) => i.source === 'slack')).toBe(true);
  expect(slack.some((i) => i.status === 'done')).toBe(true);
  expect((await rows('calendar')).find((i) => i.title === 'Nordic Star renewal review')?.status).toBe('done');
  expect((await request.get(`${BASE}/api/sources/gong/items`, { headers: auth })).status()).toBe(404);

  type Week = { state: string; weekStart: string; events: { title: string; notesItemId?: string }[] };
  const week = (await (await request.get(`${BASE}/api/calendar/week`, { headers: auth })).json()) as Week;
  expect(week.state).toBe('ok');
  expect(week.weekStart).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(week.events.find((e) => e.title === 'MVI V2 launch readiness')?.notesItemId).toMatch(/^wispr:/);

  // The sidebar's Calendar opens the week; the launch meeting opens its Wispr Flow notes in the panel.
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Calendar/ }).click();
  await expect(page).toHaveURL(/\/source\/calendar$/);
  const launch = page.locator('[data-week-event]').filter({ hasText: 'MVI V2 launch readiness' });
  await expect(launch).toHaveAttribute('data-linked', 'notes');
  await launch.click();
  const panel = page.getByRole('complementary', { name: 'Item panel' });
  await expect(panel.getByTestId('on-calendar')).toHaveText(/^On your calendar: MVI V2 launch readiness/);
  await page.screenshot({ path: join(APP, 'screenshots/server-source-calendar-light.png'), animations: 'disabled' });
});
