import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FilingEvalReport, type FilingDimension, type FilingScores, type Settings, type SourceId } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import { writeJsonAtomic } from '../store/atomic';
import type { FilingField, LabelValue, MergedFilingLabel } from '../store/filingLabels';
import { clampFiling, clampTodo, renderBatch, TriageAnswer } from './triage';
import { estimateTokens, packBatches, threadTokens } from './truncate';

// The filing eval (E14, FR-15.8): triage with the current prompt and filing policy over the
// filing labels, scored per field (To file, pre-draft, ready, to-do), as the policy's flags come
// out of code's clamps. Like the triage eval it measures the model and the policy alone: rules and
// Frank's switches in Settings › Learning are not applied. Calls are logged with purpose `eval`.

/** What the policy said for one labelled item, after code's clamps. */
export interface FilingPrediction {
  confluence: Record<FilingField, boolean>;
  vault: Record<FilingField, boolean>;
  todo: boolean;
}

export interface FilingScored {
  label: MergedFilingLabel;
  predicted: FilingPrediction;
}

const DIMENSIONS: FilingDimension[] = ['toFile', 'predraft', 'ready', 'todo'];

/** The labelled values of one dimension, with what was predicted for each. */
function pairs(rows: readonly FilingScored[], dim: FilingDimension, keep: (v: LabelValue) => boolean): [boolean, boolean][] {
  const out: [boolean, boolean][] = [];
  for (const { label, predicted } of rows) {
    if (dim === 'todo') {
      if (label.todo && keep(label.todo)) out.push([label.todo.value, predicted.todo]);
      continue;
    }
    for (const t of ['confluence', 'vault'] as const) {
      const v = label[t][dim];
      if (v && keep(v)) out.push([v.value, predicted[t][dim]]);
    }
  }
  return out;
}

/** Precision and recall per dimension, over the values `keep` lets through. */
export function scoreFiling(rows: readonly FilingScored[], keep: (v: LabelValue) => boolean = () => true): FilingScores {
  const one = (dim: FilingDimension) => {
    const p = pairs(rows, dim, keep);
    const tp = p.filter(([l, x]) => l && x).length;
    const predicted = p.filter(([, x]) => x).length;
    const support = p.filter(([l]) => l).length;
    return { precision: predicted ? tp / predicted : 0, recall: support ? tp / support : 0, support, predicted, n: p.length };
  };
  return Object.fromEntries(DIMENSIONS.map((d) => [d, one(d)])) as FilingScores;
}

export interface FilingEvalDeps {
  claude: ClaudeAdapter;
  settings: Settings;
  /** The triage prompt with the policy to score (`triageSystem`). */
  prompt: Prompt;
  now: () => Date;
  signal?: AbortSignal;
  logger?: Logger;
}

/** What the policy says for each labelled item. Throws ClaudeError when Claude can't be called. */
export async function predictFiling(d: FilingEvalDeps, labels: readonly MergedFilingLabel[]): Promise<{ rows: FilingScored[]; failed: number; tokens: number; cost: number }> {
  const t = d.settings.triage;
  const batches = packBatches([...labels], (l) => threadTokens(l.thread), { maxThreads: t.maxThreadsPerCall, maxInputTokens: t.maxInputTokens, overheadTokens: estimateTokens(d.prompt.text) + 200 });
  const rows: FilingScored[] = [];
  let tokens = 0;
  let cost = 0;
  let failed = 0;
  for (const batch of batches) {
    try {
      const r = await d.claude.structured(
        {
          purpose: 'eval',
          model: d.settings.models.triage,
          system: d.prompt.text,
          prompt: renderBatch(
            batch.map((l) => l.thread),
            d.now(),
          ),
          promptVersion: d.prompt.version,
          timeoutMs: DEADLINES.triage,
          signal: d.signal,
          itemIds: batch.map((l) => l.itemId),
        },
        TriageAnswer,
      );
      for (const u of r.usage) {
        tokens += u.inputTokens + u.outputTokens + u.cacheTokens;
        cost += u.costEquivalent;
      }
      const byId = new Map(r.value.decisions.map((a) => [a.id, a]));
      for (const l of batch) {
        const a = byId.get(l.thread.id);
        if (!a) {
          failed++;
          continue;
        }
        const flags = (f: ReturnType<typeof clampFiling>) => ({ toFile: f.suggested, predraft: !!f.predraft, ready: !!f.ready });
        rows.push({ label: l, predicted: { confluence: flags(clampFiling(a.confluence)), vault: flags(clampFiling(a.vault)), todo: !!clampTodo(a.todo, a.attention, a.next) } });
      }
    } catch (err) {
      if (!(err instanceof ClaudeOutputError)) throw err;
      failed += batch.length; // out of shape twice: counted, not scored
    }
  }
  return { rows, failed, tokens, cost };
}

/** Runs the eval over every labelled item. Throws ClaudeError when Claude can't be called. */
export async function runFilingEval(d: FilingEvalDeps, labels: readonly MergedFilingLabel[]): Promise<FilingEvalReport> {
  if (!labels.length) throw new Error('No filing labels yet.');
  const { rows, failed, tokens, cost } = await predictFiling(d, labels);
  const at = d.now().toISOString();
  const sources = [...new Set(rows.map((r) => r.label.source))];
  const report: FilingEvalReport = {
    id: `filing-eval-${at}`,
    at,
    labelCount: labels.length,
    promptVersion: d.prompt.version,
    ...(d.prompt.policyVersion && { policyVersion: d.prompt.policyVersion }),
    model: d.settings.models.triage,
    scores: scoreFiling(rows),
    byOrigin: { explicit: scoreFiling(rows, (v) => v.origin === 'explicit'), implicit: scoreFiling(rows, (v) => v.origin === 'implicit') },
    ...(sources.length > 1 && {
      bySource: Object.fromEntries(
        sources.map((s: SourceId) => {
          const mine = rows.filter((r) => r.label.source === s);
          return [s, { labelCount: mine.length, scores: scoreFiling(mine) }];
        }),
      ),
    }),
    tokens,
    costEquivalent: Math.round(cost * 10_000) / 10_000,
    ...(failed && { failed }),
  };
  d.logger?.info({ labels: labels.length, failed, tokens, cost: report.costEquivalent }, 'Filing eval finished');
  return FilingEvalReport.parse(report);
}

const REPORT_RE = /^filing-eval-.+\.json$/;

/** logs/filing-eval-<timestamp>.json, the timestamp safe for any file system. */
export async function saveFilingReport(logsDir: string, report: FilingEvalReport): Promise<string> {
  const file = join(logsDir, `filing-eval-${report.at.replace(/[:.]/g, '-')}.json`);
  await writeJsonAtomic(file, report);
  return file;
}

/** Every saved report, newest first; unreadable files are skipped. */
export async function listFilingReports(logsDir: string): Promise<FilingEvalReport[]> {
  const names = (await readdir(logsDir).catch(() => [] as string[])).filter((n) => REPORT_RE.test(n));
  const out: FilingEvalReport[] = [];
  for (const n of names) {
    try {
      const r = FilingEvalReport.safeParse(JSON.parse(await readFile(join(logsDir, n), 'utf8')));
      if (r.success) out.push(r.data);
    } catch {
      // skipped
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
