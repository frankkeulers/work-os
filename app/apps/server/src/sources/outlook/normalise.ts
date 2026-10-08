import type { Item, Message, Ms365Connector, Participant } from '@work-os/shared';
import type { Address, EmailDetail, Folder } from '../ms365/types';
import { emailText } from './html';

// Outlook emails as inbox items: one item per conversation (Outlook's conversationId), one message
// per email, keyed by its Internet message ID, which stays the same when the email moves folder.
// People are their lower-case address; Frank is the address the connector is signed in as (and his
// UPN), and everything in Sent Items is his. Senders shown as an Exchange path (/O=…) have no
// address: they are matched by name.

export const ITEM_PREFIX = 'outlook:';
export const itemId = (conversationId: string) => `${ITEM_PREFIX}${conversationId}`;
const FALLBACK_LINK = 'https://outlook.office.com/mail/';

/** Frank in Outlook: his address as the ID, his name, and every address that is his. */
export interface MeInfo {
  id: string;
  name: string;
  aliases: string[];
}

/** Frank as the account the connector reads, once Outlook is connected. */
export function meOf(a: Ms365Connector['account']): MeInfo | undefined {
  if (!a) return undefined;
  const id = a.address.toLowerCase();
  return { id, name: a.name || a.address, aliases: [...new Set([id, (a.upn ?? '').toLowerCase()].filter(Boolean))] };
}

/** Replies, forwards and the receipts Outlook sends about them: reading them adds nothing. */
const NOISE_RE = /^\s*(?:accepted|declined|tentative|tentatively accepted|automatic reply|auto[- ]?reply|out of office|read|not read|undeliverable|delivery status notification(?: \(failure\))?|delivery has failed[^:]*)\s*:/i;
export const isNoise = (subject: string | null | undefined) => NOISE_RE.test(subject ?? '');

/** The subject without its Re:/Fw: prefixes, in English and the other languages Outlook uses. */
export function cleanSubject(subject: string | null | undefined): string {
  const s = (subject ?? '').replace(/^\s*(?:(?:re|fw|fwd|aw|wg|sv|vs|antw|rif|tr|enc|r)\s*(?:\[\d+\])?\s*:\s*)+/i, '').trim();
  return s || '(no subject)';
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

export function person(a: Address | null | undefined, me: MeInfo): Participant | undefined {
  const address = lower(a?.address);
  const name = a?.name?.trim() ?? '';
  if (!address && !name) return undefined;
  if (address && me.aliases.includes(address)) return { id: me.id, name: me.name };
  if (!address || address.startsWith('/o=')) {
    if (name && lower(name) === lower(me.name)) return { id: me.id, name: me.name };
    return name ? { id: `name:${lower(name)}`, name } : undefined;
  }
  return { id: address, name: name || address };
}

const isoOf = (t: string | null | undefined) => {
  const ms = t ? Date.parse(t) : NaN;
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
};

/** One email as a message, and the people on it. Everything in Sent Items is Frank's. */
export function messageOf(e: EmailDetail, me: MeInfo, folder?: Folder): { message: Message; people: Participant[] } {
  const author = folder === 'Sent Items' ? { id: me.id, name: me.name } : (person(e.from ?? e.sender, me) ?? { id: 'unknown', name: 'Unknown sender' });
  const to = (e.toRecipients ?? []).map((a) => person(a, me)).filter((p): p is Participant => !!p);
  const cc = (e.ccRecipients ?? []).map((a) => person(a, me)).filter((p): p is Participant => !!p);
  const message: Message = {
    id: e.internetMessageId?.trim() || e.id,
    authorId: author.id,
    ts: isoOf(e.receivedDateTime) ?? isoOf(e.sentDateTime) ?? new Date(0).toISOString(),
    text: emailText(e.body, e.attachments ?? []),
    to: to.map((p) => p.id),
    cc: cc.map((p) => p.id),
  };
  return { message, people: [author, ...to, ...cc] };
}

/** Emails grouped by conversation, oldest message first. */
export function buildItems(emails: { email: EmailDetail; folder?: Folder }[], me: MeInfo): Item[] {
  const byConv = new Map<string, { email: EmailDetail; message: Message; people: Participant[] }[]>();
  for (const { email, folder } of emails) {
    const m = messageOf(email, me, folder);
    const list = byConv.get(email.conversationId) ?? [];
    if (!list.some((x) => x.message.id === m.message.id)) list.push({ email, ...m });
    byConv.set(email.conversationId, list);
  }
  return [...byConv].map(([conv, list]) => {
    list.sort((a, b) => a.message.ts.localeCompare(b.message.ts) || a.message.id.localeCompare(b.message.id));
    const latest = list[list.length - 1];
    const participants: Participant[] = [{ id: me.id, name: me.name }];
    for (const p of list.flatMap((x) => x.people)) if (!participants.some((q) => q.id === p.id)) participants.push(p);
    const link = latest.email.webLink;
    return {
      id: itemId(conv),
      source: 'outlook' as const,
      kind: 'email' as const,
      title: cleanSubject(latest.email.subject ?? list[0].email.subject),
      permalink: link && /^https:\/\//.test(link) ? link : FALLBACK_LINK,
      participants,
      messages: list.map((x) => x.message),
      messageCount: list.length,
      lastActivityAt: latest.message.ts,
      revision: 1,
      schemaVersion: 1 as const,
    };
  });
}
