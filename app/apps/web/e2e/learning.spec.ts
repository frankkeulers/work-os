import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// Settings › Learning and policy proposals (PLAN FR-15.8–15.11): with two weeks of filing labels,
// run the filing eval, propose a better policy, and apply it from Settings › Prompts; and the same
// for the triage prompt, the settle check and Looks finished.

const APP = join(import.meta.dirname, '../../..');
const HIDE = '[data-testid="os-notification"], [data-scenarios], [aria-label="Notifications"][aria-live] { display: none !important; }';

test.use({ viewport: { width: 1440, height: 1700 } });

const bell = (page: Page) => page.getByTestId('bell');
const entry = (page: Page, text: string) => page.getByRole('dialog', { name: 'Follow-ups' }).getByRole('list', { name: 'Needs you' }).getByRole('listitem').filter({ hasText: text });

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

/** Light and dark (or light only). Main scrolls on its own, so the viewport grows to fit all of the
 * element; the toasts are hidden while it shoots and shown again after, for the checks that follow. */
const shoot = async (page: Page, el: ReturnType<Page['locator']>, name: string, dark = true) => {
  const hide = await page.addStyleTag({ content: `${HIDE} [aria-live="polite"]:not([aria-label]) { display: none !important; }` });
  await page.setViewportSize({ width: 1440, height: 3200 });
  await el.screenshot({ path: join(APP, `screenshots/${name}-light.png`), animations: 'disabled' });
  if (dark) {
    await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
    await el.screenshot({ path: join(APP, `screenshots/${name}-dark.png`), animations: 'disabled' });
    await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  }
  await page.setViewportSize({ width: 1440, height: 1700 });
  await hide.evaluate((h) => h.remove());
};

test('J91 Learning: run the filing eval, propose a better policy, apply it from Prompts (FR-15.8–15.10)', async ({ page }) => {
  await withLabels(page);
  await expect(page.getByTestId('filing-labels')).toContainText('24 items');
  await expect(page.getByText('24 new labels')).toBeVisible();

  await page.getByRole('button', { name: 'Run filing eval' }).click();
  const table = page.getByRole('table', { name: 'Filing eval scores' });
  await expect(table).toBeVisible({ timeout: 10_000 });
  await expect(table.locator('[data-field="ready"]')).toContainText('counts from 30');
  // The bell says it finished, which fields meet their target, and leads back here.
  await bell(page).click();
  const done = entry(page, 'Filing eval finished');
  await expect(done).toContainText('24 labelled items');
  await expect(done).toContainText('Below: To file, Pre-draft.'); // the fields with 30 labels
  await done.getByRole('button', { name: 'View scores' }).click();
  await expect(page).toHaveURL(/\/settings\/learning$/);
  await bell(page).click();
  await expect(entry(page, 'Filing eval finished')).toHaveCount(0); // done its job once opened
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Propose a better policy' }).click();
  await expect(page.getByTestId('proposal-status-filing')).toContainText('is waiting, and scores better', { timeout: 10_000 });
  await shoot(page, page.getByRole('main', { name: 'Learning' }), 'settings-learning');

  await expect(page.getByTestId('proposal-status-filing').getByRole('link', { name: 'Review it' })).toHaveAttribute('href', '/settings/prompts#filing-policy');
  // The bell's entry opens Settings › Prompts scrolled to the proposal.
  await bell(page).click();
  await entry(page, 'A filing policy change is proposed').getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/\/settings\/prompts#filing-policy$/);
  const banner = page.getByRole('region', { name: 'Proposed change' });
  await expect(banner).toBeInViewport();
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
  await expect(page.getByTestId('proposal-status-filing')).toContainText('was applied');
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

test('J92 the other loops: propose a better triage prompt and apply it; Looks finished waits for 10 labels (FR-15.11)', async ({ page }) => {
  await withLabels(page);
  const main = page.getByRole('main', { name: 'Learning' });
  await expect(page.getByTestId('triage-labels')).toContainText('from your corrections and Triage was right');
  await expect(page.getByTestId('settle-labels')).toContainText('14 items · from your Undo and Done');
  await expect(page.getByTestId('finish-labels')).toContainText('6 items · your answers to Looks finished');
  await expect(main.getByText('Needs 10 labelled items; there are 6.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Propose a better Looks finished check' })).toBeDisabled();

  await page.getByRole('button', { name: 'Propose a better triage prompt' }).click();
  await expect(page.getByTestId('proposal-status-triage')).toContainText('is waiting, and scores better', { timeout: 10_000 });
  await expect(page.getByTestId('proposal-status-filing')).toHaveCount(0); // each loop has its own
  await shoot(page, main, 'settings-learning-loops', false);

  await bell(page).click();
  await entry(page, 'A triage prompt change is proposed').getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/\/settings\/prompts#triage$/);
  const banner = page.getByRole('region', { name: 'Proposed change' });
  await expect(banner).toBeInViewport();
  await expect(banner).toContainText('Changed: A customer waiting on Frank’s decision before a date is at least Today');
  const now = banner.getByRole('table', { name: 'Held-out scores, current → proposed' }).locator('[data-field="now"]');
  await expect(now).toContainText('82% → 82%');
  await expect(now).toContainText('78% → 89%'); // recall, against its 90% target
  await expect(now).toContainText('≥ 80%, recall ≥ 90%');
  await shoot(page, banner, 'prompts-proposal-triage', false);

  await banner.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('Triage updated')).toBeVisible();
  await expect(banner).toHaveCount(0);
  await expect(page.locator('[data-prompt="triage"]')).toContainText('triage v11#');
});

test('J98 the To Do loops: labels, what code measures, and better estimates proposed and applied (FR-16.14)', async ({ page }) => {
  await withLabels(page);
  const main = page.getByRole('main', { name: 'Learning' });
  await expect(page.getByTestId('schedule-labels')).toContainText('16 items · 10 from you · 6 from your actions');
  await expect(page.getByTestId('schedule-measures')).toHaveText('Planned times kept: 75% of 12 · Done by the deadline: 80% of 15');
  await expect(page.getByTestId('followup-labels')).toContainText('7 items · 5 from you · 2 from your actions');
  await expect(main.getByText('Needs 10 labelled items; there are 7.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Propose better follow-ups' })).toBeDisabled();
  await expect(main.getByText('npm run eval -- --purpose schedule')).toBeVisible();

  await page.getByRole('button', { name: 'Propose better estimates' }).click();
  await expect(page.getByTestId('proposal-status-schedule')).toContainText('is waiting, and scores better', { timeout: 10_000 });
  await page.getByRole('heading', { name: 'To Do estimates' }).scrollIntoViewIfNeeded();
  await shoot(page, main, 'settings-learning-todos', false);

  await bell(page).click();
  await entry(page, 'A To Do estimates prompt change is proposed').getByRole('button', { name: 'Review' }).click();
  await expect(page).toHaveURL(/\/settings\/prompts#schedule$/);
  const banner = page.getByRole('region', { name: 'Proposed change' });
  await expect(banner).toContainText('Added: Slides and figures for others take about two hours');
  const estimate = banner.getByRole('table', { name: 'Held-out scores, current → proposed' }).locator('[data-field="estimate"]');
  await expect(estimate).toContainText('68% → 82%');
  await expect(estimate).toContainText('≥ 80%, recall ≥ 70%');
  await banner.getByRole('button', { name: 'Apply' }).click();
  await expect(page.getByText('To Do estimates updated')).toBeVisible();
  await expect(page.locator('[data-prompt="schedule"]')).toContainText('schedule v2#');
});
