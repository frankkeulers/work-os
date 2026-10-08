import type { AgendaEvent, AgendaView } from '@work-os/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useNow } from '../hooks/useNow';
import { dayEvents, phaseOf, wantsAnswer, type AgendaDay } from '../lib/agenda';
import { fmtAgo, fmtTime } from '../lib/format';
import { Icon } from './icons';
import { FutureButton, Segmented, cx } from './ui';

// The agenda strip on the inbox (R2.8): today's or tomorrow's meetings from Outlook Calendar, the
// one on now picked out. A meeting opens in Outlook; "Not answered" opens its invite item. Hidden
// while the calendar is off, except in Full scope, which says how to turn it on.

const OUTLOOK_CALENDAR = 'https://outlook.office.com/calendar/';

function AgendaChip({ e, phase, onOpenItem }: { e: AgendaEvent; phase: 'past' | 'now' | 'later'; onOpenItem: (id: string) => void }) {
  const when = e.allDay ? 'All day' : fmtTime(e.start);
  const tag = 'inline-flex min-h-7 cursor-pointer items-center rounded-md border-0 bg-transparent px-1.5 text-xs font-medium hover:bg-bg';
  return (
    <li
      data-agenda-event={e.id}
      data-phase={phase}
      className={cx('flex shrink-0 items-center gap-0.5 rounded-lg border pl-2 pr-0.5', phase === 'now' ? 'border-accent-line bg-accent-wash' : 'border-line-soft bg-surface', phase === 'past' && 'opacity-60')}
    >
      <a href={e.link ?? OUTLOOK_CALENDAR} target="_blank" rel="noreferrer" title={`${e.title}${e.organizer ? ` · ${e.organizer}` : ''}: open in Outlook`} className="flex min-h-9 max-w-[280px] items-center gap-1.5 pr-1.5 !text-ink no-underline hover:underline">
        <span className="font-mono text-xs text-ink-2">{when}</span>
        <span className="truncate">{e.title}</span>
        {phase === 'now' && <span className="rounded bg-accent-bg px-1 text-[10px] font-semibold text-on-solid no-underline">Now</span>}
      </a>
      {wantsAnswer(e) &&
        (e.inviteItemId ? (
          <button type="button" className={cx(tag, 'text-amber-fg')} onClick={() => onOpenItem(e.inviteItemId!)}>
            Not answered
          </button>
        ) : (
          <span className="px-1.5 text-xs font-medium text-amber-fg">Not answered</span>
        ))}
      {e.notesItemId && (
        <button type="button" className={cx(tag, 'text-accent-ink')} onClick={() => onOpenItem(e.notesItemId!)}>
          Notes
        </button>
      )}
    </li>
  );
}

/** What the strip says about the calendar itself, beside the meetings. */
function StateNote({ v, now }: { v: AgendaView; now: Date }) {
  if (v.state === 'auth_failed')
    return (
      <Link to="/settings/outlook" className="shrink-0 py-2 text-xs font-medium !text-red-fg">
        Connector signed out
      </Link>
    );
  if (v.state === 'stale' && v.polledAt) return <span className="shrink-0 py-2 text-xs text-muted">Read {fmtAgo(v.polledAt, now)} ago</span>;
  return null;
}

export function Agenda({ full, onOpenItem }: { full: boolean; onOpenItem: (id: string) => void }) {
  const q = useApiQuery(() => api.getAgenda(), onTopics('inbox', 'settings', 'health'), []);
  const now = useNow(60_000);
  const [day, setDay] = useState<AgendaDay>('today');
  const v = q.data;
  if (!v || (v.state === 'off' && !full)) return null;
  const list = dayEvents(v.events, now, day);
  const empty = v.state === 'off' ? (
    <>
      Outlook Calendar is off. <Link to="/settings/outlook">Turn it on</Link> to see your meetings here.
    </>
  ) : v.state === 'never' ? (
    'Outlook Calendar hasn’t been read yet.'
  ) : (
    `No meetings ${day}.`
  );
  return (
    <section aria-label="Agenda" className="mx-6 mt-3 flex items-start gap-3 rounded-[10px] border border-line bg-bg py-1.5 pl-3 pr-2 text-[13px]">
      <Icon name="calendar" className="mt-2.5 shrink-0 text-muted" />
      <Segmented
        size="sm"
        label="Agenda day"
        className="shrink-0"
        value={day}
        onChange={setDay}
        options={[
          { value: 'today', label: 'Today' },
          { value: 'tomorrow', label: 'Tomorrow' },
        ]}
      />
      <div className="min-w-0 flex-1">
        {list.length ? (
          <ol aria-label={day === 'today' ? 'Today’s meetings' : 'Tomorrow’s meetings'} className="m-0 flex list-none gap-1.5 overflow-x-auto p-0 py-0.5">
            {list.map((e) => (
              <AgendaChip key={e.id} e={e} phase={day === 'today' ? phaseOf(e, now) : 'later'} onOpenItem={onOpenItem} />
            ))}
          </ol>
        ) : (
          <p className="m-0 py-2.5 text-muted">{empty}</p>
        )}
      </div>
      <StateNote v={v} now={now} />
      {full && (
        <div className="shrink-0 py-0.5">
          <FutureButton phase="P4" label="Meeting briefs" size="sm" />
        </div>
      )}
    </section>
  );
}
