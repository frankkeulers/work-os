import { stat } from 'node:fs/promises';
import { Rules, Settings, type FieldIssue, type Rule } from '@work-os/shared';
import { writeFileAtomic } from '../store/atomic';
import { paths } from './dataDir';
import { defaultSettings } from './defaults';
import type { SettingsLoad } from './settings';

// The settings in force. Saving validates both files field by field, writes them atomically,
// and keeps them as the last good copy (FR-1.2, FR-1.5).

export class SettingsValidationError extends Error {
  constructor(readonly issues: FieldIssue[]) {
    super(`${issues.length} ${issues.length === 1 ? 'field needs' : 'fields need'} fixing before saving.`);
    this.name = 'SettingsValidationError';
  }
}

export class SettingsState {
  private constructor(
    private load: SettingsLoad,
    public savedAt: string,
    private readonly dataDir: string,
    private readonly forceDryRun: boolean,
  ) {}

  static async create(dataDir: string, load: SettingsLoad, forceDryRun: boolean) {
    const mtime = await stat(paths(dataDir).settings).then(
      (s) => s.mtime.toISOString(),
      () => new Date(0).toISOString(),
    );
    return new SettingsState(load, mtime, dataDir, forceDryRun);
  }

  get status() {
    return this.load.status;
  }

  get issues(): FieldIssue[] {
    return this.load.status === 'ok' ? [] : this.load.issues;
  }

  /** The settings in force, or undefined while paused. Development always has dry-run on. */
  get settings(): Settings | undefined {
    if (this.load.status === 'paused') return undefined;
    return this.forceDryRun ? { ...this.load.settings, dryRun: true } : this.load.settings;
  }

  get rules(): Rule[] {
    return this.load.status === 'paused' ? [] : this.load.rules;
  }

  /** What the Settings page edits: the settings in force, or safe defaults while paused. */
  get editable(): { settings: Settings; rules: Rule[] } {
    return this.load.status === 'paused' ? { settings: defaultSettings(this.dataDir), rules: [] } : { settings: this.load.settings, rules: this.load.rules };
  }

  /** Validates and saves. Returns what changed, so the caller logs the right events. */
  async save(input: { settings: unknown; rules: unknown }, now: Date) {
    const issues: FieldIssue[] = [];
    const s = Settings.safeParse(input.settings);
    if (!s.success) for (const i of s.error.issues) issues.push({ path: ['settings', ...i.path].join('.'), message: i.message });
    const r = Rules.safeParse(input.rules);
    if (!r.success) for (const i of r.error.issues) issues.push({ path: ['rules', ...i.path].join('.'), message: i.message });
    if (issues.length || !s.success || !r.success) throw new SettingsValidationError(issues);

    const before = this.load.status === 'paused' ? undefined : this.load;
    const settingsChanged = !before || JSON.stringify(before.settings) !== JSON.stringify(s.data);
    const rulesChanged = !before || JSON.stringify(before.rules) !== JSON.stringify(r.data);
    const p = paths(this.dataDir);
    const settingsJson = `${JSON.stringify(s.data, null, 2)}\n`;
    const rulesJson = `${JSON.stringify(r.data, null, 2)}\n`;
    await writeFileAtomic(p.settings, settingsJson);
    await writeFileAtomic(p.rules, rulesJson);
    await writeFileAtomic(p.settingsLastGood, settingsJson);
    await writeFileAtomic(p.rulesLastGood, rulesJson);
    this.load = { status: 'ok', settings: s.data, rules: r.data };
    this.savedAt = now.toISOString();
    return { settingsChanged, rulesChanged, settings: s.data, rules: r.data };
  }
}
