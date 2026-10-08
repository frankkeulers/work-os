import type { HealthView } from '@work-os/shared';

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
