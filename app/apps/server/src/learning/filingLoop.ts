import { filingRows, type Settings } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { triageSystem, type Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { predictFiling, scoreFiling, type FilingScored } from '../pipeline/evalFiling';
import type { FilingField, LabelValue, MergedFilingLabel } from '../store/filingLabels';
import type { LoopAdapter } from './tuner';

// The filing loop's adapter for the tuner (FR-15.9): the filing eval scores a policy text, and each
// labelled item it got wrong becomes a miss: the thread, what the label says and what the policy did.

const FIELD = { toFile: 'to file', predraft: 'draft ahead', ready: 'ready to approve' } as const;

const said = (v: LabelValue) => `${v.value ? 'yes' : 'no'} (${v.origin === 'explicit' ? 'Frank said so' : `read from: ${v.signal.replace('_', ' ')}`})`;

/** What the policy got wrong on one item, or nothing. */
export function filingMiss(row: FilingScored): object | undefined {
  const wrong: string[] = [];
  for (const t of ['confluence', 'vault'] as const) {
    const p = row.predicted[t];
    for (const f of Object.keys(FIELD) as FilingField[]) {
      const v = row.label[t][f];
      if (v && v.value !== p[f]) wrong.push(`${t} ${FIELD[f]}: label ${said(v)}; the policy said ${p[f] ? 'yes' : 'no'}${p.rule ? ` (rule ${p.rule})` : ''}`);
    }
  }
  const todo = row.label.todo;
  if (todo && todo.value !== row.predicted.todo) wrong.push(`to-do suggestion: label ${said(todo)}; the policy said ${row.predicted.todo ? 'yes' : 'no'}`);
  return wrong.length ? { thread: row.label.thread, wrong } : undefined;
}

export function filingLoop(d: { claude: ClaudeAdapter; settings: () => Settings; base: () => Promise<Prompt>; now: () => Date; logger?: Logger }): LoopAdapter<MergedFilingLabel> {
  return {
    loop: 'filing',
    promptId: 'filing-policy',
    itemId: (l) => l.itemId,
    texts: (l) => l.thread.messages.map((m) => m.text),
    evaluate: async (policy, labels, signal) => {
      const { rows, failed, tokens, cost } = await predictFiling({ claude: d.claude, settings: d.settings(), prompt: triageSystem(await d.base(), policy), now: d.now, signal, logger: d.logger }, labels);
      return { scores: filingRows(scoreFiling(rows)), misses: rows.map(filingMiss).filter((m) => !!m), failed, tokens, cost };
    },
  };
}
