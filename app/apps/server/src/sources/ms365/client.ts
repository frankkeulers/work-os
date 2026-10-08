import type { DepState } from '@work-os/shared';
import type { z } from 'zod';
import type { ClaudeAdapter, McpStatus } from '../../claude/adapter';
import { ClaudeError, ConnectorError } from '../../claude/errors';
import { relayBatch, RELAY_MAX_CALLS, type BatchOutcome, type Connector } from '../../claude/relay';
import type { Logger } from '../../log';
import { SourceError } from '../errors';
import { EmailDetail, EmailRow, EventDetail, EventRow, Me, MS365_NAME, MS365_TOOLS, SearchPaging, type EventPage, type Folder, type Ms365Tool, type SearchPage } from './types';

// The claude.ai Microsoft 365 connector, as the Outlook sources use it (R2.5). Every call goes
// through the relay: one Haiku run per batch of up to RELAY_MAX_CALLS calls of one tool, the raw
// results handed to code. Failures are classified for health: the connector's (signed out, not
// answering, tools changed) go to `ms365`, Claude's own (login, usage limit) to `claude`.
//
// Ms365Api is what the adapters see; FakeMs365 implements it in memory for tests and --fakes.

export const PAGE_SIZE = 25; // the search tool's maximum
const DISCOVER_MS = 30_000;

export interface SearchArgs {
  folder: Folder;
  /** Emails received after this time (ISO). */
  after: string;
  offset: number;
}

/** A read: the email, a failure (gone: deleted or moved since the search), or never made. */
export type ReadOutcome = { ok: true; email: EmailDetail } | { ok: false; error: string; gone: boolean } | undefined;

/** Calendar occurrences starting in [after, before), oldest first (P0-12). */
export interface EventSearchArgs {
  after: string;
  before: string;
  offset: number;
}

/** A read of an event: the event, a failure (gone: deleted since the search), or never made. */
export type EventReadOutcome = { ok: true; event: EventDetail } | { ok: false; error: string; gone: boolean } | undefined;

export interface Discovered {
  id: string;
  url?: string;
  status: string;
  tools: string[];
}

export interface Ms365Api {
  /** Searches, all in one run where they fit; a page is undefined if its search was never made. */
  search(calls: SearchArgs[], signal: AbortSignal): Promise<(SearchPage | undefined)[]>;
  /** Reads whole emails by URI, RELAY_MAX_CALLS per run; outcomes in the order asked. */
  read(uris: string[], signal: AbortSignal): Promise<ReadOutcome[]>;
  /** Calendar searches, all in one run where they fit; a page is undefined if never made. */
  events(calls: EventSearchArgs[], signal: AbortSignal): Promise<(EventPage | undefined)[]>;
  /** Reads whole events by URI, RELAY_MAX_CALLS per run; outcomes in the order asked. */
  readEvents(uris: string[], signal: AbortSignal): Promise<EventReadOutcome[]>;
  /** Who the connector is signed in as. */
  me(signal: AbortSignal): Promise<Me>;
  /** Finds the connector among the claude.ai connectors, with no model turn (for setup). */
  discover(signal: AbortSignal): Promise<Discovered | undefined>;
  /** The configured connector's state, with no model turn (probe). */
  status(signal: AbortSignal): Promise<DepState>;
}

const GONE_RE = /not ?found|ErrorItemNotFound|\b404\b|does not exist|was deleted/i;
export const isMs365 = (s: McpStatus) => s.config?.type === 'claudeai-proxy' && /microsoft 365/i.test(s.name);

/** A connector result's values: text blocks, one JSON value per block (P0-9). */
export function blocks(raw: unknown): unknown[] {
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { content?: unknown })?.content) ? (raw as { content: unknown[] }).content : [raw];
  return list.map((b) => {
    const text = (b as { text?: unknown })?.text;
    if (typeof text !== 'string') return b;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  });
}

const changed = (what: string) => new SourceError('ms365', { state: 'degraded', reason: 'tools_changed' }, `Microsoft 365: ${what} changed shape`);

function parse<S extends z.ZodType>(schema: S, v: unknown, what: string): z.infer<S> {
  const r = schema.safeParse(v);
  if (!r.success) throw changed(what);
  return r.data;
}

/** A search result: the emails, and the next page's offset when there is more. */
export function searchPage(raw: unknown): SearchPage {
  const values = blocks(raw);
  const emails: EmailRow[] = [];
  let nextOffset: number | undefined;
  for (const v of values) {
    if (v && typeof v === 'object' && 'id' in v) emails.push(parse(EmailRow, v, 'outlook_email_search'));
    else if (v && typeof v === 'object') {
      const p = SearchPaging.safeParse(v);
      if (p.success && p.data.moreResults && p.data.nextOffset !== undefined) nextOffset = p.data.nextOffset;
    }
  }
  return { emails, ...(nextOffset !== undefined && { nextOffset }) };
}

/** A calendar search result: the occurrences, the next page's offset and the total, when given. */
export function eventPage(raw: unknown): EventPage {
  const events: EventRow[] = [];
  let nextOffset: number | undefined;
  let total: number | undefined;
  for (const v of blocks(raw)) {
    if (v && typeof v === 'object' && 'uri' in v) events.push(parse(EventRow, v, 'outlook_calendar_search'));
    else if (v && typeof v === 'object') {
      const p = SearchPaging.safeParse(v);
      if (p.success) {
        if (p.data.moreResults && p.data.nextOffset !== undefined) nextOffset = p.data.nextOffset;
        total = p.data.totalResultCount ?? total;
      }
    }
  }
  return { events, ...(nextOffset !== undefined && { nextOffset }), ...(total !== undefined && { total }) };
}

const chunks = <T>(list: T[], n: number) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

export class Ms365Relay implements Ms365Api {
  /** The connector's tools: the spike's list until a run's init message gives the live one. */
  private tools = [...MS365_TOOLS];

  constructor(
    private readonly o: {
      claude: ClaudeAdapter;
      /** The configured connector id (settings.connectors.ms365.id), read at each call. */
      connectorId: () => string | undefined;
      logger?: Logger;
    },
  ) {}

  private connector(): Connector {
    const id = this.o.connectorId();
    if (!id) throw new SourceError('ms365', { state: 'auth_failed', reason: 'token_missing' }, 'Microsoft 365: not connected');
    return { name: MS365_NAME, id, tools: this.tools };
  }

  /** One batched relay of `tool`, its failures classified for health. */
  private async relay(tool: Ms365Tool, calls: Record<string, unknown>[], signal: AbortSignal, itemIds?: string[]): Promise<BatchOutcome[]> {
    const out: BatchOutcome[] = [];
    for (const part of chunks(calls, RELAY_MAX_CALLS)) {
      try {
        const r = await relayBatch(this.o.claude, { connector: this.connector(), tool, calls: part, signal, itemIds });
        if (r.tools.length) this.tools = r.tools;
        out.push(...r.results);
      } catch (err) {
        throw classify(err);
      }
    }
    return out;
  }

  async search(calls: SearchArgs[], signal: AbortSignal): Promise<(SearchPage | undefined)[]> {
    const args = calls.map((c) => ({ folderName: c.folder, afterDateTime: c.after, order: 'oldest', limit: PAGE_SIZE, offset: c.offset }));
    const results = await this.relay('outlook_email_search', args, signal);
    return results.map((r) => {
      if (!r) return undefined;
      if (!r.ok) throw new SourceError('ms365', { state: 'degraded', reason: 'search_failed' }, `Microsoft 365: search failed: ${r.error}`);
      return searchPage(r.raw);
    });
  }

  async read(uris: string[], signal: AbortSignal): Promise<ReadOutcome[]> {
    return (await this.readAll(uris, EmailDetail, signal)).map((r) => (r?.ok ? { ok: true, email: r.value } : r));
  }

  async events(calls: EventSearchArgs[], signal: AbortSignal): Promise<(EventPage | undefined)[]> {
    const args = calls.map((c) => ({ query: '*', afterDateTime: c.after, beforeDateTime: c.before, order: 'oldest', limit: PAGE_SIZE, offset: c.offset }));
    const results = await this.relay('outlook_calendar_search', args, signal);
    return results.map((r) => {
      if (!r) return undefined;
      if (!r.ok) throw new SourceError('ms365', { state: 'degraded', reason: 'search_failed' }, `Microsoft 365: calendar search failed: ${r.error}`);
      return eventPage(r.raw);
    });
  }

  async readEvents(uris: string[], signal: AbortSignal): Promise<EventReadOutcome[]> {
    return (await this.readAll(uris, EventDetail, signal)).map((r) => (r?.ok ? { ok: true, event: r.value } : r));
  }

  /** Reads resources whole with read_resource: each one parsed, failed (gone or not), or never made. */
  private async readAll<S extends z.ZodType>(uris: string[], schema: S, signal: AbortSignal) {
    const results = await this.relay(
      'read_resource',
      uris.map((uri) => ({ uri })),
      signal,
    );
    return results.map((r): { ok: true; value: z.infer<S> } | { ok: false; error: string; gone: boolean } | undefined => {
      if (!r) return undefined;
      if (!r.ok) return { ok: false, error: r.error, gone: GONE_RE.test(r.error) };
      const v = blocks(r.raw)[0];
      if (typeof v === 'string' && GONE_RE.test(v)) return { ok: false, error: v, gone: true };
      return { ok: true, value: parse(schema, v, 'read_resource') };
    });
  }

  async me(signal: AbortSignal): Promise<Me> {
    const [r] = await this.relay('get_me', [{}], signal);
    if (!r) throw new SourceError('ms365', { state: 'degraded', reason: 'relay: the tool was not called' }, 'Microsoft 365: get_me was not called');
    if (!r.ok) throw new SourceError('ms365', { state: 'degraded', reason: 'get_me_failed' }, `Microsoft 365: get_me failed: ${r.error}`);
    return parse(Me, blocks(r.raw)[0], 'get_me');
  }

  async discover(signal: AbortSignal): Promise<Discovered | undefined> {
    const servers = await this.mcp(signal, (l) => l.some((s) => isMs365(s) && s.status !== 'pending'));
    const s = servers.find(isMs365);
    if (!s?.config?.id) return undefined;
    return { id: s.config.id, url: s.config.url, status: s.status, tools: (s.tools ?? []).map((t) => t.name) };
  }

  async status(signal: AbortSignal): Promise<DepState> {
    const id = this.o.connectorId();
    if (!id) return 'auth_failed';
    // Done when this connector has settled, or every one has and it isn't among them (a wrong id).
    const servers = await this.mcp(signal, (l) => l.some((s) => s.config?.id === id && s.status !== 'pending') || (l.length > 0 && l.every((s) => s.status !== 'pending')));
    const s = servers.find((x) => x.config?.id === id);
    if (!s) return 'auth_failed'; // removed from claude.ai
    if (s.status === 'connected') {
      if (s.tools?.length) this.tools = s.tools.map((t) => t.name);
      return 'ok';
    }
    return s.status === 'needs-auth' || s.status === 'disabled' ? 'auth_failed' : 'degraded';
  }

  private async mcp(signal: AbortSignal, done: (l: McpStatus[]) => boolean) {
    try {
      return await this.o.claude.mcpStatus({ timeoutMs: DISCOVER_MS, signal, done });
    } catch (err) {
      throw classify(err);
    }
  }
}

/** A relay failure for health: the connector's go to ms365, Claude's own to claude. */
export function classify(err: unknown): unknown {
  if (err instanceof SourceError) return err;
  if (err instanceof ConnectorError) return new SourceError('ms365', err.failure, err.message);
  if (err instanceof ClaudeError) return new SourceError('claude', err.failure, err.message);
  return err; // an abort (sleep, shutdown) or a bug: the poll pipeline tells them apart
}
