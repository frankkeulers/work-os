import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDataDir, paths } from '../config/dataDir';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { memoryKeychain, SLACK_TOKEN_ACCOUNT } from '../config/keychain';
import { CursorFile } from '../pipeline/cursors';
import { pollSource, type PollDeps } from '../pipeline/poll';
import { SlackAdapter } from '../sources/slack/adapter';
import { SlackApi } from '../sources/slack/api';
import { FakeSlack } from '../sources/slack/fakeSlack';
import { isoToTs } from '../sources/slack/normalise';
import { ItemFiles } from '../store/items';
import { Store } from '../store/store';

// The poll part of NF-7 (25 active threads, < 10 s excluding Claude): the real adapter and
// pipeline against the fake Slack with a realistic delay on every call. Two polls: the first, which
// finds all 25 threads, and a scheduled one after a new reply in each.

export interface PollBench {
  threads: number;
  latencyMs: number;
  firstMs: number;
  nextMs: number;
  calls: number;
  maxInFlight: number;
  items: number;
}

export async function pollBench(opts: { threads?: number; latencyMs?: number } = {}): Promise<PollBench> {
  const threads = opts.threads ?? 25;
  const latencyMs = opts.latencyMs ?? 150;
  const dir = await mkdtemp(join(tmpdir(), 'workos-perf-poll-'));
  const slack = new FakeSlack();
  slack.latencyMs = latencyMs;
  const users = Array.from({ length: 10 }, (_, i) => `U${100 + i}`);
  users.forEach((u, i) => slack.users.set(u, `Person ${i + 1}`));
  for (let c = 0; c < 5; c++) slack.channel({ id: `C0${c}`, name: `channel-${c}` });
  const ago = (mins: number) => isoToTs(Date.now() - mins * 60_000);
  const parents: { channel: string; ts: string }[] = [];
  for (let t = 0; t < threads; t++) {
    const channel = `C0${t % 5}`;
    const ts = ago(300 - t * 5);
    parents.push({ channel, ts });
    slack.post(channel, { ts, user: users[t % 10], text: `synthetic thread ${t}` });
    for (let r = 1; r <= 3; r++) slack.post(channel, { ts: ago(300 - t * 5 - r), thread_ts: ts, user: users[(t + r) % 10], text: `synthetic reply ${r}` });
  }

  try {
    const settings = defaultSettings(dir);
    await initDataDir(dir, { settings, rules: DEFAULT_RULES });
    const { store } = await Store.open({ dataDir: dir });
    const d: PollDeps = { store, items: new ItemFiles(join(dir, 'items')), cursors: await CursorFile.open(paths(dir).cursors), now: () => new Date() };
    const adapter = new SlackAdapter({ api: new SlackApi(memoryKeychain({ [SLACK_TOKEN_ACCOUNT]: slack.token }), slack.fetch), settings });
    const signal = new AbortController().signal;

    let t0 = performance.now();
    await pollSource(d, adapter, 'first', signal);
    const firstMs = performance.now() - t0;

    parents.forEach((p, i) => slack.post(p.channel, { ts: ago(0.5 - i * 0.001), thread_ts: p.ts, user: users[(i + 5) % 10], text: 'synthetic new reply' }));
    const callsBefore = slack.calls.length;
    t0 = performance.now();
    await pollSource(d, adapter, 'scheduled', signal);
    const nextMs = performance.now() - t0;

    const items = Object.keys(store.projection.items).length;
    await store.close();
    return { threads, latencyMs, firstMs, nextMs, calls: slack.calls.length - callsBefore, maxInFlight: slack.maxInFlight, items };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
