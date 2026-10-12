import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Rule, Settings } from '@work-os/shared';
import { writeFileAtomic, writeJsonAtomic } from '../store/atomic';

// The data directory layout (PLAN.md §4.3). Created on first run with owner-only permissions (FR-1.1).

export const DIRS = ['config', 'config/prompts', 'state', 'events', 'events/quarantine', 'items', 'drafts', 'labels', 'logs', 'sandbox'] as const;

export const paths = (dataDir: string) => ({
  settings: join(dataDir, 'config/settings.json'),
  settingsLastGood: join(dataDir, 'config/settings.last-good.json'),
  rules: join(dataDir, 'config/rules.json'),
  rulesLastGood: join(dataDir, 'config/rules.last-good.json'),
  lock: join(dataDir, 'state/lock'),
  snapshot: join(dataDir, 'state/snapshot.json'),
  cursors: join(dataDir, 'state/cursors.json'),
  calendar: join(dataDir, 'state/calendar.json'),
  events: join(dataDir, 'events'),
  refused: join(dataDir, 'state/refused.json'),
  logs: join(dataDir, 'logs'),
  labels: join(dataDir, 'labels/triage.jsonl'),
  settleLabels: join(dataDir, 'labels/settle.jsonl'),
  finishLabels: join(dataDir, 'labels/finish.jsonl'),
  filingLabels: join(dataDir, 'labels/filing.jsonl'),
});

const exists = (p: string) =>
  access(p).then(
    () => true,
    () => false,
  );

/** A default text file under config/, and the sha1s (of trimmed text) of earlier defaults it replaces. */
export interface DefaultFile {
  file: string;
  text: string;
  previous?: string[];
}

/**
 * Creates any missing directories and default config files. Never overwrites an existing file,
 * except a text file that still holds an earlier built-in default, which gets the current one.
 */
export async function initDataDir(dataDir: string, defaults: { settings: Settings; rules: Rule[]; files?: DefaultFile[] }): Promise<{ created: string[]; upgraded: string[] }> {
  const created: string[] = [];
  const upgraded: string[] = [];
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
  for (const { file, text, previous = [] } of defaults.files ?? []) {
    const path = join(dataDir, 'config', file);
    const current = await readFile(path, 'utf8').catch(() => null);
    if (current === null) {
      await writeFileAtomic(path, text);
      created.push(`config/${file}`);
    } else if (previous.includes(createHash('sha1').update(current.trim()).digest('hex'))) {
      await writeFileAtomic(path, text);
      upgraded.push(`config/${file}`);
    }
  }
  return { created, upgraded };
}
