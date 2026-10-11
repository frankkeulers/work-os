import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// File in a batch (specs/cockpit/SPEC.md CK-4.1–4.4): on the cockpit at 13:48, To file's
// "File in a batch" opens each item in turn on its suggested filing, one draft ahead.

const APP = join(import.meta.dirname, '../../..');
const HIDE = '[data-testid="os-notification"], [data-scenarios] { display: none !important; }';

test.use({ viewport: { width: 1728, height: 1000 } });

async function control(page: Page, name: string) {
  await page.keyboard.press('Backquote');
  const drawer = page.getByRole('complementary', { name: 'Scenarios' });
  await drawer.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer.getByRole('button', { name, exact: true }).click();
  await page.keyboard.press('Backquote');
  await expect(drawer).toHaveCount(0);
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const toFile = (page: Page) => page.getByRole('region', { name: 'Later', exact: true }).getByRole('region', { name: 'To file', exact: true });
const pos = (page: Page) => panel(page).getByTestId('batch-pos');
// In a batch, approving moves on (UX-2).
const approve = (page: Page) => panel(page).getByRole('button', { name: /^Approve and next/ });
const current = (page: Page) => new URL(page.url()).searchParams.get('item')!;

async function afternoon(page: Page) {
  await page.goto('/');
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await control(page, '13:48 with Outlook and the calendar on (cockpit)');
  await expect(page.locator('[data-row]').filter({ hasText: 'Insights APIs v2 pricing' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('poll-line')).not.toContainText(/Polling|Triaging/);
}

/** The To file rows, in order. */
const fileIds = async (page: Page) => toFile(page).locator('[data-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row')!));

test('J60: file in a batch — each item on its filing, approve moves on, the next draft already running (CK-4.1–4.4)', async ({ page }) => {
  await afternoon(page);
  const ids = await fileIds(page);
  expect(ids.length).toBeGreaterThanOrEqual(3);

  await page.addStyleTag({ content: HIDE });
  await toFile(page).screenshot({ path: join(APP, 'screenshots/cockpit-file-batch-button-light.png'), animations: 'disabled' });
  // Every toast from here on, to show the batch's own drafts don't announce themselves.
  await page.evaluate(() => {
    const seen: string[] = ((window as unknown as { toasts: string[] }).toasts = []);
    new MutationObserver(() => document.querySelectorAll('[role="status"]').forEach((t) => seen.includes(t.textContent!) || seen.push(t.textContent!))).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await toFile(page).getByRole('button', { name: 'File in a batch' }).click();
  await expect(pos(page)).toHaveText(`Filing 1 of ${ids.length}`);
  expect(current(page)).toBe(ids[0]);
  await expect(approve(page)).toBeEnabled({ timeout: 15_000 });
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-batch-light.png'), animations: 'disabled' });

  // The first item suggests Confluence and the vault: the batch stays on it for the vault note, then moves on.
  await expect(panel(page).getByRole('tab', { name: /^Confluence entry/, selected: true })).toBeVisible();
  await approve(page).click();
  await expect(panel(page).getByRole('tab', { name: /^Vault note/, selected: true })).toBeVisible();
  await expect(pos(page)).toHaveText(`Filing 1 of ${ids.length}`);
  await expect(approve(page)).toBeEnabled({ timeout: 15_000 });
  await approve(page).click();
  await expect(pos(page)).toHaveText(`Filing 2 of ${ids.length}`);
  expect(current(page)).toBe(ids[1]);
  // Its draft started with the batch, while the first was being reviewed (J61 checks it ran ahead).
  await expect(approve(page)).toBeEnabled({ timeout: 15_000 });

  // The first item is done once its writes land: it leaves To file, and Done says it was you.
  await expect(toFile(page).locator(`[data-row="${ids[0]}"]`)).toHaveCount(0, { timeout: 10_000 });

  // Skip (→) leaves the second in To file.
  await page.keyboard.press('ArrowRight');
  await expect(pos(page)).toHaveText(`Filing 3 of ${ids.length}`);
  expect(current(page)).toBe(ids[2]);
  await expect(toFile(page).locator(`[data-row="${ids[1]}"]`)).toHaveCount(1);

  // Through to the end: the rest skipped, then the tally until Esc.
  for (let n = 3; n <= ids.length; n++) await panel(page).getByRole('button', { name: /^Skip/ }).click();
  const done = page.getByRole('complementary', { name: 'Filing done' });
  await expect(done.getByTestId('batch-tally')).toHaveText(`1 filed · ${ids.length - 1} skipped`);
  expect(await page.evaluate(() => (window as unknown as { toasts: string[] }).toasts.filter((t) => t.includes('draft ready')))).toEqual([]);
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-batch-done-light.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(done).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
});

test('J61: stop a batch with Esc — the rest stay in To file, with at most one draft made ahead (CK-4.2, CK-4.3)', async ({ page }) => {
  await afternoon(page);
  const ids = await fileIds(page);
  expect(ids.length).toBeGreaterThanOrEqual(4);
  const last = ids.at(-1)!;

  await toFile(page).getByRole('button', { name: 'File in a batch' }).click();
  await expect(pos(page)).toHaveText(`Filing 1 of ${ids.length}`);
  await page.keyboard.press('ArrowRight');
  await expect(pos(page)).toHaveText(`Filing 2 of ${ids.length}`);
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  expect(await fileIds(page)).toEqual(ids);

  // The item after the one open when it stopped got its draft ahead; the last one has none.
  const step = panel(page).getByRole('button', { name: /^(Drafting…|Review (vault note|Confluence entry)|Draft (vault note|Confluence entry))$/ }).first();
  await toFile(page).locator(`[data-row="${ids[2]}"]`).click();
  await expect(pos(page)).toHaveCount(0);
  await expect(step).toHaveText(/^(Drafting…|Review (vault note|Confluence entry))$/);
  await page.keyboard.press('Escape'); // the panel covers Later
  await toFile(page).locator(`[data-row="${last}"]`).click();
  await expect(pos(page)).toHaveCount(0);
  await expect(panel(page).getByTestId('panel-pos')).toBeVisible();
  await expect(step).toHaveText(/^Draft (vault note|Confluence entry)$/);
});

test('J60, dark: filing in a batch in the dark theme', async ({ page }) => {
  await afternoon(page);
  await toFile(page).getByRole('button', { name: 'File in a batch' }).click();
  await expect(approve(page)).toBeEnabled({ timeout: 15_000 });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.addStyleTag({ content: HIDE });
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-batch-dark.png'), animations: 'disabled' });
});
