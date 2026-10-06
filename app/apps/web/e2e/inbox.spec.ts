import { expect, test, type Page } from '@playwright/test';

// FR-8.1: Now and Today rows share the Needs you group; data-lane tells them apart.
const group = (page: Page, name: 'Needs you' | 'To file') => page.getByRole('region', { name, exact: true });
const rows = (page: Page, name: 'Now' | 'Today' | 'To file') =>
  name === 'To file' ? group(page, name).locator('[data-row]') : group(page, 'Needs you').locator(`[data-row][data-lane="${name.toLowerCase()}"]`);
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


/** Replaces the draft text the way a person does: select all in the editor, then type. (Playwright's
 *  fill() selects through the DOM, which ProseMirror doesn't always pick up before the text arrives.) */
async function replaceDraftText(page: Page, text: string) {
  const editor = page.getByLabel('Draft text');
  await expect(editor).toBeFocused();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(text);
}

test('J01 morning scan: groups, the item panel, Done with Undo', async ({ page }) => {
  await expect(rows(page, 'Today')).toHaveCount(4);
  await expect(rows(page, 'To file')).toHaveCount(4);
  await expect(page.getByRole('link', { name: /Dry-run on/ })).toBeVisible();
  // Last and next poll live in the Poll button's tooltip; the top bar stays quiet when idle.
  await expect(page.getByRole('button', { name: 'Poll now' })).toHaveAttribute('title', 'Poll now · Last poll 09:42 · next 09:52');

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
  await expect(page.getByTestId('inbox-footer').getByRole('button', { name: /^3 snoozed/ })).toBeVisible();

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
  // The toast and the panel's status both say it; the row was already open, so they can land together.
  await expect(page.getByRole('status').getByText(/^Snoozed until Mon 5 Oct 11:30 · #mvi-launch/)).toBeVisible();
  await expect(itemPanel(page).getByRole('region', { name: 'Status' })).toContainText('Snoozed until Mon 5 Oct 11:30');
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
  await replaceDraftText(page, 'Unsaved change');
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

test('click the draft text to edit it in place; Save and Cancel sit under the editor', async ({ page }) => {
  await rows(page, 'To file').filter({ hasText: 'imo_str' }).click();
  await itemPanel(page).getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Review Confluence entry' }).click();
  const action = itemPanel(page).getByRole('region', { name: 'Action' });
  await expect(action.getByRole('button', { name: 'Re-draft' })).toBeVisible();
  await action.getByLabel('Draft text preview').getByText(/^Why:/).click();
  const editor = page.getByLabel('Draft text');
  await expect(editor).toBeFocused();
  // While editing, the footer's Approve and the Re-draft button step aside.
  await expect(action.getByRole('button', { name: 'Approve and write to sandbox' })).toHaveCount(0);
  await expect(action.getByRole('button', { name: 'Re-draft' })).toHaveCount(0);
  await page.keyboard.type('Note: ');
  await expect(editor).toContainText('Note: ');
  await action.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog', { name: 'Discard your edits?' }).getByRole('button', { name: 'Discard edits' }).click();
  await expect(action.getByLabel('Draft text preview')).not.toContainText('Note: ');
  await expect(action.getByRole('button', { name: 'Approve and write to sandbox' })).toBeVisible();
});

test('the panel slides in, and a click outside it closes it', async ({ page }) => {
  // The panel slides over the list, with a backdrop behind it.
  await expect(page.locator('.item-panel')).toHaveCSS('animation-name', 'item-panel-in');
  await expect(page.locator('.item-panel-backdrop')).toBeVisible();

  // Header and sidebar buttons work alongside the panel.
  await page.getByRole('button', { name: 'Poll now' }).click();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('group', { name: 'Scope' }).getByRole('button', { name: 'Full' }).click();
  await expect(itemPanel(page)).toBeVisible();

  // Rows switch the item; they don't close the panel.
  const second = rows(page, 'Now').nth(1);
  await second.click();
  await expect(selected(page)).toHaveAttribute('data-row', (await second.getAttribute('data-row'))!);
  await expect(itemPanel(page)).toBeVisible();

  // Toasts sit above the page: Undo on the Done toast keeps the panel.
  await itemPanel(page).getByRole('button', { name: /^Done e$/ }).click();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(itemPanel(page)).toBeVisible();

  // A click anywhere else closes it, after the slide-out.
  await page.getByRole('heading', { name: 'Inbox', level: 1 }).click();
  await expect(itemPanel(page)).toHaveCount(0);
  await expect(page.locator('.item-panel-backdrop')).toHaveCount(0);
  await expect(page).toHaveURL((u) => !u.searchParams.has('item'));
});

test('a click outside the panel with unsaved draft edits asks first', async ({ page }) => {
  await rows(page, 'To file').filter({ hasText: 'imo_str' }).click();
  await itemPanel(page).getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Review Confluence entry' }).click();
  await itemPanel(page).getByRole('region', { name: 'Action' }).getByRole('button', { name: 'Edit text' }).click();
  await replaceDraftText(page, 'Unsaved change');
  await page.getByRole('heading', { name: 'Inbox', level: 1 }).click();
  const leave = page.getByRole('dialog', { name: 'Leave with unsaved edits?' });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: 'Cancel' }).click();
  await expect(page.getByLabel('Draft text')).toHaveText('Unsaved change');
});

test('J23 failed triage sits in Needs you after the Now rows, and Retry moves it to its lane', async ({ page }) => {
  const needs = group(page, 'Needs you').locator('[data-row]');
  const failed = needs.nth(3);
  await expect(failed).toHaveAttribute('data-lane', 'failed');
  await expect(failed.getByText('Triage failed')).toBeVisible();
  await failed.click();
  await itemPanel(page).getByRole('button', { name: /Retry triage/ }).click();
  await expect(page.locator('[data-row][data-lane="failed"]')).toHaveCount(0, { timeout: 10_000 });
});

test('the footer opens Low priority, Snoozed and Done one at a time, and j/k walk the open list', async ({ page }) => {
  const footer = page.getByTestId('inbox-footer');
  const low = footer.getByRole('button', { name: /low priority/ });
  const done = footer.getByRole('button', { name: /done/ });
  await expect(footer.getByRole('button', { name: /^2 snoozed · next back / })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Low priority' })).toHaveCount(0);

  await low.click();
  await expect(low).toHaveAttribute('aria-expanded', 'true');
  const lowRows = page.getByRole('region', { name: 'Low priority' }).locator('[data-row]');
  const n = await lowRows.count();
  expect(n).toBeGreaterThan(0);
  // The open list joins the panel's order after To file.
  await expect(itemPanel(page).getByTestId('panel-pos')).toHaveText(`1 of ${12 + n}`);

  await done.click();
  await expect(page.getByRole('region', { name: 'Low priority' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Done' }).locator('[data-row]').first()).toBeVisible();
  await done.click();
  await expect(page.getByRole('region', { name: 'Done' })).toHaveCount(0);
});

test('threads still active show as a quiet header link that opens their list', async ({ page }) => {
  await openControls(page);
  await page.getByRole('button', { name: 'Triage budget hit', exact: true }).click();
  await page.getByRole('button', { name: '12 quiet threads', exact: true }).click();
  await closeDrawer(page);
  const link = page.getByRole('button', { name: /^\d+ still active$/ });
  await expect(link).toBeVisible({ timeout: 10_000 });
  await link.click();
  await expect(page.getByRole('region', { name: 'Waiting for quiet window' }).locator('[data-row]').first()).toBeVisible();
});
