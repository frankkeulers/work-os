import type { EmailDetail } from '../ms365/types';
import { emailText } from '../outlook/html';
import { JOIN_BLOCK_RE } from './normalise';
import type { CalendarSnapshot } from './store';

// While the calendar is read, a meeting's own mail (its invitation, an update, its cancellation)
// would be the same news twice: once as an invite item, once as an email (R2.8). The connector
// doesn't mark meeting mail (P0-12), so it is recognised by what it is: from the event's organiser,
// with the event's subject, and either Outlook's "Canceled:"/"Updated:" prefix or the joining
// details an invitation carries. Answers ("Accepted: …") are left to the mail source, and a reply
// or forward about the meeting is a conversation, so it stays mail.

const MEETING_PREFIX_RE = /^\s*(?:cancell?ed|updated(?: invitation)?|invitation|new time proposed)\s*:\s*/i;
const REPLY_RE = /^\s*(?:re|fw|fwd|aw|wg|sv|vs|antw|rif|tr|enc|r)\s*(?:\[\d+\])?\s*:/i;
const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** The email is the invitation, an update or the cancellation of an event in the snapshot. */
export function isMeetingMail(e: EmailDetail, snap: CalendarSnapshot): boolean {
  const subject = e.subject ?? '';
  if (REPLY_RE.test(subject)) return false;
  const bare = norm(subject.replace(MEETING_PREFIX_RE, ''));
  const from = norm(e.from?.address ?? e.sender?.address);
  if (!bare || !from) return false;
  if (!snap.events.some((ev) => norm(ev.subject) === bare && norm(ev.organizer?.address) === from)) return false;
  return MEETING_PREFIX_RE.test(subject) || JOIN_BLOCK_RE.test(emailText(e.body));
}
