import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generate } from '../perf/genData';

// npm run gen-data -- [--days 90] [--items-per-day 60] [--dir <new folder>]
// A synthetic data directory for performance work (NF-11). Refuses real data directories and
// folders that are not empty.

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

const days = Number(arg('--days') ?? 90);
const itemsPerDay = Number(arg('--items-per-day') ?? 60);
const dir = arg('--dir') ?? join(tmpdir(), `workos-gen-${Date.now()}`);

try {
  const r = await generate(dir, { days, itemsPerDay });
  console.log(`Generated ${r.items.toLocaleString('en-GB')} items and ${r.events.toLocaleString('en-GB')} events over ${days} days in ${(r.ms / 1000).toFixed(1)} s.`);
  console.log(`Data directory: ${dir}`);
} catch (e) {
  console.error(`gen-data did not run: ${(e as Error).message}`);
  process.exitCode = 1;
}
