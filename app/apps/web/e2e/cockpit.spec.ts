import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// The three-zone cockpit (specs/cockpit/SPEC.md CK-3) on the 16" MacBook Pro's 1728 px window:
// the time column, Needs you and Later. Scenarios › Controls › "13:48 with Outlook and the calendar
// on" sets the seed week's Monday at 13:48, twelve minutes before the [Customer] renewal call.
// Below 1600 px the Inbox keeps the list; the other specs cover it at 1440 px.

const APP = join(import.meta.dirname, '../../..');
/** The macOS-style notification card isn't part of the page under it. */
const HIDE = '[data-testid="os-notification"], [data-scenarios] { display: none !important; }';

test.use({ viewport: { width: 1728, height: 1000 } });

async function control(page: Page, name: string) {
  await page.keyboard.press('Backquote');
  const drawer = page.getByRole('complementary', { name: 'Scenarios' });
  await drawer.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer.getByRole('button', { name, exact: true }).click();
  await page.keyboard.press('Backquote');
  await expect(drawer).toHaveCount(0);
}

const panel = (page: Page) => page.getByRole('complementary', { name: 'Item panel' });
const zone = (page: Page, name: 'Time' | 'Needs you' | 'Later') => page.getByRole('region', { name, exact: true });

/** The cockpit at 13:48, the panel closed, with the Outlook mail that Connect brings in. */
async function afternoon(page: Page) {
  await page.goto('/');
  // The cockpit opens with the panel closed (UX-13), so new rows land in place.
  await expect(page.locator('[data-row]').first()).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await control(page, '13:48 with Outlook and the calendar on (cockpit)');
  await expect(page.getByTestId('clock')).toHaveText(/^13:4[89]$/);
  // Connect's poll brings the Outlook mail in, and triages it.
  await expect(page.locator('[data-row]').filter({ hasText: 'Insights APIs v2 pricing' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('poll-line')).not.toContainText(/Polling|Triaging/);
}

test('J56: three zones at a glance — the time, what needs you, and what can wait (CK-3.1, 3.4–3.8, 3.11)', async ({ page }) => {
  await afternoon(page);

  // Three zones, side by side; the agenda strip gives way to the time column.
  for (const z of ['Time', 'Needs you', 'Later'] as const) await expect(zone(page, z)).toBeVisible();
  expect((await zone(page, 'Time').boundingBox())!.width).toBeCloseTo(400, 0);
  expect((await zone(page, 'Later').boundingBox())!.width).toBeCloseTo(440, 0);
  await expect(page.getByRole('region', { name: 'Agenda' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible(); // the 60 px rail

  // The next meeting, and what's due before it.
  const card = page.getByTestId('next-meeting');
  await expect(card).toHaveAttribute('data-phase', 'next');
  await expect(card).toContainText(/NEXT · IN 1[12] MIN/); // the mock clock runs on in real time
  // A Teams meeting: the card joins it in the browser; Outlook is a link of its own beside the label.
  await expect(card.getByRole('link', { name: '14:00 [Customer] renewal call' })).toHaveAttribute('href', /^https:\/\/teams\.microsoft\.com\/v2\/\?meetingjoin=true#\/l\/meetup-join\/19:meeting_AAMkMOCKRENEWAL@/);
  await expect(card).toContainText('Join in Teams');
  await expect(card.getByRole('link', { name: 'Outlook', exact: true })).toHaveAttribute('href', /itemid=AAMkMOCKRENEWAL/);
  await expect(card).toContainText('+1 at the same time');
  await expect(card.locator('[data-open-item]')).toHaveText([/#mvi-launch · Confirm the data-licensing/, /Insights APIs v2 pricing · Answer the three pricing/]);

  // The timeline: the morning's meetings past, the renewal call and its overlap side by side, and
  // the deadlines: the 12:00 one missed (red, at the now-line), the 14:00 one close (orange).
  const meetings = zone(page, 'Time').getByRole('list', { name: 'Today’s meetings' }).getByRole('listitem');
  await expect(meetings).toHaveText([/06:45 Voyage Insights/, /09:00 Product stand-up/, /09:30 MVI V2 launch readiness/, /14:00 \[Customer\] renewal call/, /14:30 Pricing sign-off/, /16:00 Product weekly/]);
  await expect(meetings.filter({ hasText: 'stand-up' })).toHaveAttribute('data-past', 'true');
  await expect(meetings.filter({ hasText: 'renewal call' })).not.toHaveAttribute('data-past');
  // Each in its first category's colour, shaded behind as on the agenda strip; a Teams meeting to come
  // joins in the browser, one that has ended opens in Outlook.
  const renewal = meetings.filter({ hasText: 'renewal call' });
  await expect(renewal).toHaveAttribute('data-category-color', /.+/);
  expect(await renewal.getByRole('link').evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe(await meetings.filter({ hasText: 'Pricing sign-off' }).getByRole('link').evaluate((el) => getComputedStyle(el).backgroundColor));
  await expect(renewal.getByRole('link')).toHaveAttribute('href', /^https:\/\/teams\.microsoft\.com\/v2\/\?meetingjoin=true#/);
  await expect(meetings.filter({ hasText: 'stand-up' }).getByRole('link')).toHaveAttribute('href', /itemid=AAMkMOCKSTANDUP/);
  // A short meeting is one line; its colour bar still runs its full height.
  expect((await meetings.filter({ hasText: 'stand-up' }).locator('a > span[aria-hidden]').boundingBox())!.height).toBeGreaterThan(10);
  const pins = zone(page, 'Time').getByRole('list', { name: 'Deadlines' }).getByRole('button');
  await expect(pins).toHaveText([/^Overdue · Confirm the data-licensing/, /^14:00 Answer the three pricing/]);
  await expect(pins.nth(0)).toHaveAttribute('data-pin', 'late');
  await expect(pins.nth(1)).toHaveAttribute('data-pin', 'now');
  const line = (await page.getByTestId('now-line').boundingBox())!;
  const late = (await pins.nth(0).boundingBox())!;
  expect(Math.abs(late.y + late.height / 2 - line.y)).toBeLessThan(6);

  // Needs you: Now, then Today with the failed triage at its top, each under its own header.
  const needs = zone(page, 'Needs you');
  await expect(needs.locator('[data-lane-head]')).toHaveText([/^NOW · \d+$/, /^TODAY · \d+$/]);
  await expect(needs.locator('[data-row]').first()).toHaveAttribute('data-lane', 'now');
  await expect(needs.locator('[data-row]:not([data-lane="now"])').first()).toHaveAttribute('data-lane', 'failed');
  await expect(needs.locator('[data-row]').filter({ hasText: 'Insights APIs v2 pricing' })).toContainText('14:00 · in 1');

  // Later: To file with its targets, This week soonest first, Snoozed, Low priority and Done.
  const later = zone(page, 'Later');
  await expect(later.getByRole('region', { name: 'To file' }).locator('[data-row]')).toHaveCount(4);
  await expect(later.getByRole('region', { name: 'To file' }).locator('[data-row]').first()).toContainText('Insights APIs › Decisions');
  await expect(later.getByRole('region', { name: 'This week' }).locator('[data-row]')).toContainText([/Thu 09:00/, /Fri 17:00 plan lock/, /this week/]);
  await expect(later.getByRole('button', { name: /^1 snoozed · next back Tue 09:00$/ })).toBeVisible();
  await expect(later.getByRole('button', { name: /^\d+ low priority · check triage$/ })).toBeVisible();

  // The calendar's first read brings its invite in a second poll: wait for it, so the bar is quiet.
  await expect(page.getByRole('button', { name: 'Poll now' })).toBeEnabled({ timeout: 10_000 });
  await expect(page.getByTestId('poll-line')).not.toContainText(/Polling|Triaging/);
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-light.png'), style: HIDE });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-dark.png'), style: HIDE, animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
});

test('J57: clear what’s due before the meeting — pins open the item; j/k, g n, g l and t (CK-3.2, 3.3, 3.6)', async ({ page }) => {
  await afternoon(page);

  // A pin opens its item in the panel, 640 px wide, below the top bar.
  await zone(page, 'Time').getByRole('list', { name: 'Deadlines' }).getByRole('button', { name: /^14:00 Answer/ }).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('Insights APIs v2 pricing');
  const box = (await panel(page).boundingBox())!;
  expect(box.width).toBeCloseTo(640, 0);
  expect(box.y).toBeGreaterThanOrEqual(64);
  await expect(page.locator('[data-row][aria-current="true"]')).toContainText('Insights APIs v2 pricing');
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-panel-light.png'), style: HIDE, animations: 'disabled' });

  // g l: the first Later item, the top of Waiting on others (above To file); g n: back to the first Needs you item.
  await page.keyboard.press('g');
  await page.keyboard.press('l');
  await expect(page.locator('[data-row][aria-current="true"]')).toHaveAttribute('data-lane', 'follow');
  await expect(page.locator('[data-row][aria-current="true"]')).toContainText('Meridia access');
  await page.keyboard.press('g');
  await page.keyboard.press('n');
  await expect(zone(page, 'Needs you').locator('[data-row]').first()).toHaveAttribute('aria-current', 'true');

  // j walks Now, then Today, then Later: Waiting on others, To file, then This week.
  const current = page.locator('[data-row][aria-current="true"]');
  const lanes: string[] = [];
  // Every row on screen: Needs you, Waiting on others, To file and This week.
  const rows = await page.locator('[data-cockpit-zone] [data-row]').count();
  for (let n = 0; n < rows - 1; n++) {
    const id = (await current.getAttribute('data-row'))!;
    lanes.push((await current.getAttribute('data-lane'))!);
    await page.keyboard.press('j');
    await expect(current).not.toHaveAttribute('data-row', id);
  }
  lanes.push((await current.getAttribute('data-lane'))!);
  const runs = lanes.filter((l, n) => l !== lanes[n - 1]);
  expect(runs).toEqual(['now', 'failed', 'today', 'follow', 'file', 'week']);

  // Esc closes the panel; t shows tomorrow.
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press('t');
  await expect(zone(page, 'Time').getByRole('button', { name: 'Tomorrow' })).toHaveAttribute('aria-pressed', 'true');
  await expect(zone(page, 'Time').getByRole('list', { name: 'All day' })).toContainText('Sales kick-off');
  await expect(zone(page, 'Time').getByRole('list', { name: 'Tomorrow’s meetings' }).getByRole('listitem')).toHaveText([/10:00 Q4 roadmap review/, /15:00 Insights APIs sync/]);
  await expect(page.getByTestId('now-line')).toHaveCount(0);
  await page.keyboard.press('t');
  await expect(zone(page, 'Time').getByRole('button', { name: 'Today' })).toHaveAttribute('aria-pressed', 'true');

  // Low priority opens in the Later zone in place of its lists; Esc comes back.
  const later = zone(page, 'Later');
  await later.getByRole('button', { name: /low priority · check triage/ }).click();
  await expect(later.getByRole('region', { name: 'Low priority' })).toBeVisible();
  await expect(later.getByRole('region', { name: 'To file' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(later.getByRole('region', { name: 'To file' })).toBeVisible();
  await later.getByRole('button', { name: /snoozed · next back/ }).click();
  await expect(later.getByRole('region', { name: 'Snoozed' }).locator('[data-row]')).toHaveCount(1);
  await later.getByRole('button', { name: 'Back to Later (Esc)' }).click();
  await expect(later.getByRole('region', { name: 'This week' })).toBeVisible();
});

test('J58: a missed deadline turns its pin red, says Overdue and sits at the now-line (story 3.1)', async ({ page }) => {
  await afternoon(page);
  const pins = zone(page, 'Time').getByRole('list', { name: 'Deadlines' }).getByRole('button');
  await expect(pins.filter({ hasText: 'Answer the three pricing' })).toHaveAttribute('data-pin', 'now');
  // 13:58, then 14:08: the pricing questions were due at 14:00, so they join the licensing wording at the now-line.
  await control(page, '+10 min');
  await control(page, '+10 min');
  await expect(pins).toHaveText(['2 overdue']);
  await expect(pins).toHaveAttribute('data-pin', 'late');
  await expect(zone(page, 'Needs you').locator('[data-row]').filter({ hasText: 'Insights APIs v2 pricing' })).toContainText('14:00 · overdue');
  await expect(page.getByTestId('next-meeting')).toContainText('NOW · UNTIL 15:00');
});

test('J65: the time column lines up with the other headers and folds to a rail; Time and Later drag wider (CK-3.4, 3.7)', async ({ page }) => {
  await afternoon(page);
  const time = zone(page, 'Time');

  // The three headers are 56 px, and the rule under each is drawn on the same pixel row: the first
  // top border below the header, which in Needs you and Later belongs to the row under it.
  const heads = await Promise.all((['Time', 'Needs you', 'Later'] as const).map(async (z) => (await zone(page, z).locator('> div').first().boundingBox())!));
  for (const h of heads) {
    expect(h.height).toBeCloseTo(56, 0);
    expect(h.y).toBeCloseTo(heads[0].y, 0);
  }
  const rules = await page.evaluate(() =>
    ['time', 'needs', 'later'].map((z) => {
      const head = document.querySelector(`[data-cockpit-zone="${z}"] > div`)!;
      const below = [...document.querySelectorAll(`[data-cockpit-zone="${z}"] *`)].filter((el) => head.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING && !head.contains(el));
      const ruled = below.find((el) => parseFloat(getComputedStyle(el).borderTopWidth) > 0 && el.getBoundingClientRect().height > 0)!;
      return ruled.getBoundingClientRect().top;
    }),
  );
  expect(rules[0]).toBe(heads[0].y + 56);
  expect(rules[1]).toBe(rules[0]);
  expect(rules[2]).toBe(rules[0]);

  // Dragged wider by its right edge, the meetings lane widens with it and Needs you gives way; kept on reload.
  const needsWidth = (await zone(page, 'Needs you').boundingBox())!.width;
  const meetingWidth = async () => (await time.getByRole('list', { name: 'Today’s meetings' }).getByRole('listitem').filter({ hasText: 'stand-up' }).boundingBox())!.width;
  const narrow = await meetingWidth();
  const edge = (await page.getByRole('separator', { name: 'Resize the time column' }).boundingBox())!;
  await page.mouse.move(edge.x + edge.width / 2, edge.y + 300);
  await page.mouse.down();
  await page.mouse.move(edge.x + edge.width / 2 + 100, edge.y + 300, { steps: 5 });
  await page.mouse.up();
  expect((await time.boundingBox())!.width).toBeCloseTo(500, 0);
  expect((await zone(page, 'Needs you').boundingBox())!.width).toBeCloseTo(needsWidth - 100, 0);
  expect(await meetingWidth()).toBeGreaterThan(narrow + 50);
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-time-wide-light.png'), style: HIDE, animations: 'disabled' });
  await page.reload();
  await expect(time).toBeVisible();
  expect((await time.boundingBox())!.width).toBeCloseTo(500, 0);

  // The arrow keys move the edge 20 px, within 360–600 px; a double-click puts it back to 400.
  const handle = page.getByRole('separator', { name: 'Resize the time column' });
  await handle.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(handle).toHaveAttribute('aria-valuenow', '480');
  for (let n = 0; n < 10; n++) await page.keyboard.press('ArrowRight');
  await expect(handle).toHaveAttribute('aria-valuenow', '600');
  await handle.dblclick();
  await expect(handle).toHaveAttribute('aria-valuenow', '400');

  // Later drags by its left edge: dragged left it widens and Needs you gives way; kept on reload.
  const later = zone(page, 'Later');
  await expect.poll(async () => Math.round((await time.boundingBox())!.width)).toBe(400); // the reset animates
  const needsBefore = (await zone(page, 'Needs you').boundingBox())!.width;
  const laterEdge = (await page.getByRole('separator', { name: 'Resize the Later column' }).boundingBox())!;
  await page.mouse.move(laterEdge.x + laterEdge.width / 2, laterEdge.y + 300);
  await page.mouse.down();
  await page.mouse.move(laterEdge.x + laterEdge.width / 2 - 80, laterEdge.y + 300, { steps: 5 });
  await page.mouse.up();
  expect((await later.boundingBox())!.width).toBeCloseTo(520, 0);
  expect((await zone(page, 'Needs you').boundingBox())!.width).toBeCloseTo(needsBefore - 80, 0);
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-later-wide-light.png'), style: HIDE, animations: 'disabled' });
  await page.reload();
  await expect(later).toBeVisible();
  expect((await later.boundingBox())!.width).toBeCloseTo(520, 0);
  const laterHandle = page.getByRole('separator', { name: 'Resize the Later column' });
  await laterHandle.focus();
  await page.keyboard.press('ArrowRight'); // the edge moves right: Later narrows
  await expect(laterHandle).toHaveAttribute('aria-valuenow', '500');
  await laterHandle.dblclick();
  await expect(laterHandle).toHaveAttribute('aria-valuenow', '440');

  // Folded, it's a rail with the clock; kept on reload. The sidebar's meeting cue (13:58, two minutes
  // before the renewal call) shows either way, so the sidebar doesn't shift (CK-3.7 amended).
  await time.getByRole('button', { name: 'Collapse the time column' }).click();
  await expect(time).toHaveAttribute('data-collapsed', 'true');
  expect((await time.boundingBox())!.width).toBeCloseTo(56, 0);
  await expect(page.getByTestId('next-meeting')).toHaveCount(0);
  await control(page, '+10 min');
  await expect(page.getByTestId('clock')).toHaveText(/^13:5[89]$/);
  await expect(page.getByRole('region', { name: 'Meetings now and next' })).toBeVisible();
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-time-collapsed-light.png'), style: HIDE, animations: 'disabled' });
  await page.reload();
  await expect(time).toHaveAttribute('data-collapsed', 'true');
  await time.getByRole('button', { name: 'Expand the time column' }).click();
  await expect(page.getByTestId('next-meeting')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Meetings now and next' })).toBeVisible();
  // The sidebar is the 60 px rail here, so the cue is one tile: the renewal call, two minutes out.
  await expect(page.getByRole('region', { name: 'Meetings now and next' })).toHaveAttribute('data-meeting-cues', '1');
  await page.screenshot({ path: join(APP, 'screenshots/cockpit-meeting-cue-light.png'), style: HIDE, animations: 'disabled' });
});

test('J59: below 1600 px the Inbox keeps the list and the agenda strip (CK-3.1, 3.7)', async ({ page }) => {
  await page.setViewportSize({ width: 1599, height: 1000 });
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Inbox list' })).toBeVisible();
  await expect(zone(page, 'Time')).toHaveCount(0);
  await expect(zone(page, 'Later')).toHaveCount(0);
  await expect(page.getByTestId('inbox-footer')).toBeVisible();
  // Widening the window brings the cockpit, without a reload.
  await page.setViewportSize({ width: 1728, height: 1000 });
  await expect(zone(page, 'Time')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Inbox list' })).toHaveCount(0);
});

test('the cockpit opens with the panel closed, so Later is in view; the list still opens on its first item (UX-13)', async ({ page }) => {
  await page.goto('/');
  await expect(zone(page, 'Later').locator('[data-row]').first()).toBeVisible();
  await page.waitForTimeout(500); // long enough for the panel to have opened, had it been going to
  await expect(panel(page)).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get('item')).toBeNull();
  // A pick opens it as before.
  await zone(page, 'Needs you').locator('[data-row]').first().click();
  await expect(panel(page)).toBeVisible();
  // Below 1600 px, today's list opens the panel on its first item when Work OS opens.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await expect(panel(page)).toBeVisible();
});
