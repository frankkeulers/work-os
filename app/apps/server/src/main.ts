import { BUILD_VERSION, EXIT } from './config/env';
import { osascriptNotifier } from './notify/macos';
import { STOP_DEADLINE_MS } from './runtime/lifecycle';
import { run } from './start';

// Process entry point: wires signals and crash handling around run().

// `node server.mjs --version` loads the whole bundle and exits: the deploy's smoke test.
if (process.argv.includes('--version')) {
  console.log(BUILD_VERSION);
  process.exit(0);
}

const notifier = osascriptNotifier(process.env.WORKOS_INSTANCE === 'prod' ? '' : '[dev] ');
const fakes = process.argv.includes('--fakes');
const res = await run({ env: process.env, notifier: fakes ? undefined : notifier, echoLogs: process.env.WORKOS_LAUNCHD !== '1', fakes });

if (!res.running) {
  process.exitCode = res.code;
} else {
  const { lifecycle, logger, flush } = res;

  const shutdown = async (reason: string, code: number) => {
    // A hung hook can't keep the process alive past the deadline.
    setTimeout(() => process.exit(code), STOP_DEADLINE_MS + 500).unref();
    const { timedOut, failed } = await lifecycle.stop(reason);
    logger.info({ reason, timedOut, failed }, 'Work OS stopped');
    flush();
    process.exit(code);
  };

  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(sig, () => void shutdown(sig, EXIT.ok));

  // A crash exits non-zero so launchd restarts the server; the next start recovers from the log.
  const crash = (err: unknown) => {
    logger.fatal({ err }, 'Crashed');
    flush();
    process.exit(EXIT.crash);
  };
  process.on('uncaughtException', crash);
  process.on('unhandledRejection', crash);
}
