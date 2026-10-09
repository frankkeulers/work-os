import { describe, expect, it } from 'vitest';
import type { ClaudeAdapter, RunSpec } from '../claude/adapter';
import { settleFor } from '../claude/fakeClaude';
import { defaultSettings } from '../config/defaults';
import type { SettleLabelRecord } from '../store/settleLabels';
import { runSettleEval } from './evalSettle';
import type { SettleCheck } from './settle';

const NOW = new Date('2026-10-09T12:48:00.000Z');

const label = (itemId: string, reply: string, settled: boolean, origin: SettleLabelRecord['origin'] = settled ? 'manual_done' : 'undo'): SettleLabelRecord => {
  const check: SettleCheck = {
    itemId,
    itemRevision: 2,
    thread: { id: itemId, kind: 'thread', title: '#mvi-launch', messages: [{ author: 'Matt', at: NOW.toISOString(), text: 'Go/no-go?' }, { author: 'me', at: NOW.toISOString(), text: reply }], omitted: 0 },
    asks: [{ index: 0, need: 'decide', step: 'Give the go/no-go' }],
    reply: [{ at: NOW.toISOString(), text: reply }],
  };
  return { at: NOW.toISOString(), origin, itemId, itemRevision: 2, source: 'slack', settled, check: { ...check }, was: { itemId, itemRevision: 2, asks: [{ index: 0, settled: !settled, why: 'w' }], allSettled: !settled }, model: 'haiku-5.5', promptVersion: 'settle v1#abc' };
};

describe('runSettleEval (cockpit CK-2.6)', () => {
  it('re-runs each labelled check and counts false and missed closes', async () => {
    const calls: RunSpec[] = [];
    const claude = {
      structured: async (spec: RunSpec) => {
        calls.push(spec);
        const checks = JSON.parse(/<checks>\n([\s\S]*)\n<\/checks>/.exec(spec.prompt)![1]) as SettleCheck[];
        return { value: settleFor(checks), attempts: 1, usage: [{ inputTokens: 1000, outputTokens: 100, cacheTokens: 0, costEquivalent: 0.001 }] };
      },
    } as unknown as ClaudeAdapter;
    const records = [
      label('slack:C1:1', 'Ship it', false), // the fake closes it: still a false close
      label('slack:C1:2', 'Will look later', false), // now right
      label('slack:C1:3', 'Will check tomorrow', true), // the fake still holds it: a missed close
      label('slack:C1:4', 'Done, sent', true, 'manual_done_unchecked'), // now right, though no check ran at the time
      label('slack:C1:2', 'Will look later', false), // the same item again: its latest label counts once
    ];
    const r = await runSettleEval({ claude, settings: defaultSettings('/tmp/x'), prompt: { text: 'settle', version: 'settle v1#abc' }, now: () => NOW }, records);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: 'eval', system: 'settle' });
    expect(r).toMatchObject({ labelCount: 4, failed: 0, correct: 2, falseCloses: 1, missedCloses: 1, bySource: { slack: { labelCount: 4, correct: 2 } }, byOrigin: { undo: { labelCount: 2, correct: 1 }, manual_done: { labelCount: 1, correct: 0 }, manual_done_unchecked: { labelCount: 1, correct: 1 } }, tokens: 1100, costEquivalent: 0.001 });
  });
});
