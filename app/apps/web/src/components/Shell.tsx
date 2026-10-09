import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useOutletContext } from 'react-router';
import type { SourceHealth, SourceId } from '@work-os/shared';
import { API_MODE, api, type InboxView } from '../api';
import { onTopics, useApiQuery, type QueryState } from '../hooks/useApiQuery';
import { useWideLayout } from '../hooks/useLayout';
import { useNow } from '../hooks/useNow';
import { fmtAgo } from '../lib/format';
import { appHealth, isStale, type AppHealth } from '../lib/health';
import { isLive } from '../lib/next';
import { shownName } from '../lib/profile';
import { usePrefs, type Scope, type Theme } from '../store/prefs';
import { Avatar } from './Avatar';
import { BrandIcon, SourceMark } from './BrandIcon';
import { problemsOf } from './HealthBanner';
import { Icon, type IconName } from './icons';
import { MeetingCues } from './MeetingCues';
import { Dot, IconButton, PhaseTag, Segmented, Spinner, cx, phaseToast, usePopover, type Phase } from './ui';

export type ShellContext = { inbox: QueryState<InboxView> };
export const useShell = () => useOutletContext<ShellContext>();

/** Short enough for the sidebar beside a source's state. */
const SOURCE_NAME: Record<SourceId, string> = { slack: 'Slack', wispr: 'Wispr', outlook: 'Outlook', teams: 'Teams', plaud: 'Plaud', calendar: 'Calendar' };

/** A source's state in a few words, or when it last polled. */
function sourceLabel(id: SourceId, h: SourceHealth, now: Date, turn?: PollTurn): string {
  if (h.status === 'auth_failed') return id === 'slack' ? 'token rejected' : 'signed out';
  if (turn) return turn === 'polling' ? 'polling…' : 'queued';
  const words: Partial<Record<SourceHealth['status'], string>> = { never: 'not polled', backoff: 'backing off', offline: 'offline', degraded: 'retrying', paused: 'paused' };
  return words[h.status] ?? (h.lastPollAt ? `${fmtAgo(h.lastPollAt, now)} ago`.replace('now ago', 'just now') : '');
}

/** Where a source is in the poll under way: polling now, or waiting its turn. */
type PollTurn = 'polling' | 'queued';

function pollTurn(id: SourceId, poll: InboxView['poll'] | undefined): PollTurn | undefined {
  if (poll?.polling === id) return 'polling';
  if (poll?.queued?.includes(id)) return 'queued';
}

const SLACK_DOT = {
  healthy: 'var(--green)',
  backoff: 'var(--amber)',
  auth_failed: 'var(--red)',
  never: 'var(--gray-mid)',
  offline: 'var(--gray-mid)',
  degraded: 'var(--amber)',
  paused: 'var(--gray-mid)',
} as const;

/** Work OS's own health, as a dot on the Usage & health item. */
const HEALTH_DOT: Record<AppHealth['tone'], string> = {
  ok: 'var(--green)',
  info: 'var(--accent)',
  warn: 'var(--amber)',
  bad: 'var(--red)',
  idle: 'var(--gray-mid)',
};

/** A nav label: visible when expanded, kept for screen readers when the sidebar is collapsed. */
const Label = ({ collapsed, children }: { collapsed: boolean; children: ReactNode }) => <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{children}</span>;

function NavItem({ to, icon, label, count, status, end, collapsed }: { to: string; icon: IconName; label: string; count?: number; status?: AppHealth; end?: boolean; collapsed: boolean }) {
  const extra = count ?? status?.label;
  return (
    <NavLink
      to={to}
      end={end}
      title={collapsed ? (extra !== undefined ? `${label} · ${extra}` : label) : status?.label}
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
      {status && (
        <>
          {collapsed ? (
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full border-2 border-surface box-content" style={{ background: HEALTH_DOT[status.tone] }} />
          ) : (
            <Dot color={HEALTH_DOT[status.tone]} />
          )}
          <span className="sr-only" data-health={status.tone}>
            {status.label}
          </span>
        </>
      )}
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

const MenuLabel = ({ children }: { children: ReactNode }) => <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{children}</span>;

/**
 * The account button at the foot of the sidebar, and its menu: the view preferences you change
 * often (theme, scope), with your name and picture in Settings › Profile. The menu is
 * fixed, not absolute, so it isn't clipped by the sidebar, collapsed or not.
 */
function AccountMenu({ collapsed }: { collapsed: boolean }) {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const scope = usePrefs((s) => s.scope);
  const setScope = usePrefs((s) => s.setScope);
  const name = usePrefs((s) => shownName(s));
  const { open, setOpen, close, trigger, panel } = usePopover();
  const button = useRef<HTMLButtonElement | null>(null);
  const [at, setAt] = useState<{ left: number; bottom: number }>();
  const toggle = () => {
    // Above the button; beside the rail when collapsed, so it doesn't cover the icons.
    const r = button.current?.getBoundingClientRect();
    const rail = button.current?.closest('nav')?.getBoundingClientRect();
    if (r && rail) setAt(collapsed ? { left: rail.right + 8, bottom: window.innerHeight - r.bottom } : { left: r.left, bottom: window.innerHeight - r.top + 6 });
    setOpen(!open);
  };
  return (
    <div>
      <button
        ref={(el) => {
          button.current = el;
          trigger(el);
        }}
        type="button"
        aria-label={name ? `Account: ${name}` : 'Account'}
        title={collapsed ? `${name ?? 'Account'} · ${scope === 'full' ? 'Full' : 'MVP'} scope` : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={toggle}
        // Lined up with the nav items: a 24px avatar centred on their 16px icons, the label where theirs start.
        className={cx('flex min-h-10 w-full items-center gap-1.5 rounded-lg px-1.5 text-left cursor-pointer hover:bg-surface-2', open && 'bg-surface-2')}
      >
        <Avatar size={24} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink" title={name}>
              {name ?? 'Account'}
            </span>
            {/* Full changes what every page shows, so the button says which scope is on. */}
            <span className="rounded bg-track px-1.5 py-px font-mono text-[10px] font-medium text-ink-2">{scope === 'full' ? 'Full' : 'MVP'}</span>
            <Icon name="up" size={14} className="text-muted" />
          </>
        )}
      </button>
      {open && at && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Account"
          style={{ left: at.left, bottom: at.bottom }}
          className="fixed z-50 flex w-[260px] flex-col gap-3.5 whitespace-normal rounded-[10px] border border-line bg-surface p-3 shadow-[0_12px_32px_rgba(20,23,28,0.14)]"
        >
          <div className="flex items-center gap-2.5">
            <Avatar size={36} />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] font-semibold">{name ?? 'Account'}</span>
              <span className="text-xs text-muted">Preferences in this browser</span>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <MenuLabel>Theme</MenuLabel>
            <Segmented<Theme>
              label="Theme"
              size="sm"
              className="w-full"
              value={theme}
              onChange={setTheme}
              options={[
                { value: 'light', label: 'Light' },
                { value: 'dark', label: 'Dark' },
                { value: 'system', label: 'System' },
              ]}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <MenuLabel>Scope</MenuLabel>
            <Segmented<Scope>
              label="Scope"
              size="sm"
              className="w-full"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'mvp', label: 'MVP' },
                { value: 'full', label: 'Full' },
              ]}
            />
            <span className="text-[11px] leading-snug text-muted">Full shows later phases as dashed placeholders.</span>
          </div>
          <Link
            to="/settings/profile"
            onClick={() => close(false)}
            className="-mx-1.5 -mb-1.5 flex min-h-9 items-center gap-2 rounded-md border-t border-line-soft px-2.5 pt-0.5 text-[13px] !text-ink no-underline hover:bg-surface-2"
          >
            <Icon name="user" size={14} className="text-muted" />
            Edit profile
          </Link>
        </div>
      )}
    </div>
  );
}

export function Nav({ inbox }: { inbox?: InboxView }) {
  const now = useNow();
  const scope = usePrefs((s) => s.scope);
  // On the three-zone cockpit the sidebar has its own setting, the rail by default (CK-3.1).
  const wide = useWideLayout();
  const collapsed = usePrefs((s) => (wide ? s.navCollapsedWide : s.navCollapsed));
  const setCollapsed = usePrefs((s) => (wide ? s.setNavCollapsedWide : s.setNavCollapsed));
  // The time column shows the next meeting on the cockpit, so the cues step aside there (CK-3.7).
  const path = useLocation().pathname;
  const onCockpit = wide && path === '/';
  const health = useApiQuery(() => api.getHealth(), onTopics('health'), []).data;
  const status = health && appHealth(health, problemsOf(health));
  const full = scope === 'full';
  // Teams items are P2: they count only in Full scope, as on the Inbox.
  const count = inbox?.items.filter((i) => (full || isLive(i.source)) && (i.lane === 'now' || i.lane === 'today' || i.lane === 'file')).length;
  // Every enabled source (R2.1); Slack shows even before the first inbox load.
  const sources: { id: SourceId; health?: SourceHealth }[] = inbox?.sources.length ? inbox.sources.map((h) => ({ id: h.id, health: h })) : [{ id: 'slack' }];

  // [ collapses and expands the sidebar, as in most tools with a sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '[' || e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.target as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"]')) return;
      e.preventDefault();
      const p = usePrefs.getState();
      setCollapsed(!(wide ? p.navCollapsedWide : p.navCollapsed));
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [setCollapsed, wide]);

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
    <div className={cx('h-full shrink-0 overflow-hidden border-r border-line bg-surface transition-[width] duration-200 ease-out motion-reduce:transition-none', collapsed ? 'w-[60px]' : 'w-[220px]')}>
      {/* The mock's Scenarios button floats over the foot of the sidebar, so it gets room there. */}
      <nav aria-label="Main" className={cx('flex h-full flex-col gap-[22px] overflow-y-auto overflow-x-hidden whitespace-nowrap', API_MODE === 'mock' ? 'pb-16' : 'pb-3', collapsed ? 'px-2.5' : 'px-3.5')}>
        {/* 64px, the height of the Inbox top bar, so the two line up. */}
        <div className={cx('flex h-16 shrink-0 items-center gap-2', collapsed ? 'justify-center' : 'pl-2')}>
          {!collapsed && <div className="min-w-0 flex-1 text-[17px] font-semibold tracking-tight">Work OS</div>}
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
          <NavItem to="/usage" icon="usage" label="Usage & health" status={status} collapsed={collapsed} />
          <NavItem to="/settings" icon="settings" label="Settings & rules" collapsed={collapsed} />
        </div>
        {!onCockpit && <MeetingCues collapsed={collapsed} />}
        <div className="flex flex-col gap-2">
          {collapsed ? <div className="mx-2 border-t border-line-soft" /> : <div className="px-2 text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Sources</div>}
          {sources.map(({ id, health }) => {
            const name = SOURCE_NAME[id];
            const turn = pollTurn(id, inbox?.poll);
            const label = health ? sourceLabel(id, health, now, turn) : '';
            // A source the health pill calls stale is amber here too, though its last poll went well.
            const stale = !!health && health.status === 'healthy' && isStale(health, now, inbox?.poll);
            const dot = health ? (stale ? 'var(--amber)' : SLACK_DOT[health.status]) : 'var(--gray-mid)';
            return (
              <NavLink
                key={id}
                to="/usage#health"
                title={collapsed ? `${name} · ${label}` : undefined}
                className={cx('flex items-center gap-2.5 rounded-lg !text-ink no-underline hover:bg-surface-2', collapsed ? 'relative min-h-10 justify-center' : 'px-2 py-1.5')}
              >
                <SourceMark source={id} size={16} decorative />
                <Label collapsed={collapsed}>{name}</Label>
                {collapsed ? (
                  turn === 'polling' ? (
                    <span className="absolute right-1 top-1 flex rounded-full bg-surface text-accent" data-polling>
                      <Spinner size={11} />
                    </span>
                  ) : (
                    <span className="absolute right-2 top-2 h-2 w-2 rounded-full border-2 border-surface box-content" style={{ background: dot }} />
                  )
                ) : (
                  <>
                    {turn === 'polling' ? (
                      <span className="flex shrink-0 text-accent" data-polling>
                        <Spinner size={11} />
                      </span>
                    ) : (
                      <Dot color={dot} />
                    )}
                    <span className={cx('font-mono text-[11px]', health?.status === 'auth_failed' ? 'text-red-fg' : health?.status === 'backoff' || stale ? 'text-amber-fg' : 'text-muted')} {...(stale && { 'data-stale': true })}>{label}</span>
                  </>
                )}
                {collapsed && <span className="sr-only">{label}</span>}
              </NavLink>
            );
          })}
          {full && (
            <div className="flex flex-col gap-0.5 rounded-lg border border-dashed border-violet-line bg-violet-wash py-1.5">
              {(
                [
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
          <AccountMenu collapsed={collapsed} />
        </div>
      </nav>
    </div>
  );
}

export function Shell() {
  const inbox = useApiQuery(() => api.getInbox(), onTopics('inbox', 'settings', 'health'), []);
  return (
    // One screen high: the sidebar stays put and only main scrolls. Pages with a top bar keep it
    // fixed and scroll their own body (PageFrame); the others scroll whole, inside main.
    <div className="flex h-screen overflow-hidden bg-bg">
      <Nav inbox={inbox.data} />
      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <Outlet context={{ inbox } satisfies ShellContext} />
      </main>
    </div>
  );
}
