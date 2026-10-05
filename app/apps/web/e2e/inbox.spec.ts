import { expect, test, type Page } from '@playwright/test';

const lane = (page: Page, name: 'Now' | 'Today' | 'File') => page.getByRole('region', { name: `${name} lane` });

async function openControls(page: Page) {
  await page.getByRole('button', { name: /Scenarios/ }).click();
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
}

async function closeDrawer(page: Page) {
  await page.getByRole('button', { name: 'Close scenarios' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(lane(page, 'Now').getByRole('article')).toHaveCount(3);
});

test('J01 morning scan: lanes, Done with Undo, keyboard', async ({ page }) => {
  await expect(lane(page, 'Today').getByRole('article')).toHaveCount(4);
  await expect(lane(page, 'File').getByRole('article')).toHaveCount(4);
  await expect(page.getByText('Dry-run is on.')).toBeVisible();
  await expect(page.getByTestId('poll-line')).toContainText('Last poll 09:42');

  // Done, then Undo brings it back.
  const first = lane(page, 'Now').getByRole('article').first();
  const summary = (await first.getByRole('link').textContent())!;
  await first.getByRole('button', { name: 'Done' }).click();
  await expect(lane(page, 'Now').getByRole('article')).toHaveCount(2);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(lane(page, 'Now').getByRole('link', { name: summary })).toBeVisible();

  // Keyboard: the cursor follows the last card touched; j/k move it, e marks the focused card done.
  await page.keyboard.press('k');
  const focused = page.locator('article[data-card]:focus');
  await expect(focused).toHaveCount(1);
  const id = await focused.getAttribute('data-card');
  await page.keyboard.press('j');
  await expect(page.locator(`article[data-card="${id}"]`)).not.toBeFocused();
  await page.keyboard.press('k');
  await expect(page.locator(`article[data-card="${id}"]`)).toBeFocused();
  await page.keyboard.press('e');
  await expect(page.locator(`article[data-card="${id}"]`)).toHaveCount(0);
  await expect(page.locator('article[data-card]:focus')).toHaveCount(1);

  // List view keeps the same lanes.
  await page.getByRole('group', { name: 'View style' }).getByRole('button', { name: 'List' }).click();
  await expect(lane(page, 'Today').getByRole('article')).toHaveCount(4);
});

test('J04 correct triage from a card moves the item and grows the labelled set', async ({ page }) => {
  const card = lane(page, 'Today').getByRole('article').first();
  const summary = (await card.getByRole('link').textContent())!;
  await card.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Correct triage' }).click();
  const form = page.getByRole('dialog', { name: 'Correct triage' });
  await form.getByRole('group', { name: 'Attention' }).getByRole('button', { name: 'Now' }).click();
  await form.getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Correction saved · moved to Now · labelled set now 201')).toBeVisible();
  const moved = lane(page, 'Now').getByRole('article').filter({ hasText: summary });
  await expect(moved).toBeVisible();
  await expect(moved.getByText('Corrected by you')).toBeVisible();
  await expect(lane(page, 'Today').getByRole('article')).toHaveCount(3);
});

test('J03 snooze for an hour, then it comes back marked', async ({ page }) => {
  const card = lane(page, 'Now').getByRole('article').first();
  const summary = (await card.getByRole('link').textContent())!;
  await card.getByRole('button', { name: 'Snooze' }).click();
  await page.getByRole('menuitem', { name: /1 hour/ }).click();
  await expect(lane(page, 'Now').getByRole('article')).toHaveCount(2);
  await expect(page.getByRole('region', { name: 'Snoozed' })).toContainText('3');

  await openControls(page);
  await page.getByRole('button', { name: '+1 h' }).click();
  await closeDrawer(page);
  const back = lane(page, 'Now').getByRole('article').filter({ hasText: summary });
  await expect(back).toBeVisible({ timeout: 10_000 });
  await expect(back.getByText('Back from snooze')).toBeVisible();
});
