import { ConfigError, EXIT, resolveConfig } from '../config/env';
import { paths } from '../config/dataDir';
import { acquireLock } from '../runtime/lock';
import { rebuildState } from '../store/store';

// npm run rebuild-state: rebuilds state/snapshot.json from the whole event log (FR-1.4, Story 1.1).
// It takes the lock, so it never races a running server; the running server rebuilds through
// Settings › Rebuild state instead.

async function main(): Promise<number> {
  let config;
  try {
    config = resolveConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(e.message);
      return EXIT.config;
    }
    throw e;
  }
  const lock = await acquireLock(paths(config.dataDir).lock, { instance: config.instance, port: 0, version: config.version });
  if (!lock.ok) {
    console.error(`Work OS is running (pid ${lock.holder.pid}, port ${lock.holder.port}). Rebuild from Settings in the UI, or stop it first.`);
    return EXIT.lockHeld;
  }
  try {
    const { state, log, ms } = await rebuildState(config.dataDir);
    console.log(`Rebuilt ${config.dataDir}/state/snapshot.json from ${log.events} events in ${log.files} files (${ms} ms).`);
    console.log(`Items: ${Object.keys(state.items).length}. Actions: ${Object.keys(state.actions).length}. Last seq: ${state.lastSeq}.`);
    if (log.torn.length) console.log(`Cut off ${log.torn.length} torn line(s); kept in events/quarantine/.`);
    if (log.quarantined.length) console.log(`Moved ${log.quarantined.length} unreadable line(s) to events/quarantine/.`);
    if (log.gaps.length) console.log(`Missing seqs: ${log.gaps.map((g) => (g.from === g.to ? g.from : `${g.from}–${g.to}`)).join(', ')}.`);
    return EXIT.ok;
  } finally {
    await lock.lock.release();
  }
}

process.exitCode = await main();
