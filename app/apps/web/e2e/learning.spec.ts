import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Settings › Learning and policy proposals (PLAN FR-15.8–15.10): with two weeks of filing labels,
// run the filing eval, propose a better policy, and apply it from Settings › Prompts.

const APP = join(import.meta.dirname, '../../..');
const HIDE = '[data-testid="os-notification"], [data-scenarios], [aria-label="Notifications"][aria-live] { display: none !important; }';

test.use({ viewport: { width: 1440, height: 1700 } });

async function withLabels(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-row]').first()).toBeVisible();
  await page.keyboard.press('Backquote');
  const drawer = page.getByRole('complementary', { name: 'Scenarios' });
  await drawer.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer.getByRole('button', { name: '13:48 with the filing policy (cockpit)', exact: true }).click();
  await page.keyboard.press('Backquote');
  await page.getByRole('link', { name: 'Settings' }).first().click();
  await page.getByRole('link', { name: 'Learning', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Learning', level: 2 })).toBeVisible();
}

const shoot = async (page: Page, el: ReturnType<Page['locator']>, name: string) => {
  await page.addStyleTag({ content: HIDE });
  await el.screenshot({ path: join(APP, `screenshots/${name}-light.png`), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await el.screenshot({ path: join(APP, `screenshots/${name}-dark.png`), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
};

test('J91 Learning: run the filing eval, propose a better policy, apply it from Prompts (FR-15.8–15.10)', async ({ page }) => {
  await withLabels(page);
  await expect(page.getByTestId('filing-labels')).toContainText('24 items');
  await expect(page.getByText('24 new labels')).toBeVisible();

  await page.getByRole('button', { name: 'Run filing eval' }).click();
  const table = page.getByRole('table', { name: 'Filing eval scores' });
  await expect(table).toBeVisible({ timeout: 10_000 });
  await expect(table.locator('[data-field="ready"]')).toContainText('counts from 30');

  await page.getByRole('button', { name: 'Propose a better policy' }).click();
  await expect(page.getByTestId('proposal-status')).toContainText('is waiting, and scores better', { timeout: 10_000 });
  await shoot(page, page.getByRole('main', { name: 'Learning' }), 'settings-learning');

  await page.getByTestId('proposal-status').getByRole('link', { name: 'Review it' }).click();
  await expect(page).toHaveURL(/\/settings\/prompts/);
  const banner = page.getByRole('region', { name: 'Proposed change' });
  await expect(banner).toContainText('Added R2:');
  await expect(banner).toContainText('Scores better');
  await banner.getByText('Show the changes in the text').click();
  await expect(banner.getByTestId('proposal-diff')).toContainText('+ - [R2] A settled decision on a named product');
  await shoot(page, banner, 'prompts-proposal');

  await banner.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Filing policy updated')).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('[data-prompt="filing-policy"]')).toContainText('filing-policy v2#');

  await page.getByRole('link', { name: 'Learning', exact: true }).click();
  await expect(page.getByTestId('proposal-status')).toContainText('was applied');
});

test('J91 the switches: draft ahead, Ready to approve and to-do suggestions save at once (FR-15.10)', async ({ page }) => {
  await withLabels(page);
  await page.getByRole('group', { name: 'Draft ahead' }).getByRole('button', { name: 'None' }).click();
  await page.getByRole('switch', { name: 'Ready to approve' }).click();
  await expect(page.getByRole('switch', { name: 'Ready to approve' })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('group', { name: 'Draft ahead' }).getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true');
  // Back in the inbox, To file has its rows but no Ready group.
  await page.getByRole('link', { name: 'Inbox' }).first().click();
  const toFile = page.getByRole('region', { name: 'To file', exact: true });
  await expect(toFile.locator('[data-row]').filter({ hasText: 'v2 vessel-events endpoint drops the legacy imo_str field' })).toBeVisible();
  await expect(toFile).not.toContainText('Ready · R1');
  await expect(toFile.locator('[data-subhead="ready"]')).toHaveCount(0);
});
