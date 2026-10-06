import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { InboxView, ItemView, WorkEvent } from '@work-os/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { FAKE_API_TOKEN } from './fakes';
import type { CrashPoint } from './runtime/crash';

// Crash injection (PLAN.md Verification): the real entry point in a child process (--fakes), killed
// with SIGKILL at a point in a write sequence, then started again. Afterwards the log must have no
// duplicate, no gap and no orphan, and an approved write must have happened exactly once.

const APP = resolve(import.meta.dirname, '../../..');
const auth = { authorization: `Bearer ${FAKE_API_TOKEN}` };
let port = 4381;

interface Server {
  child: ChildProcess;
  base: string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(data: string, crashAt?: CrashPoint): Server {
  const p = port++;
  const child = spawn(join(APP, 'node_modules/.bin/tsx'), [join(APP, 'apps/server/src/main.ts'), '--fakes'], {
    env: { ...process.env, WORKOS_INSTANCE: 'dev', WORKOS_DATA_DIR: data, WORKOS_PORT: String(p), WORKOS_LAUNCHD: '1', ...(crashAt && { WORKOS_CRASH_AT: crashAt }) },
    stdio: 'ignore',
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  return { child, base: `http://127.0.0.1:${p}`, exited };
}

async function get<T>(s: Server, path: string): Promise<T | undefined> {
  try {
    const r = await fetch(`${s.base}${path}`, { headers: auth });
    return r.ok ? ((await r.json()) as T) : undefined;
  } catch {
    return undefined; // not listening yet
  }
}

async function send(s: Server, path: string, body?: object) {
  const r = await fetch(`${s.base}${path}`, { method: 'POST', headers: { ...auth, ...(body && { 'content-type': 'application/json' }) }, ...(body && { body: JSON.stringify(body) }) });
  return { status: r.status, body: (await r.json().catch(() => undefined)) as { id: string } | undefined };
}

async function until<T>(f: () => Promise<T | undefined | false>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const polled = (s: Server) => until(async () => ((await get<InboxView>(s, '/api/inbox'))?.source.lastPollAt ? get<InboxView>(s, '/api/inbox') : undefined), 'the first poll');

/** Killed outright: tsx runs the server as its child and reports a SIGKILL as exit code 137. */
async function killed(s: Server) {
  const e = await s.exited;
  expect(e.signal === 'SIGKILL' || e.code === 137, `exit ${JSON.stringify(e)}`).toBe(true);
}

async function stop(s: Server) {
  s.child.kill('SIGTERM');
  expect(await s.exited).toEqual({ code: 0, signal: null });
}

async function events(data: string): Promise<WorkEvent[]> {
  const dir = join(data, 'events');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.jsonl')).sort();
  const out: WorkEvent[] = [];
  for (const f of files) for (const line of (await readFile(join(dir, f), 'utf8')).split('\n')) if (line) out.push(JSON.parse(line) as WorkEvent);
  return out;
}

/** No gap in seq, no item upserted twice at the same revision, and no item file the log doesn't know. */
async function checkConsistent(data: string) {
  const log = await events(data);
  expect(log.map((e) => e.seq)).toEqual(log.map((_, i) => i + 1));
  const revisions = new Map<string, number[]>();
  for (const e of log) if (e.type === 'item.upserted') revisions.set(e.itemId!, [...(revisions.get(e.itemId!) ?? []), (e.data as { revision: number }).revision]);
  for (const [id, revs] of revisions) expect(new Set(revs).size, `${id} upserted twice at one revision`).toBe(revs.length);
  const files = await readdir(join(data, 'items/slack'));
  expect(files.length).toBe(revisions.size);
  return log;
}

let reference: string[];

beforeAll(async () => {
  // A clean run: what one poll of the made-up Slack should give.
  const s = start(join(await mkdtemp(join(tmpdir(), 'workos-crash-')), 'data'));
  reference = (await polled(s)).items.map((i) => i.title).sort();
  await stop(s);
  expect(reference.length).toBeGreaterThan(2);
}, 60_000);

describe('a crash in the middle of a poll (FR-2.8)', () => {
  for (const point of ['after-items', 'after-events', 'after-cursor'] as const) {
    it(`recovers from a kill ${point.replace('-', ' ')}`, async () => {
      const data = join(await mkdtemp(join(tmpdir(), 'workos-crash-')), 'data');
      await killed(start(data, point));
      const s = start(data);
      const inbox = await polled(s);
      expect(inbox.items.map((i) => i.title).sort()).toEqual(reference);
      await stop(s);
      await checkConsistent(data);
    }, 60_000);
  }
});

describe('a crash in the middle of an approved write (FR-14.5, NF-5)', () => {
  for (const point of ['before-write', 'after-write'] as const) {
    it(`writes the vault note exactly once after a kill ${point.replace('-', ' ')}`, async () => {
      const data = join(await mkdtemp(join(tmpdir(), 'workos-crash-')), 'data');
      let s = start(data);
      const inbox = await polled(s);
      const item = inbox.items[0];
      const requested = await send(s, `/api/items/${encodeURIComponent(item.id)}/actions`, { type: 'vault_note' });
      expect(requested.status).toBe(201);
      const actionId = requested.body!.id;
      const view = () => get<ItemView>(s, `/api/items/${encodeURIComponent(item.id)}`);
      const ready = await until(async () => ((await view())?.actions.find((a) => a.id === actionId)?.status === 'ready' ? view() : undefined), 'the draft');
      const draft = ready.drafts[actionId] as { path: string; content: string };
      await stop(s);

      s = start(data, point);
      await until(() => get(s, '/api/health'), 'the restart');
      expect((await send(s, `/api/actions/${actionId}/approve`)).status).toBe(202);
      await killed(s);

      s = start(data);
      const done = await until(async () => {
        const v = await view();
        const a = v?.actions.find((x) => x.id === actionId);
        return a && a.status !== 'approved' && a.status !== 'executing' ? a : undefined;
      }, 'the outbox');
      expect(done.status).toBe('done');
      await stop(s);
      // Exactly one write: the note holds the draft once.
      expect(await readFile(join(data, 'sandbox/vault', draft.path), 'utf8')).toBe(draft.content);
      const log = await checkConsistent(data);
      expect(log.filter((e) => e.actionId === actionId && e.type === 'action.executed')).toHaveLength(1);
    }, 90_000);
  }
});
