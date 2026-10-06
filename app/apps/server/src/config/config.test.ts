import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { initDataDir, paths } from './dataDir';
import { DEFAULT_RULES, defaultSettings } from './defaults';
import { ConfigError, EXIT, exitCode, resolveConfig } from './env';
import { applyOverrides, loadSettings } from './settings';

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

  it('never overwrites existing config', async () => {
    await init();
    await writeFile(paths(dir).settings, '{"edited": true}');
    expect((await init()).created).toEqual([]);
    expect(await readFile(paths(dir).settings, 'utf8')).toBe('{"edited": true}');
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
    const load = applyOverrides(await loadSettings(dir), { forceDryRun: true });
    expect(load.status === 'ok' && load.settings.dryRun).toBe(true);
    expect(JSON.parse(await readFile(paths(dir).settings, 'utf8')).dryRun).toBe(false);
  });
});
