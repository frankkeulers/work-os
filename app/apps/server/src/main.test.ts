import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';

// The real entry point in a child process (--fakes: made-up Slack, in-memory Keychain): a SIGTERM
// that arrives while it is still starting must stop it cleanly, not kill it with the lock held.

const APP = resolve(import.meta.dirname, '../../..');
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-main-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

it('stops cleanly on a SIGTERM that arrives during startup', async () => {
  const data = join(dir, 'data');
  const lock = join(data, 'state/lock');
  const child = spawn(join(APP, 'node_modules/.bin/tsx'), [join(APP, 'apps/server/src/main.ts'), '--fakes'], {
    env: { ...process.env, WORKOS_INSTANCE: 'dev', WORKOS_DATA_DIR: data, WORKOS_PORT: '4396', WORKOS_LAUNCHD: '1' },
    stdio: 'ignore',
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
  // The lock is the first thing run() takes; the rest of the start is still to come.
  const until = Date.now() + 20_000;
  while (!(await exists(lock)) && Date.now() < until) await new Promise((r) => setTimeout(r, 2));
  child.kill('SIGTERM');
  expect(await exited).toEqual({ code: 0, signal: null });
  expect(await exists(lock)).toBe(false);
  // Not counted as a crash towards safe mode.
  const { runs } = JSON.parse(await readFile(join(data, 'state/runs.json'), 'utf8')) as { runs: { clean: boolean }[] };
  expect(runs.at(-1)?.clean).toBe(true);
}, 30_000);
