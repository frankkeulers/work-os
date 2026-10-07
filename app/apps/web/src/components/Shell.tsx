import { useEffect, type ReactNode } from 'react';
import { NavLink, Outlet, useOutletContext } from 'react-router';
import { api, type InboxView } from '../api';
import { onTopics, useApiQuery, type QueryState } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { fmtAgo } from '../lib/format';
import { usePrefs } from '../store/prefs';
import { BrandIcon } from './BrandIcon';
import { Icon, type IconName } from './icons';
import { Dot, IconButton, PhaseTag, Segmented, cx, phaseToast, type Phase } from './ui';

export type ShellContext = { inbox: QueryState<InboxView> };
export const useShell = () => useOutletContext<ShellContext>();

const SLACK_DOT = {
  healthy: 'var(--green)',
  backoff: 'var(--amber)',
  auth_failed: 'var(--red)',
  never: 'var(--gray-mid)',
  offline: 'var(--gray-mid)',
  degraded: 'var(--amber)',
  paused: 'var(--gray-mid)',
} as const;

/** A nav label: visible when expanded, kept for screen readers when the sidebar is collapsed. */
const Label = ({ collapsed, children }: { collapsed: boolean; children: ReactNode }) => <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{children}</span>;

function NavItem({ to, icon, label, count, end, collapsed }: { to: string; icon: IconName; label: string; count?: number; end?: boolean; collapsed: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? (count !== undefined ? `${label} · ${count}` : label) : undefined}
      className={({ isActive }) =>
        cx(
          'relative flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 no-underline',
          isActive ? 'bg-accent-wash font-medium !text-accent' : '!text-ink-2 hover:bg-surface-2',
        )
      }
    >
      <Icon name={icon} className="shrink-0" />
      <Label collapsed={collapsed}>{label}</Label>
      {count !== undefined &&
        (collapsed ? (
          <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-accent-bg px-1 text-center font-mono text-[10px] leading-4 text-on-solid">{count}</span>
        ) : (
          <span className="font-mono text-xs">{count}</span>
        ))}
    </NavLink>
  );
}

function FutureNavItem({ icon, label, phase, collapsed }: { icon: IconName; label: string; phase: Phase; collapsed: boolean }) {
  return (
    <button
      type="button"
      title={collapsed ? `${label} · ${phase}` : undefined}
      onClick={() => phaseToast(phase, label)}
      className={cx('flex min-h-10 items-center gap-2.5 rounded-lg px-2.5 text-left text-ink-2 cursor-pointer hover:bg-surface-2', collapsed && 'border border-dashed border-violet-line')}
    >
      <Icon name={icon} className="shrink-0" />
      <Label collapsed={collapsed}>{label}</Label>
      {!collapsed && <PhaseTag phase={phase} />}
    </button>
  );
}

export function Nav({ inbox }: { inbox?: InboxView }) {
  const now = useNow();
  const scope = usePrefs((s) => s.scope);
  const setScope = usePrefs((s) => s.setScope);
  const collapsed = usePrefs((s) => s.navCollapsed);
  const setCollapsed = usePrefs((s) => s.setNavCollapsed);
  const full = scope === 'full';
  // Outlook and Teams items are P2: they count only in Full scope, as on the Inbox.
  const count = inbox?.items.filter((i) => (full || i.source === 'slack') && (i.lane === 'now' || i.lane === 'today' || i.lane === 'file')).length;
  const slack = inbox?.source;
  const slackLabel =
    !slack ? '' : slack.status === 'auth_failed' ? 'token rejected' : slack.status === 'never' ? 'not polled' : slack.status === 'backoff' ? 'backing off' : slack.status === 'offline' ? 'offline' : slack.status === 'degraded' ? 'retrying' : slack.status === 'paused' ? 'paused' : slack.lastPollAt ? `${fmtAgo(slack.lastPollAt, now)} ago`.replace('now ago', 'just now') : '';
  const slackDot = slack ? SLACK_DOT[slack.status] : 'var(--gray-mid)';

  // [ collapses and expands the sidebar, as in most tools with a sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      setCollapsed(!usePrefs.getState().navCollapsed);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setCollapsed]);

  const toggle = (
    <IconButton
      label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      title={collapsed ? 'Expand sidebar ([)' : 'Collapse sidebar ([)'}
      aria-expanded={!collapsed}
      size={32}
      onClick={() => setCollapsed(!collapsed)}
    >
      <Icon name="sidebar" size={17} />
    </IconButton>
  );

  return (
    <div className={cx('shrink-0 overflow-hidden border-r border-line bg-surface transition-[width] duration-200 ease-out motion-reduce:transition-none', collapsed ? 'w-[60px]' : 'w-[220px]')}>
      <nav aria-label="Main" className={cx('sticky top-0 flex h-screen flex-col gap-[22px] overflow-y-auto overflow-x-hidden whitespace-nowrap pb-16', collapsed ? 'px-2.5' : 'px-3.5')}>
        {/* 64px, the height of the Inbox top bar, so the two line up. */}
        <div className={cx('flex h-16 shrink-0 items-center gap-2', collapsed ? 'justify-center' : 'pl-2')}>
          {!collapsed && (
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="text-[17px] font-semibold tracking-tight">Work OS</div>
              <div className="font-mono text-[11px] text-muted">local · 127.0.0.1</div>
            </div>
          )}
          {toggle}
        </div>
        <div className="flex flex-col gap-0.5">
          <NavItem to="/" end icon="inbox" label="Inbox" count={count} collapsed={collapsed} />
          {full && (
            <>
              <FutureNavItem icon="commitments" label="Commitments" phase="P3" collapsed={collapsed} />
              <FutureNavItem icon="briefs" label="Briefs" phase="P4" collapsed={collapsed} />
            </>
          )}
          <NavItem to="/usage" icon="usage" label="Usage & health" collapsed={collapsed} />
          <NavItem to="/settings" icon="settings" label="Settings & rules" collapsed={collapsed} />
        </div>
        <div className="flex flex-col gap-2">
          {collapsed ? <div className="mx-2 border-t border-line-soft" /> : <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Sources</div>}
          <NavLink
            to="/usage#health"
            title={collapsed ? `Slack · ${slackLabel}` : undefined}
            className={cx('flex items-center gap-2.5 rounded-lg !text-ink no-underline hover:bg-surface-2', collapsed ? 'relative min-h-10 justify-center' : 'px-2 py-1.5')}
          >
            <BrandIcon brand="slack" size={16} decorative />
            <Label collapsed={collapsed}>Slack</Label>
            {collapsed ? (
              <span className="absolute right-2 top-2 h-2 w-2 rounded-full border-2 border-surface box-content" style={{ background: slackDot }} />
            ) : (
              <>
                <Dot color={slackDot} />
                <span className={cx('font-mono text-[11px]', slack?.status === 'auth_failed' ? 'text-red-fg' : slack?.status === 'backoff' ? 'text-amber-fg' : 'text-muted')}>{slackLabel}</span>
              </>
            )}
            {collapsed && <span className="sr-only">{slackLabel}</span>}
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
                <button
                  key={name}
                  type="button"
                  title={collapsed ? `${name} · ${phase}` : undefined}
                  onClick={() => phaseToast(phase, name)}
                  className={cx('flex items-center gap-2.5 py-1 text-left text-muted cursor-pointer', collapsed ? 'justify-center' : 'px-2')}
                >
                  {brand ? (
                    <BrandIcon brand={brand} size={16} decorative />
                  ) : (
                    <span className="flex w-4 justify-center">
                      <Dot color="" hollow />
                    </span>
                  )}
                  <Label collapsed={collapsed}>{name}</Label>
                  {!collapsed && <span className="font-mono text-[10px] text-violet-fg">{phase}</span>}
                </button>
              ))}
            </div>
          )}
        </div>
        {/* The guide sits at the bottom, out of the way of the work. */}
        <div className="mt-auto flex flex-col gap-0.5">
          <NavItem to="/guide" icon="book" label="Guide" collapsed={collapsed} />
        </div>
        {collapsed ? (
          <button
            type="button"
            onClick={() => setScope(full ? 'mvp' : 'full')}
            aria-label={`Scope: ${full ? 'Full' : 'MVP'}. Switch to ${full ? 'MVP' : 'Full'}`}
            title={`Scope: ${full ? 'Full' : 'MVP'} (click for ${full ? 'MVP' : 'Full'})`}
            className="min-h-8 rounded-lg bg-track font-mono text-[10px] font-medium text-ink-2 cursor-pointer hover:text-ink"
          >
            {full ? 'Full' : 'MVP'}
          </button>
        ) : (
          <div className="flex flex-col gap-1.5 px-1">
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
            <span className="whitespace-normal text-[11px] leading-snug text-muted">Full shows later phases as dashed placeholders.</span>
          </div>
        )}
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
