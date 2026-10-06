import type { Exec } from '../runtime/checks';
import { LABEL } from './plist';

// launchctl, by its modern domain-target commands (bootstrap, bootout, kickstart, print).

export const domain = (uid: number) => `gui/${uid}`;
export const service = (uid: number) => `${domain(uid)}/${LABEL}`;

export interface ServiceInfo {
  loaded: boolean;
  state?: string; // running, waiting, …
  pid?: number;
  lastExitCode?: string; // a number, or text such as "(never exited)"
  runs?: number;
}

/** Reads the top-level fields of `launchctl print gui/<uid>/<label>`. */
export function parsePrint(out: string): Omit<ServiceInfo, 'loaded'> {
  const top = (key: string) => new RegExp(`^\\t${key} = (.+)$`, 'm').exec(out)?.[1]?.trim();
  const pid = top('pid');
  const runs = top('runs');
  return {
    state: top('state'),
    pid: pid ? Number(pid) : undefined,
    lastExitCode: top('last exit code'),
    runs: runs ? Number(runs) : undefined,
  };
}

/** Whether `launchctl print-disabled` lists the agent as disabled (Login Items switched off). */
export function isDisabled(printDisabled: string): boolean {
  const m = new RegExp(`"${LABEL.replace(/\./g, '\\.')}" => (\\w+)`).exec(printDisabled);
  return m ? m[1] === 'disabled' || m[1] === 'true' : false;
}

export class Launchctl {
  constructor(
    private readonly exec: Exec,
    private readonly uid: number,
  ) {}

  private run(...args: string[]) {
    return this.exec('/bin/launchctl', args);
  }

  async info(): Promise<ServiceInfo> {
    const r = await this.run('print', service(this.uid));
    return r.code === 0 ? { loaded: true, ...parsePrint(r.stdout) } : { loaded: false };
  }

  async disabled(): Promise<boolean> {
    return isDisabled((await this.run('print-disabled', domain(this.uid))).stdout);
  }

  /** Loads the agent; it starts at once (RunAtLoad) and at every login. */
  async bootstrap(plist: string) {
    await this.run('enable', service(this.uid));
    const r = await this.run('bootstrap', domain(this.uid), plist);
    if (r.code !== 0) throw new Error(`launchctl bootstrap failed (exit ${r.code}). Is the agent already loaded, or switched off in Login Items?`);
  }

  /** Unloads the agent, stopping the server. Fine if it was not loaded. */
  async bootout() {
    await this.run('bootout', service(this.uid));
  }

  /** Restarts the running server, e.g. after a deploy. */
  async kickstart() {
    const r = await this.run('kickstart', '-k', service(this.uid));
    if (r.code !== 0) throw new Error(`launchctl kickstart failed (exit ${r.code}).`);
  }

  /** True if ANTHROPIC_API_KEY is set for GUI apps. The value itself is never returned or printed. */
  async apiKeyInLaunchdEnv(): Promise<boolean> {
    return (await this.run('getenv', 'ANTHROPIC_API_KEY')).stdout.trim().length > 0;
  }
}
