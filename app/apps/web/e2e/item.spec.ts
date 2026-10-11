import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const DRAFT_TIMEOUT = { timeout: 20_000 };
const APP = join(import.meta.dirname, '../../..');

async function startJourney(page: Page, id: string) {
  await page.goto('/');
  await page.getByRole('button', { name: /Scenarios/ }).click();
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Journeys' }).click();
  await page.getByRole('button', { name: new RegExp(`^Start ${id} `) }).click();
  await expect(page.getByRole('region', { name: 'Action' })).toBeVisible();
}

const panel = (page: Page) => page.getByRole('region', { name: 'Action' });


/** Replaces the draft text the way a person does: select all in the editor, then type. (Playwright's
 *  fill() selects through the DOM, which ProseMirror doesn't always pick up before the text arrives.) */
async function replaceDraftText(page: Page, text: string) {
  const editor = page.getByLabel('Draft text');
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
}

test('J10 Confluence happy path: approve, write to sandbox, mark done and next', async ({ page }) => {
  await startJourney(page, 'J10');
  await expect(panel(page).getByRole('tab', { name: /Confluence entry/ })).toHaveAttribute('aria-selected', 'true');
  // The safety checks fold into one line; their detail opens on demand.
  await panel(page).getByRole('button', { name: 'Checks passed' }).click();
  await expect(panel(page).getByText('Page in scope')).toBeVisible();
  await expect(panel(page).getByText(/Drafted by sonnet-5\.5/)).toBeVisible();
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

test('J73 a write that fails shows Not written, and Retry write writes the same draft', async ({ page }) => {
  await startJourney(page, 'J73');
  await panel(page).getByRole('button', { name: 'Draft vault note' }).click();
  await panel(page).getByRole('button', { name: 'Approve and write to sandbox' }).click(DRAFT_TIMEOUT);
  await expect(panel(page).getByText('Not written.')).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByText(/Full Disk Access/)).toBeVisible();
  await expect(panel(page).getByText(/didn’t return a usable draft/)).toHaveCount(0);
  await page.screenshot({ path: join(APP, 'screenshots/item-not-written-light.png'), animations: 'disabled' });
  await panel(page).getByRole('button', { name: 'Retry write' }).click();
  await expect(panel(page).getByRole('status')).toContainText('Dry-run', DRAFT_TIMEOUT);
});

test('J74 a conflict with the drafts budget used up offers Re-draft and Discard, not a spinner', async ({ page }) => {
  await startJourney(page, 'J74');
  await panel(page).getByRole('tab', { name: /Confluence entry/ }).click();
  await panel(page).getByRole('button', { name: 'Approve and write to sandbox' }).click();
  await expect(panel(page).getByText('Changed since draft.')).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByText(/can’t be re-drafted until the drafts budget resets/)).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByRole('button', { name: 'Re-draft' })).toBeDisabled();
  await page.screenshot({ path: join(APP, 'screenshots/item-conflict-no-budget-light.png'), animations: 'disabled' });
  await panel(page).getByRole('button', { name: 'Discard' }).click();
  await expect(panel(page).getByText('Changed since draft.')).toHaveCount(0);
});

test('J11 people mentioned: the Confluence draft leaves them out', async ({ page }) => {
  await startJourney(page, 'J11');
  await panel(page).getByRole('tab', { name: /Confluence entry/ }).click();
  await expect(panel(page).getByText('Vault only.')).toHaveCount(0);
  await panel(page).getByRole('button', { name: 'Draft Confluence entry' }).click();
  await expect(panel(page).getByRole('button', { name: 'Approve and write to sandbox' })).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByText(/The Data Products team has proposed it/)).toBeVisible();
  await expect(panel(page).getByText(/overloaded|burning out/)).toHaveCount(0);
});

test('J12 people check blocks a Confluence draft', async ({ page }) => {
  await startJourney(page, 'J12');
  await panel(page).getByRole('tab', { name: /Confluence entry/ }).click();
  await panel(page).getByRole('button', { name: 'Draft Confluence entry' }).click();
  await expect(panel(page).getByText('People check blocked this entry.')).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByRole('tab', { name: /Confluence entry/ })).toContainText('Failed');
  await expect(panel(page).getByRole('button', { name: 'Approve and write to sandbox' })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Re-draft' })).toBeEnabled();
});

test('J08 edit a vault append, then the leave guard and re-draft confirmation', async ({ page }) => {
  await startJourney(page, 'J08');
  await panel(page).getByRole('tab', { name: /Vault note/ }).click();
  await panel(page).getByRole('button', { name: 'Draft vault note' }).click();
  await panel(page).getByRole('button', { name: 'Edit text' }).click(DRAFT_TIMEOUT);
  // The note it appends to opens in Obsidian.
  await expect(panel(page).getByRole('link', { name: /\.md$/ })).toHaveAttribute('href', /^obsidian:\/\/open\?vault=PSG%20Vault&file=/);
  await replaceDraftText(page, '- 2026-10-05 · Edited by hand.');
  await panel(page).getByRole('button', { name: 'Save edits' }).click();
  await expect(panel(page).getByText('Edited', { exact: true })).toBeVisible();

  await panel(page).getByRole('button', { name: 'Re-draft' }).click();
  await expect(page.getByRole('dialog', { name: 'Re-draft and lose your edits?' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel' }).click();

  await panel(page).getByRole('button', { name: 'Edit text' }).click();
  await replaceDraftText(page, 'Unsaved change');
  await page.getByRole('link', { name: 'Back to inbox' }).click();
  await expect(page.getByRole('dialog', { name: 'Leave with unsaved edits?' })).toBeVisible();
  await page.getByRole('button', { name: 'Leave' }).click();
  // The inbox opens its item panel, so only the path is fixed.
  await expect(page).toHaveURL((u) => u.pathname === '/');
});

test('an unsaved draft edit survives a dropped connection, and the server going away', async ({ page }) => {
  const server = (name: 'Up' | 'Down' | 'Reconnecting') => page.getByRole('complementary', { name: 'Scenarios' }).getByRole('button', { name, exact: true }).click();
  await startJourney(page, 'J08');
  await panel(page).getByRole('tab', { name: /Vault note/ }).click();
  await panel(page).getByRole('button', { name: 'Draft vault note' }).click();
  await panel(page).getByRole('button', { name: 'Edit text' }).click(DRAFT_TIMEOUT);
  await replaceDraftText(page, 'Kept through the blip');
  await page.getByRole('button', { name: /Scenarios/ }).click();
  await page.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();

  // A blip: the page stays, with the edit; saving waits until it's back.
  await server('Reconnecting');
  await page.getByRole('button', { name: 'Close scenarios' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Reconnecting to Work OS…' })).toBeVisible();
  await expect(page.getByLabel('Draft text')).toContainText('Kept through the blip');
  await expect(panel(page).getByRole('button', { name: 'Save edits' })).toBeDisabled();
  await page.screenshot({ path: join(APP, 'screenshots/item-reconnecting-edit-light.png'), animations: 'disabled' });
  await expect(panel(page).getByRole('button', { name: 'Save edits' })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole('button', { name: /Scenarios/ }).click();

  // The server goes away for longer: the page is replaced, and the edit comes back with it.
  await server('Reconnecting');
  await server('Down');
  await expect(page.getByRole('heading', { name: 'Can’t reach the Work OS server' })).toBeVisible();
  await server('Up');
  await expect(page.getByLabel('Draft text')).toContainText('Kept through the blip', DRAFT_TIMEOUT);
  await page.getByRole('button', { name: 'Close scenarios' }).click();
  await panel(page).getByRole('button', { name: 'Save edits' }).click();
  await expect(panel(page).getByText('Edited', { exact: true })).toBeVisible();
});

test('J66 a vault draft that finds the meeting already filed writes nothing (FR-9.6)', async ({ page }) => {
  await startJourney(page, 'J66');
  await panel(page).getByRole('tab', { name: /Vault note/ }).click();
  await panel(page).getByRole('button', { name: 'Draft vault note' }).click();
  await expect(panel(page).getByRole('button', { name: 'Mark as filed' })).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByRole('heading', { name: 'Already filed' })).toBeVisible();
  await expect(panel(page).getByText('Nothing new to file.')).toBeVisible();
  await expect(panel(page).getByText('Already in', { exact: true })).toBeVisible();
  await expect(panel(page).getByRole('link', { name: /\.md$/ })).toHaveAttribute('href', /^obsidian:\/\/open\?/);
  await expect(panel(page).getByRole('button', { name: 'Edit text' })).toHaveCount(0);
  await panel(page).screenshot({ path: join(APP, 'screenshots/vault-already-filed-light.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await panel(page).screenshot({ path: join(APP, 'screenshots/vault-already-filed-dark.png'), animations: 'disabled' });
  await page.evaluate(() => delete document.documentElement.dataset.theme);
  await panel(page).getByRole('button', { name: 'Mark as filed' }).click();
  await expect(panel(page).getByText(/^Already in the vault: .*\. Nothing was written\. Logged action\.executed\.$/)).toBeVisible(DRAFT_TIMEOUT);
});

test('J67 a new vault note beside a likely match warns, and still lets you approve (FR-9.6)', async ({ page }) => {
  await startJourney(page, 'J67');
  await panel(page).getByRole('tab', { name: /Vault note/ }).click();
  await panel(page).getByRole('button', { name: 'Draft vault note' }).click();
  await expect(panel(page).getByText('This may already be in the vault.')).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByText(/same date, attendee: Lanny Day/)).toBeVisible();
  await panel(page).getByRole('button', { name: /Checks passed/ }).click();
  await expect(panel(page).getByText('A note may already hold this')).toBeVisible();
  await panel(page).screenshot({ path: join(APP, 'screenshots/vault-possible-duplicate-light.png'), animations: 'disabled' });
  await expect(panel(page).getByRole('button', { name: 'Approve and write to sandbox' })).toBeEnabled();
});

test('J68 a Confluence draft that finds the thread already on the page writes nothing (FR-10.7)', async ({ page }) => {
  await startJourney(page, 'J68');
  await panel(page).getByRole('tab', { name: /Confluence entry/ }).click();
  await panel(page).getByRole('button', { name: 'Draft Confluence entry' }).click();
  await expect(panel(page).getByRole('button', { name: 'Mark as filed' })).toBeVisible(DRAFT_TIMEOUT);
  await expect(panel(page).getByText('Already on', { exact: true })).toBeVisible();
  await panel(page).getByRole('button', { name: 'Mark as filed' }).click();
  await expect(panel(page).getByText(/^Already on .* under .*\. Nothing was written\. Logged action\.executed\.$/)).toBeVisible(DRAFT_TIMEOUT);
});
