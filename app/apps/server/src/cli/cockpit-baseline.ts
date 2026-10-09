import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { SettingsFile } from '@work-os/shared';
import { BaselineAnalyser, describeBaseline } from '../cockpit/baseline';
import { paths } from '../config/dataDir';
import { defaultSettings } from '../config/defaults';
import { ConfigError, EXIT, expandHome, resolveConfig } from '../config/env';
import { readLog } from '../store/recover';

// npm run cockpit:baseline -- [--data <dir>] [--days 14]
// The cockpit's Stage 0 baseline (specs/cockpit/SPEC.md CK-0.1). Reads the event log and settings
// read-only: no lock, no repair, no snapshot, no model calls, no network. A running server is fine.
// The autostarted instance's data needs WORKOS_INSTANCE=prod (or --data ~/WorkOS-data).
// Writes app/logs/cockpit-baseline-<date>.json, beside the perf reports.

const APP = join(import.meta.dirname, '../../../..');

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<number> {
  let dataDir = arg('--data');
  if (dataDir) dataDir = resolve(expandHome(dataDir, process.env.HOME ?? ''));
  else {
    try {
      dataDir = resolveConfig(process.env).dataDir;
    } catch (e) {
      if (e instanceof ConfigError) {
        console.error(e.message);
        return EXIT.config;
      }
      throw e;
    }
  }
  const days = Number(arg('--days') ?? 14);
  if (!Number.isInteger(days) || days < 1) {
    console.error(`--days must be a whole number of days, got "${arg('--days')}".`);
    return EXIT.config;
  }

  // Read settings straight from the file: loadSettings would write a last-good copy.
  const raw = await readFile(paths(dataDir).settings, 'utf8').catch(() => null);
  const parsed = raw === null ? undefined : SettingsFile.safeParse(JSON.parse(raw));
  const workHours = parsed?.success ? parsed.data.schedule.workHours : defaultSettings(dataDir).schedule.workHours;

  const now = new Date();
  const analyser = new BaselineAnalyser({ now, days, workHours });
  const log = await readLog(paths(dataDir).events, { afterSeq: 0, repair: false, onEvent: (e) => analyser.add(e) }).catch((e: unknown) => {
    throw new Error(`could not read the event log in ${dataDir}: ${(e as Error).message}`);
  });
  const report = analyser.report();

  console.log(describeBaseline(report));
  console.log(`\nRead ${log.events} events from ${log.files} files in ${dataDir} (read-only).`);
  if (log.torn.length || log.quarantined.length) console.log(`Skipped ${log.torn.length} torn and ${log.quarantined.length} unreadable line(s); the server repairs them at start.`);

  const out = join(APP, 'logs', `cockpit-baseline-${now.toISOString().slice(0, 10)}.json`);
  await mkdir(join(APP, 'logs'), { recursive: true });
  await writeFile(out, `${JSON.stringify({ dataDir, workHours, log: { events: log.events, files: log.files }, ...report }, null, 2)}\n`);
  console.log(`Report: ${out}`);
  return EXIT.ok;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(`cockpit:baseline did not finish: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
  },
);
