import { z } from 'zod';

// What the claude.ai Microsoft 365 connector returns (P0-9 and its addendum, 8 Oct 2026). Every
// result is a list of text blocks, one JSON value per block. The schemas name only the fields the
// sources read, and let anything else through: a field the connector adds is ignored, a field it
// drops that we need is a schema error, reported as the connector having changed.

/** The connector's key in mcpServers; its tools are mcp__ms365__<tool>. */
export const MS365_NAME = 'ms365';

/**
 * Its tools as the spike listed them (50). The relay hides every tool but the one it calls, so the
 * list must be complete: a run's init message replaces it with the live list (Ms365Relay.tools).
 */
export const MS365_TOOLS = [
  'read_resource', 'sharepoint_search', 'sharepoint_folder_search', 'outlook_email_search', 'outlook_calendar_search', 'find_meeting_availability',
  'outlook_find_available_time', 'chat_message_search', 'teams_list_chats', 'get_me', 'search_people', 'teams_list_teams', 'teams_list_channels',
  'teams_list_channel_messages', 'outlook_send_mail', 'outlook_set_vacation', 'outlook_forward_mail', 'outlook_create_filter', 'outlook_trash_thread',
  'outlook_create_label', 'outlook_update_label', 'outlook_batch_delete_messages', 'outlook_delete_label', 'outlook_untrash_thread', 'outlook_create_draft',
  'outlook_create_reply_draft', 'outlook_create_reply_all_draft', 'outlook_update_draft', 'outlook_send_draft', 'outlook_delete_draft', 'outlook_create_event',
  'outlook_update_event', 'outlook_delete_event', 'outlook_modify_labels', 'outlook_delete_filter', 'outlook_modify_thread_labels', 'outlook_batch_modify_labels',
  'outlook_respond_to_event', 'sharepoint_upload_file', 'sharepoint_update_file', 'sharepoint_create_folder', 'sharepoint_rename_item', 'sharepoint_move_item',
  'sharepoint_copy_item', 'sharepoint_delete_item', 'teams_send_chat_message', 'teams_send_channel_message', 'teams_reply_channel_message', 'teams_create_chat',
  'get_granted_scopes',
];

/** The only tools the Outlook sources call: all read-only. */
export type Ms365Tool = 'outlook_email_search' | 'read_resource' | 'get_me';

export const Folder = z.enum(['Inbox', 'Sent Items']);
export type Folder = z.infer<typeof Folder>;

/** One email in an outlook_email_search result: a preview, no conversation (P0-9 addendum). */
export const EmailRow = z.looseObject({
  uri: z.string().min(1),
  id: z.string().min(1),
  subject: z.string().nullish(),
  sender: z.string().nullish(),
  receivedDateTime: z.string().min(1),
  internetMessageId: z.string().nullish(),
});
export type EmailRow = z.infer<typeof EmailRow>;

/** The last block of a search: whether there is more, and where it starts. */
export const SearchPaging = z.looseObject({
  moreResults: z.boolean().optional(),
  nextOffset: z.number().int().nonnegative().optional(),
  nextCursor: z.string().optional(),
  totalResultCount: z.number().int().nonnegative().optional(),
});

export interface SearchPage {
  emails: EmailRow[];
  /** The offset of the next page, when there is one. */
  nextOffset?: number;
}

const Address = z.looseObject({ name: z.string().nullish(), address: z.string().nullish() });
export type Address = z.infer<typeof Address>;

/** One email read whole with read_resource. */
export const EmailDetail = z.looseObject({
  id: z.string().min(1),
  subject: z.string().nullish(),
  body: z.looseObject({ contentType: z.string().nullish(), content: z.string().nullish() }).nullish(),
  bodyPreview: z.string().nullish(),
  sender: Address.nullish(),
  from: Address.nullish(),
  toRecipients: z.array(Address).nullish(),
  ccRecipients: z.array(Address).nullish(),
  receivedDateTime: z.string().min(1),
  sentDateTime: z.string().nullish(),
  attachments: z.array(z.looseObject({ name: z.string().nullish(), isInline: z.boolean().nullish() })).nullish(),
  isDraft: z.boolean().nullish(),
  conversationId: z.string().min(1),
  internetMessageId: z.string().nullish(),
  webLink: z.string().nullish(),
});
export type EmailDetail = z.infer<typeof EmailDetail>;

/** get_me: the signed-in account. `mail` can be null for a guest; then the UPN is the address. */
export const Me = z.looseObject({
  displayName: z.string().nullish(),
  mail: z.string().nullish(),
  userPrincipalName: z.string().nullish(),
});
export type Me = z.infer<typeof Me>;
