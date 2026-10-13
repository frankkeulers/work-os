import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

// To Dos on the inbox (PLAN E15, FR-16.1–16.3): every line written to the Tasks note shows on the
// inbox, with where it came from and when it is due, grouped by when Frank will do it. The list
// layout has a To do group after Needs you; the cockpit has them in one place, the time column: as
// blocks on the day, and as a list under its To Dos tab.

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

/** The cockpit's To Dos: the time column's To Dos tab, opened. */
async function todosTab(page: Page) {
  await page.locator('[data-cockpit-zone="time"]').getByRole('button', { name: /^To Dos/ }).click();
  return page.getByTestId('todo-drawer');
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

  test('J99 To Dos are in one place, the time column: blocks on the day, and all of them under To Dos, by when you’ll do them (FR-16.2)', async ({ page }) => {
    await withTodos(page);
    // None in Needs you or Later.
    await expect(page.locator('[data-cockpit-zone="needs"] [data-todo], [data-cockpit-zone="later"] [data-todo]')).toHaveCount(0);
    // The tab says, in red, how many need a look: the overdue one, and one with no time before it's due.
    const time = page.locator('[data-cockpit-zone="time"]');
    await expect(time.getByTestId('todo-count')).toHaveText('2');
    await expect(time.getByTestId('todo-count')).toHaveAttribute('data-look', 'true');
    const blocks = await time.locator('[data-timeline-todo]').evaluateAll((els) => els.map((e) => e.getAttribute('data-timeline-todo')));

    const drawer = await todosTab(page);
    await expect(drawer.locator('[data-todo-head]')).toHaveText(['NEEDS A LOOK · 2', 'TODAY · 1', 'TOMORROW · 2']);
    const look = drawer.locator('[data-todo-group="look"] [data-todo]');
    await expect(look.first()).toContainText('Send Matt the one-line MVI V2 go/no-go reason');
    await expect(look.first()).toContainText('overdue');
    await expect(look.nth(1)).toContainText('Add the imo_str deprecation');
    await expect(look.nth(1)).toContainText('No free time before it is due');
    // Today's are the day's blocks: planned today, whatever their date.
    const today = await drawer.locator('[data-todo-group="today"] [data-todo]').evaluateAll((els) => els.map((e) => e.getAttribute('data-todo')));
    expect(today.every((id) => blocks.includes(id))).toBe(true);
    await expect(drawer.locator('[data-todo-group="today"]')).toContainText('Share the graduation gate checklist');
    await expect(drawer.locator('[data-todo-group="tomorrow"]')).toContainText('Book a kick-off with the Data team');
    await drawer.getByRole('button', { name: '1 done today' }).click();
    await expect(drawer.locator('[data-todo-status="done"]')).toContainText('ticked in Obsidian');
    await shoot(page, time, 'todos-cockpit-drawer');

    await drawer.locator('[data-todo]', { hasText: 'Share the graduation' }).getByRole('button', { name: '#pole-star-labs' }).click();
    await expect(page.locator('.item-panel')).toContainText('graduation gate checklist');

    // Back to the calendar, and folded: the rail still says how many need a look, and opens them.
    await time.getByRole('button', { name: 'Calendar', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await time.getByRole('button', { name: 'Collapse the time column' }).click();
    await expect(time.getByTestId('todo-count')).toHaveText('2');
    await time.getByRole('button', { name: 'Show the To Dos' }).click();
    await expect(drawer.locator('[data-todo]').first()).toBeVisible();
  });

  test('J94 Done on a To Do ticks it in the Tasks note, asks how long it took, and Undo opens it again (FR-16.4, FR-16.5)', async ({ page }) => {
    await withTodos(page);
    const drawer = await todosTab(page);
    const open = drawer.locator('[data-todo][data-todo-status="open"]');
    await expect(open).toHaveCount(5);
    const share = drawer.locator('[data-todo]', { hasText: 'Share the graduation gate checklist' });
    await share.getByRole('button', { name: 'Done: Share the graduation gate checklist' }).click();
    const toast = page.getByRole('status').filter({ hasText: 'Done · Share the graduation gate checklist' });
    await expect(toast).toContainText('Ticked in the Tasks note');
    await expect(open).toHaveCount(4);
    await toast.getByRole('button', { name: '30m' }).click();
    await expect(toast.getByRole('button', { name: '30m' })).toHaveAttribute('aria-pressed', 'true');
    await shoot(page, toast, 'todos-done-toast');
    await drawer.getByRole('button', { name: '2 done today' }).click();
    await expect(drawer.locator('[data-todo-status="done"]', { hasText: 'Share the graduation' })).toContainText('took 30m');

    // z undoes it, as any toast's Undo.
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('z');
    await expect(open).toHaveCount(5);

    // g then d, from the calendar: the To Dos and the first, and e on it is its Done, not the open item's.
    await page.locator('[data-cockpit-zone="time"]').getByRole('button', { name: 'Calendar', exact: true }).click();
    await page.locator('body').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('g');
    await page.keyboard.press('d');
    await expect(open.first()).toBeFocused();
    const item = page.locator('.item-panel');
    const hadPanel = await item.count();
    await page.keyboard.press('e');
    await expect(page.getByRole('status').filter({ hasText: 'Done · Send Matt the one-line MVI V2 go/no-go reason' })).toBeVisible();
    await expect(item).toHaveCount(hadPanel);

    // A line not in the Tasks note: done all the same, and it says it couldn't be ticked.
    await drawer.locator('[data-todo]', { hasText: 'Book a kick-off' }).getByRole('button', { name: /^Done:/ }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Done · Book a kick-off' })).toContainText('Not ticked: its line isn’t in the Tasks note');
    await drawer.getByRole('button', { name: /done today/ }).click();
    await expect(drawer.locator('[data-todo]', { hasText: 'Book a kick-off' })).toContainText('not ticked in the Tasks note');
  });

  test('J95 each To Do shows its estimate and when it would ideally be done, and you can set your own (FR-16.6, FR-16.7)', async ({ page }) => {
    await withTodos(page);
    const drawer = await todosTab(page);
    const share = drawer.locator('[data-todo]', { hasText: 'Share the graduation gate checklist' });
    await expect(share.getByRole('button', { name: /^Plan:/ })).toHaveText('~15m');
    // Unsure: dimmed, and says so.
    const kickoff = drawer.locator('[data-todo]', { hasText: 'Book a kick-off' }).getByRole('button', { name: /^Plan:/ });
    await expect(kickoff).toHaveText('~20m');
    await expect(kickoff).toHaveAttribute('title', /^A rough estimate: Finding a time/);
    // Ideally sooner than its deadline, with why.
    const legal = drawer.locator('[data-todo]', { hasText: 'Confirm the IMO STR wording with Legal' });
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
    // No deadline now: no longer overdue, so it needs no look, and goes by its time, today.
    await expect(drawer.locator('[data-todo-group="today"] [data-todo]', { hasText: 'Send Matt the one-line' })).toBeVisible();
    await expect(drawer.locator('[data-todo-group="look"] [data-todo]', { hasText: 'Send Matt the one-line' })).toHaveCount(0);
    await expect(page.locator('[data-cockpit-zone="time"]').getByTestId('todo-count')).toHaveText('1');
  });

  test('J96 each To Do gets free time around the meetings, shown in the time column, and you can keep your own time (FR-16.8, FR-16.9)', async ({ page }) => {
    await withTodos(page);
    const time = page.locator('[data-cockpit-zone="time"]');
    // 13:48, the renewal call 14:00–15:00: the overdue one first, at 15:15, then the checklist.
    const column = page.getByRole('list', { name: 'To Dos planned today' });
    const blocks = column.locator('[data-timeline-todo]');
    await expect(blocks.first()).toContainText('15:15 Send Matt the one-line');
    const shareBlock = blocks.filter({ hasText: 'Share the graduation gate checklist' });
    await expect(shareBlock).toContainText('15:30');
    await expect(shareBlock).toHaveAttribute('data-slot-by', 'plan');
    const shareId = await shareBlock.getAttribute('data-timeline-todo');
    await shoot(page, time, 'todos-time-column');

    // A block opens its plan, under the To Dos tab: keep your own time, tomorrow at 09:00.
    await shareBlock.getByRole('button').click();
    const editor = page.getByRole('dialog', { name: 'Plan: Share the graduation gate checklist' });
    await expect(editor.locator('[data-slot-note]')).toContainText('Free time Work OS found in your calendar. Nothing is booked.');
    const drawer = page.getByTestId('todo-drawer');
    await expect(time.getByRole('button', { name: /^To Dos/ })).toHaveAttribute('aria-pressed', 'true');
    // The mock's day is Mon 5 Oct 2026: 09:00 London on the Tuesday, in the browser's own zone.
    const tomorrow9 = await page.evaluate(() => {
      const t = new Date('2026-10-06T08:00:00.000Z');
      return new Date(t.getTime() - t.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    });
    await editor.getByLabel('When you’ll do it').fill(tomorrow9);
    await shoot(page, editor, 'todos-slot-editor');
    await editor.getByRole('button', { name: 'Save' }).click();
    const share = drawer.locator(`[data-todo="${shareId}"]`);
    await expect(share.locator('[data-todo-slot="you"]')).toHaveText('Tue 09:00–09:15');
    await expect(drawer.locator(`[data-todo-group="tomorrow"] [data-todo="${shareId}"]`)).toBeVisible();
    await expect(drawer.locator('[data-todo]', { hasText: 'Send Matt the one-line' }).locator('[data-todo-slot="plan"]')).toHaveText('Today 15:15–15:30');
    // Tomorrow's column has it, solid: Frank's own time. (Those that don't fit before 17:00 today are there too.)
    await time.getByRole('button', { name: 'Calendar', exact: true }).click();
    await time.getByRole('button', { name: 'Next day' }).click();
    await expect(page.getByRole('list', { name: 'To Dos planned tomorrow' }).locator(`[data-timeline-todo="${shareId}"]`)).toHaveAttribute('data-slot-by', 'you');
    await time.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(column.locator(`[data-timeline-todo="${shareId}"]`)).toHaveCount(0);

    // Hand it back.
    await todosTab(page);
    await share.locator('[data-todo-slot]').click();
    await editor.getByRole('button', { name: 'Let Work OS plan' }).click();
    await editor.getByRole('button', { name: 'Save' }).click();
    await expect(share.locator('[data-todo-slot="plan"]')).toHaveText('Today 15:30–15:45');
  });

  test('J100 To Dos are planned in their own hours, 09:00–17:00 unless you set others in Settings › Schedule (FR-16.8)', async ({ page }) => {
    await withTodos(page);
    const send = (await todosTab(page)).locator('[data-todo]', { hasText: 'Send Matt the one-line' });
    await expect(send.locator('[data-todo-slot="plan"]')).toHaveText('Today 15:15–15:30');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('link', { name: 'Schedule' }).click();
    const hours = page.getByLabel('Hours for To Dos');
    await expect(hours).toHaveValue('Mon–Fri 09:00–17:00');
    await expect(page.getByLabel('Work hours', { exact: true })).toHaveValue('Mon–Fri 08:00–18:30'); // polling's, wider
    await hours.fill('9 to 5');
    await expect(page.getByText('Write it like Mon–Fri 09:00–17:00')).toBeVisible();
    await hours.fill('Mon–Fri 16:00–17:00');
    await hours.blur();
    await expect(page.getByRole('status').filter({ hasText: 'Changes saved' })).toBeVisible();
    await shoot(page, page.getByRole('main', { name: 'Schedule' }), 'settings-todo-hours');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Inbox' }).click();
    // Product weekly is 16:00–16:30, with 10 minutes clear after it: the first free time left.
    await expect(send.locator('[data-todo-slot="plan"]')).toHaveText('Today 16:45–17:00');
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
    const drawer = await todosTab(page);
    const share = drawer.locator('[data-todo]', { hasText: 'Share the graduation gate checklist' });
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
    await drawer.getByRole('button', { name: '2 done today' }).click();
    const done = drawer.locator('[data-todo-status="done"]', { hasText: 'Share the graduation' });
    await done.getByRole('button', { name: 'Add this To Do', exact: true }).click();
    await expect(page.locator('[data-todo][data-todo-status="open"]', { hasText: 'Book the security review for the Labs prototype' })).toBeVisible();
    // Not this one: closing the item.
    await done.getByRole('button', { name: 'Not this: Mark the item done' }).click();
    await expect(done.locator('[data-followup]')).toHaveCount(0);
  });
});

test.describe('list layout', () => {
  test.use({ viewport: { width: 1280, height: 1600 } });

  test('J99 a To do group after Needs you: what needs a look, today, tomorrow, later, then done today, folded (FR-16.2)', async ({ page }) => {
    await withTodos(page);
    // The list opens on its first item: close the panel to see the whole group.
    await expect(page.locator('.item-panel')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.item-panel')).toHaveCount(0);
    const group = page.getByRole('region', { name: 'To do', exact: true });
    await expect(group.locator('[data-todo-head]')).toHaveText(['NEEDS A LOOK · 2', 'TODAY · 1', 'TOMORROW · 2']);
    await expect(group.locator('[data-todo-status="done"]')).toHaveCount(0);
    await group.getByRole('button', { name: '1 done today' }).click();
    await expect(group.locator('[data-todo-status="done"]')).toHaveCount(1);
    // It follows Needs you.
    const order = await page.locator('section[data-group]').evaluateAll((els) => els.map((e) => e.getAttribute('data-group')));
    expect(order.indexOf('todo')).toBe(order.indexOf('needs') + 1);
    await shoot(page, group, 'todos-list');
  });
});
