import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isDisabled, Launchctl, parsePrint } from './launchctl';
import { LABEL, launchdPath, NODE_FLAGS, nodePathWarning, plistProblems, plistVars, renderPlist } from './plist';
import { currentRelease, pruneReleases, releaseName, swapCurrent, toPrune } from './release';

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../scripts/launchd/com.polestar.workos.plist.tmpl');
const HOME = '/Users/test user';
const input = { home: HOME, node: '/usr/local/bin/node', root: `${HOME}/Library/Application Support/WorkOS`, dataDir: `${HOME}/WorkOS-data`, guideDir: `${HOME}/Documents/WORK_OS/app/docs/guide` };

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-agent-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('LaunchAgent plist (FR-12.3)', () => {
  it('renders a plist that plutil accepts, with the keys robustness §1 needs', async () => {
    const vars = plistVars(input);
    const rendered = renderPlist(await readFile(TEMPLATE, 'utf8'), vars);
    expect(plistProblems(rendered, vars)).toEqual([]);
    const file = join(dir, `${LABEL}.plist`);
    await writeFile(file, rendered);
    expect(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' })).toMatch(/OK/);
    const p = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
    expect(p).toMatchObject({
      Label: LABEL,
      ProgramArguments: ['/usr/local/bin/node', ...NODE_FLAGS, `${input.root}/current/server.mjs`], // perf measures with these flags
      WorkingDirectory: `${input.root}/current`,
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
      ThrottleInterval: 30,
      ProcessType: 'Standard',
      ExitTimeOut: 10,
      LimitLoadToSessionType: 'Aqua',
      AbandonProcessGroup: false,
      StandardErrorPath: `${HOME}/WorkOS-data/logs/launchd.err.log`,
      EnvironmentVariables: {
        NODE_ENV: 'production',
        WORKOS_INSTANCE: 'prod',
        WORKOS_LAUNCHD: '1',
        WORKOS_DATA_DIR: `${HOME}/WorkOS-data`,
        WORKOS_PORT: '4317',
        WORKOS_WEB_DIR: `${input.root}/current/web`,
        WORKOS_GUIDE_DIR: input.guideDir,
      },
    });
    expect(Object.keys(p.EnvironmentVariables).sort()).toEqual(['NODE_ENV', 'PATH', 'WORKOS_DATA_DIR', 'WORKOS_GUIDE_DIR', 'WORKOS_INSTANCE', 'WORKOS_LAUNCHD', 'WORKOS_PORT', 'WORKOS_WEB_DIR']);
  });

  it('escapes paths for XML', () => {
    const out = renderPlist('<string>{{DATA_DIR}}</string>', { DATA_DIR: '/Users/a&b/<x>' });
    expect(out).toBe('<string>/Users/a&amp;b/&lt;x&gt;</string>');
    expect(() => renderPlist('{{NOPE}}', {})).toThrow(/NOPE/);
  });

  it('refuses relative paths, leftovers and anything that looks like a secret', () => {
    const vars = { ...plistVars(input), NODE: 'node' };
    expect(plistProblems('<string>node</string>', vars)).toEqual(['NODE is not an absolute path: node']);
    expect(plistProblems('{{PORT}}', plistVars(input))).toContain('Unfilled placeholders remain.');
    expect(plistProblems('<key>ANTHROPIC_API_KEY</key>', plistVars(input))).toHaveLength(1);
    expect(plistProblems('<string>xoxp-123</string>', plistVars(input))).toHaveLength(1);
    expect(plistProblems('<!-- secrets stay in the Keychain: no TOKEN here --><dict/>', plistVars(input))).toEqual([]);
  });

  it('builds a PATH that needs no shell profile', () => {
    expect(launchdPath('/opt/homebrew/bin/node')).toBe('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  });

  it('warns about node installs that move on upgrade', () => {
    expect(nodePathWarning('/Users/f/.nvm/versions/node/v24.16.0/bin/node')).toMatch(/upgraded/);
    expect(nodePathWarning('/opt/homebrew/Cellar/node/24.16.0/bin/node')).toMatch(/stable path/);
    expect(nodePathWarning('/usr/local/bin/node')).toBeUndefined();
  });
});

describe('launchctl', () => {
  const PRINT = `gui/501/${LABEL} = {\n\tactive count = 1\n\tpath = /Users/f/Library/LaunchAgents/${LABEL}.plist\n\tstate = running\n\n\tprogram = /usr/local/bin/node\n\truns = 3\n\tpid = 4242\n\tlast exit code = 1\n\tenvironment = {\n\t\tstate = nested-should-be-ignored\n\t}\n}\n`;

  it('reads state, pid, runs and the last exit code', () => {
    expect(parsePrint(PRINT)).toEqual({ state: 'running', pid: 4242, lastExitCode: '1', runs: 3 });
    expect(parsePrint('\tstate = not running\n\tlast exit code = (never exited)\n')).toEqual({ state: 'not running', pid: undefined, lastExitCode: '(never exited)', runs: undefined });
  });

  it('spots the agent switched off in Login Items', () => {
    expect(isDisabled(`\tdisabled services = {\n\t\t"${LABEL}" => disabled\n\t\t"com.other" => enabled\n\t}`)).toBe(true);
    expect(isDisabled(`\t\t"${LABEL}" => enabled\n`)).toBe(false);
    expect(isDisabled('\t\t"com.polestarXworkos" => disabled\n')).toBe(false);
  });

  it('uses the gui domain, enables before bootstrapping, and never returns the API key', async () => {
    const calls: string[][] = [];
    const lc = new Launchctl(async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'getenv') return { code: 0, stdout: 'sk-ant-not-real\n' };
      if (args[0] === 'print') return { code: 113, stdout: '' };
      return { code: 0, stdout: '' };
    }, 501);
    await lc.bootstrap('/p.plist');
    expect(calls).toEqual([
      ['enable', `gui/501/${LABEL}`],
      ['bootstrap', 'gui/501', '/p.plist'],
    ]);
    expect(await lc.apiKeyInLaunchdEnv()).toBe(true);
    expect(await lc.info()).toEqual({ loaded: false });
  });

  it('explains a failed bootstrap', async () => {
    const lc = new Launchctl(async (_c, args) => ({ code: args[0] === 'bootstrap' ? 5 : 0, stdout: '' }), 501);
    await expect(lc.bootstrap('/p.plist')).rejects.toThrow(/Login Items/);
  });
});

describe('releases', () => {
  it('names releases so they sort by time', () => {
    expect(releaseName('0.1.0', new Date('2026-10-06T17:05:09.123Z'), 'e73225c')).toBe('0.1.0-20261006T170509Z-e73225c');
  });

  it('keeps the newest three and never the current one', () => {
    const names = ['0.1.0-20261001T000000Z-a', '0.1.0-20261002T000000Z-b', '0.1.0-20261003T000000Z-c', '0.1.0-20261004T000000Z-d', '.staging-x'];
    expect(toPrune(names, '0.1.0-20261004T000000Z-d')).toEqual(['0.1.0-20261001T000000Z-a']);
    // Rolled back to an old release: it stays even though it is not among the newest.
    expect(toPrune(names, '0.1.0-20261001T000000Z-a', 2)).toEqual(['0.1.0-20261002T000000Z-b']);
  });

  it('swaps current atomically and prunes old folders', async () => {
    for (const d of ['1', '2', '3', '4', '5']) await mkdir(join(dir, 'releases', `0.1.0-2026100${d}T000000Z-x`), { recursive: true });
    await swapCurrent(dir, '0.1.0-20261005T000000Z-x');
    expect(await readlink(join(dir, 'current'))).toBe('releases/0.1.0-20261005T000000Z-x');
    await swapCurrent(dir, '0.1.0-20261004T000000Z-x');
    expect(await currentRelease(dir)).toBe('0.1.0-20261004T000000Z-x');
    expect(await pruneReleases(dir)).toEqual(['0.1.0-20261002T000000Z-x', '0.1.0-20261001T000000Z-x']);
    expect((await readdir(join(dir, 'releases'))).sort()).toEqual(['0.1.0-20261003T000000Z-x', '0.1.0-20261004T000000Z-x', '0.1.0-20261005T000000Z-x']);
    expect((await readdir(dir)).filter((f) => f.startsWith('.current'))).toEqual([]);
  });
});
