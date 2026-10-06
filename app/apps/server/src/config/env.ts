import { homedir } from 'node:os';
import { resolve } from 'node:path';

// Runtime configuration from the environment. The launchd plist sets these for the autostarted
// instance (FR-12.3); `npm run dev` sets WORKOS_INSTANCE=dev. Nothing here is a secret.

export type Instance = 'prod' | 'dev';

export interface RuntimeConfig {
  instance: Instance;
  dataDir: string;
  host: '127.0.0.1'; // never any other interface (FR-3.3)
  port: number;
  underLaunchd: boolean; // exit codes differ: launchd must not restart a refusal in a loop (CL-2)
  version: string;
  forceDryRun: boolean; // development never writes to the real vault or Confluence (FR-1.6)
}

export const PORTS: Record<Instance, number> = { prod: 4317, dev: 4318 };

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export const expandHome = (p: string, home: string) => (p === '~' || p.startsWith('~/') ? home + p.slice(1) : p);

export function resolveConfig(env: NodeJS.ProcessEnv, home = homedir()): RuntimeConfig {
  const instance: Instance = env.WORKOS_INSTANCE === 'prod' ? 'prod' : 'dev';
  const prodDir = resolve(home, 'WorkOS-data');
  const dataDir = resolve(expandHome(env.WORKOS_DATA_DIR ?? (instance === 'prod' ? prodDir : `${prodDir}-dev`), home));
  if (instance === 'dev' && dataDir === prodDir && env.WORKOS_ALLOW_PROD_DATA !== '1') {
    throw new ConfigError(`Development refuses the autostarted instance's data directory (${dataDir}). Set WORKOS_ALLOW_PROD_DATA=1 to override.`);
  }
  const port = env.WORKOS_PORT === undefined ? PORTS[instance] : Number(env.WORKOS_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`WORKOS_PORT must be a port number, got "${env.WORKOS_PORT}".`);
  return {
    instance,
    dataDir,
    host: '127.0.0.1',
    port,
    underLaunchd: env.WORKOS_LAUNCHD === '1',
    version: env.WORKOS_VERSION || BUILD_VERSION,
    forceDryRun: instance === 'dev',
  };
}

/** Set by the deploy bundle (esbuild define); a dev run from source says so. */
export const BUILD_VERSION: string = process.env.WORKOS_BUILD_VERSION || '0.1.0-dev';

/** Exit codes. Under launchd every deliberate stop exits 0, so KeepAlive restarts crashes only. */
export const EXIT = { ok: 0, crash: 1, lockHeld: 75, config: 78 } as const;

export const exitCode = (code: number, underLaunchd: boolean) => (underLaunchd && code !== EXIT.crash ? EXIT.ok : code);
