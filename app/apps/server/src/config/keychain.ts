import { execFile } from 'node:child_process';

// Secrets live only in the macOS login Keychain (CLAUDE.md 6), read through /usr/bin/security.
// No native module: `security` ships with macOS and keeps working across Node upgrades.

export const KEYCHAIN_SERVICE = 'com.polestar.workos';

/** The Slack user token's account name under KEYCHAIN_SERVICE (P0-1). */
export const SLACK_TOKEN_ACCOUNT = 'slack-user-token';

/** Confluence REST credentials as "email:token" under KEYCHAIN_SERVICE (P0-8). */
export const CONFLUENCE_TOKEN_ACCOUNT = 'confluence-api-token';

/** Wispr Flow's OAuth client registration and tokens, as one JSON value (R2.7, P0-11). */
export const WISPR_OAUTH_ACCOUNT = 'wispr-oauth';

export interface SecretStore {
  /** The secret, or undefined if there is none. Throws if the Keychain can't be read. */
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
}

export class KeychainError extends Error {
  constructor(
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = 'KeychainError';
  }
}

const NOT_FOUND = 44; // errSecItemNotFound, as `security` reports it

function security(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/security', args, { timeout: 5000 }, (err, stdout) => {
      if (!err) return resolve({ code: 0, stdout });
      const code = typeof err.code === 'number' ? err.code : undefined;
      // stderr is not passed on: it can echo the item's attributes.
      if (code !== undefined) resolve({ code, stdout: '' });
      else reject(new KeychainError(err.killed ? 'The Keychain did not answer within 5 s.' : 'Could not run /usr/bin/security.'));
    });
  });
}

export function macKeychain(service = KEYCHAIN_SERVICE): SecretStore {
  return {
    async get(account) {
      const { code, stdout } = await security(['find-generic-password', '-s', service, '-a', account, '-w']);
      if (code === NOT_FOUND) return undefined;
      if (code !== 0) throw new KeychainError(`The Keychain refused the read (security exit ${code}). Is it locked?`, code);
      return stdout.replace(/\n$/, '');
    },
    async set(account, value) {
      // -U updates an existing item. The value is briefly visible to this user's own processes as
      // an argument; `security` has no other non-interactive way to take it.
      const { code } = await security(['add-generic-password', '-U', '-s', service, '-a', account, '-w', value]);
      if (code !== 0) throw new KeychainError(`The Keychain refused the write (security exit ${code}).`, code);
    },
  };
}

/** For tests and for runs with fakes: never touches the real Keychain. */
export function memoryKeychain(initial: Record<string, string> = {}): SecretStore & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    get: async (account) => values[account],
    set: async (account, value) => void (values[account] = value),
  };
}
