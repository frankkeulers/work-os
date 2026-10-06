import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { EXIT, exitCode, type RuntimeConfig } from '../config/env';
import { paths } from '../config/dataDir';
import type { Notifier } from '../notify/macos';
import { writeJsonAtomic } from '../store/atomic';

// CL-2: Claude runs on Frank's subscription. The Agent SDK would silently prefer an API key, so
// the server refuses to run while ANTHROPIC_API_KEY is set, even to an empty value.

export const apiKeySet = (env: NodeJS.ProcessEnv) => Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY');

export const API_KEY_FIX = 'Unset ANTHROPIC_API_KEY (launchctl unsetenv ANTHROPIC_API_KEY, and remove it from your shell profile), then run npm run agent:status.';

/** Records and announces the refusal. Returns the exit code. Never reads or records the key itself. */
export async function refuseApiKey(config: RuntimeConfig, notifier: Notifier, now = new Date()): Promise<number> {
  const file = paths(config.dataDir).refused;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeJsonAtomic(file, { reason: 'api_key', at: now.toISOString(), instance: config.instance, fix: API_KEY_FIX, schemaVersion: 1 });
  } catch {
    // The notification and stderr still explain it.
  }
  process.stderr.write(`Work OS refused to start: ANTHROPIC_API_KEY is set (CL-2). ${API_KEY_FIX}\n`);
  await notifier.notify({ title: 'Work OS did not start', message: 'ANTHROPIC_API_KEY is set. Unset it so Work OS uses your Claude subscription.' });
  return exitCode(EXIT.config, config.underLaunchd);
}

/** A clean start clears an earlier refusal. */
export const clearRefusal = (dataDir: string) => rm(paths(dataDir).refused, { force: true });
