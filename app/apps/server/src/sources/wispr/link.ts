import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { DEADLINES, deadline } from '../../net/http';
import type { FetchFn } from '../../net/probe';
import type { FakeWispr } from './fakeWispr';
import type { WisprMcp } from './mcp';
import type { WisprAuth } from './oauth';
import { WisprAccount } from './types';

// What Settings › Sources › Wispr Flow does (R2.7): show whether Wispr Flow is connected, start a
// sign-in, finish it when the browser comes back, and disconnect.

export interface WisprLink {
  status(): Promise<{ connected: boolean; account?: string }>;
  /** The sign-in page to open, or no URL when the stored sign-in still works. */
  begin(): Promise<{ url?: string }>;
  finish(code: string, state: string): Promise<void>;
  forget(): Promise<void>;
}

export function wisprLink(auth: WisprAuth, mcp: WisprMcp, fetchFn: FetchFn = fetch): WisprLink {
  const timed: FetchLike = (url, init) => fetchFn(String(url), { ...init, signal: deadline(DEADLINES.wispr, init?.signal ?? undefined) });
  return {
    status: () => auth.status(),
    begin: () => auth.begin(timed),
    async finish(code, state) {
      await auth.finish(code, state, timed);
      // The name is only for Settings: a failure here doesn't undo the sign-in.
      const account = await mcp
        .session(AbortSignal.timeout(2 * DEADLINES.wispr), (call) => call('get_account_info', {}, WisprAccount))
        .then((a) => a.name)
        .catch(() => undefined);
      if (account) {
        mcp.account = account;
        await auth.setAccount(account);
      }
    },
    async forget() {
      await auth.forget();
      mcp.account = undefined;
    },
  };
}

/** `--fakes`: Connect signs in at once, with no browser. */
export function fakeWisprLink(fake: FakeWispr): WisprLink {
  return {
    status: async () => ({ connected: fake.signedIn, ...(fake.signedIn && { account: fake.account }) }),
    begin: async () => ((fake.signedIn = true), {}),
    finish: async () => undefined,
    forget: async () => void (fake.signedIn = false),
  };
}
