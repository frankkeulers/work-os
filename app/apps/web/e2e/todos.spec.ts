import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// To Dos on the inbox (PLAN E15, FR-16.1–16.3): every line written to the Tasks note shows on the
// inbox, with where it came from and when it is due. The list layout has a To do group after Needs
// you; the cockpit puts what is overdue or due today in Needs you and the rest in Later.

const APP = join(import.meta.dirname, '../../..');
const HIDE = '[data-testid="os-notification"], [data-scenarios], [aria-label="Notifications"][aria-live] { display: none !important; }';

async function withTodos(page: Page) {
  await page.goto('/');
  await expect(page.locator('[data-row]').first()).toBeVisible();
  await page.keyboard.press('Backquote');
  const drawer = page.getByRole('complementary', { name: 'Scenarios' });
  await drawer.getByRole('group', { name: 'Scenario tab' }).getByRole('button', { name: 'Controls' }).click();
  await drawer.getByRole('button', { name: '13:48 with To Dos (cockpit)', exact: true }).click();
  await page.keyboard.press('Backquote');
}

const shoot = async (page: Page, el: ReturnType<Page['locator']>, name: string) => {
  const hide = await page.addStyleTag({ content: HIDE });
  await el.screenshot({ path: join(APP, `screenshots/${name}-light.png`), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'dark'));
  await el.screenshot({ path: join(APP, `screenshots/${name}-dark.png`), animations: 'disabled' });
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  await hide.evaluate((n) => n.remove());
};

test.describe('wide window (cockpit)', () => {
  test.use({ viewport: { width: 1680, height: 1050 } });

  test('J93 To Dos due today sit in Needs you, the rest in Later, and each opens its source (FR-16.2)', async ({ page }) => {
    await withTodos(page);
    const needs = page.getByRole('region', { name: 'To do today' });
    await expect(needs.locator('[data-todo]')).toHaveCount(3);
    await expect(needs.getByRole('heading', { name: 'TO DO · 3' })).toBeVisible();
    // Overdue first, in red; then today's, soonest first.
    await expect(needs.locator('[data-todo]').first()).toContainText('Send Matt the one-line MVI V2 go/no-go reason');
    await expect(needs.locator('[data-todo]').first()).toContainText('overdue');
    await expect(needs.locator('[data-todo]').nth(1)).toContainText('Share the graduation gate checklist');

    const later = page.getByRole('region', { name: 'Later' }).getByRole('region', { name: 'To do' });
    await expect(later.locator('[data-todo][data-todo-status="open"]')).toHaveCount(2);
    await expect(later.locator('[data-todo]').last()).toContainText('Book a kick-off with the Data team');
    await later.getByRole('button', { name: '1 done today' }).click();
    await expect(later.locator('[data-todo-status="done"]')).toContainText('ticked in Obsidian');
    await shoot(page, page.locator('[data-cockpit-zone="needs"]'), 'todos-cockpit-needs');
    await shoot(page, page.locator('[data-cockpit-zone="later"]'), 'todos-cockpit-later');

    await needs.locator('[data-todo]').nth(1).getByRole('button', { name: '#pole-star-labs' }).click();
    await expect(page.locator('.item-panel')).toContainText('graduation gate checklist');
  });

  test('J93 Done on a To Do ticks it in the Tasks note, asks how long it took, and Undo opens it again (FR-16.4, FR-16.5)', async ({ page }) => {
    await withTodos(page);
    const needs = page.getByRole('region', { name: 'To do today' });
    const share = needs.locator('[data-todo]', { hasText: 'Share the graduation gate checklist' });
    await share.getByRole('button', { name: 'Done: Share the graduation gate checklist' }).click();
    const toast = page.getByRole('status').filter({ hasText: 'Done · Share the graduation gate checklist' });
    await expect(toast).toContainText('Ticked in the Tasks note');
    await expect(needs.locator('[data-todo]')).toHaveCount(2);
    await toast.getByRole('button', { name: '30m' }).click();
    await expect(toast.getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'true');
    await shoot(page, toast, 'todos-done-toast');
    const later = page.getByRole('region', { name: 'Later' }).getByRole('region', { name: 'To do' });
    await later.getByRole('button', { name: '2 done today' }).click();
    await expect(later.locator('[data-todo-status="done"]', { hasText: 'Share the graduation' })).toContainText('took 30m');

    // z undoes it, as any toast's Undo.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('z');
    await expect(needs.locator('[data-todo]')).toHaveCount(3);

    // g then d: the first To Do, and e on it is its Done, not the open item's.
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await expect(needs.locator('[data-todo]').first()).toBeFocused();
    const item = page.locator('.item-panel');
    const hadPanel = await item.count();
    await page.keyboard.press('e');
    await expect(page.getByRole('status').filter({ hasText: 'Done · Send Matt the one-line MVI V2 go/no-go reason' })).toBeVisible();
    await expect(item).toHaveCount(hadPanel);

    // A line not in the Tasks note: done all the same, and it says it couldn't be ticked.
    await later.locator('[data-todo]', { hasText: 'Book a kick-off' }).getByRole('button', { name: /^Done:/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Done · Book a kick-off' })).toContainText('Not ticked: its line isn’t in the Tasks note');
    await expect(later.locator('[data-todo]', { hasText: 'Book a kick-off' })).toContainText('not ticked in the Tasks note');
  });

  test('J95 each To Do shows its estimate and when it would ideally be done, and you can set your own (FR-16.6, FR-16.7)', async ({ page }) => {
    await withTodos(page);
    const needs = page.getByRole('region', { name: 'To do today' });
    const later = page.getByRole('region', { name: 'Later' }).getByRole('region', { name: 'To do' });
    const share = needs.locator('[data-todo]', { hasText: 'Share the graduation gate checklist' });
    await expect(share.getByRole('button', { name: /^Plan:/ })).toHaveText('~15m');
    // Unsure: dimmed, and says so.
    const kickoff = later.locator('[data-todo]', { hasText: 'Book a kick-off' }).getByRole('button', { name: /^Plan:/ });
    await expect(kickoff).toHaveText('~20m');
    await expect(kickoff).toHaveAttribute('title', /^A rough estimate: Finding a time/);
    // Ideally sooner than its deadline, with why.
    const legal = later.locator('[data-todo]', { hasText: 'Confirm the IMO STR wording with Legal' });
    await expect(legal.locator('[data-todo-ideal]')).toContainText('ideally');
    await expect(legal.locator('[data-todo-ideal]')).toHaveAttribute('title', /Legal review wording on Tuesdays/);

    // Set your own: an hour.
    await share.getByRole('button', { name: /^Plan:/ }).click();
    const editor = page.getByRole('dialog', { name: 'Plan: Share the graduation gate checklist' });
    await expect(editor).toContainText('Work OS: The checklist exists');
    await editor.getByRole('button', { name: '1h' }).click();
    await shoot(page, editor, 'todos-plan-editor');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(editor).toHaveCount(0);
    await expect(share.getByRole('button', { name: /^Plan:/ })).toHaveText('1h');
    await expect(share.getByRole('button', { name: /^Plan:/ })).toHaveAttribute('title', /^Your estimate/);

    // p on a focused row opens it; Esc closes it and keeps the row's focus.
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await page.keyboard.press('p');
    const first = page.getByRole('dialog', { name: 'Plan: Send Matt the one-line MVI V2 go/no-go reason' });
    await expect(first).toBeVisible();
    await first.getByRole('button', { name: 'None' }).click();
    await first.getByRole('button', { name: 'Save' }).click();
    // No deadline now: no longer overdue, so it leaves Needs you for Later.
    await expect(later.locator('[data-todo]', { hasText: 'Send Matt the one-line' })).toBeVisible();
    await expect(needs.locator('[data-todo]', { hasText: 'Send Matt the one-line' })).toHaveCount(0);
  });

  test('J96 each To Do gets free time around the meetings, shown in the time column, and you can keep your own time (FR-16.8, FR-16.9)', async ({ page }) => {
    await withTodos(page);
    const needs = page.getByRole('region', { name: 'To do today' });
    // 13:48, the renewal call 14:00–15:00: the overdue one first, at 15:15, then today's.
    const send = needs.locator('[data-todo]', { hasText: 'Send Matt the one-line' });
    const share = needs.locator('[data-todo]', { hasText: 'Share the graduation gate checklist' });
    await expect(send.locator('[data-todo-slot="plan"]')).toHaveText('Today 15:15–15:30');
    await expect(share.locator('[data-todo-slot="plan"]')).toHaveText('Today 15:30–15:45');
    // Today's run in the order of their slots.
    await expect(needs.locator('[data-todo]').nth(1)).toContainText('Share the graduation gate checklist');

    const column = page.getByRole('list', { name: 'To Dos planned today' });
    const blocks = column.locator('[data-timeline-todo]');
    await expect(blocks.first()).toContainText('15:15 Send Matt the one-line');
    const shareBlock = column.locator(`[data-timeline-todo="${await share.getAttribute('data-todo')}"]`);
    await expect(shareBlock).toHaveAttribute('data-slot-by', 'plan');
    await shoot(page, page.locator('[data-cockpit-zone="time"]'), 'todos-time-column');

    // A block opens its plan: keep your own time, tomorrow at 09:00.
    await shareBlock.getByRole('button').click();
    const editor = page.getByRole('dialog', { name: 'Plan: Share the graduation gate checklist' });
    await expect(editor.locator('[data-slot-note]')).toContainText('Free time Work OS found in your calendar. Nothing is booked.');
    // The mock's day is Mon 5 Oct 2026: 09:00 London on the Tuesday, in the browser's own zone.
    const tomorrow9 = await page.evaluate(() => {
      const t = new Date('2026-10-06T08:00:00.000Z');
      return new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    });
    await editor.getByLabel('When you’ll do it').fill(tomorrow9);
    await shoot(page, editor, 'todos-slot-editor');
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(share.locator('[data-todo-slot="you"]')).toHaveText('Tue 09:00–09:15');
    await expect(shareBlock).toHaveCount(0);
    // Tomorrow's column has it, solid: Frank's own time.
    await page.locator('[data-cockpit-zone="time"]').getByRole('button', { name: 'Tomorrow' }).click();
    await expect(page.getByRole('list', { name: 'To Dos planned tomorrow' }).locator('[data-timeline-todo]')).toHaveAttribute('data-slot-by', 'you');
    await page.locator('[data-cockpit-zone="time"]').getByRole('button', { name: 'Today', exact: true }).click();

    // Hand it back.
    await share.locator('[data-todo-slot]').click();
    await editor.getByRole('button', { name: 'Let Work OS plan' }).click();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(share.locator('[data-todo-slot="plan"]')).toHaveText('Today 15:30–15:45');
  });

  test('J97 Done suggests what comes next: copy the reply and open the thread, add the next To Do; nothing is sent (FR-16.11, FR-16.12)', async ({ page }) => {
    // What would be copied and opened, kept instead.
    await page.addInitScript(() => {
      const w = window as unknown as { copied: string[]; opened: string[] };
      w.copied = [];
      w.opened = [];
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => void w.copied.push(t) } });
      window.open = (url?: string | URL) => (w.opened.push(String(url)), null);
    });
    await withTodos(page);
    const needs = page.getByRole('region', { name: 'To do today' });
    const share = needs.locator('[data-todo]', { hasText: 'Share the graduation gate checklist' });
    await share.getByRole('button', { name: 'Done: Share the graduation gate checklist' }).click();
    const toast = page.getByRole('status').filter({ hasText: 'Done · Share the graduation gate checklist' });
    await expect(toast).toContainText('Suggesting follow-ups…');
    const next = toast.getByRole('group', { name: 'Follow-ups' });
    await expect(next.locator('[data-followup]')).toHaveCount(3);
    await expect(next.locator('[data-followup="reply"]')).toContainText('Here’s the graduation gate checklist: [link].');
    await toast.hover(); // held while you read it
    await shoot(page, toast, 'todos-followups-toast');

    // 1: the reply, copied, and the thread opened for you to send it.
    await page.mouse.move(5, 5);
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('1');
    await expect(page.getByRole('status').filter({ hasText: 'Reply copied' })).toContainText('send it yourself');
    const kept = await page.evaluate(() => {
      const w = window as unknown as { copied: string[]; opened: string[] };
      return { copied: w.copied, opened: w.opened };
    });
    expect(kept.copied).toEqual(['Here’s the graduation gate checklist: [link]. The security review and the support runbook are the two still open for you.']);
    expect(kept.opened).toHaveLength(1);
    await expect(next.locator('[data-followup]')).toHaveCount(2);

    // The next To Do, from the row under Done today: written at once.
    const later = page.getByRole('region', { name: 'Later' }).getByRole('region', { name: 'To do' });
    await later.getByRole('button', { name: '2 done today' }).click();
    const done = later.locator('[data-todo-status="done"]', { hasText: 'Share the graduation' });
    await done.getByRole('button', { name: 'Add this To Do', exact: true }).click();
    await expect(page.locator('[data-todo][data-todo-status="open"]', { hasText: 'Book the security review for the Labs prototype' })).toBeVisible();
    // Not this one: closing the item.
    await done.getByRole('button', { name: 'Not this: Mark the item done' }).click();
    await expect(done.locator('[data-followup]')).toHaveCount(0);
  });
});

test.describe('list layout', () => {
  test.use({ viewport: { width: 1280, height: 1600 } });

  test('J93 a To do group after Needs you: overdue, today, upcoming, then done today, folded (FR-16.2)', async ({ page }) => {
    await withTodos(page);
    // The list opens on its first item: close the panel to see the whole group.
    await expect(page.locator('.item-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.item-panel')).toHaveCount(0);
    const group = page.getByRole('region', { name: 'To do', exact: true });
    await expect(group.locator('[data-todo-head]')).toHaveText(['OVERDUE · 1', 'TODAY · 2', 'UPCOMING · 2']);
    await expect(group.locator('[data-todo-status="done"]')).toHaveCount(0);
    await group.getByRole('button', { name: '1 done today' }).click();
    await expect(group.locator('[data-todo-status="done"]')).toHaveCount(1);
    // It follows Needs you.
    const order = await page.locator('section[data-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')));
    expect(order.indexOf('todo')).toBe(order.indexOf('needs') + 1);
    await shoot(page, group, 'todos-list');
  });
});
