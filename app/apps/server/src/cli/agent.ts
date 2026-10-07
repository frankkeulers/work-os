import { chmod, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenAccount } from '../api/auth';
import { paths } from '../config/dataDir';
import { macKeychain } from '../config/keychain';
import { Launchctl } from '../agent/launchctl';
import { appSupportDir, nodePathWarning, plistPath, plistProblems, plistVars, PROD_PORT, renderPlist } from '../agent/plist';
import { currentRelease } from '../agent/release';
import { systemNotifier } from '../notify/macos';
import { exec } from '../runtime/checks';
import { writeFileAtomic } from '../store/atomic';

// npm run agent:install | agent:uninstall | agent:status (FR-12.3, PLAN.md robustness §1).
// The agent runs the deployed release (npm run deploy), never the repo.

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const TEMPLATE = join(APP, 'scripts/launchd/com.polestar.workos.plist.tmpl');

const home = homedir();
const root = appSupportDir(home);
const dataDir = join(home, 'WorkOS-data');
const plist = plistPath(home);
const lc = new Launchctl(exec, process.getuid?.() ?? 0);

async function install(): Promise<number> {
  const current = await currentRelease(root);
  if (!current) {
    console.error(`No release at ${root}/current. Run \`npm run deploy\` first.`);
    return 1;
  }
  const node = process.execPath;
  const warning = nodePathWarning(node);
  if (warning) console.warn(`Warning: ${warning}`);

  const vars = plistVars({ home, node, root, dataDir, guideDir: join(APP, 'docs/guide') });
  const rendered = renderPlist(await readFile(TEMPLATE, 'utf8'), vars);
  const problems = plistProblems(rendered, vars);
  if (problems.length) {
    console.error(`Refusing to install the plist:\n- ${problems.join('\n- ')}`);
    return 1;
  }
  // launchd creates the log files but not their folder.
  await mkdir(join(dataDir, 'logs'), { recursive: true, mode: 0o700 });
  await mkdir(dirname(plist), { recursive: true });
  await writeFileAtomic(plist, rendered);
  await chmod(plist, 0o644);
  const lint = await exec('/usr/bin/plutil', ['-lint', plist]);
  if (lint.code !== 0) {
    console.error(`plutil rejected ${plist}:\n${lint.stdout}`);
    return 1;
  }
  await lc.bootout(); // reinstall: unload the old definition first
  await lc.bootstrap(plist);
  console.log(`Installed ${plist}. Work OS (${current}) starts now and at every login.`);
  return status(15_000);
}

async function uninstall(): Promise<number> {
  await lc.bootout();
  await rm(plist, { force: true });
  console.log(`Stopped Work OS and removed ${plist}. Releases and ${dataDir} are left as they are.`);
  return 0;
}

async function health(): Promise<{ mode?: string; phase?: string; version?: string; error?: string }> {
  const token = await macKeychain()
    .get(tokenAccount('prod'))
    .catch(() => undefined);
  if (!token) return { error: 'no API token in the Keychain yet (the server creates it on first start)' };
  try {
    const r = await fetch(`http://127.0.0.1:${PROD_PORT}/api/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    if (!r.ok) return { error: `HTTP ${r.status}` };
    return (await r.json()) as { mode: string; phase: string; version: string };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Prints the agent's state; waits up to `waitMs` for the server to answer. Exit 0 only if healthy. */
async function status(waitMs = 0): Promise<number> {
  const installed = !!(await stat(plist).catch(() => undefined));
  const info = await lc.info();
  const disabled = await lc.disabled();
  const apiKey = await lc.apiKeyInLaunchdEnv();
  let h = await health();
  for (const until = Date.now() + waitMs; h.error && Date.now() < until; h = await health()) await new Promise((r) => setTimeout(r, 1000));
  const refused = await readFile(paths(dataDir).refused, 'utf8').catch(() => undefined);

  const line = (ok: boolean, label: string, detail: string) => console.log(`${ok ? '✓' : '✗'} ${label.padEnd(18)} ${detail}`);
  line(installed, 'Plist', installed ? plist : 'not installed: npm run agent:install');
  line(info.loaded, 'launchd', info.loaded ? `${info.state ?? '?'}${info.pid ? `, pid ${info.pid}` : ''}, runs ${info.runs ?? '?'}, last exit ${info.lastExitCode ?? '?'}` : 'not loaded');
  if (disabled) line(false, 'Login Items', 'switched off: System Settings › General › Login Items › Allow in the Background');
  line(!apiKey, 'ANTHROPIC_API_KEY', apiKey ? 'set for GUI apps: run `launchctl unsetenv ANTHROPIC_API_KEY` (CL-2)' : 'not set');
  if (refused) line(false, 'Refused', `the server refused to start: see ${paths(dataDir).refused}`);
  line(!h.error, 'Health', h.error ?? `${h.mode}, ${h.phase}, ${h.version}`);
  line(true, 'Release', (await currentRelease(root)) ?? 'none deployed');
  // Not a failure: without it notifications still show, but a click can't open the item (FR-11.1).
  const notifier = await systemNotifier();
  line(notifier.kind === 'terminal-notifier', 'Notifications', notifier.kind === 'terminal-notifier' ? 'terminal-notifier' : 'osascript only: `brew install terminal-notifier` so a click opens the item');
  return installed && info.loaded && !apiKey && !h.error ? 0 : 1;
}

const commands: Record<string, () => Promise<number>> = { install, uninstall, status: () => status() };
const cmd = commands[process.argv[2] ?? ''];
if (!cmd) {
  console.error('Usage: agent install | uninstall | status');
  process.exit(2);
}
cmd().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
