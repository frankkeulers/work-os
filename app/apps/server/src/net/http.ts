// Every network call has a deadline (CLAUDE.md 11, CL-10) and is cut off when the Mac sleeps:
// a request frozen across sleep would otherwise hang until the far end gave up.

export const DEADLINES = {
  slack: 20_000,
  confluenceGet: 15_000,
  confluencePut: 30_000,
  probe: 5000,
  triage: 120_000,
  draft: 240_000,
} as const;

/** A signal that aborts on the deadline or with any of the given signals, whichever comes first. */
export function deadline(ms: number, ...signals: (AbortSignal | undefined)[]): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(ms), ...signals.filter((s): s is AbortSignal => !!s)]);
}

/** Runs `fn` with a deadline signal. */
export function withDeadline<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>, ...signals: (AbortSignal | undefined)[]): Promise<T> {
  return fn(deadline(ms, ...signals));
}
