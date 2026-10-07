import { expect, test } from '@playwright/test';

test('the sidebar collapses to an icon rail and remembers it', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const sidebar = nav.locator('..');
  await expect(sidebar).toHaveCSS('width', '220px');

  await nav.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect(sidebar).toHaveCSS('width', '60px');
  // Labels become tooltips, but links keep their names and the Inbox count shows as a badge.
  // (The label stays in the DOM for screen readers, visually hidden, so check the link's size.)
  const usage = nav.getByRole('link', { name: /Usage & health/ });
  await expect(usage).toHaveAttribute('title', 'Usage & health');
  expect((await usage.boundingBox())!.width).toBeLessThanOrEqual(40);
  await expect(nav.getByRole('link', { name: /Inbox/ })).toContainText('11');
  // Scope stays one click away.
  await nav.getByRole('button', { name: /Scope: MVP/ }).click();
  await expect(nav.getByRole('button', { name: /Scope: Full/ })).toBeVisible();
  // The item panel stays open: sidebar buttons aren't "outside" it.
  await expect(page.getByRole('complementary', { name: 'Item panel' })).toBeVisible();

  await page.reload();
  await expect(sidebar).toHaveCSS('width', '60px');

  // [ toggles it from the keyboard.
  await page.keyboard.press('[');
  await expect(sidebar).toHaveCSS('width', '220px');
  await expect(nav.getByText('Work OS')).toBeVisible();
});

test('only the page content scrolls: the sidebar and top bars stay put', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 }); // short enough that every page overflows
  const nav = page.getByRole('navigation', { name: 'Main' });
  const top = async (selector: string) => (await page.locator(selector).first().boundingBox())!.y;
  const scrollBy = async (selector: string) => {
    const before = await page.locator(selector).evaluate((el) => el.scrollTop);
    await page.locator(selector).hover();
    await page.mouse.wheel(0, 800);
    await expect.poll(() => page.locator(selector).evaluate((el) => el.scrollTop)).toBeGreaterThan(before);
  };

  // A page with a top bar: its body scrolls under the bar.
  await page.goto('/settings/writing');
  await scrollBy('[data-page-scroll]');
  expect(await top('header')).toBe(0);
  await expect(page.getByRole('heading', { name: 'Settings & rules', level: 1 })).toBeInViewport();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect((await nav.boundingBox())!.y).toBe(0);

  // A page without one scrolls whole, inside main; the sidebar stays.
  await page.goto('/usage');
  await scrollBy('main');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect((await nav.boundingBox())!.y).toBe(0);
  await expect(nav.getByRole('link', { name: /Inbox/ })).toBeInViewport();
});
