import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataDir, paths } from './dataDir';
import { DEFAULT_RULES, defaultSettings } from './defaults';
import { ConfigError, EXIT, exitCode, resolveConfig } from './env';
import { loadSettings } from './settings';
import { SettingsState } from './settingsState';

describe('resolveConfig', () => {
  const home = '/Users/test';

  it('defaults to the development instance, its own data directory and port', () => {
    expect(resolveConfig({}, home)).toMatchObject({ instance: 'dev', dataDir: '/Users/test/WorkOS-data-dev', port: 4318, host: '127.0.0.1', forceDryRun: true, underLaunchd: false });
  });

  it('runs the autostarted instance from ~/WorkOS-data on 4317', () => {
    expect(resolveConfig({ WORKOS_INSTANCE: 'prod', WORKOS_LAUNCHD: '1' }, home)).toMatchObject({ dataDir: '/Users/test/WorkOS-data', port: 4317, forceDryRun: false, underLaunchd: true });
  });

  it('keeps development away from the autostarted instance’s data unless told otherwise (CLAUDE.md 5)', () => {
    expect(() => resolveConfig({ WORKOS_DATA_DIR: '~/WorkOS-data' }, home)).toThrow(ConfigError);
    expect(resolveConfig({ WORKOS_DATA_DIR: '~/WorkOS-data', WORKOS_ALLOW_PROD_DATA: '1' }, home).dataDir).toBe('/Users/test/WorkOS-data');
  });

  it('rejects a port that is not a number', () => {
    expect(() => resolveConfig({ WORKOS_PORT: 'eighty' }, home)).toThrow(/WORKOS_PORT/);
    expect(resolveConfig({ WORKOS_PORT: '0' }, home).port).toBe(0);
  });

  it('exits 0 under launchd for deliberate stops, so KeepAlive restarts crashes only (CL-2)', () => {
    expect(exitCode(EXIT.lockHeld, false)).toBe(75);
    expect(exitCode(EXIT.config, false)).toBe(78);
    expect(exitCode(EXIT.lockHeld, true)).toBe(0);
    expect(exitCode(EXIT.config, true)).toBe(0);
    expect(exitCode(EXIT.crash, true)).toBe(1);
  });
});

describe('data directory and settings', () => {
  let dir: string;
  beforeEach(async () => {
    dir = join(await mkdtemp(join(tmpdir(), 'workos-cfg-')), 'data');
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  const init = () => initDataDir(dir, { settings: defaultSettings(dir), rules: DEFAULT_RULES });

  it('creates the layout and default config on first run, owner-only (FR-1.1, Story 1.1)', async () => {
    expect((await init()).created).toEqual(['config/settings.json', 'config/rules.json']);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'events/quarantine'))).isDirectory()).toBe(true);
    expect((await stat(paths(dir).settings)).mode & 0o777).toBe(0o600);
    const load = await loadSettings(dir);
    expect(load.status).toBe('ok');
  });

  it('fills the Confluence scope with the PSG defaults in a settings file from before it existed, and keeps an emptied one', async () => {
    await init();
    const s = JSON.parse(await readFile(paths(dir).settings, 'utf8'));
    s.confluence = { siteUrl: 'https://pole-star.atlassian.net', spaceKey: 'PRD', pages: [{ id: '3261890575', title: 'MR&C - Pricing' }] };
    await writeFile(paths(dir).settings, JSON.stringify(s));
    const load = await loadSettings(dir);
    if (load.status !== 'ok') throw new Error(load.status);
    expect(load.settings.confluence.roots.map((r) => r.id)).toContain('3031007299'); // Data Products
    expect(load.settings.confluence.roots).toHaveLength(11);
    expect(load.settings.confluence.labels).toContain('psg-shared-competitors');
    expect(load.settings.confluence.exclude.map((r) => r.id)).toEqual(['3215425626', '3032842242', '3157229580']);
    expect(load.settings.confluence.pages).toEqual([{ id: '3261890575', title: 'MR&C - Pricing' }]);
    s.confluence = { ...s.confluence, roots: [], labels: [], exclude: [] };
    await writeFile(paths(dir).settings, JSON.stringify(s));
    const emptied = await loadSettings(dir);
    expect(emptied.status === 'ok' && emptied.settings.confluence).toMatchObject({ roots: [], labels: [], exclude: [] });
  });

  it('moves the VIPs of a settings file from before People existed out of the Slack block', async () => {
    await init();
    const s = JSON.parse(await readFile(paths(dir).settings, 'utf8'));
    delete s.people;
    s.slack.vips = ['Dana Lee'];
    await writeFile(paths(dir).settings, JSON.stringify(s));
    const load = await loadSettings(dir);
    if (load.status !== 'ok') throw new Error(load.status);
    expect(load.settings.people).toEqual({ vips: ['Dana Lee'] });
    expect(load.settings.slack).not.toHaveProperty('vips');
  });

  it('loads a settings file from before Haiku 5.5 with haiku-5.5 in place of haiku-4.5', async () => {
    await init();
    const s = JSON.parse(await readFile(paths(dir).settings, 'utf8'));
    s.models = { triage: 'haiku-4.5', draftVault: 'sonnet-5.5', draftConfluence: 'haiku-4.5', routing: 'haiku-4.5' };
    await writeFile(paths(dir).settings, JSON.stringify(s));
    const load = await loadSettings(dir);
    if (load.status !== 'ok') throw new Error(load.status);
    expect(load.settings.models).toEqual({ triage: 'haiku-5.5', draftVault: 'sonnet-5.5', draftConfluence: 'haiku-5.5', routing: 'haiku-5.5' });
  });

  it('never overwrites existing config', async () => {
    await init();
    await writeFile(paths(dir).settings, '{"edited": true}');
    expect((await init()).created).toEqual([]);
    expect(await readFile(paths(dir).settings, 'utf8')).toBe('{"edited": true}');
  });

  it('writes default text files, replaces untouched old defaults and keeps edited ones (FR-1.1)', async () => {
    const OLD = 'old default\n';
    const oldHash = createHash('sha1').update(OLD.trim()).digest('hex');
    const files = [
      { file: 'prompts/a.md', text: 'A v2', previous: [oldHash] },
      { file: 'prompts/b.md', text: 'B v2', previous: [oldHash] },
      { file: 'guide.md', text: 'G v1' },
    ];
    const withFiles = () => initDataDir(dir, { settings: defaultSettings(dir), rules: DEFAULT_RULES, files });
    expect((await withFiles()).created).toEqual(['config/settings.json', 'config/rules.json', 'config/prompts/a.md', 'config/prompts/b.md', 'config/guide.md']);
    await writeFile(join(dir, 'config/prompts/a.md'), OLD); // still the old default
    await writeFile(join(dir, 'config/prompts/b.md'), 'Frank edited this');
    expect(await withFiles()).toEqual({ created: [], upgraded: ['config/prompts/a.md'] });
    expect(await readFile(join(dir, 'config/prompts/a.md'), 'utf8')).toBe('A v2');
    expect(await readFile(join(dir, 'config/prompts/b.md'), 'utf8')).toBe('Frank edited this');
    expect(await readFile(join(dir, 'config/guide.md'), 'utf8')).toBe('G v1');
  });

  it('falls back to the last good settings when the file is invalid (FR-1.2)', async () => {
    await init();
    expect((await loadSettings(dir)).status).toBe('ok'); // records the last good copy
    const s = JSON.parse(await readFile(paths(dir).settings, 'utf8'));
    s.schedule.intervalWorkMinutes = 0;
    await writeFile(paths(dir).settings, JSON.stringify(s));
    const load = await loadSettings(dir);
    expect(load.status).toBe('fallback');
    if (load.status !== 'fallback') return;
    expect(load.settings.schedule.intervalWorkMinutes).toBe(10);
    expect(load.issues.map((i) => i.path)).toEqual(['settings.schedule.intervalWorkMinutes']);
  });

  it('pauses every source when nothing valid is left', async () => {
    await init();
    await writeFile(paths(dir).settings, '{ not json');
    const load = await loadSettings(dir);
    expect(load.status).toBe('paused');
    if (load.status === 'paused') expect(load.issues[0]).toMatchObject({ path: 'settings', message: expect.stringMatching(/^Not valid JSON/) });
  });

  it('reports bad rules with their path and keeps the last good rules', async () => {
    await init();
    await loadSettings(dir);
    await writeFile(paths(dir).rules, JSON.stringify([{ id: 'x', enabled: true, conditions: [{ type: 'keyword', pattern: '/[oops/' }], outcome: { type: 'now' } }]));
    const load = await loadSettings(dir);
    expect(load.status).toBe('fallback');
    if (load.status === 'fallback') {
      expect(load.issues[0].path).toBe('rules.0.conditions.0.pattern');
      expect(load.rules).toHaveLength(DEFAULT_RULES.length);
    }
  });

  it('forces dry-run on in development without touching the file (FR-1.6)', async () => {
    await init();
    const s = JSON.parse(await readFile(paths(dir).settings, 'utf8'));
    await writeFile(paths(dir).settings, JSON.stringify({ ...s, dryRun: false }));
    const state = await SettingsState.create(dir, await loadSettings(dir), true);
    expect(state.settings?.dryRun).toBe(true);
    expect(state.editable.settings.dryRun).toBe(false); // the Settings page shows the file as it is
    expect(JSON.parse(await readFile(paths(dir).settings, 'utf8')).dryRun).toBe(false);
  });
});
