import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const APP = join(import.meta.dirname, '../../..');

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
  await expect(usage).toHaveAttribute('title', 'Usage & health · Running normally');
  expect((await usage.boundingBox())!.width).toBeLessThanOrEqual(40);
  await expect(nav.getByRole('link', { name: /Inbox/ })).toContainText('8');
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

test('the Usage & health item carries a dot for the app’s own health', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const usage = nav.getByRole('link', { name: /Usage & health/ });
  // No address under the name: the header is the name and the toggle.
  await expect(nav.getByText('127.0.0.1')).toHaveCount(0);
  await expect(usage.locator('[data-health]')).toHaveAttribute('data-health', 'ok');
  await expect(usage).toHaveAttribute('title', 'Running normally');
  await nav.screenshot({ path: join(APP, 'screenshots/sidebar-health-light.png') });

  // A rejected Slack token degrades the app: the dot turns amber and says what the banner says.
  await page.keyboard.press('Backquote');
  const drawer = page.getByRole('complementary', { name: 'Scenarios' });
  await drawer.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer.getByRole('button', { name: 'Auth failure', exact: true }).click();
  await drawer.getByRole('button', { name: 'Close scenarios' }).click();
  await expect(usage.locator('[data-health]')).toHaveAttribute('data-health', 'warn');
  await expect(usage).toHaveAttribute('title', 'Slack token in Keychain: rejected by Slack');
  await nav.screenshot({ path: join(APP, 'screenshots/sidebar-health-problem-light.png') });

  // On the rail it sits on the icon's corner, and the tooltip keeps the reason.
  await page.keyboard.press('[');
  await expect(usage).toHaveAttribute('title', 'Usage & health · Slack token in Keychain: rejected by Slack');
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await nav.screenshot({ path: join(APP, 'screenshots/sidebar-health-rail-dark.png'), animations: 'disabled' });
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
  // It lines up with the Guide item above it: avatar centred on the icon, label where the label starts, same height.
  const guide = nav.getByRole('link', { name: 'Guide' });
  const box = async (l: import('@playwright/test').Locator) => (await l.boundingBox())!;
  const [icon, avatar] = [await box(guide.locator('svg')), await box(account.locator('[data-avatar]'))];
  expect(avatar.x + avatar.width / 2).toBeCloseTo(icon.x + icon.width / 2, 0);
  expect((await box(account.getByText('Account', { exact: true }))).x).toBeCloseTo((await box(guide.getByText('Guide', { exact: true }))).x, 0);
  expect((await box(account)).height).toBe((await box(guide)).height);

  await account.click();
  const menu = page.getByRole('dialog', { name: 'Account' });
  await menu.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await menu.getByRole('group', { name: 'Theme' }).getByRole('button', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await menu.getByRole('group', { name: 'Scope' }).getByRole('button', { name: 'Full' }).click();
  await expect(account).toContainText('Full');

  // The picture is set in Settings › Profile.
  await menu.getByRole('link', { name: 'Edit profile' }).click();
  await expect(page).toHaveURL(/\/settings\/profile$/);
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

test('the profile: names show on the account button, as initials until there is a picture', async ({ page }) => {
  await page.goto('/settings/profile');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const account = nav.getByRole('button', { name: /^Account/ });
  await expect(page.getByRole('heading', { name: 'Profile' })).toBeVisible();
  // Account leads the Settings nav.
  const sections = page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link');
  await expect(sections.nth(0)).toHaveText('Profile');
  await expect(sections.nth(1)).toHaveText('Appearance');
  await expect(account).toHaveAccessibleName('Account');

  await page.getByLabel('First name').fill('Ada');
  await page.getByLabel('Last name').fill(' lovelace ');
  await expect(account).toHaveAccessibleName('Account: Ada lovelace');
  await expect(account.locator('[data-avatar="initials"]')).toHaveText('AL');
  // The display name falls back to the full name, shown as its placeholder.
  const display = page.getByLabel('Display name');
  await expect(display).toHaveAttribute('placeholder', 'Ada lovelace');
  await expect(display).toHaveAttribute('maxlength', '60');
  // Spaces at the ends go when you leave the field.
  await page.getByLabel('Last name').fill(' Lovelace ');
  await display.focus();
  await expect(page.getByLabel('Last name')).toHaveValue('Lovelace');

  await display.fill('Countess');
  await expect(account).toHaveAccessibleName('Account: Countess');
  await expect(account).toContainText('Countess');
  // Initials stay with the real name.
  await expect(account.locator('[data-avatar="initials"]')).toHaveText('AL');

  // Kept across reloads, and shown in the menu.
  await page.reload();
  await expect(display).toHaveValue('Countess');
  await account.click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toContainText('Countess');
  await page.keyboard.press('Escape');

  // A picture wins over initials; with no names left, the person icon is back.
  await page.getByLabel('Profile picture file').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: Buffer.from(PNG_2x1, 'base64') });
  await expect(account.locator('img[data-avatar="picture"]')).toBeVisible();
  await page.getByRole('button', { name: 'Remove' }).click();
  for (const field of ['First name', 'Last name', 'Display name']) await page.getByLabel(field).fill('');
  await expect(account).toHaveAccessibleName('Account');
  await expect(account.locator('[data-avatar="icon"]')).toBeVisible();
});

/** A 2×1 PNG (red, blue): wider than tall, so the square crop is exercised. */
const PNG_2x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADUlEQVR4nGP4zwAE/wEHAAH/4iOeWQAAAABJRU5ErkJggg==';
