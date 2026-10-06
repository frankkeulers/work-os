import type { DepId, DependencyHealth } from '@work-os/shared';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings } from '../config/defaults';
import { ALERT_EVERY_MS, HealthAlerts, OFFLINE_ALERT_MS } from './alerts';
import { systemNotifier, terminalNotifierArgs, type Notification } from './macos';

const MIN = 60_000;

describe('terminal-notifier arguments', () => {
  it('passes text as arguments, escaping what it would read as an option', () => {
    expect(terminalNotifierArgs({ title: '#product', message: 'Go/no-go?', url: 'http://127.0.0.1:4317/item/x', group: 'g' }, '[dev] ')).toEqual([
      '-title',
      '\\[dev] #product',
      '-message',
      'Go/no-go?',
      '-open',
      'http://127.0.0.1:4317/item/x',
      '-group',
      'g',
    ]);
    expect(terminalNotifierArgs({ title: 'T', message: '-rm everything' })).toEqual(['-title', 'T', '-message', '\\-rm everything']);
  });

  it('uses terminal-notifier where installed, else osascript', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workos-notify-'));
    const bin = join(dir, 'terminal-notifier');
    await writeFile(bin, '#!/bin/sh\n');
    await chmod(bin, 0o755);
    expect((await systemNotifier('', [join(dir, 'missing'), bin])).kind).toBe('terminal-notifier');
    expect((await systemNotifier('', [join(dir, 'missing')])).kind).toBe('osascript');
  });
});

describe('health alerts (FR-14.6)', () => {
  let wall: number;
  let mono: number;
  let sent: Notification[];
  let settings: ReturnType<typeof defaultSettings>;
  let alerts: HealthAlerts;
  const health = (dep: DepId): DependencyHealth => ({ id: dep, state: 'auth_failed', since: '', failures: 1, fix: `Fix ${dep}` });
  const advance = async (ms: number, awake = true) => {
    for (let t = 0; t < ms; t += 5000) {
      wall += 5000;
      if (awake) mono += 5000;
      alerts.tick();
    }
    await alerts.settled();
  };

  beforeEach(() => {
    wall = Date.parse('2026-10-06T08:00:00Z'); // Tuesday 09:00 London: work hours, not quiet
    mono = 0;
    sent = [];
    settings = defaultSettings('/tmp/x');
    alerts = new HealthAlerts({ notifier: { notify: async (n) => void sent.push(n) }, settings: () => settings, health, now: () => new Date(wall), mono: () => mono, baseUrl: () => 'http://127.0.0.1:4317' });
  });

  it('alerts on auth_failed at once, at most every 4 hours, and says when it is back', async () => {
    alerts.onChange({ dep: 'slack', state: 'auth_failed' });
    await advance(5000);
    expect(sent).toEqual([{ title: 'Slack needs you', message: 'Fix slack', group: 'work-os-health-slack', url: 'http://127.0.0.1:4317/usage' }]);
    alerts.onChange({ dep: 'slack', state: 'ok' });
    alerts.onChange({ dep: 'slack', state: 'auth_failed' });
    await advance(ALERT_EVERY_MS - 10 * MIN);
    expect(sent.map((n) => n.title)).toEqual(['Slack needs you', 'Slack is back']);
    await advance(10 * MIN);
    expect(sent.map((n) => n.title)).toEqual(['Slack needs you', 'Slack is back', 'Slack needs you']);
  });

  it('says nothing about degraded or rate-limited, nor "back" without an alert', async () => {
    alerts.onChange({ dep: 'claude', state: 'degraded' });
    alerts.onChange({ dep: 'slack', state: 'rate_limited' });
    await advance(60 * MIN);
    alerts.onChange({ dep: 'claude', state: 'ok' });
    await advance(5000);
    expect(sent).toEqual([]);
  });

  it('alerts about the network only after 30 minutes offline while awake, in work hours', async () => {
    alerts.onChange({ dep: 'network', state: 'offline' });
    await advance(OFFLINE_ALERT_MS, false); // asleep: doesn't count
    await advance(OFFLINE_ALERT_MS - 5000);
    expect(sent).toEqual([]);
    await advance(5000);
    expect(sent.map((n) => n.title)).toEqual(['Work OS is offline']);
  });

  it('holds an offline alert outside work hours', async () => {
    wall = Date.parse('2026-10-10T10:00:00Z'); // Saturday
    alerts.onChange({ dep: 'network', state: 'offline' });
    await advance(2 * OFFLINE_ALERT_MS);
    expect(sent).toEqual([]);
  });

  it('alerts once when the settings are paused, and again only after they were fixed and broke', async () => {
    let paused = true;
    alerts = new HealthAlerts({
      notifier: { notify: async (n) => void sent.push(n) },
      settings: () => settings,
      health,
      now: () => new Date(wall),
      mono: () => mono,
      baseUrl: () => undefined,
      settingsPaused: () => paused,
    });
    await advance(ALERT_EVERY_MS); // to 13:00, out of quiet hours
    expect(sent.map((n) => n.title)).toEqual(['Work OS is paused']);
    paused = false;
    await advance(5000);
    paused = true;
    await advance(5000);
    expect(sent).toHaveLength(2);
  });

  it('holds an alert through quiet hours and the off switch, and sends it after', async () => {
    settings = { ...settings, notifications: { enabled: true, quietHours: '08:00–10:00' } };
    alerts.onChange({ dep: 'keychain', state: 'auth_failed' });
    await advance(30 * MIN);
    expect(sent).toEqual([]);
    settings = { ...settings, notifications: { enabled: false, quietHours: '19:00–08:00' } };
    await advance(5000);
    expect(sent).toEqual([]);
    settings = { ...settings, notifications: { enabled: true, quietHours: '19:00–08:00' } };
    await advance(5000);
    expect(sent.map((n) => n.title)).toEqual(['Keychain needs you']);
  });
});
