// The parts of Slack's Web API answers that Work OS reads.

export interface SlackMessage {
  type?: string;
  subtype?: string;
  ts: string;
  thread_ts?: string;
  user?: string;
  bot_id?: string;
  app_id?: string;
  text?: string;
  /** Block Kit layout. For an app's post (Gong, say) this is the message; `text` is only its notification line. */
  blocks?: SlackBlock[];
  /** Legacy attachments, which older apps post their content in. */
  attachments?: SlackAttachment[];
  /** Shared files: a message can be only these. */
  files?: { name?: string; title?: string }[];
  reply_count?: number;
  latest_reply?: string;
  permalink?: string;
}

export interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: { type: string; text: string }[];
  elements?: { type: string; text?: string }[];
}

export interface SlackAttachment {
  fallback?: string;
  pretext?: string;
  title?: string;
  text?: string;
  fields?: { title?: string; value?: string }[];
}

/** A search match carries its channel and permalink with it. */
export interface SearchMatch extends SlackMessage {
  channel: { id: string; name?: string; is_im?: boolean; is_mpim?: boolean; is_private?: boolean };
}

export interface SearchResponse {
  messages: { matches: SearchMatch[]; paging?: { page: number; pages: number }; pagination?: { page: number; page_count: number } };
}

export interface Conversation {
  id: string;
  name?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  user?: string; // the other person in a DM
}

export interface Paged {
  response_metadata?: { next_cursor?: string };
}

export interface HistoryResponse extends Paged {
  messages: SlackMessage[];
  has_more?: boolean;
}

export interface ConversationsResponse extends Paged {
  channels: Conversation[];
}

export interface AuthTest {
  url: string; // https://<team>.slack.com/
  team?: string;
  user?: string;
  user_id: string;
  team_id?: string;
}

export interface MembersResponse extends Paged {
  members: string[];
}

export interface UserInfo {
  user: { id: string; name?: string; real_name?: string; is_bot?: boolean; deleted?: boolean; profile?: { display_name?: string; real_name?: string } };
}
