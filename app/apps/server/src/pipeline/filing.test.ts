import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Item, Rule } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeAdapter, RunSpec } from '../claude/adapter';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { initDataDir, paths } from '../config/dataDir';
import { readLog } from '../store/recover';
import { ItemFiles } from '../store/items';
import { Store } from '../store/store';
import { clampFiling, clampTodo, runTriage, type TriageAnswer } from './triage';
import type { TriageThread } from './truncate';

// The filing policy's fields on a decision (E14, FR-15.2): what the model said, clamped by code,
// the flags in the log and the to-do's wording with the item's text.

const NOW = new Date('2026-10-12T09:00:00.000Z');
const ID = 'slack:C1:1791270000.000100';

const thread = (over: Partial<Item> = {}): Item => ({
  id: ID,
  source: 'slack',
  kind: 'thread',
  title: '#product',
  permalink: 'https://polestar.slack.com/archives/C1/p1791270000000100',
  participants: [{ id: 'U2', name: 'Dana Lee' }],
  messages: [{ id: 'm1', authorId: 'U2', ts: new Date(NOW.getTime() - 60 * 60_000).toISOString(), text: 'We agreed bulk export ships without PDF in v1' }],
  messageCount: 1,
  lastActivityAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(),
  revision: 1,
  schemaVersion: 1,
  ...over,
});

type Answer = TriageAnswer['decisions'][number];
const base = (id: string): Answer => ({
  id,
  attention: 'none',
  confluence: { suggested: false },
  vault: { suggested: false },
  containsPeopleObservations: false,
  summary: 'Bulk export ships without PDF in v1',
  reason: 'A decision, nothing for Frank to do',
});

describe('clampFiling and clampTodo', () => {
  it('ready needs predraft, predraft needs the filing suggested; both are written once suggested', () => {
    expect(clampFiling({ suggested: true, ready: true, rule: 'R1' })).toEqual({ suggested: true, predraft: true, ready: true, rule: 'R1' });
    expect(clampFiling({ suggested: true })).toEqual({ suggested: true, predraft: false, ready: false });
    expect(clampFiling({ suggested: true }, true)).toEqual({ suggested: true, predraft: true, ready: false });
    expect(clampFiling({ suggested: false, predraft: true, ready: true, rule: 'R1' })).toEqual({ suggested: false });
    expect(clampFiling({ suggested: true, predraft: true, rule: 'my rule' })).toEqual({ suggested: true, predraft: true, ready: false });
  });

  it('keeps a to-do only beside a step or an attention level, and a due date only when it is one', () => {
    const next = { need: 'actions' as const, step: 'Confirm your action items', why: 'Assigned to you' };
    expect(clampTodo({ step: ' Send the sample ', dueAt: '2026-10-16T16:30:00.000Z', rule: 'T1' }, 'today', undefined)).toEqual({ step: 'Send the sample', dueAt: '2026-10-16T16:30:00.000Z', rule: 'T1' });
    expect(clampTodo({ step: 'Send the sample', dueAt: 'Friday' }, 'none', next)).toEqual({ step: 'Send the sample' });
    expect(clampTodo({ step: 'Send the sample' }, 'none', undefined)).toBeUndefined();
    expect(clampTodo({ step: '  ' }, 'today', undefined)).toBeUndefined();
    expect(clampTodo(undefined, 'today', next)).toBeUndefined();
  });
});

describe('triage with the filing policy (FR-15.2)', () => {
  let dir: string;
  let store: Store;
  let items: ItemFiles;
  let rules: Rule[];
  let reply: (t: TriageThread) => Answer;

  const claude = {
    structured: async (spec: RunSpec) => {
      const threads = JSON.parse(/<threads>\n([\s\S]*)\n<\/threads>/.exec(spec.prompt)![1]) as TriageThread[];
      return { value: { decisions: threads.map(reply) }, attempts: 1, usage: [{}] };
    },
  } as unknown as ClaudeAdapter;

  const add = async (it: Item) => {
    await items.write({ item: it, schemaVersion: 1 });
    await store.append({
      type: 'item.upserted',
      itemId: it.id,
      data: { source: it.source, kind: it.kind, title: it.title, permalink: it.permalink, participants: it.participants, lastActivityAt: it.lastActivityAt, revision: it.revision, messageCount: it.messageCount, fromMeOnly: false },
    });
  };
  const triage = () => {
    const settings = defaultSettings(dir);
    return runTriage(
      {
        store,
        items,
        claude,
        now: () => NOW,
        config: () => ({ settings, rules }),
        me: () => ({ id: 'UFRANK' }),
        prompt: async () => ({ text: 'triage', version: 'triage v10#00000000', policyVersion: 'filing-policy v1#11111111' }),
        budgetHit: () => false,
      },
      new AbortController().signal,
    );
  };

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'workos-filing-'));
    await initDataDir(dir, { settings: defaultSettings(dir), rules: DEFAULT_RULES });
    ({ store } = await Store.open({ dataDir: dir, now: () => NOW }));
    items = new ItemFiles(join(dir, 'items'));
    rules = [];
  });
  afterEach(async () => {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('logs the policy’s flags and version, and keeps the to-do’s wording out of the log', async () => {
    reply = (t) => ({
      ...base(t.id),
      attention: 'today',
      confluence: { suggested: true, targetHint: 'Bulk export', ready: true, rule: 'R2' },
      vault: { suggested: true, predraft: false, rule: 'F2' },
      next: { need: 'actions', step: 'Send the export spec', why: 'You said you would' },
      todo: { step: 'Send the export spec to Dana', dueAt: '2026-10-16T16:00:00.000Z', rule: 'T2' },
    });
    await add(thread());
    expect(await triage()).toMatchObject({ triaged: 1 });
    const d = store.projection.items[ID].decision!;
    expect(d).toMatchObject({
      confluence: { suggested: true, targetHint: 'Bulk export', predraft: true, ready: true, rule: 'R2' },
      vault: { suggested: true, predraft: false, ready: false, rule: 'F2' },
      todo: { dueAt: '2026-10-16T16:00:00.000Z', rule: 'T2' },
      policyVersion: 'filing-policy v1#11111111',
    });
    expect((await items.read('slack', ID))?.text?.todo).toEqual({ step: 'Send the export spec to Dana', dueAt: '2026-10-16T16:00:00.000Z', rule: 'T2' });
    const log: unknown[] = [];
    await readLog(paths(dir).events, { afterSeq: 0, repair: false, onEvent: (e) => void log.push(e) });
    expect(JSON.stringify(log)).toContain('"rule":"T2"');
    expect(JSON.stringify(log)).not.toContain('Send the export spec');
  });

  it('a To file rule that says pre-draft pre-drafts the filing it suggests', async () => {
    rules = [{ id: 'standups', enabled: true, conditions: [{ type: 'channel_in', values: ['#product'] }], outcome: { type: 'file', predraft: true } }];
    reply = (t) => ({ ...base(t.id), attention: 'today' });
    await add(thread());
    await triage();
    expect(store.projection.items[ID].decision).toMatchObject({ attention: 'none', confluence: { suggested: false }, vault: { suggested: true, predraft: true, ready: false }, ruleId: 'standups' });
  });
});
