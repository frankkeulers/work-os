import type { SlackApi } from './api';
import type { AuthTest, Conversation, ConversationsResponse, MembersResponse, SlackUser, UserInfo, UsersListResponse } from './types';

// Who is who, and which conversations Frank is in. Kept in memory: names for participants and
// titles, membership to keep search to Frank's own conversations. Refreshed hourly; a user seen for
// the first time is looked up on demand.

const REFRESH_MS = 60 * 60_000;
const MAX_PAGES = 20;

/** The name Work OS shows and rules match on: display name, then real name, then handle. */
const nameOf = (u: SlackUser) => u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id;

/**
 * A group DM's own name, "mpdm-frank.keulers--dana.lee--sam-1", as "dana.lee, sam": the handles of
 * the others, for when their names aren't known yet.
 */
export function mpdmTitle(name: string | undefined, myHandle?: string): string | undefined {
  const m = name?.match(/^mpdm-(.+)-\d+$/);
  if (!m) return undefined;
  const handles = m[1].split('--').filter((h) => h && h !== myHandle);
  return handles.length ? handles.join(', ') : undefined;
}

export class SlackDirectory {
  private me?: AuthTest;
  private users = new Map<string, string>();
  private bots = new Set<string>();
  private convs = new Map<string, Conversation>();
  private convsAt = 0;
  private members = new Map<string, { at: number; ids: string[] }>();

  constructor(
    readonly api: SlackApi,
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
    // Callers at the same moment (a poll, the inbox naming group DMs) share one listing.
    this.loading ??= this.listConversations(signal).finally(() => (this.loading = undefined));
    return this.loading;
  }

  private loading?: Promise<Map<string, Conversation>>;

  private async listConversations(signal?: AbortSignal): Promise<Map<string, Conversation>> {
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
        this.users.set(id, nameOf(r.user));
        if (r.user.is_bot) this.bots.add(id);
      } catch (err) {
        // A missing name is not worth failing a poll over, but an outage is.
        if ((err as { failure?: { state?: string } }).failure?.state === 'degraded') this.users.set(id, id);
        else throw err;
      }
    }
  }

  name = (id: string): string => this.users.get(id) ?? id;

  private people?: { at: number; list: { name: string; realName?: string }[] };

  /**
   * The workspace's people, for the VIP search: active humans other than Frank, by the name the rules match on,
   * with the real name when it differs. Listed once an hour.
   */
  async listPeople(signal?: AbortSignal): Promise<{ name: string; realName?: string }[]> {
    if (this.people && this.now() - this.people.at < REFRESH_MS) return this.people.list;
    const me = (await this.identity(signal)).user_id;
    const list: { name: string; realName?: string }[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = await this.api.call<UsersListResponse>('users.list', { limit: 200, cursor }, signal);
      for (const u of r.members) {
        if (u.deleted || u.is_bot || u.id === 'USLACKBOT' || u.id === me) continue;
        const name = nameOf(u);
        this.users.set(u.id, name);
        const real = u.profile?.real_name || u.real_name;
        list.push({ name, ...(real && real !== name && { realName: real }) });
      }
      cursor = r.response_metadata?.next_cursor || undefined;
      if (!cursor) break;
    }
    this.people = { at: this.now(), list };
    return list;
  }

  /** Whether a user resolved so far is an app's bot user. */
  isBot = (id: string): boolean => this.bots.has(id);

  /** Everyone in a DM or group DM, named. Refreshed hourly; undefined for channels. */
  async dmMembers(c: Conversation, signal?: AbortSignal): Promise<string[] | undefined> {
    if (!c.is_im && !c.is_mpim) return undefined;
    if (c.is_im) return [this.me?.user_id, c.user].filter((x): x is string => !!x);
    const hit = this.members.get(c.id);
    if (hit && this.now() - hit.at < REFRESH_MS) return hit.ids;
    const r = await this.api.call<MembersResponse>('conversations.members', { channel: c.id, limit: 200 }, signal);
    await this.resolveUsers(r.members, signal);
    this.members.set(c.id, { at: this.now(), ids: r.members });
    return r.members;
  }

  /** Who is in a DM, by channel ID, asking Slack for whatever isn't known yet (after a restart). */
  async dmMembersById(channel: string, signal?: AbortSignal): Promise<string[] | undefined> {
    await this.identity(signal);
    const c = (await this.conversations(signal)).get(channel);
    return c && this.dmMembers(c, signal);
  }

  /** The members cached by dmMembers, without asking Slack. */
  knownMembers = (channel: string): string[] | undefined => this.members.get(channel)?.ids;

  /** A conversation's title: "#channel", the DM partner's name, or a group DM's names. */
  title(c: Conversation, participants: string[]): string {
    if (c.is_im) return this.name(c.user ?? participants.find((p) => p !== this.me?.user_id) ?? c.id);
    if (c.is_mpim) {
      // Everyone in the group, not only who wrote in this window.
      const names = [...new Set(this.knownMembers(c.id) ?? participants)].filter((p) => p !== this.me?.user_id).map(this.name);
      return names.length ? names.join(', ') : mpdmTitle(c.name, this.me?.user) ?? c.id;
    }
    return c.name ? `#${c.name}` : c.id;
  }
}
