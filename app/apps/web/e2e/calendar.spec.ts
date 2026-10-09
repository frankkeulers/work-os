import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';

/** Rows that arrive while the item panel is open wait behind a "N new" pill (CK-1.2): show them. */
async function showNew(page: Page, row: Locator) {
  const pills = page.locator('[data-new-pill]');
  await expect(row.or(pills).first()).toBeVisible({ timeout: 10_000 });
  for (const p of await pills.all()) if (await p.isVisible()) await p.click();
}

const APP = join(import.meta.dirname, '../../..');

// Outlook Calendar (R2.8): turned on in Settings › Outlook once the connector is linked; today's
// and tomorrow's meetings then show in a strip above the inbox. The mock's clock is Mon 5 Oct 09:45
// London, so the stand-up is over and the launch check is on now.

const agenda = (page: Page) => page.getByRole('region', { name: 'Agenda' });
const meeting = (page: Page, title: string) => agenda(page).locator('[data-agenda-event]').filter({ hasText: title });
/** Clears the toasts, so a screenshot shows the page under them. */
async function dismissToasts(page: Page) {
  const close = page.getByRole('status').getByRole('button', { name: 'Dismiss' });
  while (await close.count()) await close.first().click();
}

/** Scope lives in the account menu at the foot of the sidebar. */
async function setScope(page: Page, scope: 'MVP' | 'Full') {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Account' }).click();
  await page.getByRole('dialog', { name: 'Account' }).getByRole('group', { name: 'Scope' }).getByRole('button', { name: scope }).click();
  await page.keyboard.press('Escape');
}

/** Connects Outlook and turns its calendar on. */
async function turnOn(page: Page) {
  await page.goto('/settings/outlook');
  const calendar = page.getByRole('switch', { name: 'Read Outlook Calendar' });
  await expect(calendar).toBeDisabled(); // nothing to read through until Outlook is connected
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByTestId('outlook-account')).toBeVisible();
  // The form shows what Connect turned on (a save made before then keeps it on too).
  await expect(page.getByRole('switch', { name: 'Read Outlook mail' })).toHaveAttribute('aria-checked', 'true');
  await expect(calendar).toHaveAttribute('aria-checked', 'false'); // connecting turns on mail only
  await calendar.click();
  await expect(calendar).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');
}

test('Settings › Outlook turns the calendar on, with its own schedule', async ({ page }) => {
  await turnOn(page);
  await expect(page.getByText('Today’s meetings show above the inbox, and invites you haven’t answered become items.')).toBeVisible();
  await expect(page.getByLabel('Outlook Calendar: poll every, work hours')).toHaveValue('30');
  await expect(page.getByLabel('Outlook Calendar: poll every, off hours')).toHaveValue('120');
  await expect(page.getByLabel('Outlook: poll every, work hours')).toHaveValue('30'); // mail keeps its own
  await dismissToasts(page);
  await page.getByRole('heading', { name: 'Calendar' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(APP, 'screenshots/settings-outlook-calendar-light.png') });
});

test('the agenda shows today’s meetings above the inbox, the one on now picked out, and tomorrow’s', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await expect(agenda(page)).toHaveCount(0); // off: nothing in the way

  await turnOn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  const today = agenda(page).getByRole('list', { name: 'Today’s meetings' });
  await expect(today.locator('[data-agenda-event]')).toHaveText([/06:45Voyage Insights pricing workshop/, /09:00Product stand-up/, /09:30MVI V2 launch readinessNow/, /14:00\[Customer\] renewal call/, /14:30Pricing sign-off/, /16:00Product weekly/]);
  await expect(meeting(page, 'Product stand-up')).toHaveAttribute('data-phase', 'past');
  await expect(meeting(page, 'MVI V2 launch readiness')).toHaveAttribute('data-phase', 'now');
  await expect(meeting(page, 'Product weekly')).toHaveAttribute('data-phase', 'later');
  const link = meeting(page, 'renewal call').getByRole('link');
  await expect(link).toHaveAttribute('href', /^https:\/\/outlook\.office365\.com\/owa\/\?itemid=AAMkMOCKRENEWAL/);
  await expect(link).toHaveAttribute('target', '_blank');
  await dismissToasts(page);
  const panel = page.getByRole('complementary', { name: 'Item panel' });
  if (await panel.count()) await page.keyboard.press('Escape'); // the list, not the first item, under the strip
  await expect(panel).toHaveCount(0);
  await page.screenshot({ path: join(APP, 'screenshots/inbox-agenda-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/inbox-agenda-dark.png'), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));

  await agenda(page).getByRole('button', { name: 'Tomorrow' }).click();
  await expect(agenda(page).getByRole('list', { name: 'Tomorrow’s meetings' }).locator('[data-agenda-event]')).toHaveText([/All daySales kick-off/, /10:00Q4 roadmap review, Planning, ProductNot answered/, /15:00Insights APIs sync/]);
  await expect(meeting(page, 'Q4 roadmap review')).toHaveAttribute('data-phase', 'later');
  await expect(meeting(page, 'Insights APIs sync').getByText('Not answered')).toHaveCount(0); // answered "tentative"
});

test('Outlook categories: their colours are picked in Settings and show on the agenda and the item (R2.8)', async ({ page }) => {
  await turnOn(page);
  const colours = page.getByRole('heading', { name: 'Category colours' });
  await expect(colours).toBeVisible();
  // Read from the meetings, A to Z; each has a colour of its own until one is picked.
  await expect(page.getByLabel(/: colour$/)).toHaveCount(3);
  await expect(page.getByLabel('Customer: colour')).toBeVisible();
  await expect(page.getByLabel('Planning: colour')).toBeVisible();
  await page.getByLabel('Customer: colour').selectOption({ label: 'Dark red' });
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');
  await dismissToasts(page);
  await colours.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(APP, 'screenshots/settings-outlook-categories-light.png') });

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await expect(meeting(page, 'renewal call')).toHaveAttribute('data-category-color', 'darkRed');
  // A light shade of it behind the chip: dark red (117, 11, 28) mixed into the white surface.
  await expect(meeting(page, 'renewal call')).toHaveCSS('background-color', /^(rgb\(235, 220, 222\)|color\(srgb 0\.9[0-9]* 0\.8[0-9]* 0\.8[0-9]*\))$/);
  await expect(meeting(page, 'Product stand-up')).not.toHaveAttribute('data-category-color');
  await agenda(page).getByRole('button', { name: 'Tomorrow' }).click();
  // In MVP scope the invite isn't in the list (the calendar isn't live yet), so it opens on its own page.
  await meeting(page, 'Q4 roadmap review').getByRole('button', { name: 'Not answered' }).click();
  await expect(page).toHaveURL(/\/item\/calendar/);
  await expect(page.getByTestId('calendar-categories').getByRole('listitem')).toHaveText(['Planning', 'Product']);
});

/** Sets the mock clock from the scenarios drawer, then closes it. */
async function clockTo(page: Page, control: string) {
  await page.keyboard.press('Backquote');
  const drawer = page.getByRole('complementary', { name: 'Scenarios' });
  await drawer.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer.getByRole('button', { name: control, exact: true }).click();
  await page.keyboard.press('Backquote');
  await expect(drawer).toHaveCount(0);
}

test('the sidebar shows a meeting from five minutes before it starts until it ends, and its agenda chip counts down, quietly (R2.8)', async ({ page }) => {
  await turnOn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  const cues = page.getByRole('region', { name: 'Meetings now and next' });
  const cue = (title: string) => cues.locator('[data-meeting-cue]').filter({ hasText: title });

  // 09:45: the launch check is on, until 10:15; nothing starts within five minutes.
  await expect(cues.locator('[data-meeting-cue]')).toHaveCount(1);
  await expect(cue('MVI V2 launch readiness')).toHaveAttribute('data-phase', 'now');
  await expect(cue('MVI V2 launch readiness')).toContainText(/Now ·\s*until 10:15/);
  await expect(agenda(page).locator('[data-soon]')).toHaveCount(0);

  // 13:56: four minutes before the renewal call.
  await clockTo(page, '13:56 (renewal call at 14:00)');
  await expect(cues.locator('[data-meeting-cue]')).toHaveCount(1); // the launch check has ended
  await expect(cue('[Customer] renewal call')).toHaveAttribute('data-phase', 'next');
  await expect(cue('[Customer] renewal call')).toContainText(/Next ·\s*in [34] min/); // the mock clock runs on in real time
  await expect(cue('[Customer] renewal call')).not.toHaveAttribute('data-imminent');
  await expect(cue('[Customer] renewal call').getByRole('link')).toHaveAttribute('href', /itemid=AAMkMOCKRENEWAL/);
  await expect(meeting(page, 'renewal call')).toHaveAttribute('data-soon', '');
  await expect(meeting(page, 'renewal call')).toContainText(/in [34] min/);
  await expect(meeting(page, 'Product weekly')).not.toHaveAttribute('data-soon');
  await dismissToasts(page);
  await page.screenshot({ path: join(APP, 'screenshots/inbox-next-meeting-light.png'), animations: 'disabled', style: '[data-testid="os-notification"] { display: none; }' });

  // 14:28: two meetings at once. The call is on until 15:00, and the sign-off inside it starts in two minutes.
  await clockTo(page, '14:28 (renewal call on, sign-off at 14:30)');
  await expect(cues.locator('[data-meeting-cue]')).toHaveText([/Now ·\s*until 15:0014:00\[Customer\] renewal call/, /Next ·\s*in [12] min14:30Pricing sign-off/]);
  await expect(cue('Pricing sign-off')).toHaveAttribute('data-imminent', 'true'); // amber
  await expect(meeting(page, 'renewal call')).toHaveAttribute('data-phase', 'now');
  await expect(meeting(page, 'renewal call')).not.toHaveAttribute('data-soon');
  await expect(meeting(page, 'Pricing sign-off')).toHaveAttribute('data-soon', '');
  await dismissToasts(page);
  await page.screenshot({ path: join(APP, 'screenshots/inbox-meetings-now-next-light.png'), animations: 'disabled', style: '[data-testid="os-notification"] { display: none; }' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/inbox-meetings-now-next-dark.png'), animations: 'disabled', style: '[data-testid="os-notification"] { display: none; }' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  // Hovered, a row shows its dismiss button.
  await cue('[Customer] renewal call').hover();
  await expect(cues.getByRole('button', { name: 'Dismiss: 14:00 [Customer] renewal call' })).toHaveCSS('opacity', '1');
  await page.screenshot({ path: join(APP, 'screenshots/inbox-meeting-dismiss-light.png'), animations: 'disabled', clip: { x: 0, y: 200, width: 440, height: 180 }, style: '[data-testid="os-notification"] { display: none; }' });

  // Collapsed, the sidebar keeps one icon with the minutes to the next, and says both.
  await page.keyboard.press('BracketLeft');
  await expect(cues).toContainText(/Now, until 15:00: 14:00 \[Customer\] renewal call; Next, in [12] min: 14:30 Pricing sign-off/);
  await page.keyboard.press('BracketLeft');

  // On every page; and Settings › Notifications sets how early one shows. One on now stays.
  await page.goto('/settings/notifications');
  await expect(cues.locator('[data-meeting-cue]')).toHaveCount(2);
  const lead = page.getByLabel('Minutes before a meeting it shows as next');
  await expect(lead).toHaveValue('5');
  await lead.fill('1');
  await lead.blur();
  await expect(page.getByTestId('saved-note')).toContainText('All changes saved');
  await expect(cues.locator('[data-meeting-cue]')).toHaveText([/renewal call/]);

  // Dismissed, a meeting stays out of the sidebar until it ends, on every page; Undo brings it back.
  const dismiss = cues.getByRole('button', { name: 'Dismiss: 14:00 [Customer] renewal call' });
  await dismissToasts(page); // the settings save's own Undo
  await cue('[Customer] renewal call').hover();
  await dismiss.click();
  await expect(cues).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(cue('[Customer] renewal call')).toBeVisible();
  await cue('[Customer] renewal call').hover();
  await dismiss.click();
  await expect(cues).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await expect(meeting(page, 'renewal call')).toHaveAttribute('data-phase', 'now'); // the agenda still shows it
  await expect(cues).toHaveCount(0);
});

test('meetings past the edge of the strip fade out under an arrow that scrolls to them', async ({ page }) => {
  await turnOn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  const later = agenda(page).getByRole('button', { name: 'Later meetings' });
  const earlier = agenda(page).getByRole('button', { name: 'Earlier meetings' });
  await expect(meeting(page, 'Product weekly')).toBeVisible();
  // Today's six meetings don't fit: the last runs past the edge. The strip has no scrollbar of its own.
  await expect(later).toBeVisible();
  await expect(agenda(page).getByRole('list', { name: 'Today’s meetings' })).toHaveCSS('scrollbar-width', 'none');
  await expect(earlier).toHaveCount(0);
  await dismissToasts(page);
  await page.screenshot({ path: join(APP, 'screenshots/inbox-agenda-scroll-light.png'), animations: 'disabled' });
  await later.click();
  await expect(earlier).toBeVisible();
  await expect(meeting(page, 'Product weekly')).toBeInViewport({ ratio: 1 });
  await earlier.click();
  await expect(earlier).toHaveCount(0);
  // Tomorrow's three fit.
  await agenda(page).getByRole('button', { name: 'Tomorrow' }).click();
  await expect(later).toHaveCount(0);
});

test('Disconnect takes the calendar off with the mail, and Full scope says how to turn it on', async ({ page }) => {
  await turnOn(page);
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('dialog', { name: 'Disconnect Outlook?' }).getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByRole('switch', { name: 'Read Outlook Calendar' })).toHaveAttribute('aria-checked', 'false');

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await expect(page.getByRole('heading', { name: 'Inbox', level: 1 })).toBeVisible();
  await expect(agenda(page)).toHaveCount(0);
  await setScope(page, 'Full');
  await expect(agenda(page)).toContainText('Outlook Calendar is off. Turn it on to see your meetings here.');
  await expect(agenda(page).getByRole('button', { name: /Meeting briefs/ })).toBeVisible();
  await agenda(page).getByRole('link', { name: 'Turn it on' }).click();
  await expect(page).toHaveURL(/\/settings\/outlook$/);
});

test('a Wispr Flow meeting shows its calendar event, and the agenda opens its notes (R2.8)', async ({ page }) => {
  await page.goto('/settings/wispr');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Frank Keulers')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await showNew(page, page.locator('[data-row^="wispr:"]')); // the poll after Connect, before a reload could cut it short
  await expect(page.locator('[data-row^="wispr:"]')).toBeVisible();
  await turnOn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();

  const workshop = meeting(page, 'Voyage Insights pricing workshop');
  await expect(workshop).toHaveAttribute('data-phase', 'past');
  await workshop.getByRole('button', { name: 'Notes' }).click();
  const panel = page.getByRole('complementary', { name: 'Item panel' });
  const onCalendar = panel.getByTestId('on-calendar');
  await expect(onCalendar).toHaveText('On your calendar: Voyage Insights pricing workshop · organised by Head of Sales · 3 invited');
  await expect(panel.getByRole('heading', { name: 'Action items for you' })).toHaveCount(1);
  await expect(panel.getByTestId('calendar-categories').getByRole('listitem')).toHaveText(['Customer']);
  await expect(onCalendar.getByRole('link', { name: 'Voyage Insights pricing workshop' })).toHaveAttribute('href', /itemid=AAMkMOCKPRICING/);
  await dismissToasts(page);
  await page.screenshot({ path: join(APP, 'screenshots/inbox-meeting-on-calendar-light.png') });
  // Only the meeting with notes offers them.
  await expect(meeting(page, 'Product stand-up').getByRole('button', { name: 'Notes' })).toHaveCount(0);
});

test('a Wispr Flow meeting says nothing of the calendar while the calendar is off', async ({ page }) => {
  await page.goto('/settings/wispr');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByText('Frank Keulers')).toBeVisible();
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  const row = page.locator('[data-row^="wispr:"]');
  await showNew(page, row);
  await expect(row).toBeVisible();
  await row.click();
  await expect(page.getByRole('complementary', { name: 'Item panel' }).getByRole('heading', { level: 2 })).toBeVisible();
  await expect(page.getByTestId('on-calendar')).toHaveCount(0);
});

test('an invite you haven’t answered is an item to answer in Outlook, with nothing to file (R2.8)', async ({ page }) => {
  await turnOn(page);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: /Inbox/ }).click();
  await setScope(page, 'Full'); // the calendar shows in Full scope until it goes live (B7)
  const row = page.locator('[data-row^="calendar:"]');
  await showNew(page, row);
  await expect(row).toContainText('Q4 roadmap review', { timeout: 10_000 });
  // A dot for each of its Outlook categories beside its title; nothing else in the inbox is on the calendar.
  await expect(row.locator('[data-row-categories]')).toHaveAttribute('data-row-categories', 'Planning, Product');
  await expect(row.locator('[data-row-categories] > span')).toHaveCount(2);
  await expect(page.locator('[data-row-categories]')).toHaveCount(1);

  await agenda(page).getByRole('button', { name: 'Tomorrow' }).click();
  await meeting(page, 'Q4 roadmap review').getByRole('button', { name: 'Not answered' }).click();
  const panel = page.getByRole('complementary', { name: 'Item panel' });
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(/^Matt invited you to the Q4 roadmap review/);
  await expect(panel.getByText('Accept or decline the invitation')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Respond in Outlook' })).toBeVisible();
  await expect(panel.getByRole('region', { name: /File it|Also file/ })).toHaveCount(0);
  await expect(panel.getByRole('heading', { name: 'The invitation' })).toBeVisible();
  await expect(panel.getByTestId('calendar-categories').getByRole('listitem')).toHaveText(['Planning', 'Product']);
  await expect(panel.getByText('Frank, please bring the Insights APIs usage numbers.')).toBeVisible();
  await dismissToasts(page);
  // The desktop notification for the Outlook mail stays up 9 s; the screenshot is of the page under it.
  await page.screenshot({ path: join(APP, 'screenshots/inbox-invite-light.png'), animations: 'disabled', style: '[data-testid="os-notification"] { display: none; }' });

  await setScope(page, 'MVP');
  await expect(row).toHaveCount(0);
});
