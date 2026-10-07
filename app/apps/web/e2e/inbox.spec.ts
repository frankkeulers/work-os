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
  await itemPanel(page).getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: /Correct triage/ }).click();
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

test('the Next step card holds the filing: its options, the draft’s progress and the review', async ({ page }) => {
  // A reply: the step's action is Slack, so both targets are filing options in the same card.
  const step = itemPanel(page).getByRole('region', { name: 'Next step' });
  const options = step.getByRole('region', { name: 'File it' });
  await expect(options.getByRole('button')).toHaveText(['Draft Confluence entry', 'Draft vault note']);
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

test('the Inbox groups Slack items by channel, newest first, and the Sort menu changes both', async ({ page }) => {
  await expect(page.getByRole('button', { name: 'Sort: Newest first' })).toBeVisible();
  // Grouped: each channel's rows sit together, newest first, under one heading.
  for (const list of await rowsInOrder(page)) {
    const channels = list.map((r) => r.channel).filter((c) => c);
    expect(channels.filter((c, n) => channels.indexOf(c) === n)).toEqual(channels.filter((c, n) => c !== channels[n - 1]));
    for (const c of new Set(channels)) newestFirst(list.filter((r) => r.channel === c).map((r) => r.at));
  }
  await expect(page.locator('[data-group="needs"] [data-channel]').first()).toBeVisible();

  await page.getByRole('button', { name: /^Sort: / }).click();
  const grouping = page.getByRole('menuitemcheckbox', { name: 'Group by channel' });
  await expect(grouping).toHaveAttribute('aria-checked', 'true');
  await grouping.click();
  await expect(grouping).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-channel]')).toHaveCount(0);
  for (const list of await rowsInOrder(page)) newestFirst(list.map((r) => r.at));

  await sortBy(page, 'Oldest first');
  for (const list of await rowsInOrder(page)) expect(list.map((r) => r.at)).toEqual(list.map((r) => r.at).sort());

  await page.reload();
  await expect(page.getByRole('button', { name: 'Sort: Oldest first' })).toBeVisible();
  await expect(page.locator('[data-channel]')).toHaveCount(0);
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
  await expect(itemPanel(page).getByTestId('panel-pos')).toHaveText(`1 of ${12 + n}`);

  await done.click();
  await expect(page.getByRole('region', { name: 'Low priority' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Done' }).locator('[data-row]').first()).toBeVisible();
  await done.click();
  await expect(page.getByRole('region', { name: 'Done' })).toHaveCount(0);
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
