import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

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
  await expect(today.locator('[data-agenda-event]')).toHaveText([/06:45Voyage Insights pricing workshop/, /09:00Product stand-up/, /09:30MVI V2 launch readinessNow/, /14:00\[Customer\] renewal call/, /16:00Product weekly/]);
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
  await expect(agenda(page).getByRole('list', { name: 'Tomorrow’s meetings' }).locator('[data-agenda-event]')).toHaveText([/All daySales kick-off/, /10:00Q4 roadmap reviewNot answered/, /15:00Insights APIs sync/]);
  await expect(meeting(page, 'Q4 roadmap review')).toHaveAttribute('data-phase', 'later');
  await expect(meeting(page, 'Insights APIs sync').getByText('Not answered')).toHaveCount(0); // answered "tentative"
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
