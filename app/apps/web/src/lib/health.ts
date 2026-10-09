import type { DependencyHealth, HealthView, PollStatus, SourceHealth } from '@work-os/shared';
import { SOURCE_NAME } from './next';
import { fmtAgoLong } from './format';

export interface AppHealth {
  tone: 'ok' | 'info' | 'warn' | 'bad' | 'idle';
  label: string;
}

/**
 * Work OS's own health in a few words, for the dot on the sidebar's Usage & health item. It says
 * what the health banner says, from the same problems, so the two never disagree. Each source
 * has its own dot under Sources, so a Slack problem the banner leaves to the inbox stays out of
 * this one too.
 */
export function appHealth(h: Pick<HealthView, 'mode' | 'phase'>, problems: { title: string }[]): AppHealth {
  if (h.mode === 'safe') return { tone: 'bad', label: 'Safe mode: polling is off' };
  if (h.phase === 'stopping') return { tone: 'idle', label: 'Stopping' };
  if (h.phase === 'waking' || h.phase === 'catching_up') return { tone: 'info', label: 'Catching up after sleep' };
  if (h.mode === 'degraded' && problems.length) {
    const more = problems.length - 1;
    return { tone: 'warn', label: more ? `${problems[0].title} (+${more} more)` : problems[0].title };
  }
  return { tone: 'ok', label: 'Running normally' };
}

// ---------- The top bar's health pill (cockpit CK-1.7) ----------

export interface PillHealth extends AppHealth {
  /** What Frank can do about it: a page in the app, or a page elsewhere. */
  fix?: { label: string; to?: string; href?: string; title?: string };
}

/** What the pill calls each dependency: what Frank knows it as. */
const PILL_DEP: Record<DependencyHealth['id'], string> = {
  network: 'Network',
  slack: 'Slack',
  claude: 'Claude',
  confluence: 'Confluence',
  keychain: 'Keychain',
  storage: 'Data disk',
  wisprDb: 'Wispr Flow',
  wisprMcp: 'Wispr Flow',
  ms365: 'Outlook',
};

/** What goes stale, or waits, while the dependency is down. */
const PILL_STALE: Partial<Record<DependencyHealth['id'], string>> = {
  network: 'nothing is being read',
  slack: 'Slack stale',
  claude: 'new items wait for triage',
  confluence: 'filing to Confluence waits',
  storage: 'nothing is being saved',
  wisprDb: 'meeting notes stale',
  wisprMcp: 'meeting notes stale',
  ms365: 'mail and calendar stale',
};

function depWord(d: DependencyHealth): string {
  if (d.state === 'auth_failed') return d.id === 'ms365' || d.id === 'wisprMcp' ? 'not connected' : 'rejected the login';
  return { offline: 'offline', degraded: 'not working', rate_limited: 'rate-limiting', paused: 'paused' }[d.state as string] ?? d.state;
}

const HEALTH_FIX = { label: 'Usage & health', to: '/usage#health' };

function depFix(d: DependencyHealth): PillHealth['fix'] {
  if (d.id === 'ms365' && d.state === 'auth_failed' && d.reason !== 'token_missing') return { label: 'Reconnect on claude.ai', href: 'https://claude.ai/settings/connectors', title: d.fix };
  return { ...HEALTH_FIX, title: d.fix };
}

const more = (label: string, n: number) => (n > 1 ? `${label} (+${n - 1} more)` : label);

/**
 * The health pill: whether Work OS is reading everything, readable from across the desk. Safe mode,
 * then stopping, then catching up, then a dependency that is down (named, with what's stale), then
 * a source whose last poll is older than twice its interval: a server that has quietly stopped
 * polling. Otherwise all is well, with the time of the oldest read.
 */
/**
 * A source that should have read by now and hasn't: its last poll is older than twice its interval,
 * and it isn't polling or waiting its turn. The pill and the sidebar's dots share it.
 */
export function isStale(s: SourceHealth, now: Date, poll?: Pick<PollStatus, 'polling' | 'queued'>): boolean {
  if (s.intervalMinutes === undefined || !s.lastPollAt || s.status === 'never') return false;
  if (poll?.polling === s.id || poll?.queued?.includes(s.id)) return false;
  return now.getTime() - Date.parse(s.lastPollAt) > 2 * s.intervalMinutes * 60_000;
}

export function pillHealth(h: Pick<HealthView, 'mode' | 'phase' | 'deps'>, sources: readonly SourceHealth[], now: Date, poll?: Pick<PollStatus, 'polling' | 'queued'>): PillHealth {
  if (h.mode === 'safe') return { tone: 'bad', label: 'Safe mode · nothing is being read', fix: { label: 'Open Usage & health', to: '/usage#health' } };
  if (h.phase === 'stopping') return { tone: 'idle', label: 'Stopping' };
  if (h.phase === 'waking' || h.phase === 'catching_up') return { tone: 'info', label: 'Catching up after sleep' };

  const down = h.deps.filter((d) => d.state !== 'ok' && d.state !== 'unknown');
  if (down.length) {
    const d = down[0];
    const stale = PILL_STALE[d.id];
    return { tone: 'warn', label: more(`${PILL_DEP[d.id]} ${depWord(d)}${stale ? ` · ${stale}` : ''}`, down.length), fix: depFix(d) };
  }

  const polling = sources.filter((s) => s.intervalMinutes !== undefined && s.lastPollAt && s.status !== 'never');
  const stale = polling.filter((s) => isStale(s, now, poll));
  if (stale.length) {
    const s = stale[0];
    return { tone: 'warn', label: more(`${SOURCE_NAME[s.id]} stale · last read ${fmtAgoLong(s.lastPollAt!, now)}`, stale.length), fix: HEALTH_FIX };
  }

  const oldest = polling.map((s) => s.lastPollAt!).sort()[0];
  return { tone: 'ok', label: oldest ? `All sources live · ${fmtAgoLong(oldest, now)}` : 'All sources live' };
}
