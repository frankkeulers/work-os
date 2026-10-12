import { z } from 'zod';
import { FilingScores, PromptFileId, type FilingEvalReport } from './schemas';

// The learning loop's proposals (E14, FR-15.9, FR-15.10): a model reads where the filing policy
// got Frank's labels wrong and proposes a revised policy; code checks it and scores both on labels
// it never saw. Nothing is applied without Frank.

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

export const PolicyProposal = z.object({
  id: z.string().min(1),
  at: z.iso.datetime(),
  loop: z.literal('filing'),
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
  /** The current and proposed policies on the held-out labels. */
  scores: z.object({ before: FilingScores, after: FilingScores }).optional(),
  better: z.boolean().optional(),
  model: z.string(),
  promptVersion: z.string(),
  /** Applied or dismissed. */
  decidedAt: z.iso.datetime().optional(),
  appliedVersion: z.string().optional(),
});
export type PolicyProposal = z.infer<typeof PolicyProposal>;

/** Settings › Learning (FR-15.10): one loop's labels, last eval and proposal. */
export interface LearningLoopView {
  labels: { items: number; explicit: number; implicit: number };
  /** Label lines since the last proposal run, or all of them before the first. */
  newLabels: number;
  lastEval?: FilingEvalReport;
  evalRunning: boolean;
  proposing: boolean;
  /** The latest proposal, whatever became of it. */
  proposal?: PolicyProposal;
}

export interface LearningView {
  filing: LearningLoopView;
}

/**
 * One number to compare two policies by: the mean F1 over the fields with labels. Precision alone
 * would reward a policy that files nothing.
 */
export function policyScore(s: z.infer<typeof FilingScores>): number {
  const dims = Object.values(s).filter((d) => d.n > 0);
  if (!dims.length) return 0;
  const f1 = (p: number, r: number) => (p + r ? (2 * p * r) / (p + r) : 0);
  return dims.reduce((sum, d) => sum + f1(d.precision, d.recall), 0) / dims.length;
}

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
