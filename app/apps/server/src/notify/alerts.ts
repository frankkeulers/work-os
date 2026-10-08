import { inTimeRange, isWorkHours, type DepId, type DepState, type DependencyHealth, type Settings } from '@work-os/shared';
import type { Logger } from 'pino';
import type { HealthChange } from '../net/health';
import type { Notifier } from './macos';

// Health alerts (FR-14.6): a notification when Work OS needs Frank, not every time a call fails.
//   - auth_failed or paused, or settings paused (invalid, with no last good copy): alert, since
//     nothing fixes itself;
//   - the network offline: only after 30 minutes of awake time in work hours (a laptop on the move
//     is offline often, and a sleeping one isn't worth telling);
//   - anything else (degraded, rate-limited): no alert; the UI shows it and work resumes on its own.
// At most one alert per dependency every 4 hours. Quiet hours and the off switch hold an alert
// back rather than drop it: it goes out on a later tick if the problem is still there. "Recovered"
// follows only an alert that was actually sent.

export const OFFLINE_ALERT_MS = 30 * 60_000;
export const ALERT_EVERY_MS = 4 * 60 * 60_000;

const NAMES: Record<DepId, string> = {
  network: 'Network',
  slack: 'Slack',
  claude: 'Claude',
  confluence: 'Confluence',
  keychain: 'Keychain',
  storage: 'Data disk',
  wisprDb: 'Wispr Flow',
  wisprMcp: 'Wispr Flow',
};

const TITLES: Partial<Record<DepState, (name: string) => string>> = {
  auth_failed: (n) => `${n} needs you`,
  paused: (n) => `${n} is paused`,
  offline: () => 'Work OS is offline',
};

export interface AlertDeps {
  notifier: Notifier;
  settings: () => Settings;
  health: (dep: DepId) => DependencyHealth;
  now: () => Date;
  /** Stops while the Mac sleeps, so offline time counts awake time only. */
  mono: () => number;
  baseUrl: () => string | undefined;
  /** True while the settings are invalid with no last good copy, so nothing runs. */
  settingsPaused?: () => boolean;
  logger?: Logger;
}

interface Episode {
  state: DepState;
  sinceMono: number;
  alerted: boolean;
}

export class HealthAlerts {
  private episodes = new Map<DepId, Episode>();
  private lastAlertAt = new Map<DepId | 'settings', number>();
  private settingsAlerted = false;
  private sending?: Promise<unknown>;

  constructor(private readonly d: AlertDeps) {}

  /** From health: starts, changes or ends a dependency's episode. */
  onChange(c: HealthChange) {
    const e = this.episodes.get(c.dep);
    if (c.state === 'ok') {
      this.episodes.delete(c.dep);
      if (e?.alerted && this.allowed()) this.send({ title: `${NAMES[c.dep]} is back`, message: 'Work OS is running normally again.', group: `work-os-health-${c.dep}` });
      return;
    }
    if (c.state === 'unknown') return;
    // A new state starts the clock again; one already alerted stays alerted (no repeat for auth → paused).
    if (!e || e.state !== c.state) this.episodes.set(c.dep, { state: c.state, sinceMono: this.d.mono(), alerted: e?.alerted ?? false });
  }

  /** On every awake tick: sends what is due. */
  tick() {
    const now = this.d.now();
    if (!this.d.settingsPaused?.()) this.settingsAlerted = false;
    else if (!this.settingsAlerted && this.quietFor('settings', now) && this.allowed()) {
      this.settingsAlerted = true;
      this.lastAlertAt.set('settings', now.getTime());
      this.send({ title: 'Work OS is paused', message: 'The settings file is invalid and there is no good copy to fall back on. Open Work OS to fix it.', group: 'work-os-health-settings' });
    }
    for (const [dep, e] of this.episodes) {
      if (e.alerted || !this.due(dep, e, now)) continue;
      if (!this.quietFor(dep, now)) continue;
      if (!this.allowed()) return; // held back, not dropped: a later tick sends it
      e.alerted = true;
      this.lastAlertAt.set(dep, now.getTime());
      const h = this.d.health(dep);
      this.send({ title: TITLES[e.state]!(NAMES[dep]), message: h.fix ?? `${NAMES[dep]}: ${h.reason ?? e.state}`, group: `work-os-health-${dep}` });
    }
  }

  async settled() {
    while (this.sending) {
      const s = this.sending;
      await s;
      if (this.sending === s) this.sending = undefined;
    }
  }

  /** No alert for this in the last 4 hours. */
  private quietFor(key: DepId | 'settings', now: Date) {
    const last = this.lastAlertAt.get(key);
    return last === undefined || now.getTime() - last >= ALERT_EVERY_MS;
  }

  private due(dep: DepId, e: Episode, now: Date) {
    if (e.state === 'auth_failed' || e.state === 'paused') return true;
    if (dep === 'network' && e.state === 'offline') return this.d.mono() - e.sinceMono >= OFFLINE_ALERT_MS && isWorkHours(now, this.d.settings().schedule.workHours);
    return false;
  }

  private allowed() {
    const n = this.d.settings().notifications;
    return n.enabled && !inTimeRange(this.d.now(), n.quietHours);
  }

  private send(n: { title: string; message: string; group: string }) {
    const base = this.d.baseUrl();
    this.d.logger?.info({ title: n.title }, 'Health alert');
    const p = this.d.notifier.notify({ ...n, ...(base && { url: `${base}/usage` }) }).catch(() => undefined);
    this.sending = Promise.all([this.sending, p]);
  }
}
