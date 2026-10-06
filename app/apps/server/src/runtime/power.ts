import { execFileSync } from 'node:child_process';

// Sleep, wake and clock changes (PLAN.md robustness §3). The monotonic clock stops while the Mac
// sleeps and the wall clock doesn't, so each tick compares how far each moved. A gap of more than
// 30 s is a wake if the kernel's wake time changed, and otherwise a clock change.

export interface Clock {
  now(): Date;
  /** Milliseconds that don't advance during sleep (mach_absolute_time behind performance.now). */
  mono(): number;
}

export const systemClock: Clock = { now: () => new Date(), mono: () => performance.now() };

export type PowerEvent = { kind: 'wake'; sleptMs: number } | { kind: 'clock_forward'; skewMs: number } | { kind: 'clock_back'; skewMs: number };

export const SKEW_THRESHOLD_MS = 30_000;

/** kern.waketime: changes on every wake, including Power Nap's brief ones. */
export function readWakeTime(): string | undefined {
  try {
    const out = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.waketime'], { encoding: 'utf8', timeout: 2000 });
    return /sec = (\d+), usec = (\d+)/.exec(out)?.slice(1).join('.') ?? out.trim();
  } catch {
    return undefined;
  }
}

export class PowerMonitor {
  private lastWall: number;
  private lastMono: number;
  private wakeTime: string | undefined;

  constructor(
    private readonly clock: Clock,
    private readonly wakeTimeOf: () => string | undefined = readWakeTime,
    private readonly thresholdMs = SKEW_THRESHOLD_MS,
  ) {
    this.lastWall = clock.now().getTime();
    this.lastMono = clock.mono();
    this.wakeTime = wakeTimeOf();
  }

  /** Called on every tick. Reads the wake time only when the clocks disagree, so it stays cheap. */
  check(): PowerEvent | undefined {
    const wall = this.clock.now().getTime();
    const mono = this.clock.mono();
    const skew = wall - this.lastWall - (mono - this.lastMono);
    this.lastWall = wall;
    this.lastMono = mono;
    if (Math.abs(skew) <= this.thresholdMs) return undefined;
    if (skew < 0) return { kind: 'clock_back', skewMs: skew };
    const wake = this.wakeTimeOf();
    const woke = wake !== undefined && wake !== this.wakeTime;
    this.wakeTime = wake;
    return woke ? { kind: 'wake', sleptMs: skew } : { kind: 'clock_forward', skewMs: skew };
  }
}
