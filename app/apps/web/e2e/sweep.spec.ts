import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The end-of-day sweep (specs/BACKLOG.md UX-10): Needs you one item at a time, each dealt with by
// one key, with a tally at the end.

const APP = join(import.meta.dirname, '../../..');
const HIDE = '[data-testid="os-notification"], [data-scenarios] { display: none !important; }';

const panel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const pos = (page: Page) => panel(page).getByTestId('sweep-pos');
const needs = (page: Page) => page.getByRole('region', { name: 'Needs you', exact: true });
const current = (page: Page) => new URL(page.url()).searchParams.get('item');

/** Waits for the sweep to move on from `id`, to position `n` of `total`. */
async function movedOn(page: Page, id: string | null, n: number, total: number) {
  await expect(pos(page)).toHaveText(`Sweep ${n} of ${total}`, { timeout: 20_000 });
  expect(current(page)).not.toBe(id);
}

test.describe('on the cockpit', () => {
  test.use({ viewport: { width: 1728, height: 1000 } });

  test('J87 sweep Needs you: e, v, s, r and → each move on, and the tally says what happened (UX-10)', async ({ page }) => {
    await page.goto('/');
    const rows = needs(page).locator('[data-row]');
    await expect(rows.first()).toBeVisible();
    const total = await rows.count();
    expect(total).toBe(5);
    const ids = await rows.evaluateAll((els) => els.map((e) => e.getAttribute('data-row')));

    await needs(page).getByRole('button', { name: 'Sweep' }).click();
    await expect(pos(page)).toHaveText(`Sweep 1 of ${total}`);
    expect(current(page)).toBe(ids[0]);
    await page.addStyleTag({ content: HIDE });
    await page.screenshot({ path: join(APP, 'screenshots/cockpit-sweep-light.png'), animations: 'disabled' });

    // e: done, and on.
    await page.keyboard.press('e');
    await movedOn(page, ids[0], 2, total);
    // v, then ⌘↵: the vault note approved, and on. The item stays open: it still needs you.
    const second = current(page);
    await page.keyboard.press('v');
    await expect(panel(page).locator('[data-action-bar]').getByRole('button', { name: 'Approve and next' })).toBeEnabled({ timeout: 20_000 });
    await page.keyboard.press('ControlOrMeta+Enter');
    await movedOn(page, second, 3, total);
    await expect(needs(page).locator(`[data-row="${second}"]`)).toBeVisible();
    // s, then 1: snoozed, and on.
    const third = current(page);
    await page.keyboard.press('s');
    await page.keyboard.press('1');
    await movedOn(page, third, 4, total);
    // r: reply in the source, and on.
    const fourth = current(page);
    await page.keyboard.press('r');
    await movedOn(page, fourth, 5, total);
    // ? lists the sweep's keys first.
    await page.keyboard.press('?');
    const keys = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
    await expect(keys.locator('section').first()).toHaveAttribute('aria-label', 'Sweep');
    await page.keyboard.press('Escape');
    await expect(pos(page)).toHaveText(`Sweep 5 of ${total}`);
    // →: skipped, and past the last one the tally.
    await page.keyboard.press('ArrowRight');
    const done = page.getByRole('complementary', { name: 'Sweep done' });
    await expect(done.getByTestId('sweep-tally')).toHaveText('1 done · 1 snoozed · 1 replied · 1 filed · 1 skipped');
    await expect(done).toContainText('still in Needs you');
    await page.screenshot({ path: join(APP, 'screenshots/cockpit-sweep-done-light.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(done).toHaveCount(0);
  });

  test('Esc stops a sweep and shows the tally so far; opening another item ends it (UX-10)', async ({ page }) => {
    await page.goto('/');
    await expect(needs(page).locator('[data-row]').first()).toBeVisible();
    await needs(page).getByRole('button', { name: 'Sweep' }).click();
    await page.keyboard.press('ArrowRight');
    await expect(pos(page)).toHaveText(/^Sweep 2 of/);
    await page.keyboard.press('Escape');
    const done = page.getByRole('complementary', { name: 'Sweep done' });
    await expect(done.getByTestId('sweep-tally')).toHaveText('1 skipped');
    await page.keyboard.press('Escape');
    await expect(done).toHaveCount(0);

    // A row picked from Later while sweeping leaves the sweep.
    await needs(page).getByRole('button', { name: 'Sweep' }).click();
    await expect(pos(page)).toHaveText(/^Sweep 1 of/);
    await page.keyboard.press('g');
    await page.keyboard.press('l');
    await expect(pos(page)).toHaveCount(0);
    await expect(panel(page).getByTestId('panel-pos')).toBeVisible();
  });
});

test('below 1600 px the sweep starts from the Needs you header too (UX-10)', async ({ page }) => {
  await page.goto('/');
  // Today's list opens the panel on its first item, over the header's right end.
  await expect(panel(page)).toBeVisible();
  await page.keyboard.press('Escape');
  const group = page.getByRole('region', { name: 'Needs you' }).first();
  await group.getByRole('button', { name: 'Sweep' }).click();
  await expect(pos(page)).toHaveText(/^Sweep 1 of \d+$/);
  await page.keyboard.press('e');
  await expect(pos(page)).toHaveText(/^Sweep 2 of \d+$/, { timeout: 20_000 });
});
