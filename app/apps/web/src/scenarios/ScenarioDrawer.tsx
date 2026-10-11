import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { api, mockControls as controls } from '../api';

// Rendered in mock builds only (App.tsx), where the controls exist.
const mockControls = controls!;
import { Icon } from '../components/icons';
import { Button, IconButton, Segmented, cx } from '../components/ui';
import { fmtDayDate, fmtTime } from '../lib/format';
import type { PollOutcome, SettleOutcome, StateFlag } from '../mock/controls';
import type { DraftOutcome } from '../mock/types';
import { usePrefs } from '../store/prefs';
import { toast } from '../store/toasts';
import { JOURNEYS } from './journeys';

type Tab = 'journeys' | 'controls' | 'events';

function useControlsState() {
  const [state, setState] = useState(() => mockControls.getControlsState());
  useEffect(() => {
    const refresh = () => setState(mockControls.getControlsState());
    const t = setInterval(refresh, 5000);
    const off = api.subscribe(refresh);
    return () => {
      clearInterval(t);
      off();
    };
  }, []);
  return state;
}

function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{title}</span>
        {hint && <span className="text-[11px] text-muted">{hint}</span>}
      </div>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

const Ctl = ({ on, children, onClick }: { on?: boolean; children: ReactNode; onClick: () => void }) => (
  <Button size="sm" variant={on ? 'tonal' : 'secondary'} aria-pressed={on} onClick={onClick}>
    {children}
  </Button>
);

const OUTCOMES: [DraftOutcome, string][] = [
  ['normal', 'Normal'],
  ['vault_conflict', 'Vault hash conflict'],
  ['confluence_conflict', 'Confluence version conflict'],
  ['people_check', 'People check blocks'],
  ['allow_list', 'Page out of scope'],
  ['no_fit', 'No page fits'],
  ['model_error', 'Model error'],
  ['already_filed', 'Already filed'],
  ['possible_duplicate', 'Possible duplicate'],
  ['write_unreachable', 'Write fails (unreachable)'],
];

const SETTLES: [SettleOutcome, string][] = [
  ['settled', 'Settles it'],
  ['open', 'Holds it (“will look later”)'],
  ['handed', 'Hands it on (still yours)'],
  ['failed', 'Check fails'],
];

const POLLS: [PollOutcome, string][] = [
  ['nothing', 'Nothing eligible'],
  ['vip_dm', 'VIP DM'],
  ['batch12', '12 quiet threads'],
  ['reply_done', 'Reply on a done item'],
  ['reply_snoozed', 'Reply on a snoozed item'],
  ['reply_corrected', 'Reply on a corrected item'],
  ['reply_drafted', 'Reply on a drafted item'],
];

function Controls() {
  const s = useControlsState();
  const navigate = useNavigate();
  const { theme, setTheme, scope, setScope } = usePrefs();
  const f = s.flags;
  const flag = (x: StateFlag) => mockControls.setFlag(x);
  return (
    <div className="flex flex-col gap-5">
      <Group title="Clock" hint={`${fmtDayDate(s.clock)} ${fmtTime(s.clock)} London`}>
        <Ctl onClick={() => mockControls.advanceClock(10)}>+10 min</Ctl>
        <Ctl onClick={() => mockControls.advanceClock(60)}>+1 h</Ctl>
        <Ctl onClick={() => mockControls.setClockLondon('09:00')}>Tomorrow 09:00</Ctl>
        <Ctl onClick={() => mockControls.setClockLondon('19:30')}>19:30 (quiet hours)</Ctl>
        <Ctl onClick={() => mockControls.setClockLondon('13:56')}>13:56 (renewal call at 14:00)</Ctl>
        <Ctl onClick={() => mockControls.setClockLondon('14:28')}>14:28 (renewal call on, sign-off at 14:30)</Ctl>
        <Ctl onClick={() => mockControls.wakeFromSleep()}>Wake from 3 h sleep</Ctl>
        <Ctl onClick={() => mockControls.cockpitAfternoon()}>13:48 with Outlook and the calendar on (cockpit)</Ctl>
      </Group>
      <Group title="Poll outcome" hint={`${s.timelinePending} scripted arrivals left`}>
        {POLLS.map(([o, l]) => (
          <Ctl key={o} onClick={() => mockControls.simulatePoll(o)}>
            {l}
          </Ctl>
        ))}
      </Group>
      <Group title="Frank replies" hint="to the open item, or a Slack item in Needs you; the settle check answers a moment later">
        {SETTLES.map(([o, l]) => (
          <Ctl key={o} onClick={() => mockControls.frankReplies(o, new URLSearchParams(window.location.search).get('item') ?? undefined)}>
            {l}
          </Ctl>
        ))}
      </Group>
      <Group title="Next draft outcome" hint="used once, then back to normal">
        {OUTCOMES.map(([o, l]) => (
          <Ctl key={o} on={s.nextDraftOutcome === o} onClick={() => mockControls.setNextDraftOutcome(o)}>
            {l}
          </Ctl>
        ))}
      </Group>
      <Group title="Budgets">
        <Ctl on={f.forceTriageBudget} onClick={() => flag('triage_budget')}>Triage budget hit</Ctl>
        <Ctl on={f.forceDraftBudget} onClick={() => flag('drafts_budget')}>Drafts budget hit</Ctl>
      </Group>
      <Group title="Slack" hint={s.slack}>
        <Ctl on={s.slack === 'healthy'} onClick={() => flag('slack_healthy')}>Healthy</Ctl>
        <Ctl on={s.slack === 'backoff'} onClick={() => flag('slack_429')}>429 back-off</Ctl>
        <Ctl on={s.slack === 'auth_failed'} onClick={() => flag('slack_auth')}>Auth failure</Ctl>
      </Group>
      <Group title="Health pill" hint="what the top bar shows from across the desk">
        <Ctl on={!f.health} onClick={() => flag('health_normal')}>Running normally</Ctl>
        <Ctl on={f.health === 'catching_up'} onClick={() => flag('health_catching_up')}>Catching up</Ctl>
        <Ctl on={f.health === 'stale'} onClick={() => flag('health_stale')}>Slack stale</Ctl>
        <Ctl on={f.health === 'ms365'} onClick={() => flag('health_ms365')}>Outlook signed out</Ctl>
        <Ctl on={f.health === 'safe'} onClick={() => flag('health_safe')}>Safe mode</Ctl>
        <Ctl on={f.health === 'stopping'} onClick={() => flag('health_stopping')}>Stopping</Ctl>
      </Group>
      <Group title="Server">
        <Ctl on={f.connection === 'up'} onClick={() => flag('server_up')}>Up</Ctl>
        <Ctl on={f.connection === 'down'} onClick={() => flag('server_down')}>Down</Ctl>
        <Ctl on={f.connection === 'reconnecting'} onClick={() => flag('reconnecting')}>Reconnecting</Ctl>
      </Group>
      <Group title="Startup checks">
        <Ctl on={!f.startupFailure} onClick={() => flag('startup_ok')}>All pass</Ctl>
        <Ctl on={f.startupFailure === 'api_key'} onClick={() => flag('api_key')}>API key set</Ctl>
        <Ctl on={f.startupFailure === 'slack_token'} onClick={() => flag('slack_token')}>Slack token missing</Ctl>
        <Ctl on={f.startupFailure === 'claude_login'} onClick={() => flag('claude_login')}>Claude login failed</Ctl>
        <Ctl on={f.fileVaultOff} onClick={() => flag('filevault_off')}>FileVault off</Ctl>
        <Ctl on={!!f.rebuiltNotice} onClick={() => flag('rebuilt_notice')}>State rebuilt notice</Ctl>
      </Group>
      <Group title="Data">
        <Ctl onClick={() => (mockControls.reset('default'), navigate('/'), toast('Demo data reset.'))}>Reset demo data</Ctl>
        <Ctl onClick={() => (mockControls.reset('firstRun'), navigate('/'))}>First run</Ctl>
        <Ctl onClick={() => (mockControls.reset('inboxZero'), navigate('/'))}>Inbox zero</Ctl>
        <Ctl onClick={() => (mockControls.reset('heavy'), navigate('/'))}>Heavy day</Ctl>
        <Ctl onClick={() => (mockControls.reset('topics'), navigate('/'))}>Topics</Ctl>
        <Ctl onClick={() => (mockControls.reset('noBaseline'), navigate('/usage'))}>No baseline</Ctl>
      </Group>
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Scope</span>
          <Segmented label="Scope" size="sm" value={scope} onChange={setScope} options={[{ value: 'mvp', label: 'MVP' }, { value: 'full', label: 'Full' }]} />
        </div>
        <div className="flex flex-col gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">Theme</span>
          <Segmented label="Theme" size="sm" value={theme} onChange={setTheme} options={[{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }]} />
        </div>
      </div>
    </div>
  );
}

function Journeys({ onStart }: { onStart: () => void }) {
  const navigate = useNavigate();
  const groups = [...new Set(JOURNEYS.map((j) => j.group))];
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-xs leading-relaxed text-muted">Each Start resets the demo data, sets up the scenario, opens the right page and closes this drawer (press ` to reopen). Steps and what to watch for are in JOURNEYS.md.</p>
      {groups.map((g) => (
        <div key={g} className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">{g}</span>
          {JOURNEYS.filter((j) => j.group === g).map((j) => (
            <div key={j.id} className="flex items-center gap-2 rounded-md px-1 py-0.5 hover:bg-surface-2">
              <span className="w-8 font-mono text-[11px] text-muted">{j.id}</span>
              <span className="flex-1 text-[13px]">{j.title}</span>
              <Button
                size="sm"
                variant="ghost"
                className="text-accent"
                aria-label={`Start ${j.id} ${j.title}`}
                onClick={() => {
                  const to = j.start(mockControls);
                  navigate(to);
                  onStart();
                }}
              >
                Start
              </Button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function EventLog() {
  const [events, setEvents] = useState(() => mockControls.getEvents());
  useEffect(() => api.subscribe(() => setEvents(mockControls.getEvents())), []);
  return (
    <div className="flex flex-col">
      <p className="m-0 mb-2 text-xs leading-relaxed text-muted">Newest first. Events carry IDs and decisions, never message bodies (PLAN.md §4.3).</p>
      {events.map((e) => (
        <div key={e.id} className="flex flex-col gap-0.5 border-b border-line-soft py-1.5">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[11px] text-muted">{fmtTime(e.at)}</span>
            <span className="font-mono text-xs font-medium text-ink">{e.type}</span>
          </div>
          {(e.itemId || e.data) && (
            <div className="truncate font-mono text-[11px] text-muted" title={JSON.stringify(e.data ?? {})}>
              {e.itemId && <span>{e.itemId.split(':').slice(1).join(':')} </span>}
              {e.data &&
                Object.entries(e.data)
                  .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : v}`)
                  .join(' ')}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function ScenarioDrawer() {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('journeys');
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === '`' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <div data-scenarios className="print:hidden">
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-scenario-fab
          className="fixed bottom-4 left-4 z-[55] inline-flex items-center gap-2 rounded-full border-[1.5px] border-dashed border-violet-line bg-violet-wash-2 px-3.5 py-2 text-[13px] font-semibold text-violet-fg shadow-[0_6px_18px_rgba(20,23,28,0.12)] cursor-pointer"
        >
          <Icon name="flask" /> Scenarios <span className="font-mono text-[10px] font-normal opacity-70">`</span>
        </button>
      )}
      {open && (
        <aside aria-label="Scenarios" className="fixed bottom-0 left-0 top-0 z-[58] flex w-[400px] max-w-full flex-col border-r-[1.5px] border-dashed border-violet-line bg-surface shadow-[0_0_48px_rgba(20,23,28,0.22)]">
          <div className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
            <Icon name="flask" className="text-violet-fg" />
            <div className="flex flex-1 flex-col">
              <span className="text-[15px] font-semibold">Scenarios</span>
              <span className="text-[11px] text-muted">UX-testing aid · mock data only · not part of the product</span>
            </div>
            <IconButton label="Close scenarios" icon="x" onClick={() => setOpen(false)} />
          </div>
          <div className="border-b border-line-soft px-4 py-2">
            <Segmented
              label="Scenario tab"
              size="sm"
              className="w-full"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'journeys', label: 'Journeys' },
                { value: 'controls', label: 'Controls' },
                { value: 'events', label: 'Event log' },
              ]}
            />
          </div>
          <div className={cx('flex-1 overflow-y-auto px-4 py-4')}>
            {tab === 'journeys' && <Journeys onStart={() => setOpen(false)} />}
            {tab === 'controls' && <Controls />}
            {tab === 'events' && <EventLog />}
          </div>
        </aside>
      )}
    </div>
  );
}
