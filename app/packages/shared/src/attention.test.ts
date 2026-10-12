import { describe, expect, it } from 'vitest';
import { buildAttention, unseenCount, type AttentionInput } from './attention';
import type { DependencyHealth } from './api';

const NOW = '2026-10-11T12:00:00.000Z';
const at = (mins: number) => new Date(Date.parse(NOW) + mins * 60_000).toISOString();

type Act = AttentionInput['actions'][number];
type It = AttentionInput['items'][number];

const item = (id: string, extra: Partial<It> = {}): It => ({ id, title: `Item ${id}`, status: 'open', revision: 1, backFromSnooze: false, lastActivityAt: at(-300), ...extra });
const action = (id: string, itemId: string, extra: Partial<Act> = {}): Act => ({
  id,
  itemId,
  type: 'vault_note',
  status: 'ready',
  itemRevision: 1,
  createdAt: at(-30),
  updatedAt: at(-20),
  ...extra,
});

function input(extra: Partial<AttentionInput> = {}): AttentionInput {
  return {
    now: NOW,
    items: [],
    actions: [],
    progress: {},
    health: { mode: 'normal', deps: [], checks: [], checkedAt: at(-5), startedAt: at(-600) },
    budgets: { drafts: { used: 0, limit: 20, hit: false } },
    guidance: [],
    dismissed: {},
    ...extra,
  };
}

const dep = (id: DependencyHealth['id'], state: DependencyHealth['state'], extra: Partial<DependencyHealth> = {}): DependencyHealth => ({ id, state, since: at(-15), failures: 1, ...extra });

describe('buildAttention: drafts (FR-11.4)', () => {
  it('lists a ready draft to review, and nothing once it is approved or discarded', () => {
    const v = buildAttention(input({ items: [item('a')], actions: [action('x', 'a')] }));
    expect(v.entries).toEqual([
      expect.objectContaining({ key: 'draft_ready:x', kind: 'draft_ready', title: 'Vault note draft ready', subject: 'Item a', cta: 'Review', to: '/item/a', dismissible: false }),
    ]);
    for (const status of ['approved', 'executing', 'done', 'discarded'] as const) {
      expect(buildAttention(input({ items: [item('a')], actions: [action('x', 'a', { status })] })).entries).toEqual([]);
    }
  });

  it('says when new replies came in since the draft, or when it has waited over a day', () => {
    const stale = buildAttention(input({ items: [item('a', { revision: 2 })], actions: [action('x', 'a')] }));
    expect(stale.entries[0]?.detail).toMatch(/New replies since/);
    const old = buildAttention(input({ items: [item('a')], actions: [action('x', 'a', { updatedAt: at(-25 * 60) })] }));
    expect(old.entries[0]?.detail).toMatch(/over a day/);
  });

  it('tells a failed draft from a failed write, with the server’s message', () => {
    const v = buildAttention(
      input({
        items: [item('a'), item('b')],
        actions: [
          action('x', 'a', { status: 'failed', failedWhile: 'drafting', failureReason: 'model_error' }),
          action('y', 'b', { type: 'confluence_entry', status: 'failed', failedWhile: 'writing', failureReason: 'unreachable' }),
        ],
        results: { y: 'Confluence failed 5 times. Nothing was written.' },
      }),
    );
    const [draft, write] = ['draft_failed', 'write_failed'].map((k) => v.entries.find((e) => e.kind === k));
    expect(draft).toMatchObject({ key: 'draft_failed:x', title: 'Vault note draft failed', detail: 'The model’s answer couldn’t be used.', dismissible: true });
    expect(write).toMatchObject({ key: 'write_failed:y', title: 'Couldn’t file the Confluence entry', detail: 'Confluence failed 5 times. Nothing was written.' });
  });

  it('shows only the current action per type: a failure replaced by a re-draft goes', () => {
    const v = buildAttention(
      input({
        items: [item('a')],
        actions: [action('x', 'a', { status: 'failed', failedWhile: 'writing', failureReason: 'conflict', createdAt: at(-60) }), action('y', 'a', { status: 'drafting', supersedes: 'x', createdAt: at(-10) })],
      }),
    );
    expect(v.entries).toEqual([]);
    expect(v.working).toEqual([expect.objectContaining({ actionId: 'y', subject: 'Item a' })]);
  });

  it('lists drafts in progress apart, oldest first, and why a waiting one is held', () => {
    const progress = { stages: ['Reading', 'Drafting'], stage: 1, startedAt: Date.parse(at(-1)) };
    const actions = [action('x', 'a', { status: 'drafting', createdAt: at(-5) }), action('y', 'b', { status: 'drafting', type: 'confluence_entry', createdAt: at(-2) })];
    const items = [item('a'), item('b')];
    const v = buildAttention(input({ items, actions, progress: { x: progress } }));
    expect(v.working).toEqual([
      { itemId: 'a', actionId: 'x', type: 'vault_note', subject: 'Item a', progress },
      { itemId: 'b', actionId: 'y', type: 'confluence_entry', subject: 'Item b' },
    ]);
    const offline = buildAttention(input({ items, actions, progress: { x: progress }, health: { ...input().health, deps: [dep('confluence', 'offline')] } }));
    expect(offline.working[1]?.held).toBe('Waits for Confluence');
  });

  it('leaves out a draft on an item closed after it was ready, not one ready after the item closed', () => {
    const closedAfter = buildAttention(input({ items: [item('a', { status: 'done', doneAt: at(-10) })], actions: [action('x', 'a', { updatedAt: at(-20) })] }));
    expect(closedAfter.entries).toEqual([]);
    const readyAfter = buildAttention(input({ items: [item('a', { status: 'done', doneAt: at(-25) })], actions: [action('x', 'a', { updatedAt: at(-20) })] }));
    expect(readyAfter.entries.map((e) => e.kind)).toEqual(['draft_ready']);
  });

  it('skips actions whose item retention removed', () => {
    expect(buildAttention(input({ actions: [action('x', 'gone')] })).entries).toEqual([]);
  });
});

describe('buildAttention: fixes', () => {
  it('lists a rejected login and a connector to reconnect, not a degraded dependency', () => {
    const v = buildAttention(
      input({ health: { ...input().health, mode: 'degraded', deps: [dep('slack', 'auth_failed', { fix: 'Update the token.' }), dep('ms365', 'auth_failed', { reason: 'needs-auth' }), dep('confluence', 'degraded')] } }),
    );
    // Newest first; these two started at the same time.
    expect(v.entries.map((e) => [e.title, e.to ?? e.href])).toEqual([
      ['Outlook not connected', 'https://claude.ai/settings/connectors'],
      ['Slack rejected the login', '/usage#health'],
    ]);
    expect(v.entries[1]).toMatchObject({ kind: 'fix_needed', detail: 'Update the token.', dismissible: false });
  });

  it('leaves out a failed check a dependency already covers', () => {
    const v = buildAttention(
      input({
        health: {
          ...input().health,
          deps: [dep('claude', 'auth_failed')],
          checks: [
            { id: 'claude_login', label: 'Claude login', status: 'fail', note: 'Logged out' },
            { id: 'settings', label: 'Settings', status: 'fail', note: 'Invalid' },
          ],
        },
      }),
    );
    expect(v.entries.map((e) => e.key)).toEqual(['fix:check:settings', 'fix:claude:' + at(-15)]);
    expect(v.entries[0]?.to).toBe('/settings');
  });

  it('says when drafts wait for the budget, and only while some do', () => {
    const budgets = { drafts: { used: 20, limit: 20, hit: true } };
    expect(buildAttention(input({ budgets })).entries).toEqual([]);
    const v = buildAttention(input({ budgets, items: [item('a')], actions: [action('x', 'a', { status: 'drafting' })] }));
    expect(v.entries).toEqual([expect.objectContaining({ kind: 'fix_needed', title: 'Drafts wait for the budget', subject: '1 draft waiting' })]);
    expect(v.working[0]?.held).toBe('Waits for the drafts budget');
  });
});

describe('buildAttention: nudges and housekeeping', () => {
  it('nudges an open item back from snooze, one that looks finished, and a reply that left asks open', () => {
    const v = buildAttention(
      input({
        items: [
          item('a', { backFromSnooze: true, backAt: at(-3) }),
          item('b', { looksFinished: { at: at(-2), why: 'Dana confirmed it.' } }),
          item('c', { replyCheck: { at: at(-1), allSettled: false, settled: 1 } }),
          item('d', { replyCheck: { at: at(-1), allSettled: true, settled: 2 } }),
          item('e', { backFromSnooze: true, status: 'done' }),
        ],
      }),
    );
    expect(v.entries.map((e) => [e.kind, e.itemId])).toEqual([
      ['reply_unsettled', 'c'],
      ['looks_finished', 'b'],
      ['snooze_back', 'a'],
    ]);
    expect(v.entries[1]?.detail).toBe('Dana confirmed it.');
  });

  it('shows a finished eval for a day, and changed guidance sources', () => {
    const lastEval = { id: 'ev1', at: at(-60), labelCount: 42 };
    const guidance = [{ id: 'vault-conventions' as const, label: 'Vault conventions', changed: ['obsidian skill'], since: at(-30) }];
    const v = buildAttention(input({ lastEval, guidance }));
    expect(v.entries.map((e) => [e.kind, e.to])).toEqual([
      ['guidance_changed', '/settings/prompts#vault-conventions'],
      ['eval_done', '/usage/eval/ev1'],
    ]);
    expect(buildAttention(input({ lastEval: { ...lastEval, at: at(-25 * 60) } })).entries).toEqual([]);
  });
});

describe('buildAttention: a finished filing eval (FR-15.8)', () => {
  const score = (precision: number, n: number) => ({ precision, recall: 1, support: n, predicted: n, n });
  const scores = { toFile: score(0.9, 40), predraft: score(0.7, 35), ready: score(1, 12), todo: score(0, 0) };

  it('shows for a day, linked to Settings › Learning, with the fields that meet their target', () => {
    const lastFilingEval = { id: 'filing-eval-1', at: at(-60), labelCount: 41, scores };
    const [e] = buildAttention(input({ lastFilingEval })).entries;
    expect(e).toMatchObject({ key: 'eval_done:filing-eval-1', kind: 'eval_done', title: 'Filing eval finished', subject: '41 labelled items', to: '/settings/learning', detail: 'Meets its target: To file. Below: Pre-draft.' });
    expect(buildAttention(input({ lastFilingEval: { ...lastFilingEval, at: at(-25 * 60) } })).entries).toEqual([]);
    expect(buildAttention(input({ lastFilingEval, dismissed: { 'eval_done:filing-eval-1': at(-1) } })).entries).toEqual([]);
  });

  it('says when no field has enough labels to count', () => {
    const few = { toFile: score(1, 10), predraft: score(1, 10), ready: score(1, 10), todo: score(1, 10) };
    expect(buildAttention(input({ lastFilingEval: { id: 'f', at: at(-1), labelCount: 10, scores: few } })).entries[0]?.detail).toBe('No field has 30 labels yet.');
  });
});

describe('buildAttention: dismissing (FR-11.5)', () => {
  it('hides a dismissed entry; a new occurrence shows again', () => {
    const items = [item('a', { backFromSnooze: true, backAt: at(-3) })];
    expect(buildAttention(input({ items, dismissed: { [`snooze_back:a:${at(-3)}`]: at(-1) } })).entries).toEqual([]);
    const again = [item('a', { backFromSnooze: true, backAt: at(-0.5) })];
    expect(buildAttention(input({ items: again, dismissed: { [`snooze_back:a:${at(-3)}`]: at(-1) } })).entries).toHaveLength(1);
  });

  it('never hides what can’t be dismissed', () => {
    const v = buildAttention(input({ items: [item('a')], actions: [action('x', 'a')], dismissed: { 'draft_ready:x': at(-1) } }));
    expect(v.entries).toHaveLength(1);
  });

  it('counts the entries since the bell was last opened', () => {
    const entries = [{ at: at(-1) }, { at: at(-10) }];
    expect(unseenCount(entries)).toBe(2);
    expect(unseenCount(entries, at(-5))).toBe(1);
  });
});
