import { expect, test, type Page } from '@playwright/test';

const DRAFT_TIMEOUT = { timeout: 20_000 };

async function startJourney(page: Page, id: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /Scenarios/ }).click();
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Journeys' }).click();
  await page.getByRole('button', { name: new RegExp(`^Start ${id} `) }).click();
  await expect(page.getByRole('region', { name: 'Action' })).toBeVisible();
}

const panel = (page: Page) => page.getByRole('region', { name: 'Action' });

test('J10 Confluence happy path: approve, write to sandbox, mark done and next', async ({ page }) => {
  await startJourney(page, 'J10');
  await expect(panel(page).getByRole('tab', { name: /Confluence entry/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByText('Page on allow-list')).toBeVisible();
  const url = page.url();
  await panel(page).getByRole('button', { name: 'Approve and write to sandbox' }).click();
  await expect(panel(page).getByRole('status')).toContainText('Dry-run: write logged only', DRAFT_TIMEOUT);
  await expect(panel(page).getByRole('tab', { name: /Confluence entry/ })).toContainText('Filed');
  await panel(page).getByRole('button', { name: 'Mark done and next item' }).click();
  await expect(page).not.toHaveURL(url);
  await expect(page).toHaveURL(/\/item\//);
});

test('J13 Confluence version conflict re-drafts instead of writing', async ({ page }) => {
  await startJourney(page, 'J13');
  await panel(page).getByRole('tab', { name: /Confluence entry/ }).click();
  await panel(page).getByRole('button', { name: 'Draft Confluence entry' }).click();
  await expect(panel(page).getByTestId('drafting')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Approve and write to sandbox' }).click(DRAFT_TIMEOUT);
  await expect(panel(page).getByText('Changed since draft.')).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByText(/Re-drafted after a conflict/)).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByRole('button', { name: 'Approve and write to sandbox' })).toBeEnabled();
});

test('J11 people observations: Confluence is blocked, vault offered instead', async ({ page }) => {
  await startJourney(page, 'J11');
  await panel(page).getByRole('tab', { name: /Confluence entry/ }).click();
  await expect(panel(page).getByText('Vault only.')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Draft vault note instead' }).click();
  await expect(panel(page).getByRole('tab', { name: /Vault note/ })).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByTestId('drafting')).toBeVisible();
});

test('J12 people check blocks a Confluence draft', async ({ page }) => {
  await startJourney(page, 'J12');
  await panel(page).getByRole('tab', { name: /Confluence entry/ }).click();
  await panel(page).getByRole('button', { name: 'Draft Confluence entry' }).click();
  await expect(panel(page).getByText('People check blocked this entry.')).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByRole('tab', { name: /Confluence entry/ })).toContainText('Failed');
  await expect(panel(page).getByRole('button', { name: 'Approve and write to sandbox' })).toHaveCount(0);
});

test('J08 edit a vault append, then the leave guard and re-draft confirmation', async ({ page }) => {
  await startJourney(page, 'J08');
  await panel(page).getByRole('tab', { name: /Vault note/ }).click();
  await panel(page).getByRole('button', { name: 'Draft vault note' }).click();
  await panel(page).getByRole('button', { name: 'Edit text' }).click(DRAFT_TIMEOUT);
  // The note it appends to opens in Obsidian.
  await expect(panel(page).getByRole('link', { name: /\.md$/ })).toHaveAttribute('href', /^obsidian:\/\/open\?vault=PSG%20Vault&file=/);
  await page.getByLabel('Draft text').fill('- 2026-10-05 · Edited by hand.');
  await panel(page).getByRole('button', { name: 'Save edits' }).click();
  await expect(panel(page).getByText('Edited', { exact: true })).toBeVisible();

  await panel(page).getByRole('button', { name: 'Re-draft' }).click();
  await expect(page.getByRole('dialog', { name: 'Re-draft and lose your edits?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await panel(page).getByRole('button', { name: 'Edit text' }).click();
  await page.getByLabel('Draft text').fill('Unsaved change');
  await page.getByRole('link', { name: 'Back to inbox' }).click();
  await expect(page.getByRole('dialog', { name: 'Leave with unsaved edits?' })).toBeVisible();
  await page.getByRole('button', { name: 'Leave' }).click();
  // The inbox opens its item panel, so only the path is fixed.
  await expect(page).toHaveURL((u) => u.pathname === '/');
});
