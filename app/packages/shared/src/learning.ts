import { z } from 'zod';
import { FILING_TARGETS, PromptFileId, type EvalReport, type FilingEvalReport, type FilingScores } from './schemas';

// The learning loops' proposals (E14, FR-15.9–15.11): a model reads where a prompt got Frank's
// labels wrong and proposes a revision; code checks it and scores both on labels it never saw.
// Nothing is applied without Frank.

/** Fewest labelled items a proposal run needs: some to learn from, some held out. */
export const PROPOSAL_MIN_LABELS = 10;
/** Settings › Learning suggests a run once this many label lines have arrived since the last. */
export const PROPOSAL_NUDGE_LABELS = 10;

export const PolicyChange = z.object({
  /** The rule it touches, such as "R1". */
  rule: z.string().max(10).optional(),
  kind: z.enum(['added', 'changed', 'removed']),
  what: z.string().min(1).max(400),
});
export type PolicyChange = z.infer<typeof PolicyChange>;

export const DiffLine = z.object({ op: z.enum(['same', 'add', 'del']), text: z.string() });
export type DiffLine = z.infer<typeof DiffLine>;

/**
 * The loops a proposal can revise (FR-15.9, FR-15.11), each with the prompt file it revises: the
 * filing policy over the filing labels, the triage prompt's attention over the triage labels, and
 * the settle and finish checks over theirs.
 */
export const LearningLoop = z.enum(['filing', 'triage', 'settle', 'finish']);
export type LearningLoop = z.infer<typeof LearningLoop>;
export const LEARNING_LOOPS = LearningLoop.options;
export const LOOP_PROMPT: Record<LearningLoop, PromptFileId> = { filing: 'filing-policy', triage: 'triage', settle: 'settle', finish: 'finish' };
/** As the bell and toasts name the file: "A filing policy change is proposed". */
export const LOOP_NOUN: Record<LearningLoop, string> = { filing: 'filing policy', triage: 'triage prompt', settle: 'settle check', finish: 'Looks finished check' };
/** As Settings › Prompts names the file. */
export const LOOP_FILE_LABEL: Record<LearningLoop, string> = { filing: 'Filing policy', triage: 'Triage', settle: 'Settle check', finish: 'Looks finished' };

/**
 * One row of a loop's scores: how often the prompt was right when it said this (precision), how
 * many of the labelled cases it found (recall), over `n` labelled cases. A filing field, a triage
 * attention, or a check's close or stay-open.
 */
export const LoopScore = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  precision: z.number().min(0).max(1),
  recall: z.number().min(0).max(1),
  n: z.number().int().nonnegative(),
  /** The precision it must reach, where the spec sets one. */
  target: z.number().min(0).max(1).optional(),
  /** The recall it must reach, where the spec sets one (S2: nothing urgent missed). */
  recallTarget: z.number().min(0).max(1).optional(),
});
export type LoopScore = z.infer<typeof LoopScore>;

export const PolicyProposal = z.object({
  id: z.string().min(1),
  at: z.iso.datetime(),
  loop: LearningLoop,
  promptId: PromptFileId,
  /** The policy's version it was made from: applying refuses once the file has moved on. */
  baseVersion: z.string().min(1),
  status: z.enum(['open', 'applied', 'dismissed', 'rejected']),
  /** Why code turned it down. A rejected proposal keeps no text: it may hold a thread's words. */
  rejected: z.string().optional(),
  text: z.string().optional(),
  changes: z.array(PolicyChange),
  diff: z.array(DiffLine).optional(),
  /** Labelled items it learned from and was scored on. */
  train: z.number().int().nonnegative(),
  heldOut: z.number().int().nonnegative(),
  /** The current and proposed policies on the held-out labels, row for row. */
  scores: z.object({ before: z.array(LoopScore), after: z.array(LoopScore) }).optional(),
  better: z.boolean().optional(),
  model: z.string(),
  promptVersion: z.string(),
  /** Applied or dismissed. */
  decidedAt: z.iso.datetime().optional(),
  appliedVersion: z.string().optional(),
});
export type PolicyProposal = z.infer<typeof PolicyProposal>;

/** Settings › Learning (FR-15.10, FR-15.11): one loop's labels and proposal. */
export interface LearningLoopView {
  labels: { items: number; explicit: number; implicit: number };
  /** Label lines since the last proposal run, or all of them before the first. */
  newLabels: number;
  proposing: boolean;
  /** The latest proposal, whatever became of it. */
  proposal?: PolicyProposal;
}

/** The filing loop also runs its eval from here (FR-15.8). */
export interface FilingLoopView extends LearningLoopView {
  lastEval?: FilingEvalReport;
  evalRunning: boolean;
}

export interface LearningView {
  filing: FilingLoopView;
  /** The triage eval's latest report, which Usage shows in full (FR-6.1). */
  triage?: LearningLoopView & { lastEval?: Pick<EvalReport, 'id' | 'at' | 'labelCount'> };
  settle?: LearningLoopView;
  finish?: LearningLoopView;
}

const FILING_ROW: Record<keyof FilingScores, string> = { toFile: 'To file', predraft: 'Pre-draft', ready: 'Ready to approve', todo: 'To-do suggestions' };

/** The filing eval's scores as rows, each with its target. */
export function filingRows(s: FilingScores): LoopScore[] {
  return (Object.keys(FILING_ROW) as (keyof FilingScores)[]).map((k) => ({ key: k, label: FILING_ROW[k], precision: s[k].precision, recall: s[k].recall, n: s[k].n, target: FILING_TARGETS[k] }));
}

/**
 * One number to compare two prompts by: the mean F1 over the rows with labels. Precision alone
 * would reward a policy that files nothing, or a check that never closes.
 */
export function loopScore(rows: readonly LoopScore[]): number {
  const dims = rows.filter((d) => d.n > 0);
  if (!dims.length) return 0;
  const f1 = (p: number, r: number) => (p + r ? (2 * p * r) / (p + r) : 0);
  return dims.reduce((sum, d) => sum + f1(d.precision, d.recall), 0) / dims.length;
}

/** The same for the filing eval's scores. */
export const policyScore = (s: FilingScores) => loopScore(filingRows(s));

/** A line diff (longest common subsequence), for showing a proposal against the current text. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: 'del', text: a[i++] });
    else out.push({ op: 'add', text: b[j++] });
  }
  while (i < a.length) out.push({ op: 'del', text: a[i++] });
  while (j < b.length) out.push({ op: 'add', text: b[j++] });
  return out;
}
