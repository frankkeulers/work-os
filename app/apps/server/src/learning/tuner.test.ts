import type { FilingScores, PolicyChange } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import type { ClaudeAdapter, RunSpec } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import { copiedRun, guard, heldOut, propose, ruleIds, type LoopAdapter } from './tuner';

// The tuner (FR-15.9): the split, code's checks on a proposal, and a run end to end with a fake
// adapter and a fake Claude. No live calls.

const NOW = new Date('2026-10-12T09:00:00.000Z');
const POLICY = `<!-- prompt: filing-policy v1 -->
# Filing policy

## To file
- [F1] Confluence: decisions and requirements.
- [F2] Vault: ideas worth keeping.

## Ready to approve
- [R1] A meeting's vault note.

## To-dos
- [T1] A meeting action item that falls to Frank.`;
const THREAD = 'We agreed the bulk export ships without the PDF option in version one of the release';

const score = (p: number, r = 1, n = 10) => ({ precision: p, recall: r, support: n, predicted: n, n });
const scores = (p: number): FilingScores => ({ toFile: score(p), predraft: score(p), ready: score(p), todo: score(p) });

describe('heldOut', () => {
  it('puts the same item on the same side every time, about three in ten held out', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => `slack:C1:${i}.0`);
    expect(ids.map(heldOut)).toEqual(ids.map(heldOut));
    const n = ids.filter(heldOut).length;
    expect(n).toBeGreaterThan(250);
    expect(n).toBeLessThan(350);
  });
});

describe('the checks on a proposal', () => {
  it('finds eight words in a row from a thread, but not seven, nor a run the policy already had', () => {
    expect(copiedRun(`New rule: ${THREAD}.`, [THREAD], POLICY)).toBe('we agreed the bulk export ships without the');
    expect(copiedRun('New rule: the bulk export ships without the PDF.', [THREAD], POLICY)).toBeUndefined(); // seven
    expect(copiedRun(`${POLICY}\nwe agreed the bulk export ships without the`, [THREAD], `${POLICY}\nWe agreed the bulk export ships without the`)).toBeUndefined();
  });

  it('reads rule IDs', () => {
    expect([...ruleIds(POLICY)]).toEqual(['F1', 'F2', 'R1', 'T1']);
  });

  it('turns down a proposal that is too long, drops a rule unannounced, or copies a thread', () => {
    const removed: PolicyChange[] = [{ rule: 'F2', kind: 'removed', what: 'Ideas are rarely filed.' }];
    const withoutF2 = POLICY.replace('- [F2] Vault: ideas worth keeping.\n', '');
    expect(guard(POLICY, POLICY + POLICY + 'x', [], [THREAD])).toMatch(/over twice the length/);
    expect(guard(POLICY, withoutF2, [], [THREAD])).toBe('It drops F2 without listing the removal.');
    expect(guard(POLICY, withoutF2, removed, [THREAD])).toBeUndefined();
    expect(guard(POLICY, `${POLICY}\n- [T2] ${THREAD}`, [], [THREAD])).toMatch(/copies eight or more words/);
    // The change list is checked too.
    expect(guard(POLICY, POLICY, [{ kind: 'changed', what: THREAD }], [THREAD])).toMatch(/copies/);
    expect(guard(POLICY, `${POLICY}\n- [T2] A promise with a date.`, [], [THREAD])).toBeUndefined();
  });
});

describe('propose', () => {
  type L = { itemId: string; text: string };
  const labels: L[] = Array.from({ length: 20 }, (_, i) => ({ itemId: `slack:C1:${i}.0`, text: THREAD }));
  const evaluated: { version: string; n: number }[] = [];
  const adapter = (misses = 2, better = true): LoopAdapter<L> => ({
    loop: 'filing',
    promptId: 'filing-policy',
    itemId: (l) => l.itemId,
    texts: (l) => [l.text],
    evaluate: async (policy, ls) => {
      evaluated.push({ version: policy.version, n: ls.length });
      const proposed = policy.text !== POLICY;
      return { scores: scores(proposed === better ? 0.9 : 0.7), misses: Array.from({ length: misses }, (_, i) => ({ miss: i })), tokens: 0, cost: 0 };
    },
    summary: (s) => s.toFile.precision,
    describe: () => 'To file: 70%',
  });
  const calls: RunSpec[] = [];
  let answer: unknown = { policy: `${POLICY}\n- [T2] Frank promised something with a date.`, changes: [{ rule: 'T2', kind: 'added', what: 'Dated promises.' }] };
  const claude = {
    structured: async (spec: RunSpec) => {
      calls.push(spec);
      if (answer instanceof Error) throw answer;
      return { value: answer, attempts: 1, usage: [] };
    },
  } as unknown as ClaudeAdapter;
  const deps = { claude, now: () => NOW, policy: async (): Promise<Prompt> => ({ text: POLICY, version: 'filing-policy v1#aaaaaaaa' }), prompt: async (): Promise<Prompt> => ({ text: 'tune', version: 'tune-policy v1#bbbbbbbb' }) };

  it('learns from the misses on most items and scores both policies on the rest', async () => {
    evaluated.length = 0;
    const p = await propose(deps, adapter(), labels);
    const held = labels.filter((l) => heldOut(l.itemId)).length;
    expect(p).toMatchObject({ status: 'open', loop: 'filing', promptId: 'filing-policy', baseVersion: 'filing-policy v1#aaaaaaaa', train: 20 - held, heldOut: held, better: true, model: 'opus-5.5', promptVersion: 'tune-policy v1#bbbbbbbb' });
    expect(p.diff?.filter((d) => d.op !== 'same')).toEqual([{ op: 'add', text: '- [T2] Frank promised something with a date.' }]);
    expect(p.scores?.after.toFile.precision).toBe(0.9);
    // Train with the current policy; then held out, current and proposed.
    expect(evaluated.map((e) => e.n)).toEqual([20 - held, held, held]);
    expect(evaluated[1].version).toBe('filing-policy v1#aaaaaaaa');
    expect(evaluated[2].version).not.toBe('filing-policy v1#aaaaaaaa'); // the proposed text
    const call = calls.at(-1)!;
    expect(call).toMatchObject({ purpose: 'tune', model: 'opus-5.5', system: 'tune', promptVersion: 'tune-policy v1#bbbbbbbb' });
    expect(call.prompt).toMatch(/^<policy>\n<!-- prompt: filing-policy v1 -->[\s\S]*<\/policy>\n\n<scores>\nTo file: 70%\n<\/scores>\n\n<misses count="2">/);
  });

  it('marks one that scores no better', async () => {
    expect((await propose(deps, adapter(2, false), labels)).better).toBe(false);
  });

  it('keeps no text from a proposal it turns down', async () => {
    answer = { policy: `${POLICY}\n- [T2] ${THREAD}`, changes: [] };
    const p = await propose(deps, adapter(), labels);
    expect(p).toMatchObject({ status: 'rejected', rejected: expect.stringMatching(/copies/), changes: [] });
    expect(p.text).toBeUndefined();
    expect(p.diff).toBeUndefined();
    answer = new ClaudeOutputError(2, 'bad');
    expect(await propose(deps, adapter(), labels)).toMatchObject({ status: 'rejected', rejected: 'The model’s answer couldn’t be used.' });
  });

  it('asks nothing when the policy gets every label right, and refuses with nothing held out', async () => {
    const before = calls.length;
    expect(await propose(deps, adapter(0), labels)).toMatchObject({ status: 'rejected', rejected: expect.stringMatching(/nothing to change/) });
    expect(calls).toHaveLength(before);
    await expect(propose(deps, adapter(), labels.filter((l) => !heldOut(l.itemId)))).rejects.toThrow(/Too few/);
  });
});
