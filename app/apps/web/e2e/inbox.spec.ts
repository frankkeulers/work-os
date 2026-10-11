import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const APP = join(import.meta.dirname, '../../..');

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

/** Scope lives in the account menu at the foot of the sidebar. */
async function setScope(page: Page, scope: 'MVP' | 'Full') {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Account' }).click();
  await page.getByRole('dialog', { name: 'Account' }).getByRole('group', { name: 'Scope' }).getByRole('button', { name: scope }).click();
  await page.keyboard.press('Escape');
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
  // Monday: Today holds what's due today; asks due Thursday, Friday or "this week" wait under This week (CK-3.10).
  await expect(rows(page, 'Today')).toHaveCount(1);
  await expect(rows(page, 'To file')).toHaveCount(4);
  await expect(page.getByRole('region', { name: 'Waiting on others', exact: true }).locator('[data-row]')).toHaveCount(1);
  await expect(page.getByTestId('inbox-footer').getByRole('button', { name: /^3 this week/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Dry-run on/ })).toBeVisible();
  // Last and next poll live in the Poll button's tooltip; the top bar stays quiet when idle.
  await expect(page.getByRole('button', { name: 'Poll now' })).toHaveAttribute('title', 'Poll now · Last poll 09:42 · next 09:52');

  // The panel opens on the first item, with its next step.
  const first = rows(page, 'Now').first();
  await expect(first).toHaveAttribute('aria-current', 'true');
  await expect(itemPanel(page).getByTestId('panel-pos')).toHaveText('1 of 10');
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
  await expect(itemPanel(page).getByTestId('panel-pos')).toHaveText('2 of 10');
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

test('J06 keyboard: keys pressed faster than the screen updates act on the row they reach', async ({ page }) => {
  const ids = await rows(page, 'Now').evaluateAll((els) => els.map((e) => e.getAttribute('data-row')!));
  expect(ids.length).toBeGreaterThanOrEqual(3);
  await expect(selected(page)).toHaveAttribute('data-row', ids[0]);
  // In one burst: no render in between.
  const burst = (keys: string[]) => page.evaluate((ks) => ks.forEach((key) => document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))), keys);

  await burst(['j', 'j']);
  await expect(selected(page)).toHaveAttribute('data-row', ids[2]);
  await burst(['k', 'e']);
  // e marked the second done, not the third it left.
  await expect(rows(page, 'Now')).toHaveCount(ids.length - 1);
  await expect(page.locator(`[data-row="${ids[1]}"]`)).toHaveCount(0);
  await expect(rows(page, 'Now').and(page.locator(`[data-row="${ids[2]}"]`))).toHaveCount(1);
});

test('J04 correct triage in the panel moves the item and grows the labelled set', async ({ page }) => {
  const row = rows(page, 'Today').first();
  const id = (await row.getAttribute('data-row'))!;
  await row.click();
  await itemPanel(page).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Correct triage/ }).click();
  await itemPanel(page).getByRole('group', { name: 'Attention' }).getByRole('button', { name: 'Now' }).click();
  await itemPanel(page).getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Correction saved · moved to Now · labelled set now 201')).toBeVisible();
  const moved = group(page, 'Needs you').locator(`[data-row="${id}"][data-lane="now"]`);
  await expect(moved).toBeVisible();
  await expect(moved.getByText('Corrected by you')).toBeVisible();
  await expect(rows(page, 'Today')).toHaveCount(0);
});

test('J75 Waiting on others: between Needs you and To file, it says who has the next move, and a correction can send an item there (FR-8.1, amended)', async ({ page }) => {
  const follow = page.getByRole('region', { name: 'Waiting on others', exact: true });
  await expect(follow.locator('[data-row]')).toHaveCount(1);
  expect(await page.locator('section[data-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')))).toEqual(['needs', 'follow', 'file']);
  const row = follow.locator('[data-row]').first();
  await expect(row).toHaveAttribute('data-lane', 'follow');
  await row.click();
  const status = itemPanel(page).getByRole('region', { name: 'Status' });
  await expect(status).toContainText('Waiting on others');
  await expect(status).toContainText('You own the outcome and someone else has the next move.');
  await page.screenshot({ path: join(APP, 'screenshots/inbox-follow-light.png'), animations: 'disabled' });

  // A Today item, corrected to Waiting on others, moves there.
  const today = rows(page, 'Today').first();
  const id = (await today.getAttribute('data-row'))!;
  await today.click();
  await itemPanel(page).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Correct triage/ }).click();
  await itemPanel(page).getByRole('group', { name: 'Attention' }).getByRole('button', { name: 'Waiting on others' }).click();
  await itemPanel(page).getByRole('button', { name: 'Save correction' }).click();
  await expect(page.getByText('Correction saved · moved to Waiting on others · labelled set now 201')).toBeVisible();
  await expect(follow.locator(`[data-row="${id}"][data-lane="follow"]`)).toBeVisible();
  await expect(follow.locator('[data-row]')).toHaveCount(2);
});

test('triage was right: the decision joins the labelled set as it stands, by button or y', async ({ page }) => {
  const row = rows(page, 'Now').first();
  const id = (await row.getAttribute('data-row'))!;
  await row.click();
  const right = itemPanel(page).getByRole('button', { name: /Triage was right/ });
  await itemPanel(page).screenshot({ path: join(APP, 'screenshots/inbox-triage-right-light.png'), animations: 'disabled' });
  await right.click();
  await expect(page.getByText('Labelled as right · labelled set now 201')).toBeVisible();
  await expect(itemPanel(page).locator('[data-confirmed]')).toHaveText('Right · labelled');
  await expect(right).toHaveCount(0);
  await expect(group(page, 'Needs you').locator(`[data-row="${id}"][data-lane="now"]`)).toBeVisible(); // nothing moves
  const hide = await page.addStyleTag({ content: '[role="status"] { display: none !important; }' });
  await itemPanel(page).screenshot({ path: join(APP, 'screenshots/inbox-triage-right-done-light.png'), animations: 'disabled' });
  await hide.evaluate((e) => e.remove());

  // y on the next item.
  await page.keyboard.press('j');
  await expect(itemPanel(page).getByRole('button', { name: /Triage was right/ })).toBeVisible();
  await page.keyboard.press('y');
  await expect(page.getByText('Labelled as right · labelled set now 202')).toBeVisible();
  await expect(itemPanel(page).locator('[data-confirmed]')).toBeVisible();
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

test('J77 a adds the next step as a to-do: review, edit, approve into the sandbox Tasks note', async ({ page }) => {
  await rows(page, 'Now').filter({ hasText: 'data-licensing' }).click();
  await page.keyboard.press('a');
  const action = itemPanel(page).getByRole('region', { name: 'Action' });
  // Built by code at once: no drafting step, no model.
  await expect(action.getByRole('heading', { name: 'Review and approve the to-do' })).toBeVisible();
  await expect(action.getByRole('tab', { name: /To-do/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page).toHaveURL(/file=todo/);
  await expect(action).toContainText('Add to the end of');
  await expect(action).toContainText('Work/Tasks.md');
  const tasks = action.getByRole('list', { name: 'Tasks' });
  await expect(tasks.getByRole('listitem')).toHaveCount(1);
  await expect(tasks).toContainText('Confirm the data-licensing wording in the doc');
  await expect(tasks).toContainText('📅 2026-10-05');
  await expect(tasks).toContainText('#mvi-launch');
  await action.getByRole('button', { name: 'Checks passed' }).click();
  await expect(action.getByText('Built from the triage by code, no model call')).toBeVisible();
  await itemPanel(page).screenshot({ path: join(APP, 'screenshots/todo-review-light.png'), animations: 'disabled' });

  // Edited as the plain lines: a line without a checkbox becomes a task.
  await action.getByRole('button', { name: 'Edit text' }).click();
  const lines = action.getByLabel('Task lines');
  await expect(lines).toHaveValue(/^- \[ \] Confirm the data-licensing wording in the doc 📅 2026-10-05 \[#mvi-launch\]\(https:/);
  await lines.fill(`${await lines.inputValue()}\nChase Legal for the final wording`);
  await action.getByRole('button', { name: 'Save edits' }).click();
  await expect(tasks.getByRole('listitem')).toHaveCount(2);

  await action.getByRole('button', { name: 'Approve and add in the sandbox' }).click();
  await expect(action.getByRole('status')).toContainText('Dry-run: Added 2 to-dos to ~/WorkOS-data/sandbox/vault/Work/Tasks.md', { timeout: 20_000 });
  await expect(action.getByRole('heading', { name: 'Added in the sandbox' })).toBeVisible();
  await expect(action.getByRole('tab', { name: /To-do/ })).toContainText('Added');
});

test('J78 a meeting’s action items: pick some, and they go to Tasks as a to-do to review', async ({ page }) => {
  await setScope(page, 'Full');
  await page.locator('[data-row^="teams:MTG-MVIREADY"]').click();
  const items = itemPanel(page).getByRole('region', { name: 'Action items for you' });
  await expect(items.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await items.getByRole('checkbox', { name: /Share the customer comms plan/ }).uncheck();
  await items.getByRole('button', { name: 'Add 1 to Tasks' }).click();
  const action = itemPanel(page).getByRole('region', { name: 'Action' });
  const tasks = action.getByRole('list', { name: 'Tasks' });
  await expect(tasks.getByRole('listitem')).toHaveCount(1);
  await expect(tasks).toContainText('Confirm the rollback owner for MVI V2');
  await expect(items).toContainText('To-do ready to review');
  await itemPanel(page).screenshot({ path: join(APP, 'screenshots/todo-action-items-light.png'), animations: 'disabled' });

  // Picking again replaces the to-do still waiting for review.
  await items.getByRole('checkbox', { name: /Share the customer comms plan/ }).check();
  await items.getByRole('button', { name: 'Add to Tasks' }).click();
  await expect(tasks.getByRole('listitem')).toHaveCount(2);
  await action.getByRole('button', { name: 'Approve and add in the sandbox' }).click();
  await expect(items).toContainText('Added to Tasks', { timeout: 20_000 });
});

test('the Next step card holds the filing: its options, the draft’s progress and the review', async ({ page }) => {
  // The newest item is a reply: the step's action is Slack, so both targets are filing options in the same card.
  await sortBy(page, 'Newest first');
  await group(page, 'Needs you').locator('[data-row]').first().click();
  const step = itemPanel(page).getByRole('region', { name: 'Next step' });
  const options = step.getByRole('region', { name: 'File it' });
  // A to-do is a third target (UX-5): Frank's call, never a triage suggestion.
  await expect(options.getByRole('button')).toHaveText(['Draft Confluence entry', 'Draft vault note', /^Add to-do/]);
  await options.getByRole('button', { name: 'Draft Confluence entry' }).click();
  // The progress shows in the card, under the step, in place of the options.
  const action = step.getByRole('region', { name: 'Action' });
  await expect(action.getByTestId('drafting')).toBeVisible();
  await expect(step.getByRole('button', { name: 'Reply in Slack' })).toBeVisible();
  await expect(options).toHaveCount(0);
  await action.getByRole('button', { name: 'Back to filing options' }).click();
  await expect(options).toBeVisible();
  await expect(page).toHaveURL((u) => !u.searchParams.has('file'));

  // To file: the step's action is the draft, so the options offer only the other target…
  await rows(page, 'To file').filter({ hasText: 'imo_str' }).click();
  const also = step.getByRole('region', { name: 'Also file' });
  await expect(also.getByText('Vault note', { exact: true })).toBeVisible();
  await expect(also.getByText('Confluence entry', { exact: true })).toHaveCount(0);
  await expect(step.getByText('To Insights APIs › Decisions')).toBeVisible();
  // …and once the draft is open, its tabs switch target, so the step's own button steps aside.
  await step.getByRole('button', { name: 'Review Confluence entry' }).click();
  await expect(action.getByRole('tab', { name: /Confluence entry/ })).toHaveAttribute('aria-selected', 'true');
  await expect(step.getByRole('button', { name: 'Review Confluence entry' })).toHaveCount(0);
  await expect(step.getByRole('button', { name: /^Snooze until/ })).toBeVisible();
  await page.screenshot({ path: join(APP, 'screenshots/inbox-filing-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/inbox-filing-dark.png'), animations: 'disabled' }); // fast-forward the colour transitions
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
});

test('a filed entry with new replies offers a v2 draft, and discarding it goes back to the filed entry', async ({ page }) => {
  await rows(page, 'To file').filter({ hasText: 'imo_str' }).click();
  await itemPanel(page).getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Review Confluence entry' }).click();
  const action = itemPanel(page).getByRole('region', { name: 'Action' });
  await action.getByRole('button', { name: 'Approve and write to sandbox' }).click();
  await expect(action.getByRole('status')).toContainText('Dry-run: write logged only', { timeout: 20_000 });
  // Nothing new since the draft, so nothing to add.
  await expect(action.getByRole('button', { name: 'Draft v2' })).toHaveCount(0);

  await openControls(page);
  await page.getByRole('button', { name: 'Reply on a drafted item', exact: true }).click();
  await closeDrawer(page);
  await expect(action.getByText('New replies since this entry was drafted.')).toBeVisible({ timeout: 10_000 });
  await action.getByRole('button', { name: 'Draft v2' }).click();
  await expect(action.getByRole('button', { name: 'Approve and write to sandbox' })).toBeVisible({ timeout: 20_000 });
  await expect(action.getByRole('heading', { name: 'Review and approve the draft v2' })).toBeVisible();
  await expect(action.getByRole('tab', { name: /Confluence entry/ })).toContainText('v2 · Ready');

  // Discarding v2 leaves the first entry as it was, ready for another try.
  await action.getByRole('button', { name: 'Discard' }).click();
  await expect(action.getByRole('status').filter({ hasText: 'Dry-run: write logged only' })).toBeVisible();
  await expect(action.getByText('The last draft was discarded.')).toBeVisible();
  await expect(action.getByRole('tab', { name: /Confluence entry/ })).toContainText('Filed');
  await expect(action.getByRole('button', { name: 'Draft v2' })).toBeVisible();
});

// Outlook is live (R2.5): its mail arrives after Connect, checked in outlook.spec.ts.
test('Full scope adds the Teams items with their brand mark, tagged P2', async ({ page }) => {
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.getByRole('link', { name: /Inbox/ })).toContainText('8');
  await expect(page.locator('[data-row^="teams:"]')).toHaveCount(0);

  await setScope(page, 'Full');
  await expect(nav.getByRole('link', { name: /Inbox/ })).toContainText('10');
  await expect(rows(page, 'Now')).toHaveCount(3);
  await expect(page.locator('[data-row^="teams:"]').first().getByRole('img', { name: 'Teams' })).toBeVisible();

  await page.locator('[data-row^="teams:MTG-MVIREADY"]').click();
  await expect(itemPanel(page).getByText('P2', { exact: true })).toBeVisible();
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
  await action.getByRole('group', { name: 'Draft view' }).getByRole('button', { name: 'Markdown' }).click();
  await expect(page.getByLabel('Draft text')).toHaveValue('**Ship it**');
  await action.getByRole('button', { name: 'Save edits' }).click();
  // The view holds after saving; Rich text renders the saved markdown.
  await expect(action.getByLabel('Draft text preview')).toHaveText('**Ship it**');
  await action.getByRole('group', { name: 'Draft view' }).getByRole('button', { name: 'Rich text' }).click();
  await expect(action.getByLabel('Draft text preview').locator('strong')).toHaveText('Ship it');
  await expect(action.getByText('Edited', { exact: true })).toBeVisible();
});

test('a vault append reads as rich text under the note’s lines, with Markdown a click away', async ({ page }) => {
  await rows(page, 'To file').filter({ hasText: 'imo_str' }).click();
  await itemPanel(page).getByRole('region', { name: 'Also file' }).getByRole('button', { name: 'Review' }).click();
  const action = itemPanel(page).getByRole('region', { name: 'Action' });
  await expect(action.getByRole('tab', { name: /Vault note/ })).toHaveAttribute('aria-selected', 'true');
  // The heading is named, not shown as markdown.
  await expect(action.getByText('under Decisions', { exact: true })).toBeVisible();
  // Rich text by default: the new lines, and the note's lines above them for where they land.
  await expect(action.getByLabel('Draft text preview').locator('code').first()).toHaveText('imo_str');
  await expect(action.getByLabel('Existing lines preview')).toContainText('v2 pagination uses cursors');
  // The same switch shows the raw text without editing.
  const view = action.getByRole('group', { name: 'Draft view' });
  await view.getByRole('button', { name: 'Markdown' }).click();
  await expect(action.getByLabel('Draft text preview')).toContainText('`imo_str`');
  await expect(action.getByLabel('Existing lines preview')).toContainText('## Decisions');
  // Checks and Re-draft sit together under the draft.
  await expect(action.getByRole('button', { name: 'Checks passed' })).toBeVisible();
  await expect(action.getByRole('button', { name: 'Re-draft' })).toBeVisible();
  // Edit keeps the view; Cancel with nothing changed doesn't ask.
  await action.getByRole('button', { name: 'Edit text' }).click();
  await expect(page.getByLabel('Draft text')).toBeFocused();
  await expect(page.getByLabel('Draft text')).toHaveValue(/`imo_str`/);
  await view.getByRole('button', { name: 'Rich text' }).click();
  await action.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Discard your edits?' })).toHaveCount(0);
  await expect(action.getByRole('button', { name: 'Approve and write to sandbox' })).toBeVisible();
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
  await setScope(page, 'Full');
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

async function sortBy(page: Page, name: 'Newest first' | 'Oldest first' | 'Priority') {
  await page.getByRole('button', { name: /^Sort: / }).click();
  await page.getByRole('menu', { name: 'Sort' }).getByRole('menuitem', { name }).click();
  await expect(page.getByRole('button', { name: `Sort: ${name}` })).toBeVisible();
}

/** Each Needs you and To file row's channel (Slack) and last activity, in the order on screen. */
async function rowsInOrder(page: Page) {
  const at = (g: string) =>
    page.locator(`[data-group="${g}"] [data-row]`).evaluateAll((els) => els.map((e) => ({ channel: e.getAttribute('data-row')!.match(/^slack:([^:]+):/)?.[1], at: e.getAttribute('data-activity')! })));
  return [await at('needs'), await at('file')];
}
const newestFirst = (list: string[]) => expect(list).toEqual([...list].sort().reverse());

test('the Inbox sorts by priority, ungrouped, by default; the Sort menu groups by channel and changes the order (CK-1.1)', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Sort: Priority' })).toBeVisible();
  await expect(page.locator('[data-channel]')).toHaveCount(0);
  // Priority: the Now rows lead Needs you.
  const lanes = await group(page, 'Needs you').locator('[data-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lane')));
  expect(lanes.slice(0, 3)).toEqual(['now', 'now', 'now']);
  expect(lanes.slice(3)).not.toContain('now');

  await sortBy(page, 'Newest first');
  for (const list of await rowsInOrder(page)) newestFirst(list.map((r) => r.at));

  // Grouped: each channel's rows sit together, newest first, under one heading.
  await page.getByRole('button', { name: /^Sort: / }).click();
  const grouping = page.getByRole('menuitemcheckbox', { name: 'Group by channel' });
  await expect(grouping).toHaveAttribute('aria-checked', 'false');
  await grouping.click();
  await expect(grouping).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-group="needs"] [data-channel]').first()).toBeVisible();
  for (const list of await rowsInOrder(page)) {
    const channels = list.map((r) => r.channel).filter((c) => c);
    expect(channels.filter((c, n) => channels.indexOf(c) === n)).toEqual(channels.filter((c, n) => c !== channels[n - 1]));
    for (const c of new Set(channels)) newestFirst(list.filter((r) => r.channel === c).map((r) => r.at));
  }

  await sortBy(page, 'Oldest first');
  await page.getByRole('button', { name: /^Sort: / }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Group by channel' }).click();
  await page.keyboard.press('Escape');
  for (const list of await rowsInOrder(page)) expect(list.map((r) => r.at)).toEqual(list.map((r) => r.at).sort());

  // The choice is kept in this browser.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Sort: Oldest first' })).toBeVisible();
  await expect(page.locator('[data-channel]')).toHaveCount(0);
});

test('the top bar counts Now, Today and To file, and a pill scrolls to its rows (CK-1.5)', async ({ page }) => {
  const pills = page.getByTestId('count-pills');
  const today = await group(page, 'Needs you').locator('[data-row][data-lane="today"], [data-row][data-lane="failed"]').count();
  await expect(pills.locator('[data-pill]')).toHaveText(['3now', `${today}today`, '4to file']);
  // Scrolled to the foot of a short window, the Now pill brings the Now rows back.
  await page.setViewportSize({ width: 1440, height: 480 });
  await page.getByRole('region', { name: 'Inbox list' }).evaluate((el) => (el.scrollTop = el.scrollHeight));
  const firstNow = rows(page, 'Now').first();
  await expect(firstNow).not.toBeInViewport();
  await pills.locator('[data-pill="now"]').click();
  await expect(firstNow).toBeInViewport();
});

test('J50 still list: a new Now item waits while the panel is open, then lands marked New (CK-1.2, CK-1.3)', async ({ page }) => {
  await rows(page, 'Today').filter({ hasText: 'Graduation request' }).click();
  // What was there on load isn't new.
  await expect(page.locator('[data-new-dot]')).toHaveCount(0);
  const ids = () => group(page, 'Needs you').locator('[data-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-row')!));
  const before = await ids();

  await openControls(page);
  await page.getByRole('complementary', { name: 'Scenarios' }).getByRole('button', { name: 'VIP DM', exact: true }).click();
  await closeDrawer(page);
  // Nothing moves under the panel: a pill says what's waiting, and the count already has it.
  const pill = page.locator('[data-new-pill="needs"]');
  await expect(pill).toHaveText('1 new Now item', { timeout: 10_000 });
  expect(await ids()).toEqual(before);
  await expect(page.getByTestId('count-pills').locator('[data-pill="now"]')).toHaveText('4now');
  await page.screenshot({ path: join(APP, 'screenshots/inbox-new-pill-light.png') });

  // The panel closes: the DM lands at its place, and every other row keeps its order.
  await page.keyboard.press('Escape');
  await expect(pill).toHaveCount(0);
  const after = await ids();
  const added = after.filter((id) => !before.includes(id));
  expect(added).toHaveLength(1);
  expect(after.filter((id) => id !== added[0])).toEqual(before);
  const row = page.locator(`[data-row="${added[0]}"]`);
  await expect(row).toHaveAttribute('data-lane', 'now');
  // New until it has been in view for 2 s with the window focused.
  await expect(row.locator('[data-new-dot]')).toBeVisible();
  await page.screenshot({ path: join(APP, 'screenshots/inbox-new-dot-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/inbox-new-dot-dark.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await expect(row.locator('[data-new-dot]')).toHaveCount(0, { timeout: 6_000 });
});

test('scrolled down with the panel closed, a new row lands above without moving what’s in view (CK-1.2)', async ({ page }) => {
  await page.keyboard.press('Escape');
  await expect(itemPanel(page)).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 620 });
  const list = page.getByRole('region', { name: 'Inbox list' });
  await list.evaluate((el) => (el.scrollTop = 260));
  const watched = rows(page, 'Today').last();
  await expect(watched).toBeInViewport();
  const y = (await watched.boundingBox())!.y;

  await openControls(page);
  await page.getByRole('complementary', { name: 'Scenarios' }).getByRole('button', { name: 'VIP DM', exact: true }).click();
  await closeDrawer(page);
  const pill = page.locator('[data-new-pill="needs"]');
  await expect(pill).toHaveText('1 new Now item above', { timeout: 10_000 });
  expect(Math.abs((await watched.boundingBox())!.y - y)).toBeLessThan(2);

  await pill.click();
  await expect(rows(page, 'Now').locator('[data-new-dot]').first()).toBeInViewport();
  await expect(pill).toHaveCount(0);
});

test('a row Frank brings back himself lands at once, even under the open panel (CK-1.2)', async ({ page }) => {
  const first = rows(page, 'Now').first();
  const id = (await first.getAttribute('data-row'))!;
  await first.click();
  await itemPanel(page).getByRole('button', { name: /^Done/ }).first().click();
  await expect(page.locator(`[data-group="needs"] [data-row="${id}"]`)).toHaveCount(0);
  await page.getByRole('status').getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator(`[data-group="needs"] [data-row="${id}"]`)).toBeVisible();
  await expect(page.locator('[data-new-pill]')).toHaveCount(0);
});

test('triage details say when a rule’s floor overrode the model’s None (FR-4.3)', async ({ page }) => {
  // The FYI mention waits for the quiet window, then the model says None and mention-me keeps it in Today.
  await openControls(page);
  await page.getByRole('button', { name: '+10 min', exact: true }).click();
  await expect(page.getByTestId('poll-line')).toContainText(/triaged/, { timeout: 15_000 });
  await closeDrawer(page);
  await rows(page, 'Today').filter({ hasText: 'map tiles' }).click();
  const details = itemPanel(page).getByTestId('triage-details');
  const toggle = details.getByRole('button', { name: 'Triage details · model said None · rule mention-me set Today' });
  await toggle.click();
  await expect(details).toContainText(/Triaged .* by model · model said None · rule mention-me set Today · /);
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(APP, 'screenshots/inbox-triage-floor-light.png'), animations: 'disabled' });
});

test('triage details sit behind a disclosure that stays as Frank left it (CK-1.6)', async ({ page }) => {
  await rows(page, 'Today').filter({ hasText: 'Graduation request' }).click();
  const details = itemPanel(page).getByTestId('triage-details');
  const toggle = details.getByRole('button', { name: 'Triage details · model' });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(details).not.toContainText('Triaged');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(details).toContainText(/Triaged .* by model · .* · revision \d+/);
  await details.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(APP, 'screenshots/inbox-triage-details-light.png'), animations: 'disabled' });

  // Remembered in this browser, and a rule names itself.
  await page.reload();
  await rows(page, 'Now').filter({ hasText: 'go/no-go' }).click();
  await expect(details.getByRole('button', { name: 'Triage details · rule vip-dm' })).toHaveAttribute('aria-expanded', 'true');
  await expect(details).toContainText('by rule vip-dm · no model call');
});

test('J51 the top bar’s health pill: hidden while live; stale, a connector down, catching up, safe mode, stopping (CK-1.7)', async ({ page }) => {
  const header = page.locator('[data-inbox-header]');
  const pill = page.getByTestId('health-pill');
  const setHealth = async (name: string) => {
    await openControls(page);
    await page.getByRole('complementary', { name: 'Scenarios' }).getByRole('button', { name, exact: true }).click();
    await closeDrawer(page);
  };

  // All well: no pill, and a plain bar.
  await expect(header).toHaveAttribute('data-health', 'ok');
  await expect(pill).toHaveCount(0);

  // The server quietly stopped polling: Slack's last read is past twice its 10-minute interval.
  await setHealth('Slack stale');
  await expect(pill).toHaveAttribute('data-tone', 'warn');
  await expect(pill).toContainText('Slack stale · last read 34 min ago');
  await expect(header).toHaveAttribute('data-health', 'warn');
  // The sidebar agrees: Slack's last-read time is amber, not green.
  const slackNav = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /^Slack/ });
  await expect(slackNav.locator('[data-stale]')).toHaveText('34m ago');
  await page.screenshot({ path: join(APP, 'screenshots/inbox-health-stale-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/inbox-health-stale-dark.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  await setHealth('Outlook signed out');
  await expect(pill).toContainText('Outlook not connected · mail and calendar stale');
  await expect(pill.getByRole('link', { name: 'Reconnect on claude.ai' })).toHaveAttribute('href', 'https://claude.ai/settings/connectors');
  await header.screenshot({ path: join(APP, 'screenshots/inbox-health-connector-light.png') });

  await setHealth('Catching up');
  await expect(pill).toHaveAttribute('data-tone', 'info');
  await expect(pill).toContainText('Catching up after sleep');
  await expect(header).toHaveAttribute('data-health', 'info');

  await setHealth('Safe mode');
  await expect(pill).toHaveAttribute('data-tone', 'bad');
  await expect(pill).toContainText('Safe mode · nothing is being read');
  await expect(pill.getByRole('link', { name: 'Open Usage & health' })).toHaveAttribute('href', '/usage#health');
  await header.screenshot({ path: join(APP, 'screenshots/inbox-health-safe-light.png') });

  await setHealth('Stopping');
  await expect(pill).toHaveAttribute('data-tone', 'idle');
  await expect(pill).toContainText('Stopping');
  await expect(header).toHaveAttribute('data-health', 'idle');

  // Back to normal: the mock polls again, and the pill goes, leaving a plain bar.
  await setHealth('Running normally');
  await expect(header).toHaveAttribute('data-health', 'ok', { timeout: 10_000 });
  await expect(pill).toHaveCount(0);
  await expect(slackNav.locator('[data-stale]')).toHaveCount(0);
});

test('J23 failed triage sits in Needs you after the Now rows, and Retry moves it to its lane', async ({ page }) => {
  await sortBy(page, 'Priority');
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
  await expect(itemPanel(page).getByTestId('panel-pos')).toHaveText(`1 of ${10 + n}`);

  await done.click();
  await expect(page.getByRole('region', { name: 'Low priority' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Done' }).locator('[data-row]').first()).toBeVisible();
  await done.click();
  await expect(page.getByRole('region', { name: 'Done' })).toHaveCount(0);
});

test('asks due after today wait under This week, soonest first, with their dates (CK-3.10)', async ({ page }) => {
  await page.keyboard.press('Escape'); // the open panel covers the footer's end
  const footer = page.getByTestId('inbox-footer');
  const week = footer.getByRole('button', { name: /^3 this week/ });
  await week.click();
  await expect(week).toHaveAttribute('aria-expanded', 'true');
  const list = page.getByRole('region', { name: 'This week' }).locator('[data-row]');
  // Thursday 09:00, Friday 17:00, then "this week" with no time.
  await expect(list).toHaveCount(3);
  await expect(list.nth(0)).toContainText('overloaded engineers');
  await expect(list.nth(0)).toContainText('Thu 09:00');
  await expect(list.nth(1)).toContainText('which three items');
  await expect(list.nth(1)).toContainText('Fri 17:00');
  await expect(list.nth(2)).toContainText('walkthrough');
  // None of them is in Needs you.
  await expect(group(page, 'Needs you')).not.toContainText('walkthrough');
});

test('a row can be marked done from the list without opening it', async ({ page }) => {
  const row = rows(page, 'Today').first();
  const id = (await row.getAttribute('data-row'))!;
  const before = await rows(page, 'Today').count();
  await page.keyboard.press('Escape'); // the open panel covers the row's end
  await expect(itemPanel(page)).toHaveCount(0);
  await row.locator('xpath=..').locator('[data-row-action]').click();
  await expect(page.locator(`[data-row="${id}"]`)).toHaveCount(0);
  await expect(rows(page, 'Today')).toHaveCount(before - 1);
  await expect(itemPanel(page)).toHaveCount(0); // it didn't open the item
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.locator(`[data-row="${id}"]`)).toHaveCount(1);
});

test('Low priority can be marked done as a whole, and Undo brings it back', async ({ page }) => {
  const footer = page.getByTestId('inbox-footer');
  await footer.getByRole('button', { name: /low priority/ }).click();
  const list = page.getByRole('region', { name: 'Low priority' });
  const n = await list.locator('[data-row]').count();
  expect(n).toBeGreaterThan(0);
  await list.getByRole('button', { name: `Mark all ${n} done` }).click();
  await expect(page.getByText(`Done · ${n} items in Low priority`)).toBeVisible();
  await expect(footer.getByRole('button', { name: /^0 low priority/ })).toBeVisible();
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(footer.getByRole('button', { name: new RegExp(`^${n} low priority`) })).toBeVisible();
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
