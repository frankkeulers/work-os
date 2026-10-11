import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { MockServer } from './server';

let server: MockServer;
const id = (key: string) => server.itemIdForKey(key)!;
const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Resolves an API promise while advancing fake timers past its simulated latency. */
const settle = async <T,>(p: Promise<T>, ms = 600): Promise<T> => {
  await run(ms);
  return p;
};
const lane = async (key: string) => (await settle(server.getItem(id(key)))).summary.lane;

beforeEach(() => {
  vi.useFakeTimers();
  server = new MockServer();
  server.reset('default');
});
afterEach(() => {
  server.dispose();
  vi.useRealTimers();
});

describe('inbox commands', () => {
  it('returns a snoozed item when the snooze time passes (FR-8.3)', async () => {
    // t3 asks for a walkthrough "this week": This week on a Monday (CK-3.10), and back there after.
    expect(await lane('t3')).toBe('week');
    await settle(server.snooze(id('t3'), new Date(server.now().getTime() + 5 * 60_000).toISOString()));
    expect(await lane('t3')).toBe('snoozed');
    server.advanceClock(6);
    const view = await settle(server.getItem(id('t3')));
    expect(view.summary.lane).toBe('week');
    expect(view.summary.backFromSnooze).toBe(true);
  });

  it('moves an item when Frank corrects the triage and grows the labelled set (FR-6.2)', async () => {
    const res = await settle(server.correctTriage(id('e1'), { attention: 'today', confluence: false, vault: false }));
    expect(res.labelCount).toBe(201);
    expect(await lane('e1')).toBe('today');
    expect(server.getEvents()[0].type).toBe('triage.corrected');
  });

  it('drafts Confluence for a thread that mentions people (FR-10.1, amended)', async () => {
    const a = await settle(server.requestDraft(id('t4'), 'confluence_entry'));
    expect(a).toMatchObject({ type: 'confluence_entry', status: 'drafting' });
  });
});

describe('source views (cockpit CK-5.1, CK-5.6)', () => {
  it('lists every item of one source, done ones and topic anchors included, newest first', async () => {
    await settle(server.markDone(id('t3')));
    const inbox = await settle(server.getInbox());
    const view = await settle(server.getSourceItems('slack'));
    expect(view.items.length).toBeGreaterThan(0);
    expect(view.items.every((i) => i.source === 'slack')).toBe(true);
    expect(view.items.map((i) => i.id)).toEqual(inbox.items.filter((i) => i.source === 'slack').map((i) => i.id));
    expect(view.items.find((i) => i.id === id('t3'))?.status).toBe('done');
    const times = view.items.map((i) => i.lastActivityAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(view.items.every((i) => !i.people.includes('Frank Keulers'))).toBe(true);
  });

  it('shows the whole calendar week, cancelled and declined meetings marked', async () => {
    expect((await settle(server.getWeek())).state).toBe('off');
    server.cockpitAfternoon();
    const week = await settle(server.getWeek(), 2000);
    expect(week.weekStart).toBe('2026-10-05');
    expect(week.events.some((e) => e.cancelled)).toBe(true);
    expect(week.events.some((e) => e.response === 'declined')).toBe(true);
    expect(new Set(week.events.map((e) => e.start.slice(0, 10))).size).toBeGreaterThan(2);
    expect((await settle(server.getWeek('2026-10-12'))).events).toEqual([]);
  });
});

describe('polling and triage', () => {
  it('waits for the quiet window, then triages in one batched call (§5.3)', async () => {
    const usageBefore = (await settle(server.getUsage())).today.triageCalls;
    await settle(server.pollNow(), 4000);
    expect(await lane('q1')).toBe('waiting');
    server.advanceClock(10);
    await run(4000);
    expect(await lane('q1')).toBe('today');
    expect((await settle(server.getUsage())).today.triageCalls).toBe(usageBefore + 1);
  });

  it('keeps an FYI mention in Today by the mention-me floor, and records that the model said None (FR-4.3)', async () => {
    await settle(server.pollNow(), 4000);
    server.advanceClock(10);
    await run(4000);
    expect((await settle(server.getItem(id('q1')))).decision).toMatchObject({ attention: 'today', ruleId: 'mention-me', modelAttention: 'none' });
  });

  it('makes no Claude call when nothing is eligible (Story 5.1)', async () => {
    const calls = (await settle(server.getUsage())).today.triageCalls;
    server.simulatePoll('nothing');
    await run(4000);
    expect((await settle(server.getUsage())).today.triageCalls).toBe(calls);
  });

  it('sends one notification for a VIP DM, bypassing the quiet window (FR-4.3, FR-11.1)', async () => {
    const notes: string[] = [];
    server.subscribe((n) => n.topic === 'notification' && notes.push(n.summary));
    server.simulatePoll('vip_dm');
    await run(3000);
    expect(notes).toHaveLength(1);
  });
});

describe('draft and approval outcomes', () => {
  const draft = async (key: string, type: 'vault_note' | 'confluence_entry') => {
    const a = await settle(server.requestDraft(id(key), type));
    await run(8000);
    return a.id;
  };
  const view = (key: string) => settle(server.getItem(id(key)));

  it('drafts, approves and writes to the sandbox in dry-run (FR-9.1–9.4, FR-1.6)', async () => {
    const actionId = await draft('f4', 'vault_note');
    expect((await view('f4')).actions[0].status).toBe('ready');
    await settle(server.approveAction(actionId), 3000);
    const v = await view('f4');
    expect(v.actions[0].status).toBe('done');
    expect(v.results[actionId]).toContain('sandbox/vault/Resources/Claude Code/Subscription auth.md');
  });

  it('marks an item approved in a batch done once all its filings are written; a single approval leaves it open (CK-4.4)', async () => {
    await settle(server.approveAction(await draft('f4', 'vault_note')), 3000);
    expect((await view('f4')).summary.status).toBe('open');

    // f1 suggests Confluence too, its entry not yet filed: the vault note alone doesn't close it.
    const f1 = await view('f1');
    expect(f1.summary.triage).toMatchObject({ confluence: true, vault: true });
    await settle(server.approveAction(f1.actions.find((a) => a.type === 'vault_note')!.id, { markDoneWhenFiled: true }), 3000);
    expect((await view('f1')).summary.status).toBe('open');

    // f4 suggests the vault only: done as the write lands.
    const again = await draft('f4', 'vault_note');
    await settle(server.approveAction(again, { markDoneWhenFiled: true }), 3000);
    const v = await view('f4');
    expect(v.actions[0]).toMatchObject({ id: again, status: 'done' });
    expect(v.summary).toMatchObject({ status: 'done', lane: 'done' });
  });

  it('re-drafts instead of writing when the page changed (FR-10.5)', async () => {
    server.setNextDraftOutcome('confluence_conflict');
    const f1 = await view('f1');
    const conf = f1.actions.find((a) => a.type === 'confluence_entry')!;
    await settle(server.approveAction(conf.id), 3500);
    const v = await view('f1');
    const confs = v.actions.filter((a) => a.type === 'confluence_entry');
    expect(confs[1].failureReason).toBe('conflict');
    expect(confs[0].supersedes).toBe(conf.id);
    expect(confs[0].status).toBe('drafting');
  });

  it('refuses a page excluded from the scope at write time (FR-10.6)', async () => {
    const actionId = await draft('f2', 'confluence_entry');
    const before = await view('f2');
    expect(before.excludedPageIds).toContain('31000007'); // Product org, above the drafted page
    await settle(server.approveAction(actionId), 3000);
    const a = (await view('f2')).actions.find((x) => x.id === actionId)!;
    expect(a.status).toBe('failed');
    expect(a.failureReason).toBe('allow_list');
  });

  it('lists the catalogue the scope rules find: roots and below, labels, minus excluded subtrees', async () => {
    const cat = await settle(server.getConfluenceCatalogue());
    const ids = cat.pages.map((p) => p.id);
    expect(ids).toContain('31000001'); // a root, as a hub
    expect(cat.pages.find((p) => p.id === '31000001')).toMatchObject({ hub: true, rootId: '31000001' });
    expect(ids).toContain('31000041'); // below the Competitor Profiles root
    expect(ids).toContain('31000051'); // by label, under no root
    expect(ids).not.toContain('31000061'); // under the excluded Archive
    expect(ids).not.toContain('48213377'); // under the excluded Product org
    expect(ids).not.toContain('31000052'); // no root, no label
    const settings = (await settle(server.getSettings())).settings;
    await settle(server.saveSettings({ ...settings, confluence: { ...settings.confluence, exclude: [] } }, (await settle(server.getSettings())).rules));
    expect((await settle(server.getConfluenceCatalogue())).pages.map((p) => p.id)).toContain('48213377');
  });

  it('blocks a Confluence draft that fails the people check, and a re-draft goes through (FR-10.4)', async () => {
    server.setNextDraftOutcome('people_check');
    const actionId = await draft('t2', 'confluence_entry');
    const a = (await view('t2')).actions.find((x) => x.id === actionId)!;
    expect(a.failureReason).toBe('people_check');
    const again = await settle(server.redraft(actionId));
    await run(8000);
    expect((await view('t2')).actions.find((x) => x.id === again.id)?.status).toBe('ready');
  });

  it('drafts an anonymised Confluence entry for a thread that mentions people (FR-10.1, amended)', async () => {
    const actionId = await draft('t4', 'confluence_entry');
    const v = await view('t4');
    expect(v.actions.find((x) => x.id === actionId)?.status).toBe('ready');
    const d = v.drafts[actionId];
    expect(d?.kind === 'confluence' && d.content).toMatch(/Data Products team/);
    expect(d?.kind === 'confluence' && d.content).not.toMatch(/overloaded|burning out|team lead/i);
  });
});

describe('settings', () => {
  it('rejects invalid settings and rules with field paths (FR-1.2, FR-1.5)', async () => {
    const { settings, rules } = await settle(server.getSettings());
    settings.schedule.intervalWorkMinutes = 0;
    rules[3] = { ...rules[3], conditions: [{ type: 'keyword', pattern: '/[oops/' }] };
    const err = (await settle(server.saveSettings(settings, rules).catch((e) => e))) as ApiError;
    expect(err.status).toBe(422);
    expect(err.issues.map((i) => i.path)).toEqual(['settings.schedule.intervalWorkMinutes', 'rules.3.conditions.0.pattern']);
  });
  it('edits, conflicts on and resets a prompt file (FR-1.7)', async () => {
    const before = (await settle(server.getPrompts())).find((p) => p.id === 'draft-vault')!;
    expect(before).toMatchObject({ edited: false, version: before.defaultVersion });
    const saved = await settle(server.savePrompt('draft-vault', '<!-- prompt: draft-vault v3 -->\nShorter.', before.version));
    expect(saved).toMatchObject({ edited: true, version: expect.stringMatching(/^draft-vault v3#[0-9a-f]{8}$/) });
    expect(server.getEvents()[0]).toMatchObject({ type: 'prompt.changed', data: { id: 'draft-vault', reset: false } });
    const stale = (await settle(server.savePrompt('draft-vault', 'x', before.version).catch((e) => e))) as ApiError;
    expect(stale.status).toBe(409);
    const empty = (await settle(server.savePrompt('draft-vault', ' ', saved.version).catch((e) => e))) as ApiError;
    expect(empty.status).toBe(422);
    expect(await settle(server.resetPrompt('draft-vault', saved.version))).toMatchObject({ edited: false, version: before.version });
  });

  it('flags the routing guidance’s changed source until it is marked reviewed (FR-1.7)', async () => {
    const routing = (await settle(server.getPrompts())).find((p) => p.id === 'confluence-routing')!;
    expect(routing.sources).toMatchObject([{ id: 'psg-context-builder', state: 'changed' }]);
    const after = await settle(server.markPromptReviewed('confluence-routing', routing.version));
    expect(after.sources).toMatchObject([{ state: 'current' }]);
  });
});

describe('the bell (FR-11.3–11.5)', () => {
  const attention = () => settle(server.getAttention());

  it('shows a draft in progress, then ready, and a failure until dismissed', async () => {
    const notices: string[] = [];
    server.subscribe((n) => notices.push(n.topic));
    const a = await settle(server.requestDraft(id('f4'), 'vault_note'));
    expect((await attention()).working).toEqual([expect.objectContaining({ actionId: a.id, type: 'vault_note', progress: expect.objectContaining({ stage: 0 }) })]);
    await run(8000);
    const ready = await attention();
    expect(ready.working).toEqual([]);
    expect(ready.entries.find((e) => e.actionId === a.id)).toMatchObject({ kind: 'draft_ready', cta: 'Review' });

    server.setNextDraftOutcome('people_check');
    const b = await settle(server.requestDraft(id('t2'), 'confluence_entry'));
    await run(8000);
    expect(notices).toContain('draft_failed');
    const failed = (await attention()).entries.find((e) => e.actionId === b.id)!;
    expect(failed).toMatchObject({ kind: 'draft_failed', detail: expect.stringMatching(/identifies a person/), dismissible: true });
    await settle(server.dismissAttention(failed.key));
    expect((await attention()).entries.find((e) => e.actionId === b.id)).toBeUndefined();
  });

  it('lists the guidance whose sources changed, until it is marked reviewed', async () => {
    const entry = (await attention()).entries.find((e) => e.kind === 'guidance_changed');
    expect(entry).toMatchObject({ subject: expect.any(String), to: '/settings/prompts#confluence-routing' });
    const routing = (await settle(server.getPrompts())).find((p) => p.id === 'confluence-routing')!;
    await settle(server.markPromptReviewed('confluence-routing', routing.version));
    expect((await attention()).entries.find((e) => e.kind === 'guidance_changed')).toBeUndefined();
  });
});
