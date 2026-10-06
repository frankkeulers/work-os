import { join } from 'node:path';
import { pino, type DestinationStream, type Logger } from 'pino';

// Structured logs in logs/app-<UTC date>.log (PLAN.md §4.3). Secrets and message bodies never go
// in the log; the redaction list is a backstop, not the rule.

export type { Logger };

const REDACT = ['req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'token', '*.token', 'apiKey', '*.apiKey'];

/** A destination that moves to a new file when the UTC date changes. */
class DailyFile implements DestinationStream {
  private key = '';
  private dest?: ReturnType<typeof pino.destination>;

  constructor(
    private readonly dir: string,
    private readonly now: () => Date,
  ) {}

  write(line: string) {
    const key = this.now().toISOString().slice(0, 10);
    if (key !== this.key) {
      this.dest?.end();
      this.key = key;
      this.dest = pino.destination({ dest: join(this.dir, `app-${key}.log`), sync: false, mkdir: true });
    }
    this.dest!.write(line);
  }

  flushSync() {
    try {
      this.dest?.flushSync();
    } catch {
      // Nothing buffered yet, or the stream is still opening.
    }
  }
}

export interface LogHandle {
  logger: Logger;
  flush(): void;
}

export function createLogger(opts: { dir: string; level?: string; echo?: boolean; now?: () => Date; base?: Record<string, unknown> }): LogHandle {
  const file = new DailyFile(opts.dir, opts.now ?? (() => new Date()));
  const streams: pino.StreamEntry[] = [{ stream: file }];
  if (opts.echo) streams.push({ stream: process.stdout });
  const logger = pino(
    { level: opts.level ?? 'info', base: opts.base ?? {}, redact: { paths: REDACT, censor: '[redacted]' }, timestamp: pino.stdTimeFunctions.isoTime },
    pino.multistream(streams),
  );
  return { logger, flush: () => file.flushSync() };
}
