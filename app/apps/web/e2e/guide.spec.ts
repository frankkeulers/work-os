import { join } from 'node:path';
import { expect, test } from '@playwright/test';

const APP = join(import.meta.dirname, '../../..');

const pagesNav = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: 'Guide pages' });

test('J43 the guide opens from the sidebar, in groups, with an outline and Previous / Next', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Guide' }).click();
  await expect(page).toHaveURL(/\/guide\/overview$/);
  await expect(page.getByRole('heading', { name: 'Guide', level: 1 })).toBeVisible();

  const nav = pagesNav(page);
  await expect(nav.getByText('Start here')).toBeVisible();
  await expect(nav.getByRole('link')).toHaveText([
    'What Work OS does',
    'Dev and prod',
    'The inbox',
    'Triage rules',
    'Outlook mail and calendar',
    'Wispr Flow meetings',
    'Filing to Confluence',
    'Filing to the vault',
    'Prompts and guidance',
    'Troubleshooting',
    'Keyboard shortcuts',
  ]);
  await expect(page.getByTestId('guide-updated')).toContainText('Updated');
  await expect(page.getByTestId('guide-source')).toHaveText('Built-in copy from this build'); // the mock has no guide folder

  await nav.getByRole('link', { name: 'Filing to Confluence' }).click();
  const outline = page.getByRole('navigation', { name: 'On this page' });
  await expect(outline.getByRole('link')).toHaveText(['Scope', 'Drafting', 'Already on the page', 'No fit', 'Approving and writing', 'Refused writes']);
  await outline.getByRole('link', { name: 'No fit' }).click();
  await expect(page).toHaveURL(/\/guide\/confluence#no-fit$/);
  await expect(page.locator('#no-fit')).toBeInViewport();
  await expect(outline.getByRole('link', { name: 'No fit' })).toHaveAttribute('aria-current', 'location');

  await page.getByRole('navigation', { name: 'Previous and next' }).getByRole('link', { name: /Next/ }).click();
  await expect(page).toHaveURL(/\/guide\/vault$/);
  await expect(page.getByRole('heading', { name: 'Filing to the vault', level: 2 })).toBeVisible();
  await expect(page).toHaveTitle('Filing to the vault · Guide · Work OS');

  // An app route in the Markdown moves within the app, without a reload.
  await page.evaluate(() => ((window as unknown as { marker: number }).marker = 1));
  await page.locator('.wos-guide').getByRole('link', { name: 'Settings › Write targets' }).click();
  await expect(page).toHaveURL(/\/settings\/writing$/);
  expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);

  await page.goto('/guide');
  await expect(page).toHaveURL(/\/guide\/overview$/);
  await page.goto('/guide/no-such-page');
  await expect(page).toHaveURL(/\/guide\/overview$/);
});

test('J43 search finds a section; Enter opens it', async ({ page }) => {
  await page.goto('/guide/overview');
  await expect(page.getByRole('heading', { name: 'What Work OS does', level: 2 })).toBeVisible();
  await page.keyboard.press('/');
  const box = page.getByRole('combobox', { name: 'Search the guide' });
  await expect(box).toBeFocused();
  await box.fill('keychain token');
  const results = page.getByRole('listbox', { name: 'Search results' });
  await expect(results.getByRole('option').first()).toContainText('Troubleshooting › Keychain tokens');
  await page.screenshot({ path: join(APP, 'screenshots/guide-search-light.png') });
  await box.press('Enter');
  await expect(page).toHaveURL(/\/guide\/troubleshooting#keychain-tokens$/);
  await expect(page.locator('#keychain-tokens')).toBeInViewport();
  await expect(results).toHaveCount(0);

  await box.fill('xylophone');
  await expect(page.getByText('Nothing in the guide matches “xylophone”.')).toBeVisible();
  await box.press('Escape');
  await expect(box).toHaveValue('');
});

test('J43 a code block copies; ? opens the shortcuts from anywhere', async ({ page }) => {
  // The system clipboard depends on window focus, which parallel workers don't share; record instead.
  await page.addInitScript(() => {
    const w = window as unknown as { copied?: string };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (t: string) => void (w.copied = t) } });
  });
  await page.goto('/guide/troubleshooting#keychain-tokens');
  await expect(page.locator('#keychain-tokens')).toBeInViewport();
  const copy = page.locator('.wos-guide-code').first().getByRole('button');
  await copy.click();
  await expect(copy).toHaveText('Copied');
  expect(await page.evaluate(() => (window as unknown as { copied?: string }).copied)).toContain('-w "$(pbpaste)"');

  await page.goto('/');
  await page.keyboard.press('?');
  await expect(page).toHaveURL(/\/guide\/shortcuts$/);
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts', level: 2 })).toBeVisible();
});

test('J43 Write targets links to the Confluence scope section', async ({ page }) => {
  await page.goto('/settings/writing');
  await page.getByTestId('guide-link-scope').click();
  await expect(page).toHaveURL(/\/guide\/confluence#scope$/);
  await expect(page.locator('#scope')).toBeInViewport();
});

test('guide screenshots', async ({ page }) => {
  await page.goto('/guide/confluence');
  await expect(page.getByRole('heading', { name: 'Filing to Confluence', level: 2 })).toBeVisible();
  await page.screenshot({ path: join(APP, 'screenshots/guide-light.png') });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await page.screenshot({ path: join(APP, 'screenshots/guide-dark.png'), animations: 'disabled' }); // fast-forward the colour transitions
});
