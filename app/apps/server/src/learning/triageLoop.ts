import { ATTENTION_ORDER, type Attention, type LoopScore, type Settings } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { triageSystem, type Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { predictTriage, score, type Predicted } from '../pipeline/eval';
import type { LabelRecord } from '../store/labels';
import type { LoopAdapter } from './tuner';

// The triage loop's adapter for the tuner (FR-15.11, backlog FT-11): the triage prompt's attention
// over labels/triage.jsonl. The filing policy is sent with it as it is now and isn't revised here;
// its own loop does that. Each label whose attention the prompt got wrong becomes a miss.

const NAME: Record<Attention, string> = { now: 'Now', today: 'Today', follow: 'Follow', none: 'None' };
/** PLAN S1: Now and Today precision ≥ 80%. S2: Now recall ≥ 90%. */
const TARGET: Partial<Record<Attention, { target?: number; recallTarget?: number }>> = { now: { target: 0.8, recallTarget: 0.9 }, today: { target: 0.8 } };

/** Attention precision and recall as the tuner's rows. */
export function triageRows(rows: readonly Predicted[]): LoopScore[] {
  const c = score([...rows]).categories;
  return ATTENTION_ORDER.map((a) => ({ key: a, label: NAME[a], precision: c[a].precision, recall: c[a].recall, n: c[a].support, ...TARGET[a] }));
}

const how = (r: LabelRecord) => (r.origin === 'correction' ? 'Frank corrected it' : r.origin === 'confirmed' ? 'Frank said triage was right' : 'from the labelled set');

/** What the prompt got wrong on one item's attention, or nothing. */
export function triageMiss(row: Predicted): object | undefined {
  if (row.label.attention === row.predicted.attention) return undefined;
  return { thread: row.record.thread, wrong: [`attention: label ${row.label.attention} (${how(row.record)}); the prompt said ${row.predicted.attention}`] };
}

export function triageLoop(d: { claude: ClaudeAdapter; settings: () => Settings; filingPolicy: () => Promise<Prompt>; now: () => Date; logger?: Logger }): LoopAdapter<LabelRecord> {
  return {
    loop: 'triage',
    promptId: 'triage',
    itemId: (l) => l.itemId,
    texts: (l) => l.thread.messages.map((m) => m.text),
    evaluate: async (policy, labels, signal) => {
      const { rows, failed, tokens, cost } = await predictTriage({ claude: d.claude, settings: d.settings(), prompt: triageSystem(policy, await d.filingPolicy()), now: d.now, signal, logger: d.logger }, labels);
      return { scores: triageRows(rows), misses: rows.map(triageMiss).filter((m) => !!m), failed, tokens, cost };
    },
  };
}
