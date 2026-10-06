import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import type { InboxView } from '@work-os/shared';
import { NODE_FLAGS } from '../agent/plist';
import { FAKE_API_TOKEN } from '../fakes';
import { generate, SYNTHETIC_MARKER } from '../perf/genData';
import { Client, openEvents, percentile, processStats, round } from '../perf/measure';
import { pollBench } from '../perf/pollBench';
import { bundleServer, SERVER_DIR } from './bundle';

// npm run perf -- [--data <gen-data folder>] [--days 90] [--idle-seconds 20] [--keep]
//
// The performance budgets (PLAN.md NF-11) against 90 days of synthetic data: the bundled server
// is started with --fakes (made-up Slack, in-memory Keychain, temp data folder only), measured
// over HTTP, stopped, and started again without its snapshot. The poll budget runs in-process
// against the fake Slack with a realistic delay. Results go to app/logs/perf-<time>.json; any
// breach of app/scripts/perf-budgets.json exits 1.

const APP = resolve(SERVER_DIR, '../..');
const PORT = 4397;
const BASE = `http://127.0.0.1:${PORT}`;
const STARTS = 3;

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const median = (xs: number[]) => percentile(xs, 50);

type Budget = { max: number; unit: string; what: string } | { expect: boolean; what: string };

class ServerProcess {
  private child?: ChildProcess;
  output = '';

  constructor(
    private readonly entry: string,
    private readonly dataDir: string,
  ) {}

  get pid() {
    return this.child?.pid;
  }

  /** Starts the server and resolves with the time until /api/health answered 200. */
  async start(): Promise<number> {
    this.output = '';
    const webDir = join(APP, 'apps/web/dist');
    const t0 = performance.now();
    const child = spawn(process.execPath, [...NODE_FLAGS, this.entry, '--fakes'], {
      env: { ...process.env, NODE_ENV: 'production', WORKOS_INSTANCE: 'dev', WORKOS_DATA_DIR: this.dataDir, WORKOS_PORT: String(PORT), ...((await exists(webDir)) && { WORKOS_WEB_DIR: webDir }) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.on('data', (b) => (this.output += b));
    child.stderr?.on('data', (b) => (this.output += b));
    const client = new Client(BASE, FAKE_API_TOKEN);
    try {
      while (performance.now() - t0 < 20_000) {
        if (child.exitCode !== null) throw new Error(`The server exited (${child.exitCode}):\n${this.output}`);
        const ok = await client.call('GET', '/api/health').then(
          (r) => r.status === 200,
          () => false,
        );
        if (ok) return performance.now() - t0;
        await sleep(5);
      }
    } finally {
      client.close();
    }
    throw new Error(`The server did not answer within 20 s:\n${this.output}`);
  }

  async stop() {
    const c = this.child;
    this.child = undefined;
    if (!c || c.exitCode !== null) return;
    const exited = new Promise((r) => c.once('exit', r));
    c.kill('SIGTERM');
    await exited;
  }
}

async function measureApi(client: Client, mark: (label: string) => Promise<void>) {
  const inbox = async (headers: Record<string, string> = {}) => client.call('GET', '/api/inbox', { headers });
  for (let i = 0; i < 20; i++) await inbox({ 'accept-encoding': 'gzip' }); // warm up

  const inboxMs: number[] = [];
  let wire = 0;
  let raw = 0;
  let view: InboxView | undefined;
  let etag = '';
  for (let i = 0; i < 200; i++) {
    const r = await inbox({ 'accept-encoding': 'gzip' });
    inboxMs.push(r.ms);
    wire = r.body.length;
    const body = r.headers['content-encoding'] === 'gzip' ? gunzipSync(r.body) : r.body;
    raw = body.length;
    view = JSON.parse(body.toString()) as InboxView;
    etag = String(r.headers.etag ?? '');
  }
  await mark('afterInbox');
  const gzip = (await inbox({ 'accept-encoding': 'gzip' })).headers['content-encoding'] === 'gzip';
  const notModifiedMs: number[] = [];
  let notModified = true;
  for (let i = 0; i < 50; i++) {
    const r = await inbox({ 'accept-encoding': 'gzip', 'if-none-match': etag });
    notModifiedMs.push(r.ms);
    notModified &&= r.status === 304;
  }

  const items = view!.items;
  const active = items.filter((i) => i.status !== 'done' && i.status !== 'snoozed');
  // Cold: each item read for the first time (the cache holds 64). Warm: one item again and again.
  const itemColdMs: number[] = [];
  for (const it of items.slice(0, 150)) itemColdMs.push((await client.call('GET', `/api/items/${encodeURIComponent(it.id)}`)).ms);
  const itemWarmMs: number[] = [];
  const warmId = encodeURIComponent(items[0].id);
  for (let i = 0; i < 200; i++) itemWarmMs.push((await client.call('GET', `/api/items/${warmId}`)).ms);

  await mark('afterItems');
  // Commands, each synced to disk before it answers; then the SSE notice each one causes.
  const commandMs: number[] = [];
  const targets = active.slice(0, 60);
  const check = (r: { status: number }, what: string) => {
    if (r.status >= 300) throw new Error(`${what} answered ${r.status}`);
  };
  for (const it of targets.slice(0, 40)) {
    const id = encodeURIComponent(it.id);
    const done = await client.call('POST', `/api/items/${id}/done`, { json: {} });
    check(done, 'done');
    const reopen = await client.call('POST', `/api/items/${id}/reopen`, { json: {} });
    check(reopen, 'reopen');
    commandMs.push(done.ms, reopen.ms);
  }
  const until = new Date(Date.now() + 86_400_000).toISOString();
  for (const it of targets.slice(40, 60)) {
    const r = await client.call('POST', `/api/items/${encodeURIComponent(it.id)}/snooze`, { json: { until } });
    check(r, 'snooze');
    commandMs.push(r.ms);
  }

  const sseMs: number[] = [];
  let waiting: { id: string; sent: number; resolve: (at: number) => void } | undefined;
  const close = await openEvents(BASE, FAKE_API_TOKEN, (data, at) => {
    if (!waiting) return;
    try {
      const n = JSON.parse(data) as { topic: string; id?: string };
      if (n.topic === 'item' && n.id === waiting.id) waiting.resolve(at);
    } catch {
      // not a notice
    }
  });
  await sleep(100);
  for (const it of targets.slice(0, 40)) {
    const id = encodeURIComponent(it.id);
    const sent = performance.now();
    const arrived = new Promise<number>((r) => (waiting = { id: it.id, sent, resolve: r }));
    check(await client.call('POST', `/api/items/${id}/done`, { json: {} }), 'done');
    const at = await Promise.race([arrived, sleep(2000).then(() => NaN)]);
    sseMs.push(at - sent);
    waiting = undefined;
    check(await client.call('POST', `/api/items/${id}/reopen`, { json: {} }), 'reopen');
    await sleep(40); // let the reopen's notice go first
  }
  close();

  return {
    inboxItems: items.length,
    inboxP95Ms: percentile(inboxMs, 95),
    inboxP50Ms: percentile(inboxMs, 50),
    inbox304P95Ms: percentile(notModifiedMs, 95),
    inboxRawKb: raw / 1024,
    inboxWireKb: wire / 1024,
    gzip,
    notModified,
    itemColdP95Ms: percentile(itemColdMs, 95),
    itemWarmP95Ms: percentile(itemWarmMs, 95),
    commandP95Ms: percentile(commandMs, 95),
    sseP95Ms: percentile(sseMs, 95),
  };
}

async function main(): Promise<number> {
  const budgets = JSON.parse(await readFile(join(APP, 'scripts/perf-budgets.json'), 'utf8')) as Record<string, Budget>;
  const idleSeconds = Number(arg('--idle-seconds') ?? 20);
  const days = Number(arg('--days') ?? 90);
  const given = arg('--data');
  const work = await mkdtemp(join(tmpdir(), 'workos-perf-'));
  const keep = process.argv.includes('--keep'); // a --data folder is outside `work` and never removed
  const results: Record<string, number | boolean> = {};
  const info: Record<string, unknown> = { node: process.version, startedAt: new Date().toISOString() };

  let server: ServerProcess | undefined;
  try {
    let dataDir: string;
    if (given) {
      dataDir = resolve(given);
      if (!(await exists(join(dataDir, SYNTHETIC_MARKER)))) throw new Error(`${dataDir} was not made by gen-data.`);
    } else {
      dataDir = join(work, 'data');
      console.log(`Generating ${days} days of synthetic data…`);
      const g = await generate(dataDir, { days });
      info.generated = g;
      console.log(`  ${g.items.toLocaleString('en-GB')} items, ${g.events.toLocaleString('en-GB')} events in ${(g.ms / 1000).toFixed(1)} s`);
    }

    const entry = join(work, 'server.mjs');
    const b = await bundleServer(entry, 'perf');
    console.log(`Bundled the server (${(b.bytes / 1024).toFixed(0)} kB).`);
    server = new ServerProcess(entry, dataDir);

    // Cold starts with the snapshot; the first one stays up for the API measurements.
    const withSnapshot: number[] = [];
    withSnapshot.push(await server.start());
    await sleep(1500); // the first tick, its poll of the fake Slack and the text preload
    const client = new Client(BASE, FAKE_API_TOKEN);
    const rss: Record<string, number> = {};
    const mark = async (label: string) => void (rss[label] = round((await processStats(server!.pid!)).rssMb));
    await mark('afterStart');
    console.log('Measuring the API…');
    Object.assign(results, await measureApi(client, mark));
    info.rssMb = rss;
    client.close();

    await sleep(2000);
    const pid = server.pid!;
    const before = await processStats(pid);
    const t0 = performance.now();
    console.log(`Idle for ${idleSeconds} s…`);
    await sleep(idleSeconds * 1000);
    const after = await processStats(pid);
    results.idleCpuPercent = ((after.cpuMs - before.cpuMs) / (performance.now() - t0)) * 100;
    results.rssMb = after.rssMb;
    console.log(`RSS by stage (MB): ${JSON.stringify({ ...rss, afterIdle: round(after.rssMb) })}`);
    await server.stop();

    for (let i = 1; i < STARTS; i++) {
      withSnapshot.push(await server.start());
      await server.stop();
    }
    results.coldStartSnapshotMs = median(withSnapshot);
    const replay: number[] = [];
    for (let i = 0; i < STARTS; i++) {
      await rm(join(dataDir, 'state/snapshot.json'), { force: true });
      replay.push(await server.start());
      await server.stop();
    }
    results.coldStartReplayMs = median(replay);
    info.starts = { withSnapshot, replay };

    console.log('Polling 25 threads against the slow fake Slack…');
    const poll = await pollBench({ threads: 25, latencyMs: 150 });
    info.poll = poll;
    results.poll25ThreadsMs = Math.max(poll.firstMs, poll.nextMs);
  } finally {
    await server?.stop();
    if (!keep) await rm(work, { recursive: true, force: true });
  }

  // Compare.
  let breaches = 0;
  const rows: string[] = [];
  for (const [key, value] of Object.entries(results)) {
    const b = budgets[key];
    if (typeof value === 'boolean') {
      const ok = !b || !('expect' in b) || value === b.expect;
      if (!ok) breaches++;
      rows.push(`${ok ? '  ok ' : 'FAIL '} ${key.padEnd(22)} ${value ? 'yes' : 'no'}`);
      continue;
    }
    const max = b && 'max' in b ? b : undefined;
    const ok = !max || value <= max.max;
    if (!ok) breaches++;
    const limit = max ? `  (budget ${max.max} ${max.unit}: ${max.what})` : '';
    rows.push(`${max ? (ok ? '  ok ' : 'FAIL ') : '     '} ${key.padEnd(22)} ${String(round(value, 2)).padStart(9)}${limit}`);
  }
  console.log(`\n${rows.join('\n')}\n`);

  const out = join(APP, 'logs', `perf-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await mkdir(join(APP, 'logs'), { recursive: true });
  await writeFile(out, `${JSON.stringify({ ...info, results, budgets, breaches }, null, 2)}\n`);
  console.log(`Results: ${out}`);
  console.log(breaches ? `${breaches} budget(s) breached.` : 'All budgets met.');
  return breaches ? 1 : 0;
}

main().then(
  (code) => (process.exitCode = code),
  (e: unknown) => {
    console.error(`perf did not finish: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 2;
  },
);
