// All times display in Europe/London, whatever the browser's zone, so the mock clock reads the same everywhere.
export const TZ = 'Europe/London';

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ,
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

export function londonParts(d: Date | string) {
  const parts = Object.fromEntries(partsFmt.formatToParts(new Date(d)).map((p) => [p.type, p.value]));
  return {
    weekday: parts.weekday as string, // Mon, Tue…
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    hours: Number(parts.hour),
    minutes: Number(parts.minute),
  };
}

const MINUTES_IN_DAY = 24 * 60;
const toMins = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** True when the London time of d falls in an "HH:MM–HH:MM" range; ranges may wrap midnight. */
export function inTimeRange(d: Date | string, range: string): boolean {
  const m = /^(\d\d:\d\d)\s*[–-]\s*(\d\d:\d\d)$/.exec(range.trim());
  if (!m) return false;
  const p = londonParts(d);
  const now = p.hours * 60 + p.minutes;
  const from = toMins(m[1]);
  const to = toMins(m[2]);
  return from <= to ? now >= from && now < to : now >= from || now < to % MINUTES_IN_DAY;
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Parses "Mon–Fri 08:00–18:30". Falls back to weekdays 08:00–18:30. */
export function isWorkHours(d: Date | string, spec: string): boolean {
  const m = /^(\w{3})\s*[–-]\s*(\w{3})\s+(\d\d:\d\d\s*[–-]\s*\d\d:\d\d)$/.exec(spec.trim());
  const [fromDay, toDay, range] = m ? [m[1], m[2], m[3]] : ['Mon', 'Fri', '08:00–18:30'];
  const day = DAYS.indexOf(londonParts(d).weekday);
  const a = DAYS.indexOf(fromDay);
  const b = DAYS.indexOf(toDay);
  if (day < 0 || a < 0 || b < 0) return false;
  const inDays = a <= b ? day >= a && day <= b : day >= a || day <= b;
  return inDays && inTimeRange(d, range);
}

/** Next London 09:00 after d, as ISO. */
export function tomorrowAt9(d: Date): string {
  const p = londonParts(d);
  // Start from London midnight of today, then step forward a day and to 09:00, correcting for the offset.
  const guess = new Date(`${p.dateKey}T09:00:00Z`);
  const offsetMins = londonParts(guess).hours * 60 + londonParts(guess).minutes - 9 * 60;
  const nine = new Date(guess.getTime() - offsetMins * 60_000 + 24 * 3600_000);
  return nine.toISOString();
}

/** London HH:MM on d's London day, or `days` later, as ISO. */
export function londonAt(d: Date, hhmm: string, days = 0): string {
  const [h, m] = hhmm.split(':').map(Number);
  const guess = new Date(`${londonParts(d).dateKey}T${hhmm}:00Z`);
  const g = londonParts(guess);
  let offsetMins = (g.hours * 60 + g.minutes - (h * 60 + m) + MINUTES_IN_DAY) % MINUTES_IN_DAY;
  if (offsetMins > MINUTES_IN_DAY / 2) offsetMins -= MINUTES_IN_DAY;
  return new Date(guess.getTime() - offsetMins * 60_000 + days * MINUTES_IN_DAY * 60_000).toISOString();
}
