import { join } from 'node:path';
import { SourceId, type EvalReport } from '@work-os/shared';
import { ClaudeAdapter } from '../claude/adapter';
import { loadPromptFile } from '../claude/promptFiles';
import { UsageLog } from '../claude/usage';
import { paths } from '../config/dataDir';
import { ConfigError, EXIT, resolveConfig } from '../config/env';
import { macKeychain } from '../config/keychain';
import { loadSettings } from '../config/settings';
import { SettingsState } from '../config/settingsState';
import { runEval, saveReport } from '../pipeline/eval';
import { SETTLE_EVAL_MIN_LABELS, runSettleEval, saveSettleReport, type SettleEvalReport } from '../pipeline/evalSettle';
import { renderFinishChecks, type FinishCheck } from '../pipeline/finish';
import { acquireLock } from '../runtime/lock';
import { API_KEY_FIX, apiKeySet } from '../runtime/refuse';
import { readLabels } from '../store/labels';
import { latestSettleLabels, readSettleLabels } from '../store/settleLabels';

// npm run eval (FR-6.1, FR-6.3): the triage prompt and model over labels/triage.jsonl, scored and
// saved to logs/eval-<timestamp>.json. `-- --source outlook` scores one source's labels alone (R2.2).
// `-- --purpose settle` runs the settle prompt over labels/settle.jsonl instead (cockpit CK-2.6),
// and `-- --purpose finish` the finish prompt over labels/finish.jsonl (CK-2.10), once the file
// holds 30 labelled checks. It calls Claude on the subscription login, like the server.
// It takes the lock, so it never shares the usage log with a running server; while the server
// runs, use Usage › Run eval instead. Prints scores and counts only, never thread text.

const pct = (v: number) => `${Math.round(v * 100)}%`.padStart(4);

function print(r: EvalReport, file: string) {
  console.log(`Eval of ${r.labelCount} labelled threads${r.source ? ` from ${r.source}` : ''} · ${r.model} · prompt ${r.promptVersion}`);
  if (r.failed) console.log(`${r.failed} thread(s) got no usable answer and are not scored.`);
  console.log('');
  console.log('              precision  recall  support');
  for (const [k, v] of Object.entries(r.categories)) console.log(`  ${k.padEnd(11)} ${pct(v.precision).padStart(9)} ${pct(v.recall).padStart(7)} ${String(v.support).padStart(8)}`);
  console.log('');
  console.log('  labelled ↓ / predicted →   now  today  none');
  ['now', 'today', 'none'].forEach((k, i) => console.log(`  ${k.padEnd(24)} ${r.confusion[i].map((n) => String(n).padStart(5)).join(' ')}`));
  console.log('');
  for (const [source, s] of Object.entries(r.bySource ?? {})) console.log(`  ${source.padEnd(8)} ${s.labelCount} labels · now ${pct(s.categories.now.precision)} precision ${pct(s.categories.now.recall)} recall · today ${pct(s.categories.today.precision)} precision`);
  console.log(`Tokens ${r.tokens.toLocaleString('en-GB')} · cost-equivalent $${r.costEquivalent.toFixed(4)}`);
  console.log(`Saved ${file}`);
}

function printSettle(r: SettleEvalReport, file: string, title = 'Settle') {
  const scored = r.labelCount - r.failed;
  console.log(`${title} eval of ${r.labelCount} labelled checks · ${r.model} · prompt ${r.promptVersion}`);
  if (r.failed) console.log(`${r.failed} check(s) got no usable answer and are not scored.`);
  console.log('');
  console.log(`  right now       ${String(r.correct).padStart(4)} of ${scored}`);
  console.log(`  false closes    ${String(r.falseCloses).padStart(4)}   (an ask you still owed, closed)`);
  console.log(`  missed closes   ${String(r.missedCloses).padStart(4)}   (left open after your reply settled it)`);
  for (const [source, s] of Object.entries(r.bySource)) console.log(`  ${source.padEnd(8)} ${s.correct} of ${s.labelCount} right`);
  const ORIGIN = { undo: 'your Undo', manual_done: 'Done after "not settled"', manual_done_unchecked: 'Done, no check ran', finish_accepted: 'Looks finished: Done', finish_rejected: 'Looks finished: kept' } as const;
  for (const [origin, s] of Object.entries(r.byOrigin)) console.log(`  ${ORIGIN[origin as keyof typeof ORIGIN].padEnd(26)} ${s.correct} of ${s.labelCount} right`);
  console.log('');
  console.log(`Tokens ${r.tokens.toLocaleString('en-GB')} · cost-equivalent $${r.costEquivalent.toFixed(4)}`);
  console.log(`Saved ${file}`);
}

/** `--purpose triage|settle|finish`: which prompt to score. */
function purposeArg(argv: string[]): 'triage' | 'settle' | 'finish' | Error {
  const i = argv.indexOf('--purpose');
  if (i < 0) return 'triage';
  const v = argv[i + 1];
  return v === 'triage' || v === 'settle' || v === 'finish' ? v : new Error('--purpose takes triage, settle or finish');
}

/** `--source <id>`: one source's labels only. */
function sourceArg(argv: string[]): SourceId | undefined | Error {
  const i = argv.indexOf('--source');
  if (i < 0) return undefined;
  const v = SourceId.safeParse(argv[i + 1]);
  return v.success ? v.data : new Error(`--source takes one of ${SourceId.options.join(', ')}`);
}

async function main(): Promise<number> {
  const source = sourceArg(process.argv.slice(2));
  const purpose = purposeArg(process.argv.slice(2));
  if (source instanceof Error || purpose instanceof Error) {
    console.error((source instanceof Error ? source : (purpose as Error)).message);
    return EXIT.config;
  }
  if (apiKeySet(process.env)) {
    console.error(`ANTHROPIC_API_KEY is set, so the eval would not run on the subscription (CL-2). ${API_KEY_FIX}`);
    return EXIT.config;
  }
  let config;
  try {
    config = resolveConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return EXIT.config;
    }
    throw e;
  }
  const p = paths(config.dataDir);
  const lock = await acquireLock(p.lock, { instance: config.instance, port: 0, version: config.version });
  if (!lock.ok) {
    console.error(`Work OS is running (pid ${lock.holder.pid}, port ${lock.holder.port}). Run the eval from Usage › Run eval, or stop it first.`);
    return EXIT.lockHeld;
  }
  let usage: UsageLog | undefined;
  try {
    if (purpose === 'settle' || purpose === 'finish') {
      const file = purpose === 'settle' ? p.settleLabels : p.finishLabels;
      const settle = await readSettleLabels(file);
      const n = latestSettleLabels(settle).length;
      if (n < SETTLE_EVAL_MIN_LABELS) {
        const how = purpose === 'settle' ? 'Undo a wrong close, or press Done on an item your reply settled, to add one.' : 'Answer a "Looks finished" suggestion, with Done or Not finished, to add one.';
        console.error(`The ${purpose} eval runs once ${file} holds ${SETTLE_EVAL_MIN_LABELS} labelled checks; it has ${n}. ${how}`);
        return EXIT.config;
      }
      const settings = (await SettingsState.create(config.dataDir, await loadSettings(config.dataDir), config.forceDryRun)).editable.settings;
      usage = await UsageLog.open(p.logs);
      const claude = new ClaudeAdapter({ usage, settings: () => settings, secrets: macKeychain(), now: () => new Date(), cwd: join(config.dataDir, 'sandbox'), client: `work-os-eval/${config.version}` });
      const deps = { claude, settings, prompt: await loadPromptFile(config.dataDir, purpose), now: () => new Date() };
      const report = purpose === 'settle' ? await runSettleEval(deps, settle) : await runSettleEval(deps, settle, (checks, now) => renderFinishChecks(checks as unknown as FinishCheck[], now));
      printSettle(report, await saveSettleReport(p.logs, report), purpose === 'settle' ? 'Settle' : 'Finish');
      return EXIT.ok;
    }
    const records = await readLabels(p.labels);
    if (!records.length) {
      console.error(`No labelled threads in ${p.labels} yet. Correct a triage in the inbox to add one.`);
      return EXIT.config;
    }
    const settings = (await SettingsState.create(config.dataDir, await loadSettings(config.dataDir), config.forceDryRun)).editable.settings;
    usage = await UsageLog.open(p.logs);
    const claude = new ClaudeAdapter({
      usage,
      settings: () => settings,
      secrets: macKeychain(),
      now: () => new Date(),
      cwd: join(config.dataDir, 'sandbox'),
      client: `work-os-eval/${config.version}`,
    });
    const prompt = await loadPromptFile(config.dataDir, 'triage');
    const report = await runEval({ claude, settings, prompt, now: () => new Date() }, records, { source });
    print(report, await saveReport(p.logs, report));
    return EXIT.ok;
  } catch (e) {
    console.error(`The eval did not finish: ${(e as Error).message}`);
    return EXIT.crash;
  } finally {
    await usage?.close();
    await lock.lock.release();
  }
}

process.exitCode = await main();
