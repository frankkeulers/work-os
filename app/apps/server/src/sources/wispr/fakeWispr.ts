import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { cursorKey } from './normalise';
import tools from './fixtures/tools.json';
import type { WisprMeeting, WisprParticipants } from './types';

// A made-up Wispr Flow MCP server for tests and `--fakes` (R2.7): the real MCP protocol over an
// in-memory transport, answering the four read tools in the shapes P0-11 recorded. No network and
// no sign-in; `signedIn = false` makes connecting fail the way an expired sign-in does.

export interface FakeMeeting extends WisprMeeting {
  participants?: WisprParticipants['participants'];
}

export class FakeWispr {
  readonly meetings = new Map<string, FakeMeeting>();
  account = 'Frank Keulers';
  signedIn = true;
  /** Fail every tool call with this HTTP status (429, 500…) until cleared. */
  failWith?: number;
  /** Drop a tool from the list, or mark it writable: the "tools changed" case. */
  toolsChanged = false;
  calls: { tool: string; args: Record<string, unknown> }[] = [];

  add(m: Partial<FakeMeeting> & Pick<FakeMeeting, 'id' | 'modified_at'>) {
    this.meetings.set(m.id, { title: 'Meeting', finalized: true, has_transcript: true, summary: '### Next Steps\n- Something', content: '', todos: [], share_link: `https://wisprflow.ai/m/${m.id}`, ...m });
    return this;
  }

  private answer(tool: string, args: Record<string, unknown>): unknown {
    if (tool === 'get_account_info') return { name: this.account, aliases: [] };
    if (tool === 'search_meetings') {
      const all = [...this.meetings.values()].sort((a, b) => cursorKey(b).localeCompare(cursorKey(a)));
      const start = Number(args.cursor ?? 0);
      const limit = Number(args.limit ?? 25);
      const page = all.slice(start, start + limit);
      const more = start + limit < all.length;
      return {
        meetings: page.map(({ id, title, finalized, has_transcript, start: s, end, modified_at, share_link }) => ({ id, title, content_excerpt: '', finalized, has_transcript, attendees: [], start: s, end, modified_at, share_link })),
        count: page.length,
        has_more: more,
        ...(more && { next_cursor: String(start + limit) }),
      };
    }
    const m = this.meetings.get(String(args.meeting_id));
    if (!m) throw new Error(`No meeting ${String(args.meeting_id)}`);
    if (tool === 'get_meeting') {
      const { participants: _p, transcript, ...rest } = m;
      const v = args.view_transcript as { start_char?: number; char_limit?: number } | undefined;
      if (!v || !transcript) return { ...rest, attendees: [] };
      const from = v.start_char ?? 0;
      const to = from + (v.char_limit ?? 12000);
      const left = transcript.length - to;
      return { ...rest, attendees: [], transcript: transcript.slice(from, to) + (left > 0 ? `\n(...truncated, ${left} chars remaining; continue with view_transcript.start_char=${to}...)` : '') };
    }
    if (tool === 'get_meeting_participants_enriched') {
      return { meeting_id: m.id, user: { name: this.account, email: 'frank@example.com' }, participants: [{ name: 'Frank', is_self: true, spoke: true, relationship: 'self' }, ...(m.participants ?? [])] };
    }
    throw new Error(`Unknown tool ${tool}`);
  }

  private server(): Server {
    const s = new Server({ name: 'wispr-meetings', version: '1' }, { capabilities: { tools: {} } });
    s.setRequestHandler(ListToolsRequestSchema, () => ({
      tools: tools.tools
        .filter((t) => !(this.toolsChanged && t.name === 'get_meeting'))
        .map((t) => ({ ...t, inputSchema: t.inputSchema as { type: 'object' } })),
    }));
    s.setRequestHandler(CallToolRequestSchema, (req): CallToolResult => {
      const args = (req.params.arguments ?? {}) as Record<string, unknown>;
      this.calls.push({ tool: req.params.name, args });
      if (this.failWith === 429) return { isError: true, content: [{ type: 'text', text: 'Too many requests. Wait a minute and try again.' }] };
      try {
        const out = this.answer(req.params.name, args) as Record<string, unknown>;
        return { structuredContent: out, content: [{ type: 'text', text: JSON.stringify(out) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: (e as Error).message }] };
      }
    });
    return s;
  }

  /** A Connector for WisprMcp. */
  connector = async (): Promise<Client> => {
    if (!this.signedIn) throw new UnauthorizedError('Signed out');
    if (this.failWith && this.failWith !== 429) throw new StreamableHTTPError(this.failWith, `HTTP ${this.failWith}`);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await this.server().connect(b);
    const client = new Client({ name: 'work-os-test', version: '0' });
    await client.connect(a);
    return client;
  };
}
