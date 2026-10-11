import { z } from 'zod';

// What Wispr Flow's MCP server answers (P0-11), validated before use: a changed response is
// "tools changed", not a crash (R2.7). Objects are not strict, so a field Wispr adds is ignored.
// Every timestamp is UTC ISO 8601 with microseconds, ending in Z.

export const WISPR_MCP_URL = new URL('https://api.wisprflow.ai/connect/mcp');

/** The read tools the source may call (R2.7). Anything else on the server is never called. */
export const WISPR_TOOLS = ['get_account_info', 'search_meetings', 'get_meeting', 'get_meeting_participants_enriched'] as const;
export type WisprTool = (typeof WISPR_TOOLS)[number];

const text = z.string().nullish();

export const WisprAccount = z.object({ name: z.string(), aliases: z.array(z.string()).optional() });
export type WisprAccount = z.infer<typeof WisprAccount>;

export const WisprMeetingRow = z.object({
  id: z.string().min(1),
  title: text,
  finalized: z.boolean(),
  has_transcript: z.boolean().optional(),
  start: text,
  end: text,
  modified_at: z.string().min(1),
  share_link: text,
});
export type WisprMeetingRow = z.infer<typeof WisprMeetingRow>;

export const WisprSearchPage = z.object({
  // Each row is checked on its own (adapter): one odd row is skipped, not the whole page.
  meetings: z.array(z.unknown()),
  has_more: z.boolean(),
  next_cursor: text,
});
export type WisprSearchPage = z.infer<typeof WisprSearchPage>;

export const WisprMeeting = WisprMeetingRow.extend({
  content: text, // Frank's own notes, markdown
  summary: text, // markdown with ### sections; action items under "### Next Steps"
  todos: z.array(z.unknown()).optional(),
  transcript: text, // only when asked for: "Speaker: text" lines, bounded, with a continuation marker
});
export type WisprMeeting = z.infer<typeof WisprMeeting>;

export const WisprParticipants = z.object({
  user: z.object({ name: z.string().optional(), email: z.string().optional() }).optional(),
  participants: z.array(
    z.object({
      name: z.string(),
      contact_id: text,
      is_self: z.boolean().optional(),
      spoke: z.boolean().optional(),
      relationship: text,
    }),
  ),
});
export type WisprParticipants = z.infer<typeof WisprParticipants>;
