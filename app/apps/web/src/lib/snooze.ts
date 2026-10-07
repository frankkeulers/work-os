import { londonAt, londonParts, tomorrowAt9 } from '@work-os/shared';
import { fmtDayDate, fmtTime } from './format';

/** Snooze choices from a few minutes to next week. Days are London days, at 09:00. */
export function snoozeOptions(now: Date): { label: string; until: string; hint: string }[] {
  const later = (mins: number) => new Date(now.getTime() + mins * 60_000).toISOString();
  const [y, m, d] = londonParts(now).dateKey.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 Sunday
  const toMonday = (8 - weekday) % 7 || 7;
  const opts = [
    { label: '30 minutes', until: later(30) },
    { label: '1 hour', until: later(60) },
    { label: '3 hours', until: later(180) },
    { label: 'Tomorrow 09:00', until: tomorrowAt9(now), day: true },
    { label: 'In 2 days', until: londonAt(now, '09:00', 2), day: true },
    { label: 'Next Monday', until: londonAt(now, '09:00', toMonday), day: true },
  ];
  // "In 2 days" is next Monday on a Saturday: keep one.
  return opts
    .filter((o, i) => opts.findIndex((p) => p.until === o.until) === i)
    .map((o) => ({ label: o.label, until: o.until, hint: o.day ? fmtDayDate(o.until) : fmtTime(o.until) }));
}
