import type { SlackApi } from './api';
import type { AuthTest, Conversation, ConversationsResponse, UserInfo } from './types';

// Who is who, and which conversations Frank is in. Kept in memory: names for participants and
// titles, membership to keep search to Frank's own conversations. Refreshed hourly; a user seen for
// the first time is looked up on demand.

const REFRESH_MS = 60 * 60_000;
const MAX_PAGES = 20;

export class SlackDirectory {
  private me?: AuthTest;
  private users = new Map<string, string>();
  private convs = new Map<string, Conversation>();
  private convsAt = 0;

  constructor(
    private readonly api: SlackApi,
    private readonly now: () => number = Date.now,
  ) {}

  /** auth.test, once: Frank's user ID and the workspace URL for permalinks. */
  async identity(signal?: AbortSignal): Promise<AuthTest> {
    return (this.me ??= await this.api.call<AuthTest>('auth.test', {}, signal));
  }

  get identityKnown(): AuthTest | undefined {
    return this.me;
  }

  /** The conversations Frank is a member of, including DMs and group DMs. */
  async conversations(signal?: AbortSignal): Promise<Map<string, Conversation>> {
    if (this.convs.size && this.now() - this.convsAt < REFRESH_MS) return this.convs;
    const next = new Map<string, Conversation>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.api.call<ConversationsResponse>('users.conversations', { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200, cursor }, signal);
      for (const c of r.channels) next.set(c.id, c);
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    this.convs = next;
    this.convsAt = this.now();
    return next;
  }

  /** A conversation by ID: from the member list, or as given by a search match. */
  conversation(id: string): Conversation | undefined {
    return this.convs.get(id);
  }

  /** Display names for these users, looking up any not seen before. */
  async resolveUsers(ids: Iterable<string>, signal?: AbortSignal) {
    for (const id of new Set(ids)) {
      if (this.users.has(id)) continue;
      try {
        const r = await this.api.call<UserInfo>('users.info', { user: id }, signal);
        const p = r.user.profile;
        this.users.set(id, p?.display_name || p?.real_name || r.user.real_name || r.user.name || id);
      } catch (err) {
        // A missing name is not worth failing a poll over, but an outage is.
        if ((err as { failure?: { state?: string } }).failure?.state === 'degraded') this.users.set(id, id);
        else throw err;
      }
    }
  }

  name = (id: string): string => this.users.get(id) ?? id;

  /** A conversation's title: "#channel", the DM partner's name, or a group DM's names. */
  title(c: Conversation, participants: string[]): string {
    if (c.is_im) return this.name(c.user ?? participants.find((p) => p !== this.me?.user_id) ?? c.id);
    if (c.is_mpim) {
      const names = participants.filter((p) => p !== this.me?.user_id).map(this.name);
      return names.length ? names.join(', ') : (c.name ?? c.id);
    }
    return c.name ? `#${c.name}` : c.id;
  }
}
