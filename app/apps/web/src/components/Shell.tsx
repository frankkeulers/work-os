import { NavLink, Outlet, useOutletContext } from 'react-router';
import { api, type InboxView } from '../api';
import { onTopics, useApiQuery, type QueryState } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { fmtAgo } from '../lib/format';
import { usePrefs } from '../store/prefs';
import { BrandIcon } from './BrandIcon';
import { Icon, type IconName } from './icons';
import { Dot, PhaseTag, Segmented, cx, phaseToast, type Phase } from './ui';

export type ShellContext = { inbox: QueryState<InboxView> };
export const useShell = () => useOutletContext<ShellContext>();

const SLACK_DOT = { healthy: 'var(--green)', backoff: 'var(--amber)', auth_failed: 'var(--red)', never: 'var(--gray-mid)' } as const;

function NavItem({ to, icon, label, count, end }: { to: string; icon: IconName; label: string; count?: number; end?: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cx(
          'flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 no-underline',
          isActive ? 'bg-accent-wash font-medium !text-accent' : '!text-ink-2 hover:bg-surface-2',
        )
      }
    >
      <Icon name={icon} />
      <span className="flex-1">{label}</span>
      {count !== undefined && <span className="font-mono text-xs">{count}</span>}
    </NavLink>
  );
}

function FutureNavItem({ icon, label, phase }: { icon: IconName; label: string; phase: Phase }) {
  return (
    <button type="button" onClick={() => phaseToast(phase, label)} className="flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-ink-2 cursor-pointer hover:bg-surface-2">
      <Icon name={icon} />
      <span className="flex-1">{label}</span>
      <PhaseTag phase={phase} />
    </button>
  );
}

export function Nav({ inbox }: { inbox?: InboxView }) {
  const now = useNow();
  const scope = usePrefs((s) => s.scope);
  const setScope = usePrefs((s) => s.setScope);
  const full = scope === 'full';
  // Outlook and Teams items are P2: they count only in Full scope, as on the Inbox.
  const count = inbox?.items.filter((i) => (full || i.source === 'slack') && (i.lane === 'now' || i.lane === 'today' || i.lane === 'file')).length;
  const slack = inbox?.source;
  const slackLabel =
    !slack ? '' : slack.status === 'auth_failed' ? 'token rejected' : slack.status === 'never' ? 'not polled' : slack.status === 'backoff' ? 'backing off' : slack.lastPollAt ? `${fmtAgo(slack.lastPollAt, now)} ago`.replace('now ago', 'just now') : '';
  return (
    <div className="w-[220px] shrink-0 border-r border-line bg-surface">
    <nav aria-label="Main" className="sticky top-0 flex h-screen flex-col gap-[22px] overflow-y-auto px-3.5 pb-16">
      {/* 64px, the height of the Inbox top bar, so the two line up. */}
      <div className="flex h-16 shrink-0 flex-col justify-center gap-0.5 px-2">
        <div className="text-[17px] font-semibold tracking-tight">Work OS</div>
        <div className="font-mono text-[11px] text-muted">local · 127.0.0.1</div>
      </div>
      <div className="flex flex-col gap-0.5">
        <NavItem to="/" end icon="inbox" label="Inbox" count={count} />
        {full && (
          <>
            <FutureNavItem icon="commitments" label="Commitments" phase="P3" />
            <FutureNavItem icon="briefs" label="Briefs" phase="P4" />
          </>
        )}
        <NavItem to="/usage" icon="usage" label="Usage & health" />
        <NavItem to="/settings" icon="settings" label="Settings & rules" />
      </div>
      <div className="flex flex-col gap-2">
        <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Sources</div>
        <NavLink to="/usage#health" className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 !text-ink no-underline hover:bg-surface-2">
          <BrandIcon brand="slack" size={16} decorative />
          <span className="flex-1">Slack</span>
          <Dot color={slack ? SLACK_DOT[slack.status] : 'var(--gray-mid)'} />
          <span className={cx('font-mono text-[11px]', slack?.status === 'auth_failed' ? 'text-red-fg' : slack?.status === 'backoff' ? 'text-amber-fg' : 'text-muted')}>{slackLabel}</span>
        </NavLink>
        {full && (
          <div className="flex flex-col gap-0.5 rounded-lg border border-dashed border-violet-line bg-violet-wash py-1.5">
            {(
              [
                ['Outlook', 'P2', 'outlook'],
                ['Teams', 'P2', 'teams'],
                ['Gong · CRM', 'P4', undefined],
              ] as const
            ).map(([name, phase, brand]) => (
              <button key={name} type="button" onClick={() => phaseToast(phase, name)} className="flex items-center gap-2.5 px-2 py-1 text-left text-muted cursor-pointer">
                {brand ? <BrandIcon brand={brand} size={16} decorative /> : <span className="flex w-4 justify-center"><Dot color="" hollow /></span>}
                <span className="flex-1">{name}</span>
                <span className="font-mono text-[10px] text-violet-fg">{phase}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="mt-auto flex flex-col gap-1.5 px-1">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Scope</span>
        <Segmented
          label="Scope"
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'mvp', label: 'MVP' },
            { value: 'full', label: 'Full' },
          ]}
        />
        <span className="text-[11px] leading-snug text-muted">Full shows later phases as dashed placeholders.</span>
      </div>
    </nav>
    </div>
  );
}

export function Shell() {
  const inbox = useApiQuery(() => api.getInbox(), onTopics('inbox', 'settings', 'health'), []);
  return (
    <div className="flex min-h-screen bg-bg">
      <Nav inbox={inbox.data} />
      <main className="min-w-0 flex-1">
        <Outlet context={{ inbox } satisfies ShellContext} />
      </main>
    </div>
  );
}
