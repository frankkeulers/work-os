// Crash injection for the robustness tests (PLAN.md Verification): WORKOS_CRASH_AT names a point
// in a write sequence, and the process kills itself with SIGKILL when it gets there, as power loss
// or `kill -9` would. Armed only in `--fakes` runs, which are refused outside a temp data dir, so a
// stray variable can never take down the real server.

export const CRASH_POINTS = ['after-items', 'after-events', 'after-cursor', 'before-write', 'after-write'] as const;
export type CrashPoint = (typeof CRASH_POINTS)[number];

let armed: CrashPoint | undefined;

export function armCrash(point: string | undefined) {
  armed = CRASH_POINTS.find((p) => p === point);
}

export function crashPoint(p: CrashPoint) {
  if (armed === p) process.kill(process.pid, 'SIGKILL');
}
