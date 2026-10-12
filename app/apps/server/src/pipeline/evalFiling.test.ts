import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ClaudeAdapter, RunSpec } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import { defaultSettings } from '../config/defaults';
import { mergeFilingLabels, type FilingLabelRecord } from '../store/filingLabels';
import { listFilingReports, runFilingEval, saveFilingReport, scoreFiling, type FilingScored } from './evalFiling';
import type { TriageAnswer } from './triage';
import type { TriageThread } from './truncate';

// The filing eval (FR-15.8): the policy's flags, after code's clamps, against the filing labels.
// Synthetic threads and a fake Claude only.

const NOW = new Date('2026-10-12T09:00:00.000Z');
type Answer = TriageAnswer['decisions'][number];

const thread = (id: string) => ({ id, kind: 'thread' as const, title: '#synthetic', messages: [{ author: 'Sam', at: NOW.toISOString(), text: 'synthetic' }], omitted: 0 });
const line = (itemId: string, over: Partial<FilingLabelRecord>): FilingLabelRecord => ({ at: NOW.toISOString(), origin: 'explicit', signal: 'corrected', itemId, itemRevision: 1, source: 'slack', label: {}, thread: thread(itemId), ...over });
const answer = (id: string, over: Partial<Answer> = {}): Answer => ({
  id,
  attention: 'none',
  confluence: { suggested: false },
  vault: { suggested: false },
  containsPeopleObservations: false,
  summary: 'Synthetic',
  reason: 'Synthetic',
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-filing-eval-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('scoreFiling', () => {
  const merged = mergeFilingLabels([
    line('a', { label: { vault: { toFile: true, predraft: true, ready: true } } }),
    line('b', { origin: 'implicit', signal: 'discarded', label: { vault: { predraft: false, ready: false } } }),
    line('c', { label: { confluence: { toFile: false, predraft: false, ready: false }, todo: true } }),
  ]);
  const off = { toFile: false, predraft: false, ready: false };
  const rows: FilingScored[] = [
    { label: merged[0], predicted: { confluence: off, vault: { toFile: true, predraft: true, ready: false }, todo: false } },
    { label: merged[1], predicted: { confluence: off, vault: { toFile: true, predraft: true, ready: false }, todo: false } },
    { label: merged[2], predicted: { confluence: { toFile: true, predraft: false, ready: false }, vault: off, todo: true } },
  ];

  it('scores each field over the values labelled, pooling Confluence and vault', () => {
    const s = scoreFiling(rows);
    expect(s.toFile).toEqual({ precision: 0.5, recall: 1, support: 1, predicted: 2, n: 2 });
    expect(s.predraft).toEqual({ precision: 0.5, recall: 1, support: 1, predicted: 2, n: 3 });
    expect(s.ready).toEqual({ precision: 0, recall: 0, support: 1, predicted: 0, n: 3 });
    expect(s.todo).toEqual({ precision: 1, recall: 1, support: 1, predicted: 1, n: 1 });
  });

  it('splits by origin', () => {
    expect(scoreFiling(rows, (v) => v.origin === 'implicit').predraft).toEqual({ precision: 0, recall: 0, support: 0, predicted: 1, n: 1 });
    expect(scoreFiling(rows, (v) => v.origin === 'implicit').toFile.n).toBe(0);
  });
});

describe('runFilingEval', () => {
  const calls: RunSpec[] = [];
  let reply: (t: TriageThread) => Answer | undefined;
  const claude = {
    structured: async (spec: RunSpec) => {
      calls.push(spec);
      const threads = JSON.parse(/<threads>\n([\s\S]*)\n<\/threads>/.exec(spec.prompt)![1]) as TriageThread[];
      if (threads.some((t) => t.id === 'broken')) throw new ClaudeOutputError(2, 'out of shape');
      return { value: { decisions: threads.map(reply).filter(Boolean) }, attempts: 1, usage: [{ inputTokens: 100, outputTokens: 20, cacheTokens: 0, costEquivalent: 0.001 }] };
    },
  } as unknown as ClaudeAdapter;
  const deps = () => ({ claude, settings: defaultSettings(dir), prompt: { text: 'triage + policy', version: 'triage v10#00000000', policyVersion: 'filing-policy v1#11111111' }, now: () => NOW });

  it('scores the policy’s clamped flags, counts what got no answer, and saves the report', async () => {
    reply = (t) =>
      t.id === 'silent'
        ? undefined
        : answer(t.id, {
            attention: 'today',
            // `ready` without `predraft` is clamped to both, as triage does.
            vault: t.id === 'a' ? { suggested: true, ready: true, rule: 'R1' } : { suggested: false },
            todo: { step: 'Send it', rule: 'T1' },
          });
    const labels = mergeFilingLabels([
      line('a', { label: { vault: { ready: true } } }),
      line('b', { origin: 'implicit', signal: 'todo_dismissed', label: { todo: false } }),
      line('silent', { label: { vault: { toFile: true } } }),
    ]);
    const r = await runFilingEval(deps(), labels);
    expect(calls.at(-1)).toMatchObject({ purpose: 'eval', system: 'triage + policy', promptVersion: 'triage v10#00000000' });
    expect(r).toMatchObject({ labelCount: 3, failed: 1, policyVersion: 'filing-policy v1#11111111', tokens: 120, costEquivalent: 0.001 });
    expect(r.scores.ready).toMatchObject({ precision: 1, recall: 1, n: 1 });
    expect(r.scores.toFile).toMatchObject({ precision: 1, n: 1 });
    expect(r.scores.todo).toMatchObject({ precision: 0, predicted: 1, n: 1 });
    expect(r.byOrigin.implicit.todo.n).toBe(1);
    expect(r.byOrigin.explicit.todo.n).toBe(0);
    expect(r.bySource).toBeUndefined();

    await saveFilingReport(dir, r);
    expect((await listFilingReports(dir)).map((x) => x.id)).toEqual([r.id]);
  });

  it('counts a batch out of shape as failed, and refuses no labels', async () => {
    reply = (t) => answer(t.id);
    const r = await runFilingEval(deps(), mergeFilingLabels([line('broken', { label: { vault: { toFile: false } } })]));
    expect(r.failed).toBe(1);
    expect(r.scores.toFile.n).toBe(0);
    await expect(runFilingEval(deps(), [])).rejects.toThrow(/No filing labels/);
  });
});
