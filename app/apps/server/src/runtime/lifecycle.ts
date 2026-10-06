// Graceful shutdown (PLAN.md robustness §2). Modules register a stop hook as they start; stop()
// runs them newest first, so the lock, taken first, is released last. A hook that fails or hangs
// never blocks the rest: the whole stop has a deadline, and launchd's ExitTimeOut is longer.

export const STOP_DEADLINE_MS = 8000;

type Hook = { name: string; fn: (reason: string) => unknown };

export class Lifecycle {
  private hooks: Hook[] = [];
  private stopping?: Promise<{ timedOut: boolean; failed: string[] }>;

  constructor(private readonly onHookError: (name: string, err: unknown) => void = () => undefined) {}

  get isStopping() {
    return !!this.stopping;
  }

  onStop(name: string, fn: (reason: string) => unknown) {
    this.hooks.push({ name, fn });
  }

  /** Runs every hook once. Calling it again returns the same result. */
  stop(reason: string, deadlineMs = STOP_DEADLINE_MS) {
    this.stopping ??= this.runHooks(reason, deadlineMs);
    return this.stopping;
  }

  private async runHooks(reason: string, deadlineMs: number) {
    const failed: string[] = [];
    const all = (async () => {
      for (const h of [...this.hooks].reverse()) {
        try {
          await h.fn(reason);
        } catch (e) {
          failed.push(h.name);
          this.onHookError(h.name, e);
        }
      }
      return false;
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(true), deadlineMs);
    });
    const timedOut = await Promise.race([all, deadline]);
    clearTimeout(timer);
    return { timedOut, failed };
  }
}
