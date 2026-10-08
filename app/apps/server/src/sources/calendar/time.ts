import { timeZone } from '@work-os/shared';
import type { WallTime } from '../ms365/types';

// Calendar times arrive as a wall-clock time and a zone name: "UTC" for Frank's mailbox (P0-12),
// but Graph can also give an IANA name or a Windows one ("GMT Standard Time"). Everything is
// stored and compared as UTC ISO.

/** The Windows zone names Outlook uses most, as IANA zones. Anything else is read as UTC. */
const WINDOWS: Record<string, string> = {
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin',
  'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Helsinki',
  'GTB Standard Time': 'Europe/Athens',
  'Russian Standard Time': 'Europe/Moscow',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'Singapore Standard Time': 'Asia/Singapore',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'Pacific Standard Time': 'America/Los_Angeles',
};

const isUtc = (z: string) => /^(utc|gmt|etc\/utc|etc\/gmt|z|coordinated universal time)$/i.test(z.trim());

function ianaOf(zone: string | null | undefined): string | undefined {
  if (!zone || isUtc(zone)) return undefined;
  const z = WINDOWS[zone.trim()] ?? zone.trim();
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: z });
    return z;
  } catch {
    return undefined; // unknown: read as UTC
  }
}

/** Minutes the zone is ahead of UTC at instant t. */
function offsetMinutes(zone: string, t: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(t))
      .map((x) => [x.type, Number(x.value)]),
  );
  return (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000) / 60_000;
}

/** A wall-clock time in its zone as a UTC ISO timestamp, or undefined when it doesn't parse. */
export function wallToUtc(w: WallTime): string | undefined {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d)(?:\.(\d+))?)?(Z|[+-]\d\d:\d\d)?$/.exec(w.dateTime.trim());
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s = '0', frac = '0', offset] = m;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, Math.round(Number(`0.${frac}`) * 1000));
  if (offset) return new Date(Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${s.padStart(2, '0')}${offset}`) + (asUtc % 1000)).toISOString();
  const zone = ianaOf(w.timeZone);
  if (!zone) return new Date(asUtc).toISOString();
  // Correct by the zone's offset at the answer, not at the guess: they differ across a clock change.
  const first = asUtc - offsetMinutes(zone, asUtc) * 60_000;
  return new Date(asUtc - offsetMinutes(zone, first) * 60_000).toISOString();
}

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-GB', { timeZone: timeZone(), ...opts });

/** "Thu 9 Oct, 14:00–15:00", in the zone in force; an all-day event is its day(s). */
export function whenText(start: string, end: string, allDay = false): string {
  const day = (t: string) => fmt({ weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(t)).replace(',', '');
  const time = (t: string) => fmt({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t));
  if (allDay) {
    // Midnight to midnight after its last day, whether the midnights are UTC's or the mailbox's own
    // turned into UTC: two hours in from either end is always on the right day.
    const first = new Date(Date.parse(start) + 2 * 3_600_000).toISOString();
    const last = new Date(Date.parse(end) - 2 * 3_600_000).toISOString();
    return day(first) === day(last) ? `${day(first)}, all day` : `${day(first)} to ${day(last)}, all day`;
  }
  return day(start) === day(end) ? `${day(start)}, ${time(start)}–${time(end)}` : `${day(start)}, ${time(start)} to ${day(end)}, ${time(end)}`;
}
