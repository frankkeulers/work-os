import { join } from 'node:path';
import { SettleBatchOutput, type Settings, type SourceId } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import { writeJsonAtomic } from '../store/atomic';
import { latestSettleLabels, type SettleLabelRecord } from '../store/settleLabels';
import { SETTLE_MAX_PER_CALL, judge, renderChecks, type SettleCheck } from './settle';
import { estimateTokens, packBatches, threadTokens } from './truncate';

// The settle eval (cockpit CK-2.6): the settle prompt and model over labels/settle.jsonl, scored
// on the two mistakes that matter: a false close (an ask Frank still owed, hidden) and a missed
// close (a click he had to make). Saved to logs/settle-eval-<timestamp>.json. Calls are logged with
// purpose `eval`. It runs once there are enough labels to say something.

export const SETTLE_EVAL_MIN_LABELS = 30;

export interface SettleEvalReport {
  id: string;
  at: string;
  model: string;
  promptVersion: string;
  labelCount: number;
  /** Checks that got no usable answer: not scored. */
  failed: number;
  /** Labelled "should not close" (an Undo), and the model would close it. */
  falseCloses: number;
  /** Labelled "should close" (a Done soon after "not settled"), and the model still wouldn't. */
  missedCloses: number;
  /** Scored checks the model now gets right. */
  correct: number;
  bySource: Partial<Record<SourceId, { labelCount: number; correct: number }>>;
  /** By how the label came: an Undo, a Done after "not settled", or a Done no check saw. */
  byOrigin: Partial<Record<SettleLabelRecord['origin'], { labelCount: number; correct: number }>>;
  tokens: number;
  costEquivalent: number;
}

export interface SettleEvalDeps {
  claude: ClaudeAdapter;
  settings: Settings;
  prompt: Prompt;
  now: () => Date;
  signal?: AbortSignal;
  logger?: Logger;
}

/**
 * Re-runs each item's latest labelled check. Throws ClaudeError when Claude can't be called. The
 * finish eval (cockpit CK-2.10) is the same over labels/finish.jsonl, with its prompt and `render`.
 */
export async function runSettleEval(d: SettleEvalDeps, records: SettleLabelRecord[], render: (checks: SettleCheck[], now: Date) => string = renderChecks): Promise<SettleEvalReport> {
  const labels = latestSettleLabels(records);
  if (!labels.length) throw new Error('No settle labels yet.');
  const t = d.settings.triage;
  const model = d.settings.models.triage;
  const check = (l: SettleLabelRecord) => l.check as unknown as SettleCheck;
  const batches = packBatches(labels, (l) => threadTokens(check(l).thread) + estimateTokens(JSON.stringify(check(l).asks)), {
    maxThreads: Math.min(SETTLE_MAX_PER_CALL, t.maxThreadsPerCall),
    maxInputTokens: t.maxInputTokens,
    overheadTokens: estimateTokens(d.prompt.text) + 200,
  });
  const r: Pick<SettleEvalReport, 'failed' | 'falseCloses' | 'missedCloses' | 'correct' | 'bySource' | 'byOrigin' | 'tokens'> = { failed: 0, falseCloses: 0, missedCloses: 0, correct: 0, bySource: {}, byOrigin: {}, tokens: 0 };
  let cost = 0;
  for (const batch of batches) {
    try {
      const out = await d.claude.structured(
        {
          purpose: 'eval',
          model,
          system: d.prompt.text,
          prompt: render(batch.map(check), d.now()),
          promptVersion: d.prompt.version,
          timeoutMs: DEADLINES.triage,
          signal: d.signal,
          itemIds: batch.map((l) => l.itemId),
        },
        SettleBatchOutput,
      );
      for (const u of out.usage) {
        r.tokens += u.inputTokens + u.outputTokens + u.cacheTokens;
        cost += u.costEquivalent;
      }
      const byId = new Map(out.value.decisions.map((a) => [a.itemId, a]));
      for (const l of batch) {
        const a = byId.get(l.itemId);
        if (!a) {
          r.failed++;
          continue;
        }
        const closes = judge(check(l), a).allSettled;
        const src = (r.bySource[l.source] ??= { labelCount: 0, correct: 0 });
        const how = (r.byOrigin[l.origin] ??= { labelCount: 0, correct: 0 });
        src.labelCount++;
        how.labelCount++;
        if (closes === l.settled) {
          r.correct++;
          src.correct++;
          how.correct++;
        } else if (closes) r.falseCloses++;
        else r.missedCloses++;
      }
    } catch (err) {
      if (!(err instanceof ClaudeOutputError)) throw err;
      r.failed += batch.length; // out of shape twice: counted, not scored
    }
  }
  const at = d.now().toISOString();
  d.logger?.info({ labels: labels.length, ...r }, 'Settle eval finished');
  return { id: `settle-eval-${at}`, at, model, promptVersion: d.prompt.version, labelCount: labels.length, ...r, costEquivalent: Math.round(cost * 10_000) / 10_000 };
}

/** logs/settle-eval-<timestamp>.json. */
export async function saveSettleReport(logsDir: string, report: SettleEvalReport): Promise<string> {
  const file = join(logsDir, `settle-eval-${report.at.replace(/[:.]/g, '-')}.json`);
  await writeJsonAtomic(file, report);
  return file;
}
