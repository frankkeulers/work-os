import type { DepState } from '@work-os/shared';
import { SourceError } from '../errors';
import { PAGE_SIZE, type Discovered, type Ms365Api, type ReadOutcome, type SearchArgs } from './client';
import { MS365_TOOLS, type EmailDetail, type EmailRow, type Folder, type Me, type SearchPage } from './types';

// The Microsoft 365 connector in memory, for tests and --fakes runs: never a live call. A mailbox
// of Inbox and Sent Items that search pages through (oldest first, PAGE_SIZE at a time, as the real
// tool does with folderName and order "oldest") and read hands back whole. Tests can make a read
// fail, leave it unmade (the model skipped it), or sign the connector out.

export const FAKE_CONNECTOR_ID = 'mcpsrv_fake0000000000000000';

export interface FakeMs365Options {
  me?: Me;
  connected?: boolean;
}

export class FakeMs365 implements Ms365Api {
  readonly folders: Record<Folder, EmailDetail[]> = { Inbox: [], 'Sent Items': [] };
  me_: Me;
  /** 'connected' | 'needs-auth' | … as claude.ai would report it. */
  status_ = 'connected';
  /** By URI: a read that fails ('gone' or an error text), or is never made ('skip'). */
  readFaults = new Map<string, 'gone' | 'skip' | string>();
  searches: SearchArgs[][] = [];
  reads: string[][] = [];

  constructor(o: FakeMs365Options = {}) {
    this.me_ = o.me ?? { displayName: 'Frank Keulers', mail: 'frank.keulers@example.com', userPrincipalName: 'frank.keulers@example.com' };
    if (o.connected === false) this.status_ = 'needs-auth';
  }

  static uri = (id: string) => `mail:///messages/${encodeURIComponent(id)}`;

  /** Adds an email to a folder. */
  deliver(folder: Folder, e: EmailDetail) {
    this.folders[folder].push(e);
  }

  private check() {
    if (this.status_ !== 'connected')
      throw new SourceError('ms365', { state: this.status_ === 'needs-auth' ? 'auth_failed' : 'degraded', reason: `connector ${this.status_}` }, `Microsoft 365: connector ${this.status_}`);
  }

  private row(e: EmailDetail): EmailRow {
    return {
      uri: FakeMs365.uri(e.id),
      id: e.id,
      subject: e.subject,
      sender: e.from?.address ?? e.sender?.address,
      receivedDateTime: e.receivedDateTime,
      internetMessageId: e.internetMessageId,
    };
  }

  async search(calls: SearchArgs[]): Promise<(SearchPage | undefined)[]> {
    this.check();
    this.searches.push(calls);
    return calls.map((c) => {
      const all = this.folders[c.folder].filter((e) => Date.parse(e.receivedDateTime) > Date.parse(c.after)).sort((a, b) => a.receivedDateTime.localeCompare(b.receivedDateTime));
      const page = all.slice(c.offset, c.offset + PAGE_SIZE);
      const more = c.offset + PAGE_SIZE < all.length;
      return { emails: page.map((e) => this.row(e)), ...(more && { nextOffset: c.offset + PAGE_SIZE }) };
    });
  }

  async read(uris: string[]): Promise<ReadOutcome[]> {
    this.check();
    this.reads.push(uris);
    const all = [...this.folders.Inbox, ...this.folders['Sent Items']];
    return uris.map((uri): ReadOutcome => {
      const fault = this.readFaults.get(uri);
      if (fault === 'skip') return undefined;
      if (fault === 'gone') return { ok: false, error: 'ErrorItemNotFound: The specified object was not found in the store.', gone: true };
      if (fault) return { ok: false, error: fault, gone: false };
      const e = all.find((x) => FakeMs365.uri(x.id) === uri);
      return e ? { ok: true, email: e } : { ok: false, error: 'not found', gone: true };
    });
  }

  async me(): Promise<Me> {
    this.check();
    return this.me_;
  }

  async discover(): Promise<Discovered> {
    return { id: FAKE_CONNECTOR_ID, status: this.status_, tools: MS365_TOOLS };
  }

  async status(): Promise<DepState> {
    return this.status_ === 'connected' ? 'ok' : this.status_ === 'needs-auth' || this.status_ === 'disabled' ? 'auth_failed' : 'degraded';
  }
}

let seq = 0;

/** A synthetic email for tests and fakes: plain fields, an HTML body. */
export function fakeEmail(o: {
  conversation: string;
  subject: string;
  from: { name: string; address: string };
  to?: { name: string; address: string }[];
  cc?: { name: string; address: string }[];
  at: string;
  html: string;
  id?: string;
  attachments?: { name: string; isInline?: boolean }[];
}): EmailDetail {
  const n = ++seq;
  const id = o.id ?? `AAMkFAKE${String(n).padStart(4, '0')}`;
  return {
    id,
    subject: o.subject,
    body: { contentType: 'html', content: o.html },
    sender: o.from,
    from: o.from,
    toRecipients: o.to ?? [],
    ccRecipients: o.cc ?? [],
    receivedDateTime: o.at,
    sentDateTime: o.at,
    attachments: o.attachments ?? [],
    conversationId: o.conversation,
    internetMessageId: `<${id}@mail.example.com>`,
    webLink: `https://outlook.office365.com/owa/?ItemID=${encodeURIComponent(id)}&exvsurl=1&viewmodel=ReadMessageItem`,
  };
}
