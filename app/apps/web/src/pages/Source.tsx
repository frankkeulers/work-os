import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { SourceId, mondayOf, type SourceRow, type WeekEvent } from '@work-os/shared';
import { api } from '../api';
import { SourceMark } from '../components/BrandIcon';
import { itemPath } from '../components/item';
import { useShell } from '../components/Shell';
import { HEALTH_BAR, HealthPill, usePillHealth } from '../components/HealthPill';
import { cx } from '../components/ui';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useWideLayout } from '../hooks/useLayout';
import { useNow } from '../hooks/useNow';
import { fmtAgo, plural } from '../lib/format';
import { SOURCE_NAME, isLive } from '../lib/next';
import { usePrefs } from '../store/prefs';
import { ItemPanel } from './inbox/ItemPanel';
import { LeaveDialog, PanelSlide } from './inbox/PanelSlide';
import { usePanelHost } from './inbox/usePanelHost';
import { CalendarWeek, EventCard, eventItem } from './source/CalendarWeek';
import { MEETING_STATES, ROW_STATES, countBy, defaultHidden, meetingState, rowState } from './source/filters';
import { HistoryGroup, HistoryRow, StateFilter, byConversation, byDay, byWeek, whenOf, type Group } from './source/rows';
import { NotificationBell } from '../components/NotificationBell';

// A source's history (cockpit CK-5): everything the source has stored, newest first, whatever
// triage made of it, each item opening in the same panel as in the Inbox, filing included. Slack by
// conversation, Outlook mail by day, Wispr Flow notes by week, and the calendar as a week.

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]');

/** Clicks here aren't "outside" the panel: rows and meetings switch the item; the rest work alongside it. */
const NOT_OUTSIDE = '[data-row], [data-row-action], [data-week-event], [data-event-card], a[href], [data-source-header] button, [data-state-filter] button, nav button, [aria-live], [data-scenarios], [data-overlay], [role="dialog"], [role="menu"]';

const NOTE: Partial<Record<SourceId, string>> = {
  slack: 'Every conversation stored, newest first',
  outlook: 'Every email conversation stored, newest first',
  wispr: 'Every meeting’s notes, newest first',
  calendar: 'Every meeting the calendar holds, the week at a time',
};

function groupsOf(source: SourceId, items: readonly SourceRow[], now: Date): Group[] {
  if (source === 'slack') return byConversation(items);
  if (source === 'wispr') return byWeek(items, now);
  return byDay(items, now);
}

/** When the source was last read: "read just now", "read 3m ago". */
function readAgo(iso: string, now: Date): string {
  const ago = fmtAgo(iso, now);
  return ago === 'now' ? 'read just now' : `read ${ago} ago`;
}

/** Who or what a row is about, by source: a meeting's name, an email's people, a conversation's. */
function leadOf(i: SourceRow): string {
  if (i.source === 'wispr') return i.title;
  const people = i.people.slice(0, 2).join(', ');
  return i.people.length > 2 ? `${people} +${i.people.length - 2}` : people || i.title;
}

export function SourcePage() {
  const params = useParams();
  const parsed = SourceId.safeParse(params.id);
  const source = parsed.success ? parsed.data : undefined;
  const { inbox: q } = useShell();
  const inbox = q.data;
  const navigate = useNavigate();
  const now = useNow(60_000);
  const wide = useWideLayout();
  const calendar = source === 'calendar';

  const history = useApiQuery(() => (source ? api.getSourceItems(source) : Promise.resolve(undefined)), onTopics('inbox', 'settings', 'health'), [source]);
  // The calendar's meetings open their Wispr Flow notes, so the week holds those items too.
  const notes = useApiQuery(() => (calendar ? api.getSourceItems('wispr') : Promise.resolve(undefined)), onTopics('inbox', 'settings', 'health'), [calendar]);
  const [weekStart, setWeekStart] = useState(() => mondayOf(api.now()));
  const week = useApiQuery(() => (calendar ? api.getWeek(weekStart) : Promise.resolve(undefined)), onTopics('inbox', 'settings', 'health'), [calendar, weekStart]);
  const workHours = useApiQuery(() => (calendar ? api.getSettings() : Promise.resolve(undefined)), onTopics('settings'), [calendar]).data?.settings.schedule.workHours ?? '';

  const rows = useMemo(() => (history.data && history.data.source === source ? history.data.items : []), [history.data, source]);
  const items = useMemo(() => (calendar ? [...rows, ...(notes.data?.items ?? [])] : rows), [calendar, rows, notes.data]);
  const allEvents = useMemo(() => (calendar && week.data?.weekStart === weekStart ? week.data.events : []), [calendar, week.data, weekStart]);
  // The states Frank hid (CK-5.8), kept per source in this browser; Done until he chooses. The open item stays open when
  // its state is hidden; only the list and j/k leave it out.
  const hiddenBySource = usePrefs((s) => s.sourceHidden);
  const setSourceHidden = usePrefs((s) => s.setSourceHidden);
  const hidden = useMemo(() => (source ? (hiddenBySource[source] ?? defaultHidden(calendar)) : []), [source, hiddenBySource, calendar]);
  const counts = useMemo(() => (calendar ? countBy(allEvents, meetingState) : countBy(rows, rowState)), [calendar, allEvents, rows]);
  const shownRows = useMemo(() => rows.filter((i) => !hidden.includes(rowState(i))), [rows, hidden]);
  const events = useMemo(() => allEvents.filter((e) => !hidden.includes(meetingState(e))), [allEvents, hidden]);
  const shownWeek = useMemo(() => week.data && { ...week.data, events: week.data.weekStart === weekStart ? events : week.data.events }, [week.data, weekStart, events]);
  const groups = useMemo(() => (source && !calendar ? groupsOf(source, shownRows, now) : []), [source, calendar, shownRows, now]);
  // j/k walk the rows as they show; on the calendar, the week's meetings that open an item.
  const order = useMemo(
    () => (calendar ? [...new Set(events.map(eventItem).filter((id): id is string => !!id && items.some((i) => i.id === id)))] : groups.flatMap((g) => g.items.map((i) => i.id))),
    [calendar, events, groups, items],
  );

  // A meeting with no item behind it opens a card in the panel's place.
  const [card, setCard] = useState<WeekEvent | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const host = usePanelHost({ items, order, notOutside: NOT_OUTSIDE, onPick: () => setCard(null) });
  const { sel, filing, pick, step, close, doneAndNext, setFiling, onDirty, blocker, panelRef, panel, closing } = host;
  const onEvent = (e: WeekEvent) => {
    const id = eventItem(e);
    if (id && items.some((i) => i.id === id)) return pick(id);
    if (sel) close();
    setCard(e);
  };
  if (card && !calendar) setCard(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'j') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'k') {
        e.preventDefault();
        step(-1);
      } else if (e.key === 'Escape' && sel) {
        e.preventDefault();
        close();
      } else if (e.key === 'Escape' && card) {
        e.preventDefault();
        setCard(null);
      } else if (e.key === 'o' && sel) {
        e.preventDefault();
        navigate(itemPath(sel));
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [step, close, sel, card, navigate]);

  // A click outside the card closes it, as the panel does.
  useEffect(() => {
    if (!card) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.isConnected || cardRef.current?.contains(t) || t.closest(NOT_OUTSIDE)) return;
      setCard(null);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [card]);

  const name = source ? SOURCE_NAME[source] : 'Source';
  useEffect(() => {
    document.title = `${name} · Work OS`;
  }, [name]);
  const pill = usePillHealth(inbox);
  const health = source ? inbox?.sources.find((s) => s.id === source) : undefined;

  if (!source) return <div className="p-8 text-muted">No such source.</div>;
  const panelWidth = wide ? 'max-w-[640px]' : 'max-w-[600px]';
  const selectedEvent = card?.id ?? (sel ? events.find((e) => eventItem(e) === sel)?.id : undefined);

  let body;
  if (!isLive(source) && source !== 'calendar') {
    body = <div className="px-6 py-8 text-[13px] text-muted">{name} isn’t built yet (Phase 2): it has nothing stored.</div>;
  } else if (calendar) {
    body = <CalendarWeek week={shownWeek} weekStart={weekStart} setWeekStart={setWeekStart} workHours={workHours} now={now} selected={selectedEvent} onEvent={onEvent} />;
  } else if (!history.data) {
    body = <div className="px-6 py-8 text-[13px] text-muted">{history.error ? `Could not load ${name}.` : 'Loading…'}</div>;
  } else if (!rows.length) {
    body = <div className="px-6 py-8 text-[13px] text-muted">Nothing stored from {name} yet. Items show here from its first poll.</div>;
  } else if (!shownRows.length) {
    body = (
      <div data-filter-empty className="px-6 py-8 text-[13px] text-muted">
        Nothing here in the states shown.{' '}
        <button type="button" className="font-medium text-accent cursor-pointer hover:underline" onClick={() => setSourceHidden(source, [])}>
          Show all {plural(rows.length, 'item')}
        </button>
      </div>
    );
  } else {
    body = (
      <section aria-label={`${name} history`} className="min-w-0 flex-1 overflow-y-auto pb-6">
        {groups.map((g) => (
          <HistoryGroup key={g.id} id={g.id} title={g.title} count={g.items.length}>
            {g.items.map((i) => (
              <HistoryRow key={i.id} item={i} selected={i.id === sel} onPick={() => pick(i.id)} lead={leadOf(i)} title={source === 'outlook' ? i.title : undefined} when={whenOf(i.lastActivityAt, now)} />
            ))}
          </HistoryGroup>
        ))}
      </section>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <header data-source-header data-health={pill?.tone} className={cx('flex h-16 shrink-0 items-center gap-2.5 whitespace-nowrap border-b px-6', HEALTH_BAR[pill?.tone ?? 'ok'])}>
        <SourceMark source={source} size={20} />
        <h1 className="m-0 text-xl font-semibold tracking-[-0.01em]">{name}</h1>
        {!calendar && history.data && <span className="font-mono text-xs text-muted">{shownRows.length < rows.length ? `${shownRows.length} of ${plural(rows.length, 'item')}` : plural(rows.length, 'item')}</span>}
        <span className="hidden min-w-0 truncate text-xs text-muted md:inline">{NOTE[source]}</span>
        <span className="flex-1" />
        {health?.lastPollAt && <span className="font-mono text-[11px] text-muted">{readAgo(health.lastPollAt, now)}</span>}
        <Link to="/usage#health" className="inline-flex min-h-8 items-center rounded-lg px-2 text-[13px] font-medium !text-ink-2 no-underline hover:bg-surface-2">
          Health ›
        </Link>
        {pill && <HealthPill health={pill} />}
        <NotificationBell />
      </header>
      {(isLive(source) || calendar) && <StateFilter states={calendar ? MEETING_STATES : ROW_STATES} counts={counts} hidden={hidden} onChange={(h) => setSourceHidden(source, h)} />}

      <div className="relative flex min-h-0 flex-1">
        {body}
        {panel && (
          <PanelSlide closing={closing} panelRef={panelRef} onSlidOut={host.onSlidOut} className={panelWidth}>
            <ItemPanel
              item={panel.item}
              view={panel.view}
              pos={panel.pos}
              total={order.length}
              filing={filing}
              setFiling={setFiling}
              draftsBudgetHit={!!inbox?.budgets.drafts.hit}
              onPrev={() => step(-1)}
              onNext={() => step(1)}
              onClose={close}
              onDoneNext={doneAndNext}
              onDirty={onDirty}
            />
          </PanelSlide>
        )}
        {!panel && card && (
          <PanelSlide panelRef={cardRef} className={panelWidth}>
            <EventCard e={card} onClose={() => setCard(null)} />
          </PanelSlide>
        )}
      </div>

      <LeaveDialog blocker={blocker} />
    </div>
  );
}
