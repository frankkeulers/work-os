import { access, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Rule, Settings } from '@work-os/shared';
import { writeJsonAtomic } from '../store/atomic';

// The data directory layout (PLAN.md §4.3). Created on first run with owner-only permissions (FR-1.1).

export const DIRS = ['config', 'config/prompts', 'state', 'events', 'events/quarantine', 'items', 'drafts', 'labels', 'logs', 'sandbox'] as const;

export const paths = (dataDir: string) => ({
  settings: join(dataDir, 'config/settings.json'),
  settingsLastGood: join(dataDir, 'config/settings.last-good.json'),
  rules: join(dataDir, 'config/rules.json'),
  rulesLastGood: join(dataDir, 'config/rules.last-good.json'),
  lock: join(dataDir, 'state/lock'),
  snapshot: join(dataDir, 'state/snapshot.json'),
  events: join(dataDir, 'events'),
  refused: join(dataDir, 'state/refused.json'),
  logs: join(dataDir, 'logs'),
});

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** Creates any missing directories and default config files. Never overwrites an existing file. */
export async function initDataDir(dataDir: string, defaults: { settings: Settings; rules: Rule[] }): Promise<{ created: string[] }> {
  const created: string[] = [];
  const fresh = !(await exists(dataDir));
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (fresh) await chmod(dataDir, 0o700);
  for (const d of DIRS) await mkdir(join(dataDir, d), { recursive: true, mode: 0o700 });
  const p = paths(dataDir);
  if (!(await exists(p.settings))) {
    await writeJsonAtomic(p.settings, defaults.settings);
    created.push('config/settings.json');
  }
  if (!(await exists(p.rules))) {
    await writeJsonAtomic(p.rules, defaults.rules);
    created.push('config/rules.json');
  }
  return { created };
}
