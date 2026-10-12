import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// To Dos on the inbox (PLAN E15, FR-16.1–16.3): every line written to the Tasks note shows on the
// inbox, with where it came from and when it is due. The list layout has a To do group after Needs
// you; the cockpit puts what is overdue or due today in Needs you and the rest in Later.

const APP = join(import.meta.dirname, '../../..');
const HIDE = '[data-testid="os-notification"], [data-scenarios], [aria-label="Notifications"][aria-live] { display: none !important; }';

async function withTodos(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-row]').first()).toBeVisible();
  await page.keyboard.press('Backquote');
  const drawer = page.getByRole('complementary', { name: 'Scenarios' });
  await drawer.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer.getByRole('button', { name: '13:48 with To Dos (cockpit)', exact: true }).click();
  await page.keyboard.press('Backquote');
}

const shoot = async (page: Page, el: ReturnType<Page['locator']>, name: string) => {
  const hide = await page.addStyleTag({ content: HIDE });
  await el.screenshot({ path: join(APP, `screenshots/${name}-light.png`), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await el.screenshot({ path: join(APP, `screenshots/${name}-dark.png`), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await hide.evaluate((n) => n.remove());
};

test.describe('wide window (cockpit)', () => {
  test.use({ viewport: { width: 1680, height: 1050 } });

  test('J93 To Dos due today sit in Needs you, the rest in Later, and each opens its source (FR-16.2)', async ({ page }) => {
    await withTodos(page);
    const needs = page.getByRole('region', { name: 'To do today' });
    await expect(needs.locator('[data-todo]')).toHaveCount(3);
    await expect(needs.getByRole('heading', { name: 'TO DO · 3' })).toBeVisible();
    // Overdue first, in red; then today's, soonest first.
    await expect(needs.locator('[data-todo]').first()).toContainText('Send Matt the one-line MVI V2 go/no-go reason');
    await expect(needs.locator('[data-todo]').first()).toContainText('overdue');
    await expect(needs.locator('[data-todo]').nth(1)).toContainText('Share the graduation gate checklist');

    const later = page.getByRole('region', { name: 'Later' }).getByRole('region', { name: 'To do' });
    await expect(later.locator('[data-todo][data-todo-status="open"]')).toHaveCount(2);
    await expect(later.locator('[data-todo]').last()).toContainText('Book a kick-off with the Data team');
    await later.getByRole('button', { name: '1 done today' }).click();
    await expect(later.locator('[data-todo-status="done"]')).toContainText('ticked in Obsidian');
    await shoot(page, page.locator('[data-cockpit-zone="needs"]'), 'todos-cockpit-needs');
    await shoot(page, page.locator('[data-cockpit-zone="later"]'), 'todos-cockpit-later');

    await needs.locator('[data-todo]').nth(1).getByRole('button', { name: '#pole-star-labs' }).click();
    await expect(page.locator('.item-panel')).toContainText('graduation gate checklist');
  });

  test('J93 Done on a To Do ticks it in the Tasks note, asks how long it took, and Undo opens it again (FR-16.4, FR-16.5)', async ({ page }) => {
    await withTodos(page);
    const needs = page.getByRole('region', { name: 'To do today' });
    const share = needs.locator('[data-todo]', { hasText: 'Share the graduation gate checklist' });
    await share.getByRole('button', { name: 'Done: Share the graduation gate checklist' }).click();
    const toast = page.getByRole('status').filter({ hasText: 'Done · Share the graduation gate checklist' });
    await expect(toast).toContainText('Ticked in the Tasks note');
    await expect(needs.locator('[data-todo]')).toHaveCount(2);
    await toast.getByRole('button', { name: '30m' }).click();
    await expect(toast.getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'true');
    await shoot(page, toast, 'todos-done-toast');
    const later = page.getByRole('region', { name: 'Later' }).getByRole('region', { name: 'To do' });
    await later.getByRole('button', { name: '2 done today' }).click();
    await expect(later.locator('[data-todo-status="done"]', { hasText: 'Share the graduation' })).toContainText('took 30m');

    // z undoes it, as any toast's Undo.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('z');
    await expect(needs.locator('[data-todo]')).toHaveCount(3);

    // g then d: the first To Do, and e on it is its Done, not the open item's.
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await expect(needs.locator('[data-todo]').first()).toBeFocused();
    const item = page.locator('.item-panel');
    const hadPanel = await item.count();
    await page.keyboard.press('e');
    await expect(page.getByRole('status').filter({ hasText: 'Done · Send Matt the one-line MVI V2 go/no-go reason' })).toBeVisible();
    await expect(item).toHaveCount(hadPanel);

    // A line not in the Tasks note: done all the same, and it says it couldn't be ticked.
    await later.locator('[data-todo]', { hasText: 'Book a kick-off' }).getByRole('button', { name: /^Done:/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Done · Book a kick-off' })).toContainText('Not ticked: its line isn’t in the Tasks note');
    await expect(later.locator('[data-todo]', { hasText: 'Book a kick-off' })).toContainText('not ticked in the Tasks note');
  });
});

test.describe('list layout', () => {
  test.use({ viewport: { width: 1280, height: 1600 } });

  test('J93 a To do group after Needs you: overdue, today, upcoming, then done today, folded (FR-16.2)', async ({ page }) => {
    await withTodos(page);
    // The list opens on its first item: close the panel to see the whole group.
    await expect(page.locator('.item-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.item-panel')).toHaveCount(0);
    const group = page.getByRole('region', { name: 'To do', exact: true });
    await expect(group.locator('[data-todo-head]')).toHaveText(['OVERDUE · 1', 'TODAY · 2', 'UPCOMING · 2']);
    await expect(group.locator('[data-todo-status="done"]')).toHaveCount(0);
    await group.getByRole('button', { name: '1 done today' }).click();
    await expect(group.locator('[data-todo-status="done"]')).toHaveCount(1);
    // It follows Needs you.
    const order = await page.locator('section[data-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')));
    expect(order.indexOf('todo')).toBe(order.indexOf('needs') + 1);
    await shoot(page, group, 'todos-list');
  });
});
