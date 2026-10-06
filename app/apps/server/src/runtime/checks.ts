import { execFile } from 'node:child_process';
import type { DependencyHealth, StartupCheck } from '@work-os/shared';
import { tokenAccount } from '../api/auth';
import type { Instance } from '../config/env';
import { SLACK_TOKEN_ACCOUNT, type SecretStore } from '../config/keychain';

// Startup checks (FR-12.2). They run after the server is listening, never block it, and run again
// on wake, on a settings save and on "Check again". A failed check puts the server in degraded
// mode with the fix shown in the UI; only an API key stops it (CL-2), before any of this runs.

export type Exec = (cmd: string, args: string[]) => Promise<{ code: number; stdout: string }>;

export const exec: Exec = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : -1) : 0, stdout: String(stdout) }));
  });

export interface CheckDeps {
  exec: Exec;
  secrets: SecretStore;
  instance: Instance;
  settingsCheck: () => StartupCheck;
  /** Claude's health as the last real call left it (triage, drafts); undefined before the runtime. */
  claude?: () => DependencyHealth | undefined;
}

/**
 * The Claude login, judged by the calls Work OS already makes rather than an extra one every few
 * minutes: every triage and draft call reports to health, so a lost login shows at the first call
 * that needs it, with its fix. Until the first call it is unknown, which is a warning, not a failure.
 */
function claudeCheck(h: DependencyHealth | undefined): StartupCheck {
  const label = 'Claude login works';
  if (!h || h.state === 'unknown') return check('claude_login', label, 'warn', 'not called yet: checked by the first triage');
  if (h.state === 'ok') return check('claude_login', label, 'ok', h.lastOkAt ? `ok: last call ${h.lastOkAt}` : 'ok');
  if (h.state === 'auth_failed') return check('claude_login', label, 'fail', h.fix ?? 'signed out: run `claude login`');
  return check('claude_login', label, 'warn', h.fix ?? `${h.state}${h.reason ? `: ${h.reason}` : ''}`);
}

const check = (id: StartupCheck['id'], label: string, status: StartupCheck['status'], note: string): StartupCheck => ({ id, label, status, note });

export async function runChecks(d: CheckDeps): Promise<StartupCheck[]> {
  const [fv, pmset, keychain, slack] = await Promise.all([
    d.exec('/usr/bin/fdesetup', ['status']),
    d.exec('/usr/bin/pmset', ['-g']),
    d.secrets.get(tokenAccount(d.instance)).then(
      () => true,
      () => false,
    ),
    d.secrets.get(SLACK_TOKEN_ACCOUNT).then(
      (v) => (v ? 'present' : 'missing'),
      () => 'unreadable' as const,
    ),
  ]);
  const powerNap = /^\s*powernap\s+1\b/m.test(pmset.stdout);
  return [
    /FileVault is On/.test(fv.stdout) ? check('filevault', 'FileVault on', 'ok', 'ok') : check('filevault', 'FileVault on', 'warn', fv.code === 0 ? 'off: local files hold company messages' : 'could not check'),
    check('api_key', 'ANTHROPIC_API_KEY not set', 'ok', 'ok'),
    slack === 'present'
      ? check('slack_token', 'Slack token in Keychain', 'ok', 'ok')
      : check('slack_token', 'Slack token in Keychain', 'fail', slack === 'missing' ? `missing: add it to the Keychain as ${SLACK_TOKEN_ACCOUNT}` : 'Keychain locked'),
    claudeCheck(d.claude?.()),
    d.settingsCheck(),
    keychain ? check('keychain', 'Keychain readable', 'ok', 'ok') : check('keychain', 'Keychain readable', 'fail', 'locked or unreadable: unlock the login Keychain'),
    check('power_nap', 'Power Nap', 'ok', powerNap ? 'on: Claude calls wait 45 s after a wake' : 'off'),
  ];
}
