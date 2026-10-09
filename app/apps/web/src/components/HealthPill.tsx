import { Link } from 'react-router';
import { api, type InboxView } from '../api';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { pillHealth, type AppHealth, type PillHealth } from '../lib/health';
import { cx } from './ui';

// The top bar's health pill (cockpit CK-1.7): whether Work OS is reading everything, readable from
// across the desk. The health banner stays for what Frank must act on, and the sidebar dot stays.

const PILL: Record<AppHealth['tone'], { pill: string; dot: string }> = {
  ok: { pill: 'bg-green-wash !text-green-fg', dot: 'bg-green' },
  info: { pill: 'bg-accent-wash !text-accent-ink', dot: 'bg-accent' },
  warn: { pill: 'bg-health-amber-pill !text-amber-fg', dot: 'bg-amber' },
  bad: { pill: 'bg-health-red-pill !text-red-fg', dot: 'bg-red' },
  idle: { pill: 'bg-line-soft-2 !text-gray-fg', dot: 'bg-gray-mid' },
};

/** The top bar's tint and hairline for each tone: plain unless something needs a look. */
export const HEALTH_BAR: Record<AppHealth['tone'], string> = {
  ok: 'border-line',
  idle: 'border-line',
  info: 'bg-health-blue-bar border-accent-line-2',
  warn: 'bg-amber-wash border-amber-line',
  bad: 'bg-red-wash border-health-red-line',
};

/** The pill's state, once the server's health is known and it is reachable. */
export function usePillHealth(inbox: InboxView | undefined): PillHealth | undefined {
  const now = useNow(15_000);
  const health = useApiQuery(() => api.getHealth(), onTopics('health'), []).data;
  if (!inbox || !health || health.connection !== 'up') return undefined;
  return pillHealth(health, inbox.sources, now, inbox.poll);
}

export function HealthPill({ health }: { health: PillHealth }) {
  const tone = PILL[health.tone];
  const fix = health.fix;
  return (
    <span role="status" data-testid="health-pill" data-tone={health.tone} className="inline-flex min-w-0 items-center gap-2">
      <Link
        to="/usage#health"
        title={health.label}
        className={cx('inline-flex min-h-8 min-w-0 items-center gap-2 rounded-2xl px-3 text-sm font-medium no-underline hover:no-underline', tone.pill)}
      >
        <span aria-hidden className={cx('size-2.5 shrink-0 rounded-full', tone.dot)} />
        <span className="truncate">{health.label}</span>
      </Link>
      {fix &&
        (fix.href ? (
          <a href={fix.href} target="_blank" rel="noreferrer" title={fix.title} className="shrink-0 whitespace-nowrap text-[13px] font-medium">
            {fix.label}
          </a>
        ) : (
          <Link to={fix.to!} title={fix.title} className="shrink-0 whitespace-nowrap text-[13px] font-medium">
            {fix.label}
          </Link>
        ))}
    </span>
  );
}
