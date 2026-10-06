import { TZ, londonParts } from '@work-os/shared';

const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayDate = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const dayTime = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayMonth = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short' });
const fullDate = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: 'numeric', month: 'short', year: 'numeric' });

export const fmtTime = (iso: string | Date) => time.format(new Date(iso));
export const fmtDayDate = (iso: string | Date) => dayDate.format(new Date(iso)).replace(',', '');
export const fmtDate = (iso: string | Date) => fullDate.format(new Date(iso));

/** "Mon 09:20" for other days, "09:20" for today. */
export function fmtWhen(iso: string, now: Date): string {
  const sameDay = londonParts(iso).dateKey === londonParts(now).dateKey;
  return sameDay ? fmtTime(iso) : dayTime.format(new Date(iso)).replace(',', '');
}

/** Compact age for cards: "now", "12m", "3h", "Sun", "2 Sep". */
export function fmtAgo(iso: string, now: Date): string {
  const mins = Math.floor((now.getTime() - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)}h`;
  if (mins < 6 * 24 * 60) return londonParts(iso).weekday;
  return dayMonth.format(new Date(iso));
}

/** "in 6 min", "in 1 h 5 min", "now". */
export function fmtIn(iso: string, now: Date): string {
  const mins = Math.ceil((Date.parse(iso) - now.getTime()) / 60_000);
  if (mins <= 0) return 'now';
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `in ${h} h ${m} min` : `in ${h} h`;
}

export const fmtMoney = (v: number) => `$${v < 10 ? v.toFixed(2) : v.toFixed(0)}`;

export const fmtTokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));

export const fmtPct = (v: number) => `${Math.round(v * 100)}%`;

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
