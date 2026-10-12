import { createHash } from 'node:crypto';
import { PolicyChange, PolicyProposal, lineDiff, type FilingScores, type ModelId, type PromptFileId } from '@work-os/shared';
import { z } from 'zod';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import { promptVersion, type Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';

// The tuner (E14, FR-15.9): one loop's labels split by item, the current policy scored on the part
// it learns from, Opus asked for a revision from the misses, code's checks on the answer, and both
// policies scored on the part held out. The result is a proposal; nothing is applied here. Each
// loop plugs in with an adapter: filing first (filingLoop.ts), triage attention, settle and
// finish later (FR-15.11).

export const TUNE_MODEL: ModelId = 'opus-5.5';
/** Of every ten items, how many are held out to score on. */
const HELD_OUT_OF_TEN = 3;
/** The most misses one request shows Opus. */
export const MAX_MISSES = 40;
/** Words in a row that may not move from a labelled thread into the policy. */
export const COPY_RUN = 8;

export interface Evaluation {
  scores: FilingScores;
  /** What the policy got wrong, one entry per item, as the tuner shows them. */
  misses: unknown[];
  tokens: number;
  cost: number;
}

export interface LoopAdapter<L> {
  loop: PolicyProposal['loop'];
  /** The policy file a proposal revises. */
  promptId: PromptFileId;
  itemId(l: L): string;
  /** The labelled messages' text, for the copy check. */
  texts(l: L): string[];
  /** Scores a policy text on some labels. Throws ClaudeError when Claude can't be called. */
  evaluate(policy: Prompt, labels: L[], signal?: AbortSignal): Promise<Evaluation>;
  /** One number to compare policies by. */
  summary(s: FilingScores): number;
  /** The scores as the tuner reads them. */
  describe(s: FilingScores): string;
}

export interface TunerDeps {
  claude: ClaudeAdapter;
  now: () => Date;
  /** The policy as it is now. */
  policy: () => Promise<Prompt>;
  /** The tune-policy prompt. */
  prompt: () => Promise<Prompt>;
  signal?: AbortSignal;
  logger?: Logger;
}

/** Held out or learned from, by a hash of the item's ID: the same item always lands on the same side. */
export const heldOut = (itemId: string) => createHash('sha1').update(itemId).digest()[0] % 10 < HELD_OUT_OF_TEN;

const TuneAnswer = z.object({ policy: z.string().min(1), changes: z.array(PolicyChange).max(30) });

const words = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
const runs = (t: string, n: number) => {
  const w = words(t);
  const out = new Set<string>();
  for (let i = 0; i + n <= w.length; i++) out.add(w.slice(i, i + n).join(' '));
  return out;
};

/** A run of `n` words in `text` taken from `sources` that `current` didn't already hold. */
export function copiedRun(text: string, sources: readonly string[], current: string, n = COPY_RUN): string | undefined {
  const from = new Set<string>();
  for (const s of sources) for (const r of runs(s, n)) from.add(r);
  const had = runs(current, n);
  for (const r of runs(text, n)) if (from.has(r) && !had.has(r)) return r;
  return undefined;
}

export const ruleIds = (t: string) => new Set([...t.matchAll(/\[([A-Z]{1,3}\d{1,3})\]/g)].map((m) => m[1]));

/** Why code turns a proposal down, or nothing. */
export function guard(current: string, proposed: string, changes: readonly PolicyChange[], sources: readonly string[]): string | undefined {
  if (proposed.length > 2 * current.length) return `It is over twice the length of the current policy (${proposed.length} characters against ${current.length}).`;
  const kept = ruleIds(proposed);
  const removed = new Set(changes.filter((c) => c.kind === 'removed' && c.rule).map((c) => c.rule));
  const dropped = [...ruleIds(current)].filter((id) => !kept.has(id) && !removed.has(id));
  if (dropped.length) return `It drops ${dropped.join(', ')} without listing the removal.`;
  const copied = copiedRun([proposed, ...changes.map((c) => c.what)].join('\n'), sources, current);
  if (copied) return 'It copies eight or more words in a row from a labelled thread.';
  return undefined;
}

export function renderTune(policy: string, scores: string, misses: readonly unknown[]): string {
  return [
    '<policy>',
    policy,
    '</policy>',
    '',
    '<scores>',
    scores,
    '</scores>',
    '',
    `<misses count="${misses.length}">`,
    JSON.stringify(misses, null, 1),
    '</misses>',
    '',
    'Propose the revised policy.',
  ].join('\n');
}

/**
 * One proposal from the labels. Throws when there is nothing to learn from or hold out, and
 * ClaudeError when Claude can't be called. A proposal code turns down is returned as `rejected`,
 * without its text.
 */
export async function propose<L>(d: TunerDeps, a: LoopAdapter<L>, labels: readonly L[]): Promise<PolicyProposal> {
  const train = labels.filter((l) => !heldOut(a.itemId(l)));
  const held = labels.filter((l) => heldOut(a.itemId(l)));
  if (!train.length || !held.length) throw new Error('Too few labelled items to learn from and to hold out.');
  const [current, tune] = await Promise.all([d.policy(), d.prompt()]);
  const at = d.now().toISOString();
  const base = { id: `proposal-${at.replace(/[:.]/g, '-')}`, at, loop: a.loop, promptId: a.promptId, baseVersion: current.version, train: train.length, heldOut: held.length, model: TUNE_MODEL, promptVersion: tune.version };

  const learned = await a.evaluate(current, train, d.signal);
  const misses = learned.misses.slice(0, MAX_MISSES);
  if (!misses.length) return PolicyProposal.parse({ ...base, status: 'rejected', rejected: 'The current policy gets every label it learns from right, so there is nothing to change.', changes: [] });

  let answer: z.infer<typeof TuneAnswer>;
  try {
    const r = await d.claude.structured(
      {
        purpose: 'tune',
        model: TUNE_MODEL,
        system: tune.text,
        prompt: renderTune(current.text, a.describe(learned.scores), misses),
        promptVersion: tune.version,
        timeoutMs: DEADLINES.draft,
        signal: d.signal,
        itemIds: train.map((l) => a.itemId(l)),
      },
      TuneAnswer,
    );
    answer = r.value;
  } catch (err) {
    if (!(err instanceof ClaudeOutputError)) throw err;
    return PolicyProposal.parse({ ...base, status: 'rejected', rejected: 'The model’s answer couldn’t be used.', changes: [] });
  }
  const text = answer.policy.trim();
  const why = guard(current.text, text, answer.changes, labels.flatMap((l) => a.texts(l)));
  if (why) {
    d.logger?.info({ loop: a.loop, why }, 'Policy proposal rejected');
    return PolicyProposal.parse({ ...base, status: 'rejected', rejected: why, changes: [] });
  }
  const before = await a.evaluate(current, held, d.signal);
  const after = await a.evaluate({ text, version: promptVersion(text) }, held, d.signal);
  return PolicyProposal.parse({
    ...base,
    status: 'open',
    text,
    changes: answer.changes,
    diff: lineDiff(current.text, text),
    scores: { before: before.scores, after: after.scores },
    better: a.summary(after.scores) > a.summary(before.scores),
  });
}
