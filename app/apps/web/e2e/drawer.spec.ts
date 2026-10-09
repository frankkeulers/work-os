import { expect, test, type Page } from '@playwright/test';

// FR-8.1: Now and Today rows share the Needs you group; data-lane tells them apart.
const group = (page: Page, name: 'Needs you' | 'To file') => page.getByRole('region', { name, exact: true });
const rows = (page: Page, name: 'Now' | 'Today' | 'To file') =>
  name === 'To file' ? group(page, name).locator('[data-row]') : group(page, 'Needs you').locator(`[data-row][data-lane="${name.toLowerCase()}"]`);
const drawer = (page: Page) => page.getByRole('complementary', { name: 'Scenarios' });

async function tab(page: Page, name: 'Journeys' | 'Controls' | 'Event log') {
  if (!(await drawer(page).isVisible())) await page.keyboard.press('Backquote');
  await drawer(page).getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name }).click();
}

const ctl = (page: Page, name: string) => drawer(page).getByRole('button', { name, exact: true });

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await tab(page, 'Controls');
  await ctl(page, 'Reset demo data').click();
  await expect(rows(page, 'Now')).toHaveCount(3);
});

test('poll outcomes: nothing eligible, VIP DM, batch of 12, and the event log', async ({ page }) => {
  await ctl(page, 'Nothing eligible').click();
  await expect(page.getByTestId('poll-line')).toContainText('Nothing new, no Claude call', { timeout: 10_000 });

  await ctl(page, 'VIP DM').click();
  await expect(page.getByRole('button', { name: /new item/ }).or(group(page, 'Needs you').getByText('exec sync'))).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel('Notifications').getByText(/Matt M\./)).toBeVisible();

  await ctl(page, '12 quiet threads').click();
  await expect(page.getByTestId('poll-line')).toContainText(/Triaging 12 threads|12 new/, { timeout: 10_000 });

  await tab(page, 'Event log');
  const log = drawer(page);
  await expect(log.getByText('source.polled').first()).toBeVisible();
  await expect(log.getByText('item.upserted').first()).toBeVisible();
  await expect(log.getByText('triage.decided').first()).toBeVisible();
  // Events carry IDs and decisions, never message bodies.
  await expect(log.getByText(/exec sync/)).toHaveCount(0);
});

test('state flags: budgets, Slack, FileVault and rebuilt notices show as banners', async ({ page }) => {
  await ctl(page, 'Triage budget hit').click();
  await expect(page.getByText(/Triage budget reached/)).toBeVisible();
  await ctl(page, 'Drafts budget hit').click();
  // The banner; the panel also says it next to the disabled draft buttons.
  await expect(page.getByText(/Drafts budget reached \(/)).toBeVisible();
  await expect(ctl(page, 'Drafts budget hit')).toHaveAttribute('aria-pressed', 'true');

  await ctl(page, '429 back-off').click();
  await expect(page.getByText('Slack is rate-limiting.')).toBeVisible();
  await ctl(page, 'Auth failure').click();
  await expect(page.getByText('Slack rejected the token.')).toBeVisible();
  await ctl(page, 'Healthy').click();
  await expect(page.getByText('Slack rejected the token.')).toHaveCount(0);

  await ctl(page, 'FileVault off').click();
  await expect(page.getByText('FileVault is off.')).toBeVisible();
  await ctl(page, 'State rebuilt notice').click();
  await expect(page.getByText(/rebuilt from the event log/)).toBeVisible();

  await tab(page, 'Event log');
  await expect(drawer(page).getByText('source.failed').first()).toBeVisible();
});

test('server and startup states replace the app, and the drawer brings it back', async ({ page }) => {
  await ctl(page, 'Down').click();
  await expect(page.getByRole('heading', { name: 'Can’t reach the Work OS server' })).toBeVisible();
  await ctl(page, 'Reconnecting').click();
  await expect(page.getByRole('heading', { name: 'Reconnecting to Work OS…' })).toBeVisible();
  await expect(group(page, 'Needs you')).toBeVisible({ timeout: 10_000 });

  for (const [control, heading] of [
    ['API key set', 'Work OS refused to start'],
    ['Slack token missing', 'No Slack token in the Keychain'],
    ['Claude login failed', 'Claude login failed'],
  ]) {
    await ctl(page, control).click();
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
  }
  await ctl(page, 'All pass').click();
  await expect(group(page, 'Needs you')).toBeVisible();
});

test('clock, draft outcome and data resets', async ({ page }) => {
  const hint = drawer(page).getByText(/London$/).first();
  await expect(hint).toContainText('09:45');
  await ctl(page, '+1 h').click();
  await expect(hint).toContainText('10:45');
  await ctl(page, '+10 min').click();
  await expect(hint).toContainText('10:55');

  await ctl(page, 'Model error').click();
  await expect(ctl(page, 'Model error')).toHaveAttribute('aria-pressed', 'true');
  await expect(ctl(page, 'Normal')).toHaveAttribute('aria-pressed', 'false');

  await ctl(page, 'Inbox zero').click();
  await expect(page.getByTestId('inbox-zero')).toBeVisible();
  await ctl(page, 'First run').click();
  await expect(page.getByRole('button', { name: 'Run first poll' })).toBeVisible();
  await ctl(page, 'Heavy day').click();
  await expect(page.locator('[data-row]').nth(10)).toBeVisible();
  await ctl(page, 'No baseline').click();
  await expect(page.getByText('Baseline not measured yet.')).toBeVisible();
});

test('scope and theme apply instantly', async ({ page }) => {
  await drawer(page).getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await drawer(page).getByRole('group', { name: 'Scope' }).getByRole('button', { name: 'Full' }).click();
  await expect(page.getByRole('region', { name: /Commitments/ })).toBeVisible();
});

test('revision collisions: replies on done, snoozed, corrected and drafted items', async ({ page }) => {
  const poll = page.getByTestId('poll-line');
  const pollWith = async (control: string) => {
    await ctl(page, control).click();
    await expect(poll).toContainText('Polling');
    await expect(poll).not.toContainText(/Polling|Triaging/, { timeout: 10_000 });
  };
  for (const c of ['Reply on a done item', 'Reply on a snoozed item', 'Reply on a corrected item', 'Reply on a drafted item']) await pollWith(c);
  // Replies wait for the 10-minute quiet window like any other thread (§5.3), so nothing has moved yet.
  await expect(poll).toContainText('no Claude call needed');
  await expect(rows(page, 'Now')).toHaveCount(3);

  // Past the quiet window the scheduled poll re-triages all four in one batch.
  await ctl(page, '+10 min').click();
  await expect(poll).toContainText(/4 triaged|1 call/, { timeout: 15_000 });
  // Rows held while the panel is open wait behind a "N new" pill (CK-1.2), which the drawer covers.
  const pills = page.locator('[data-new-pill]');
  await expect(rows(page, 'Now').filter({ hasText: 'needed by 15:00' }).or(pills).first()).toBeVisible();
  await page.keyboard.press('Backquote');
  for (const pill of await pills.all()) if (await pill.isVisible()) await pill.click();

  await expect(rows(page, 'Today').filter({ hasText: 'logo swapped' })).toContainText('New replies');
  await expect(rows(page, 'Now').filter({ hasText: 'needed by 15:00' })).toBeVisible();
  await expect(page.getByText(/Re-triaged after new replies · you had set None/)).toBeVisible();

  await rows(page, 'To file').filter({ hasText: 'imo_str' }).click();
  await page.getByRole('complementary', { name: 'Item panel' }).getByRole('button', { name: 'Review Confluence entry' }).click();
  await expect(page.getByText('New replies since this draft')).toBeVisible();
});
