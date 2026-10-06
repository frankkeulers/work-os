import { readlinkSync } from 'node:fs';
import { setTimeZone, timeZone } from '@work-os/shared';

// Work hours, quiet hours and budget days follow the Mac's own time zone (PLAN.md robustness §3).
// Node reads the zone once at start, so when Frank travels the server re-reads /etc/localtime and
// switches both Node's TZ and the shared helpers.

export function systemZone(readlink: (p: string) => string = readlinkSync): string | undefined {
  try {
    const target = readlink('/etc/localtime'); // e.g. /var/db/timezone/zoneinfo/Europe/Paris
    return /zoneinfo\/(.+)$/.exec(target)?.[1];
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  }
}

/** Applies the system zone. Returns the new zone if it changed. */
export function followSystemZone(read: () => string | undefined = systemZone): string | undefined {
  const zone = read();
  if (!zone || zone === timeZone()) return undefined;
  try {
    setTimeZone(zone);
  } catch {
    return undefined; // not a zone Intl knows: keep the current one
  }
  process.env.TZ = zone;
  return zone;
}
