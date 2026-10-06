import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Launchctl } from '../agent/launchctl';
import { appSupportDir } from '../agent/plist';
import { ensureRoot, pruneReleases, releaseName, swapCurrent } from '../agent/release';
import { exec } from '../runtime/checks';

// npm run deploy (PLAN.md robustness §1): bundles the server, copies it and the built web app into
// a new release folder, smoke-tests it, swaps `current`, and restarts the agent if it is loaded.
//
//   --root <dir>   deploy somewhere else (tests); default ~/Library/Application Support/WorkOS
//   --no-restart   leave the running agent alone

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SERVER = join(APP, 'apps/server');
const WEB_DIST = join(APP, 'apps/web/dist');

/** Packages kept out of the bundle and installed in the release instead. The Agent SDK joins in M2. */
const EXTERNALS: string[] = [];

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
};

function git(...args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: APP, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

async function main(): Promise<number> {
  const root = resolve(arg('--root') ?? appSupportDir(homedir()));
  const restart = !process.argv.includes('--no-restart');
  const pkg = JSON.parse(await readFile(join(SERVER, 'package.json'), 'utf8')) as { version: string; dependencies: Record<string, string> };

  if (!(await stat(join(WEB_DIST, 'index.html')).catch(() => undefined))) {
    console.error('The web app is not built. Run `npm run build` first (npm run deploy does both).');
    return 1;
  }
  const commit = git('rev-parse', '--short', 'HEAD') || 'nogit';
  const dirty = git('status', '--porcelain').length > 0;
  if (dirty) console.warn('Note: the working tree has uncommitted changes; they are in this release.');

  const name = releaseName(pkg.version, new Date(), commit + (dirty ? '-dirty' : ''));
  await ensureRoot(root);
  const stage = join(root, 'releases', `.staging-${name}`);
  await rm(stage, { recursive: true, force: true });
  await mkdir(stage, { recursive: true });

  const t0 = performance.now();
  const result = await build({
    entryPoints: [join(SERVER, 'src/main.ts')],
    outfile: join(stage, 'server.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'linked',
    legalComments: 'none',
    external: EXTERNALS,
    define: { 'process.env.WORKOS_BUILD_VERSION': JSON.stringify(name) },
    // Some dependencies are CommonJS and call require(); give the ESM bundle one.
    banner: {
      js: "import { createRequire as __workosRequire } from 'node:module';\nconst require = __workosRequire(import.meta.url);",
    },
    metafile: true,
    logLevel: 'warning',
  });
  const bytes = Object.values(result.metafile.outputs).reduce((n, o) => n + o.bytes, 0);
  console.log(`Bundled the server in ${Math.round(performance.now() - t0)} ms (${(bytes / 1024).toFixed(0)} kB).`);

  await cp(WEB_DIST, join(stage, 'web'), { recursive: true });
  const deps = Object.fromEntries(EXTERNALS.map((d) => [d, pkg.dependencies[d]]));
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'work-os-release', private: true, type: 'module', dependencies: deps }, null, 2));
  if (EXTERNALS.length) execFileSync('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit' });
  await writeFile(join(stage, 'release.json'), JSON.stringify({ name, version: pkg.version, commit, dirty, builtAt: new Date().toISOString(), node: process.version }, null, 2));

  // Smoke test: the bundle loads all its modules and reports the version it was built with.
  const said = execFileSync(process.execPath, [join(stage, 'server.mjs'), '--version'], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' }, timeout: 15_000 }).trim();
  if (said !== name) throw new Error(`The bundle reported version "${said}", expected "${name}".`);

  const final = join(root, 'releases', name);
  await rename(stage, final);
  await swapCurrent(root, name);
  console.log(`Deployed ${name} to ${final}`);
  const pruned = await pruneReleases(root);
  if (pruned.length) console.log(`Removed old releases: ${pruned.join(', ')}`);

  if (restart) {
    const lc = new Launchctl(exec, process.getuid?.() ?? 0);
    if ((await lc.info()).loaded) {
      await lc.kickstart();
      console.log('Restarted the agent. Check it with `npm run agent:status`.');
    } else {
      console.log('The agent is not installed. Install it with `npm run agent:install`.');
    }
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
