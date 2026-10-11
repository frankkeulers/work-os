import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ATTENTION_ORDER, EvalReport, type Attention, type Settings, type SourceId } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import { writeJsonAtomic } from '../store/atomic';
import { latestLabels, type LabelRecord } from '../store/labels';
import { renderBatch, TriageAnswer } from './triage';
import { estimateTokens, packBatches, threadTokens } from './truncate';

// The eval (FR-6.1, FR-6.3): the triage prompt and model over the labelled set, scored per
// category, saved to logs/eval-<timestamp>.json so prompt changes can be compared. It measures
// the model alone: rules are not applied, so a rule change never moves the score. Calls are logged
// with purpose `eval` and count towards the day's cost-equivalent like any other call.

const ORDER = ATTENTION_ORDER;

export interface Scored {
  source?: SourceId;
  label: LabelRecord['label'];
  predicted: { attention: Attention; confluence: boolean; vault: boolean };
}

const pr = (tp: number, predicted: number, actual: number) => ({ precision: predicted ? tp / predicted : 0, recall: actual ? tp / actual : 0, support: actual });

/** Precision and recall per category, and the attention confusion matrix (rows labelled). */
export function score(rows: Scored[]): Pick<EvalReport, 'categories' | 'confusion'> {
  const confusion = ORDER.map(() => ORDER.map(() => 0));
  for (const r of rows) confusion[ORDER.indexOf(r.label.attention)][ORDER.indexOf(r.predicted.attention)]++;
  const att = (i: number) =>
    pr(
      confusion[i][i],
      confusion.reduce((s, row) => s + row[i], 0),
      confusion[i].reduce((s, v) => s + v, 0),
    );
  const flag = (k: 'confluence' | 'vault') =>
    pr(
      rows.filter((r) => r.label[k] && r.predicted[k]).length,
      rows.filter((r) => r.predicted[k]).length,
      rows.filter((r) => r.label[k]).length,
    );
  return { categories: { now: att(0), today: att(1), follow: att(2), none: att(3), confluence: flag('confluence'), vault: flag('vault') }, confusion };
}

export interface EvalDeps {
  claude: ClaudeAdapter;
  settings: Settings;
  prompt: Prompt;
  now: () => Date;
  signal?: AbortSignal;
  logger?: Logger;
}

/**
 * Runs triage over the latest label of each item, or of one source's items (R2.2: a new source goes
 * live on its own scores). Throws ClaudeError when Claude can't be called.
 */
export async function runEval(d: EvalDeps, records: LabelRecord[], o: { source?: SourceId } = {}): Promise<EvalReport> {
  const labels = latestLabels(records).filter((l) => !o.source || l.source === o.source);
  if (!labels.length) throw new Error(o.source ? `No labelled threads from ${o.source} yet.` : 'No labelled threads yet.');
  const t = d.settings.triage;
  const model = d.settings.models.triage;
  const batches = packBatches(labels, (l) => threadTokens(l.thread), { maxThreads: t.maxThreadsPerCall, maxInputTokens: t.maxInputTokens, overheadTokens: estimateTokens(d.prompt.text) + 200 });
  const rows: Scored[] = [];
  let tokens = 0;
  let cost = 0;
  let failed = 0;
  for (const batch of batches) {
    try {
      const r = await d.claude.structured(
        {
          purpose: 'eval',
          model,
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
        rows.push({ source: l.source, label: l.label, predicted: { attention: a.attention, confluence: a.confluence.suggested, vault: a.vault.suggested } });
      }
    } catch (err) {
      if (!(err instanceof ClaudeOutputError)) throw err;
      failed += batch.length; // out of shape twice: counted, not scored
    }
  }
  const at = d.now().toISOString();
  const report: EvalReport = {
    id: `eval-${at}`,
    at,
    labelCount: labels.length,
    promptVersion: d.prompt.version,
    model,
    ...score(rows),
    tokens,
    costEquivalent: Math.round(cost * 10_000) / 10_000,
    ...(failed && { failed }),
    ...(o.source && { source: o.source }),
    ...bySource(rows),
  };
  d.logger?.info({ labels: labels.length, failed, tokens, cost: report.costEquivalent }, 'Eval finished');
  return EvalReport.parse(report);
}

/** Scores per source, when the rows come from more than one. */
function bySource(rows: Scored[]): Pick<EvalReport, 'bySource'> {
  const sources = [...new Set(rows.map((r) => r.source).filter((s): s is SourceId => !!s))];
  if (sources.length < 2) return {};
  return { bySource: Object.fromEntries(sources.map((s) => { const mine = rows.filter((r) => r.source === s); return [s, { labelCount: mine.length, ...score(mine) }]; })) };
}

const REPORT_RE = /^eval-.+\.json$/;

/** logs/eval-<timestamp>.json, the timestamp safe for any file system. */
export async function saveReport(logsDir: string, report: EvalReport): Promise<string> {
  const file = join(logsDir, `eval-${report.at.replace(/[:.]/g, '-')}.json`);
  await writeJsonAtomic(file, report);
  return file;
}

/** Every saved report, newest first; unreadable files are skipped. */
export async function listReports(logsDir: string): Promise<EvalReport[]> {
  const names = (await readdir(logsDir).catch(() => [] as string[])).filter((n) => REPORT_RE.test(n));
  const out: EvalReport[] = [];
  for (const n of names) {
    try {
      const r = EvalReport.safeParse(JSON.parse(await readFile(join(logsDir, n), 'utf8')));
      if (r.success) out.push(r.data);
    } catch {
      // skipped
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** "Run eval" in the UI: one run at a time, in the background; listeners hear start and end. */
export class Evals {
  running = false;
  last?: EvalReport;
  private current?: Promise<void>;
  private abort = new AbortController();
  private listeners = new Set<() => void>();

  private constructor(
    private readonly d: {
      logsDir: string;
      labels: () => Promise<LabelRecord[]>;
      run: (labels: LabelRecord[], signal: AbortSignal) => Promise<EvalReport>;
      logger?: Logger;
    },
  ) {}

  static async open(d: Evals['d']): Promise<Evals> {
    const e = new Evals(d);
    e.last = (await listReports(d.logsDir))[0];
    return e;
  }

  list() {
    return listReports(this.d.logsDir);
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
  }

  /** Starts a run unless one is going; says why not when there is nothing to run. */
  async start(): Promise<'started' | 'running' | 'no_labels'> {
    if (this.running) return 'running';
    const labels = await this.d.labels();
    if (this.running) return 'running';
    if (!labels.length) return 'no_labels';
    this.running = true;
    this.changed();
    this.current = this.d
      .run(labels, this.abort.signal)
      .then(async (report) => {
        await saveReport(this.d.logsDir, report);
        this.last = report;
      })
      .catch((err) => {
        if (!this.abort.signal.aborted) this.d.logger?.error({ err }, 'Eval failed');
      })
      .finally(() => {
        this.running = false;
        this.current = undefined;
        this.changed();
      });
    return 'started';
  }

  /** Waits for a run in progress (tests). */
  async settled() {
    await this.current;
  }

  async stop() {
    this.abort.abort(new Error('stopping'));
    await this.current;
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }
}
