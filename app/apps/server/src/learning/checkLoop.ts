import type { LoopScore, Settings } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import type { Logger } from '../log';
import { predictSettle, type RenderChecks, type SettlePredicted } from '../pipeline/evalSettle';
import { renderFinishChecks, type FinishCheck } from '../pipeline/finish';
import type { SettleLabelRecord } from '../store/settleLabels';
import type { LoopAdapter } from './tuner';

// The settle and finish loops' adapter for the tuner (FR-15.11, backlog FT-12): the settle prompt
// over labels/settle.jsonl, and the finish prompt over labels/finish.jsonl. Each labelled check the
// prompt now gets wrong becomes a miss: a close Frank undid, or one he had to make himself.

/** Cockpit C2: at most 2% of closes undone, so a close must be right 98% of the time. */
const CLOSE_TARGET = 0.98;

const ROWS = {
  settle: { closes: 'Closes on your reply', stays: 'Stays open' },
  finish: { closes: 'Looks finished', stays: 'Not finished' },
} as const;

const HOW: Record<SettleLabelRecord['origin'], string> = {
  undo: 'Frank undid the close',
  manual_done: 'Frank pressed Done soon after the check said it was not settled',
  manual_done_unchecked: 'Frank pressed Done after replying; no check had run',
  finish_accepted: 'Frank pressed Done on Looks finished',
  finish_rejected: 'Frank answered Not finished',
};

/** Precision and recall of closing, and of staying open, as the tuner's rows. */
export function checkRows(kind: 'settle' | 'finish', rows: readonly SettlePredicted[]): LoopScore[] {
  const one = (closes: boolean, key: 'closes' | 'stays'): LoopScore => {
    const tp = rows.filter((r) => r.label.settled === closes && r.closes === closes).length;
    const predicted = rows.filter((r) => r.closes === closes).length;
    const support = rows.filter((r) => r.label.settled === closes).length;
    return { key, label: ROWS[kind][key], precision: predicted ? tp / predicted : 0, recall: support ? tp / support : 0, n: support, ...(closes && { target: CLOSE_TARGET }) };
  };
  return [one(true, 'closes'), one(false, 'stays')];
}

/** What the check got wrong on one labelled item, or nothing. */
export function checkMiss(row: SettlePredicted): object | undefined {
  if (row.closes === row.label.settled) return undefined;
  const said = (v: boolean) => (v ? 'settled, so it closes' : 'not settled, so it stays open');
  return { check: row.label.check, wrong: [`label: ${said(row.label.settled)} (${HOW[row.label.origin]}); the prompt said ${said(row.closes)}`] };
}

/** Every string in a check: the thread, the asks and the reply, for the copy check. */
export function strings(v: unknown, out: string[] = []): string[] {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) strings(x, out);
  return out;
}

export function checkLoop(kind: 'settle' | 'finish', d: { claude: ClaudeAdapter; settings: () => Settings; now: () => Date; logger?: Logger }): LoopAdapter<SettleLabelRecord> {
  return {
    loop: kind,
    promptId: kind,
    itemId: (l) => l.itemId,
    texts: (l) => strings(l.check),
    evaluate: async (policy, labels, signal) => {
      const render: RenderChecks | undefined = kind === 'finish' ? (checks, now) => renderFinishChecks(checks as unknown as FinishCheck[], now) : undefined;
      const { rows, failed, tokens, cost } = await predictSettle({ claude: d.claude, settings: d.settings(), prompt: policy, now: d.now, signal, logger: d.logger }, labels, render);
      return { scores: checkRows(kind, rows), misses: rows.map(checkMiss).filter((m) => !!m), failed, tokens, cost };
    },
  };
}
