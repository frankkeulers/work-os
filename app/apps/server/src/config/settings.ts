import { readFile } from 'node:fs/promises';
import { Rules, Settings, type FieldIssue, type Rule } from '@work-os/shared';
import type { z } from 'zod';
import { writeFileAtomic } from '../store/atomic';
import { paths } from './dataDir';

// Settings and rules, validated at startup (FR-1.2). An invalid file never stops the server: it
// falls back to the last copy that passed, and with none it stays up with every source paused.

export type SettingsLoad =
  | { status: 'ok'; settings: Settings; rules: Rule[] }
  | { status: 'fallback'; settings: Settings; rules: Rule[]; issues: FieldIssue[] }
  | { status: 'paused'; issues: FieldIssue[] };

type Read<T> = { ok: true; value: T; raw: string } | { ok: false; issues: FieldIssue[] };

async function readValid<T>(file: string, schema: z.ZodType<T>, prefix: string): Promise<Read<T>> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, issues: [{ path: prefix, message: code === 'ENOENT' ? 'File is missing' : `Cannot read the file (${code})` }] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    return { ok: false, issues: [{ path: prefix, message: `Not valid JSON: ${(e as Error).message}` }] };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: [prefix, ...i.path].join('.'), message: i.message })) };
  }
  return { ok: true, value: parsed.data, raw };
}

async function keepLastGood(file: string, raw: string) {
  const current = await readFile(file, 'utf8').catch(() => undefined);
  if (current !== raw) await writeFileAtomic(file, raw);
}

export async function loadSettings(dataDir: string): Promise<SettingsLoad> {
  const p = paths(dataDir);
  const [settings, rules] = await Promise.all([readValid(p.settings, Settings, 'settings'), readValid(p.rules, Rules, 'rules')]);
  if (settings.ok && rules.ok) {
    await keepLastGood(p.settingsLastGood, settings.raw);
    await keepLastGood(p.rulesLastGood, rules.raw);
    return { status: 'ok', settings: settings.value, rules: rules.value };
  }
  const issues = [...(settings.ok ? [] : settings.issues), ...(rules.ok ? [] : rules.issues)];
  const s = settings.ok ? settings : await readValid(p.settingsLastGood, Settings, 'settings');
  const r = rules.ok ? rules : await readValid(p.rulesLastGood, Rules, 'rules');
  if (s.ok && r.ok) return { status: 'fallback', settings: s.value, rules: r.value, issues };
  return { status: 'paused', issues };
}
