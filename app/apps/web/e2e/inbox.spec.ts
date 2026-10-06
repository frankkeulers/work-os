import { expect, test, type Page } from '@playwright/test';

const group = (page: Page, name: 'Now' | 'Today' | 'To file' | 'Snoozed' | 'Done') => page.getByRole('region', { name, exact: true });
const rows = (page: Page, name: Parameters<typeof group>[1]) => group(page, name).locator('[data-row]');
const itemPanel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const selected = (page: Page) => page.locator('[data-row][aria-current="true"]');

async function openControls(page: Page) {
  await page.getByRole('button', { name: /Scenarios/ }).click();
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
}

async function closeDrawer(page: Page) {
  await page.getByRole('button', { name: 'Close scenarios' }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(rows(page, 'Now')).toHaveCount(3);
});

test('J01 morning scan: groups, the item panel, Done with Undo', async ({ page }) => {
  await expect(rows(page, 'Today')).toHaveCount(4);
  await expect(rows(page, 'To file')).toHaveCount(4);
  await expect(page.getByRole('link', { name: /Dry-run on/ })).toBeVisible();
  await expect(page.getByTestId('poll-line')).toContainText('Last poll 09:42');

  // The panel opens on the first item, with its next step.
  const first = rows(page, 'Now').first();
  await expect(first).toHaveAttribute('aria-current', 'true');
  await expect(itemPanel(page).getByTestId('panel-pos')).toHaveText('1 of 12');
  await expect(itemPanel(page).getByRole('region', { name: 'Next step' })).toBeVisible();
  // Rows show the source's brand mark.
  await expect(first.getByRole('img', { name: 'Slack' })).toBeVisible();

  // Done, then Undo brings it back.
  const summary = (await itemPanel(page).getByRole('heading', { level: 2 }).textContent())!;
  await itemPanel(page).getByRole('button', { name: /^Done e$/ }).click();
  await expect(rows(page, 'Now')).toHaveCount(2);
  await expect(itemPanel(page).getByRole('region', { name: 'Status' })).toContainText('Done');
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(rows(page, 'Now').filter({ hasText: summary })).toBeVisible();
});

test('J06 keyboard: j/k move the panel, e and ⇧E mark done, Esc closes', async ({ page }) => {
  const firstId = await rows(page, 'Now').first().getAttribute('data-row');
  const secondId = await rows(page, 'Now').nth(1).getAttribute('data-row');
  await page.keyboard.press('j');
  await expect(selected(page)).toHaveAttribute('data-row', secondId!);
  await expect(itemPanel(page).getByTestId('panel-pos')).toHaveText('2 of 12');
  await page.keyboard.press('k');
  await expect(selected(page)).toHaveAttribute('data-row', firstId!);

  // e marks the selected item done; the panel stays on it until you move on.
  await page.keyboard.press('e');
  await expect(rows(page, 'Now')).toHaveCount(2);
  await page.keyboard.press('j');
  await expect(selected(page)).toHaveAttribute('data-row', secondId!);

  // ⇧E is Done and next.
  await page.keyboard.press('Shift+E');
  await expect(rows(page, 'Now')).toHaveCount(1);
  await expect(selected(page)).toHaveCount(1);
  await expect(selected(page)).not.toHaveAttribute('data-row', secondId!);

  await page.keyboard.press('Escape');
  await expect(itemPanel(page)).toHaveCount(0);
  await page.keyboard.press('j');
  await expect(itemPanel(page)).toBeVisible();
});

test('J04 correct triage in the panel moves the item and grows the labelled set', async ({ page }) => {
  const row = rows(page, 'Today').first();
  const summary = (await row.textContent())!.slice(0, 40);
  await row.click();
  await itemPanel(page).getByRole('button', { name: 'Correct triage' }).click();
  await itemPanel(page).getByRole('group', { name: 'Attention' }).getByRole('button', { name: 'Now' }).click();
  await itemPanel(page).getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Correction saved · moved to Now · labelled set now 201')).toBeVisible();
  const moved = rows(page, 'Now').filter({ hasText: summary });
  await expect(moved).toBeVisible();
  await expect(moved.getByText('Corrected by you')).toBeVisible();
  await expect(rows(page, 'Today')).toHaveCount(3);
});

test('J03 snooze for an hour, then it comes back marked', async ({ page }) => {
  const summary = (await itemPanel(page).getByRole('heading', { level: 2 }).textContent())!;
  await itemPanel(page).getByRole('button', { name: /^Snooze s$/ }).click();
  await page.getByRole('menuitem', { name: /1 hour/ }).click();
  await expect(rows(page, 'Now')).toHaveCount(2);
  await expect(group(page, 'Snoozed')).toContainText('3');

  await openControls(page);
  await page.getByRole('button', { name: '+1 h' }).click();
  await closeDrawer(page);
  const back = rows(page, 'Now').filter({ hasText: summary });
  await expect(back).toBeVisible({ timeout: 10_000 });
  await expect(back.getByText('Back from snooze')).toBeVisible();
});

test('the next step offers a snooze timed to the deadline', async ({ page }) => {
  const row = rows(page, 'Now').filter({ hasText: 'data-licensing' });
  await expect(row.getByText('12:00 · in 2 h 15 min')).toBeVisible();
  await row.click();
  const step = itemPanel(page).getByRole('region', { name: 'Next step' });
  await expect(step).toContainText('Marketing waiting');
  await step.getByRole('button', { name: 'Snooze until 11:30' }).click();
  await expect(page.getByText(/^Snoozed until Mon 5 Oct 11:30/)).toBeVisible();
  await expect(rows(page, 'Now')).toHaveCount(2);
});

test('J10 file from the panel: review and approve the Confluence entry in place', async ({ page }) => {
  await rows(page, 'To file').filter({ hasText: 'imo_str' }).click();
  await itemPanel(page).getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Review Confluence entry' }).click();
  const action = itemPanel(page).getByRole('region', { name: 'Action' });
  await expect(action.getByRole('tab', { name: /Confluence entry/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/file=confluence/);
  await action.getByRole('button', { name: 'Approve and write to sandbox' }).click();
  await expect(action.getByRole('status')).toContainText('Dry-run: write logged only', { timeout: 20_000 });
});

test('Full scope adds the Outlook and Teams items with their brand marks', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: /Inbox/ })).toContainText('11');
  await expect(page.locator('[data-row^="outlook:"]')).toHaveCount(0);

  await nav.getByRole('group', { name: 'Scope' }).getByRole('button', { name: 'Full' }).click();
  await expect(nav.getByRole('link', { name: /Inbox/ })).toContainText('14');
  await expect(rows(page, 'Now')).toHaveCount(4);
  const email = page.locator('[data-row^="outlook:"]');
  await expect(email.getByRole('img', { name: 'Outlook' })).toBeVisible();
  await expect(page.locator('[data-row^="teams:"]').first().getByRole('img', { name: 'Teams' })).toBeVisible();

  await email.click();
  await expect(itemPanel(page).getByText('P2', { exact: true })).toBeVisible();
  await expect(itemPanel(page).getByRole('button', { name: 'Reply in Outlook' })).toBeVisible();

  await page.locator('[data-row^="teams:MTG-MVIREADY"]').click();
  await expect(itemPanel(page).getByRole('region', { name: 'Action items for you' }).getByRole('checkbox')).toHaveCount(2);
});

test('J08 unsaved draft edits in the panel ask before moving to another item', async ({ page }) => {
  await rows(page, 'To file').filter({ hasText: 'imo_str' }).click();
  await itemPanel(page).getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Review Confluence entry' }).click();
  const action = itemPanel(page).getByRole('region', { name: 'Action' });
  await action.getByRole('button', { name: 'Edit text' }).click();
  await page.getByLabel('Draft text').fill('Unsaved change');
  await page.getByLabel('Draft text').blur();
  await page.keyboard.press('k');
  const leave = page.getByRole('dialog', { name: 'Leave with unsaved edits?' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Cancel' }).click();
  // The draft field is a rich-text editor (contenteditable), so it has text rather than a value.
  await expect(page.getByLabel('Draft text')).toHaveText('Unsaved change');
});

test('the Confluence target links to the page, and rich-text edits are saved as markdown', async ({ page }) => {
  await rows(page, 'To file').filter({ hasText: 'imo_str' }).click();
  await itemPanel(page).getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Review Confluence entry' }).click();
  const action = itemPanel(page).getByRole('region', { name: 'Action' });
  await expect(action.getByRole('link', { name: 'Insights APIs › Decisions' })).toHaveAttribute('href', 'https://pole-star.atlassian.net/wiki/spaces/PRD/pages/39004512');
  await expect(action.getByRole('link', { name: 'Insights APIs › Decisions' })).toHaveAttribute('target', '_blank');

  await action.getByRole('button', { name: 'Edit text' }).click();
  const editor = page.getByLabel('Draft text');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Ship it');
  await page.keyboard.press('ControlOrMeta+a');
  await action.getByRole('toolbar', { name: 'Formatting' }).getByRole('button', { name: 'Bold' }).click();
  await expect(editor.locator('strong')).toHaveText('Ship it');
  await action.getByRole('group', { name: 'Editor view' }).getByRole('button', { name: 'Markdown' }).click();
  await expect(page.getByLabel('Draft text')).toHaveValue('**Ship it**');
  await action.getByRole('button', { name: 'Save edits' }).click();
  await expect(action.getByLabel('Draft text preview').locator('strong')).toHaveText('Ship it');
  await expect(action.getByText('Edited', { exact: true })).toBeVisible();
});
