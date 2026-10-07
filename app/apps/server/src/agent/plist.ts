import { isAbsolute, join } from 'node:path';

// Renders the LaunchAgent plist (PLAN.md robustness §1, FR-12.3) from
// scripts/launchd/com.polestar.workos.plist.tmpl. Every path is absolute and nothing secret goes
// in: launchd keeps the plist in a world-readable folder.

export const LABEL = 'com.polestar.workos';
export const PROD_PORT = 4317;
/** Node's flags in the plist's ProgramArguments, which `npm run perf` also starts the server with.
 * The young generation is capped at 2 MB semi-spaces: an idle server doesn't need V8's default
 * 16 MB, and RSS stays inside its budget (NF-11). */
export const NODE_FLAGS = ['--max-old-space-size=256', '--max-semi-space-size=2'];

/** Where releases live. The prod instance never runs from the repo, so a checkout can't break it. */
export const appSupportDir = (home: string) => join(home, 'Library', 'Application Support', 'WorkOS');
export const plistPath = (home: string) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);

export interface AgentPaths {
  home: string;
  /** The node binary launchd runs. */
  node: string;
  /** The deploy root; `current` inside it points at the running release. */
  root: string;
  dataDir: string;
  port?: number;
  /** The repo's guide folder, read live so an edited page shows without a deploy (FR-1.8). */
  guideDir: string;
}

/** A PATH with no shell profile behind it: system tools, Homebrew and node's own folder. */
export function launchdPath(node: string): string {
  const dirs = [node.slice(0, node.lastIndexOf('/')), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return [...new Set(dirs)].join(':');
}

export function plistVars(p: AgentPaths): Record<string, string> {
  const current = join(p.root, 'current');
  return {
    LABEL,
    NODE: p.node,
    ENTRY: join(current, 'server.mjs'),
    WORKDIR: current,
    PATH: launchdPath(p.node),
    DATA_DIR: p.dataDir,
    PORT: String(p.port ?? PROD_PORT),
    WEB_DIR: join(current, 'web'),
    GUIDE_DIR: p.guideDir,
    STDOUT: join(p.dataDir, 'logs', 'launchd.out.log'),
    STDERR: join(p.dataDir, 'logs', 'launchd.err.log'),
  };
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderPlist(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_m, key: string) => {
    const v = vars[key];
    if (v === undefined) throw new Error(`The plist template uses {{${key}}}, which has no value.`);
    return xml(v);
  });
}

const PATH_KEYS = ['NODE', 'ENTRY', 'WORKDIR', 'DATA_DIR', 'WEB_DIR', 'GUIDE_DIR', 'STDOUT', 'STDERR'];
const SECRETISH = /(API_KEY|TOKEN|SECRET|PASSWORD|xox[a-z]-|sk-ant-)/i;

/** What is wrong with a rendered plist, if anything. */
export function plistProblems(rendered: string, vars: Record<string, string>): string[] {
  const problems: string[] = [];
  if (/\{\{[A-Z_]+\}\}/.test(rendered)) problems.push('Unfilled placeholders remain.');
  for (const k of PATH_KEYS) if (!isAbsolute(vars[k] ?? '')) problems.push(`${k} is not an absolute path: ${vars[k]}`);
  for (const dir of (vars.PATH ?? '').split(':')) if (!isAbsolute(dir)) problems.push(`PATH entry is not absolute: ${dir}`);
  const body = rendered.replace(/<!--[\s\S]*?-->/g, '');
  if (SECRETISH.test(body)) problems.push('The plist mentions something that looks like a secret. Secrets belong in the Keychain.');
  return problems;
}

/** Node installs that move on upgrade, which would leave launchd pointing at nothing. */
export function nodePathWarning(node: string): string | undefined {
  if (/\/\.(nvm|volta|asdf|fnm)\//.test(node) || /\/Cellar\//.test(node)) {
    return `node is at ${node}, which changes when node is upgraded. Prefer a stable path such as /usr/local/bin/node or /opt/homebrew/bin/node.`;
  }
  return undefined;
}
