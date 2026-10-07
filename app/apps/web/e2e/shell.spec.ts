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
  // The account menu still opens from the rail, beside it rather than clipped by it.
  await nav.getByRole('button', { name: 'Account' }).click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await menu.getByRole('group', { name: 'Scope' }).getByRole('button', { name: 'Full' }).click();
  await expect(menu.getByRole('group', { name: 'Scope' }).getByRole('button', { name: 'Full' })).toHaveAttribute('aria-pressed', 'true');
  const box = (await menu.boundingBox())!;
  expect(box.width).toBe(260);
  expect(box.x).toBeGreaterThanOrEqual(60); // beside the 60px rail, not over its icons
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
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

  // Usage has one too.
  await page.goto('/usage');
  await scrollBy('[data-page-scroll]');
  await expect(page.getByRole('heading', { name: 'Usage & health', level: 1 })).toBeInViewport();
  expect((await nav.boundingBox())!.y).toBe(0);

  // A page without one (the eval report) scrolls whole, inside main; the sidebar stays.
  await page.getByRole('link', { name: 'View report' }).click();
  await expect(page.getByRole('heading', { name: 'Eval report', level: 1 })).toBeVisible();
  await scrollBy('main');
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect((await nav.boundingBox())!.y).toBe(0);
  await expect(nav.getByRole('link', { name: /Inbox/ })).toBeInViewport();
});

test('the account menu: theme and scope, and a profile picture from Settings', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const account = nav.getByRole('button', { name: 'Account' });
  // Until a picture is set, the avatar is a person icon. The button shows the scope.
  await expect(account.locator('[data-avatar="icon"]')).toBeVisible();
  await expect(account).toContainText('MVP');

  await account.click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await menu.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await menu.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await menu.getByRole('group', { name: 'Scope' }).getByRole('button', { name: 'Full' }).click();
  await expect(account).toContainText('Full');

  // The picture is set in Settings › Appearance.
  await menu.getByRole('link', { name: 'Profile picture and appearance' }).click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await expect(menu).toHaveCount(0);
  await page.getByLabel('Profile picture file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(PNG_2x1, 'base64') });
  await expect(page.getByText('Profile picture updated.')).toBeVisible();
  const picture = account.locator('img[data-avatar="picture"]');
  await expect(picture).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  // It's kept in this browser across reloads.
  await page.reload();
  await expect(picture).toBeVisible();

  // A file that isn't a picture is refused, and the picture stays.
  await page.getByLabel('Profile picture file').setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByText('That file isn’t an image.', { exact: false })).toBeVisible();
  await expect(picture).toBeVisible();

  await page.getByRole('button', { name: 'Remove' }).click();
  await expect(account.locator('[data-avatar="icon"]')).toBeVisible();
});

/** A 2×1 PNG (red, blue): wider than tall, so the square crop is exercised. */
const PNG_2x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4zwAE/wEHAAH/4iOeWQAAAABJRU5ErkJggg==';
