import type { Ms365Connector } from '@work-os/shared';
import { SourceError } from '../errors';
import type { Ms365Api } from './client';

// What Settings › Sources › Outlook does to connect (R2.5): find the Microsoft 365 connector among
// the claude.ai connectors (no model turn), or take the id Frank pasted, check claude.ai has it
// signed in, and ask it who it reads mail as (one get_me relay run). Failures come back as the
// sentence Settings shows.

export type Ms365Account = NonNullable<Ms365Connector['account']>;

export class Ms365LinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Ms365LinkError';
  }
}

export interface Ms365Link {
  /** The connector to use and the account it reads: found, or the pasted id, then tested. */
  connect(connectorId: string | undefined, signal: AbortSignal): Promise<{ id: string; account: Ms365Account }>;
}

const SIGNED_OUT = 'The Microsoft 365 connector on claude.ai is signed out. Reconnect it on claude.ai (Settings → Connectors), then choose Connect again.';
const NOT_FOUND = 'Couldn’t find the Microsoft 365 connector among your claude.ai connectors. Add it on claude.ai (Settings → Connectors) and choose Connect again, or enter its ID.';
const UNKNOWN_ID = 'claude.ai has no connector with that ID, or it is signed out. Check the ID, or leave it empty to find the connector.';

/** Who get_me says the connector is signed in as. */
export function accountOf(me: { displayName?: string | null; mail?: string | null; userPrincipalName?: string | null }): Ms365Account {
  const address = (me.mail || me.userPrincipalName || '').trim().toLowerCase();
  if (!address) throw new Ms365LinkError('The Microsoft 365 connector didn’t say which account it reads. Try Connect again.');
  const upn = me.userPrincipalName?.trim().toLowerCase();
  return { name: me.displayName?.trim() || address, address, ...(upn && upn !== address && { upn }) };
}

/** A failure as the sentence Settings shows; anything unexpected is left as it is. */
function explain(err: unknown, pasted: boolean): unknown {
  if (!(err instanceof SourceError)) return err;
  if (err.dep === 'claude') return new Ms365LinkError(`Claude can’t be called right now (${err.message}). Try again once Claude is working.`);
  if (err.failure.state === 'auth_failed') return new Ms365LinkError(pasted ? UNKNOWN_ID : SIGNED_OUT);
  return new Ms365LinkError(`The Microsoft 365 connector didn’t answer (${err.message}). Try again in a minute.`);
}

/** `make(id)`: the connector API reading through the connector with this id. */
export function ms365Link(make: (connectorId?: string) => Ms365Api): Ms365Link {
  return {
    async connect(pasted, signal) {
      try {
        let id = pasted;
        if (!id) {
          const found = await make().discover(signal);
          if (!found) throw new Ms365LinkError(NOT_FOUND);
          if (found.status === 'needs-auth' || found.status === 'disabled') throw new Ms365LinkError(SIGNED_OUT);
          id = found.id;
        }
        const api = make(id);
        if ((await api.status(signal)) !== 'ok') throw new Ms365LinkError(pasted ? UNKNOWN_ID : SIGNED_OUT);
        return { id, account: accountOf(await api.me(signal)) };
      } catch (err) {
        throw explain(err, !!pasted);
      }
    },
  };
}
