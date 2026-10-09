import { expect, test, type Page } from '@playwright/test';

// The Work OS mark (specs/WORKOS-IDENTITY.md W2, W3): the light and the tab's icon follow the Now lane,
// needs you plays when a Now item arrives, filed when a filing is written, checking while Inbox zero polls.

const drawer = (page: Page) => page.getByRole('complementary', { name: 'Scenarios' });
const ctl = (page: Page, name: string) => drawer(page).getByRole('button', { name, exact: true });
const nav = (page: Page) => page.getByRole('navigation', { name: 'Main' });
const navMark = (page: Page) => nav(page).locator('svg.bm');
const favicon = (page: Page) => page.locator('link#brand-favicon');

async function controls(page: Page) {
  if (!(await drawer(page).isVisible())) await page.keyboard.press('Backquote');
  await drawer(page).getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
}

async function inboxZero(page: Page) {
  await page.goto('/');
  await controls(page);
  await ctl(page, 'Reset demo data').click();
  await ctl(page, 'Inbox zero').click();
  await expect(page.getByTestId('inbox-zero')).toBeVisible();
}

test('the light and the tab icon are quiet with nothing in Now, and turn to attention when a Now item arrives', async ({ page }) => {
  await inboxZero(page);
  await expect(navMark(page)).toHaveAttribute('data-mark-state', 'quiet');
  await expect(favicon(page)).toHaveAttribute('href', '/favicon.svg');
  // The empty state's mark is decorative.
  await expect(page.getByTestId('inbox-zero').locator('svg[aria-hidden="true"]')).toHaveCount(1);

  await ctl(page, 'VIP DM').click();
  await expect(navMark(page)).toHaveAttribute('data-mark-state', 'attention', { timeout: 10_000 });
  await expect(navMark(page)).toHaveClass(/\bbm-nd\b/); // needs you plays once…
  await expect(navMark(page)).not.toHaveClass(/\bbm-nd\b/, { timeout: 5_000 }); // …then the class clears
  await expect(navMark(page)).toHaveAttribute('data-mark-state', 'attention'); // and the light stays orange
  await expect(favicon(page)).toHaveAttribute('href', '/favicon-attention.svg');
  // The OS notification card carries the mark on its tile.
  await expect(page.getByTestId('os-notification').locator('svg.bm')).toBeVisible();

  // With Now empty again, both go back to quiet.
  await ctl(page, 'Inbox zero').click();
  await expect(navMark(page)).toHaveAttribute('data-mark-state', 'quiet');
  await expect(favicon(page)).toHaveAttribute('href', '/favicon.svg');
});

test('on first load the light shows attention without playing needs you', async ({ page }) => {
  await page.goto('/');
  await controls(page);
  await ctl(page, 'Reset demo data').click();
  await page.reload();
  await expect(navMark(page)).toHaveAttribute('data-mark-state', 'attention');
  await expect(favicon(page)).toHaveAttribute('href', '/favicon-attention.svg');
  await expect(navMark(page)).not.toHaveClass(/\bbm-nd\b/);
});

test('Inbox zero plays checking sources while a poll runs, and finishes its cycle when it ends', async ({ page }) => {
  await inboxZero(page);
  const mark = page.getByTestId('inbox-zero').locator('svg.bm');
  await ctl(page, 'Nothing eligible').click();
  await expect(mark).toHaveClass(/\bbm-ck\b/);
  await expect(page.getByTestId('poll-line')).toContainText('Nothing new, no Claude call', { timeout: 10_000 });
  // One 4.8s cycle at most after the poll ends.
  await expect(mark).not.toHaveClass(/\bbm-ck\b/, { timeout: 6_000 });
  const card = page.getByTestId('inbox-zero');
  expect((await card.boundingBox())!.height).toBeGreaterThan(0);
});

test('the sidebar mark plays filed when a filing is written to the sandbox', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('region', { name: 'To file', exact: true }).locator('[data-row]').filter({ hasText: 'imo_str' }).click();
  const panel = page.getByRole('complementary', { name: 'Item panel' });
  await panel.getByRole('region', { name: 'Next step' }).getByRole('button', { name: 'Review Confluence entry' }).click();
  await panel.getByRole('region', { name: 'Action' }).getByRole('button', { name: 'Approve and write to sandbox' }).click();
  await expect(navMark(page)).toHaveClass(/\bbm-fl\b/, { timeout: 20_000 });
  await expect(navMark(page)).not.toHaveClass(/\bbm-fl\b/, { timeout: 5_000 });
});

test.describe('on the cockpit', () => {
  test.use({ viewport: { width: 1728, height: 1000 } });

  test('a batch plays filed although it moves on before the write lands', async ({ page }) => {
    await page.goto('/');
    const panel = page.getByRole('complementary', { name: 'Item panel' });
    await expect(panel).toBeVisible();
    await page.keyboard.press('Escape');
    await controls(page);
    await ctl(page, '13:48 with Outlook and the calendar on (cockpit)').click();
    await page.keyboard.press('Backquote');
    await expect(page.getByTestId('poll-line')).not.toContainText(/Polling|Triaging/, { timeout: 15_000 });
    const toFile = page.getByRole('region', { name: 'Later', exact: true }).getByRole('region', { name: 'To file', exact: true });
    await toFile.getByRole('button', { name: 'File in a batch' }).click();
    const approve = panel.getByRole('button', { name: /^Approve and write/ });
    await expect(approve).toBeEnabled({ timeout: 15_000 });
    await expect(navMark(page)).not.toHaveClass(/\bbm-fl\b/);
    await approve.click();
    await expect(navMark(page)).toHaveClass(/\bbm-fl\b/, { timeout: 20_000 });
  });
});

test('the collapsed rail shows only the mark, which expands the sidebar', async ({ page }) => {
  await page.goto('/');
  const sidebar = nav(page).locator('..');
  await nav(page).getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebar).toHaveCSS('width', '60px');
  const expand = nav(page).getByRole('button', { name: 'Expand sidebar' });
  await expect(expand.locator('svg.bm')).toBeVisible();
  await expect(nav(page).getByText('Work OS')).toHaveCount(0);
  await expand.click();
  await expect(sidebar).toHaveCSS('width', '220px');
  await expect(nav(page).getByText('Work OS')).toBeVisible();
});

test.describe('with reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('a new Now item turns the light orange at once, with nothing moving', async ({ page }) => {
    await inboxZero(page);
    await ctl(page, 'VIP DM').click();
    await expect(navMark(page)).toHaveAttribute('data-mark-state', 'attention', { timeout: 10_000 });
    const light = navMark(page).locator('.bm-light');
    const moving = await navMark(page).evaluate((svg) => svg.getAnimations({ subtree: true }).filter((a) => a instanceof CSSAnimation && /^(ndTilt|ndRing|ckHop|ckLook)$/.test(a.animationName)).length);
    expect(moving).toBe(0);
    const fill = await light.evaluate((c) => getComputedStyle(c).fill);
    const attention = await page.evaluate(() => {
      const probe = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      probe.setAttribute('fill', 'var(--mark-attention)');
      document.querySelector('svg.bm')!.appendChild(probe);
      const c = getComputedStyle(probe).fill;
      probe.remove();
      return c;
    });
    expect(fill).toBe(attention);
  });
});

test('the sidebar header stays 64px tall while the mark animates', async ({ page }) => {
  await inboxZero(page);
  const header = nav(page).locator('div.h-16').first();
  await ctl(page, 'VIP DM').click();
  await expect(navMark(page)).toHaveClass(/\bbm-nd\b/, { timeout: 10_000 });
  for (let i = 0; i < 5; i++) {
    expect((await header.boundingBox())!.height).toBe(64);
    await page.waitForTimeout(400);
  }
});
