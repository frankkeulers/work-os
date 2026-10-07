import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Topics (amendment): a group DM that Slack cut into six pieces shows as two entries, each with a
// checklist of asks and its pieces in the panel. A piece can be split out; Regroup merges topics.

const APP = join(import.meta.dirname, '../../..');
const drawer = (page: Page) => page.getByRole('complementary', { name: 'Scenarios' });
const itemPanel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const channel = (page: Page, key: string) => page.locator(`[data-channel="${key}"]`);
const rowsIn = (page: Page, title: string) => page.locator('[data-row]').filter({ hasText: title });
const GROUP = 'Backend lead, Platform engineer, QA engineer, Data engineer';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.keyboard.press('Backquote');
  await drawer(page).getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer(page).getByRole('button', { name: 'Topics', exact: true }).click();
  await page.getByRole('button', { name: 'Close scenarios' }).click();
  await page.reload(); // items that arrive while the inbox is open wait behind "new"; a fresh load shows them
  await expect(channel(page, 'G01APIGOV').first()).toBeVisible();
});

test('a group DM in pieces shows as two topics, each with its asks and pieces', async ({ page }) => {
  const rows = rowsIn(page, GROUP);
  await expect(rows).toHaveCount(2);
  const branch = rows.filter({ hasText: 'Pre-publish branch workflow' });
  await expect(branch.locator('[data-pieces]')).toHaveText(' · 4 parts');
  await expect(branch.getByText('+2 asks')).toBeVisible();
  await expect(branch.getByText('Approve', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); // show the rows' ends, which the open panel covers
  await expect(itemPanel(page)).toBeHidden();
  await page.screenshot({ path: join(APP, 'screenshots/topics-inbox-light.png'), animations: 'disabled' });

  await branch.click();
  const panel = itemPanel(page);
  const asks = panel.getByRole('region', { name: 'Asks in this topic' });
  await expect(asks.getByText('3 of 3 open')).toBeVisible();
  await expect(panel.getByRole('heading', { name: 'In this topic · 4 parts' })).toBeVisible();
  await expect(panel.locator('[data-piece]')).toHaveCount(4);
  await expect(panel.locator('[data-piece]').first().getByRole('button', { name: 'Not this topic' })).toHaveCount(0); // the anchor stays
  await page.screenshot({ path: join(APP, 'screenshots/topics-panel-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/topics-panel-dark.png'), animations: 'disabled' }); // fast-forward the colour transitions
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  // Ticking the main ask moves the row on to the next open one.
  await asks.getByRole('checkbox', { name: 'Done: Give the go to enable main branch protection' }).check();
  await expect(asks.getByText('2 of 3 open')).toBeVisible();
  await expect(branch.getByText('Review', { exact: true })).toBeVisible();
  await expect(branch.getByText('+1 ask')).toBeVisible();
});

test('a piece split out of its topic becomes its own entry', async ({ page }) => {
  const rows = rowsIn(page, GROUP);
  await rows.filter({ hasText: 'Pre-publish branch workflow' }).click();
  const piece = itemPanel(page).locator('[data-piece]').filter({ hasText: 'Thread · 2 messages' }).filter({ has: page.getByRole('button', { name: 'Not this topic' }) });
  await expect(piece).toHaveCount(1); // PR 60's thread; the PR 63 one has 3 messages
  await piece.getByRole('button', { name: 'Not this topic' }).click();
  await expect(page.getByText('Split out · it gets its own entry once triaged')).toBeVisible();
  await expect(rows).toHaveCount(3, { timeout: 10_000 });
  await expect(rows.filter({ hasText: 'Pre-publish branch workflow' }).locator('[data-pieces]')).toHaveText(' · 3 parts');
});

test('Regroup merges a conversation’s topics on the same subject', async ({ page }) => {
  // Two threads on the Insights API key auth, triaged apart: a status update (Low priority) and an ask.
  const rows = rowsIn(page, 'Insights API key auth');
  await expect(rows).toHaveCount(1);
  await page.keyboard.press('Escape'); // the open panel covers the channel head's buttons
  const head = page.locator('[data-group="needs"] [data-channel="C04INSIGHTS"]');
  await head.getByRole('button', { name: 'Regroup #insights-api by topic' }).click();
  await expect(page.getByText('Regrouped #insights-api · 1 entry merged into its topic')).toBeVisible({ timeout: 10_000 });
  await expect(rows).toHaveCount(1);
  await expect(rows.locator('[data-pieces]')).toHaveText(' · 2 parts');
  await expect(rows).toHaveAttribute('data-lane', 'today');
});
