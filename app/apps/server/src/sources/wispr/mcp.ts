import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import { KeychainError } from '../../config/keychain';
import { classifyError, retryAfterMs, type Failure } from '../../net/classify';
import { DEADLINES, deadline } from '../../net/http';
import type { FetchFn } from '../../net/probe';
import { SourceError } from '../errors';
import { SignInNeeded, type WisprAuth } from './oauth';
import { WISPR_MCP_URL, WISPR_TOOLS, type WisprTool } from './types';

// A thin client for Wispr Flow's MCP server (R2.7), with no model in the loop. Each poll or draft
// opens a session, checks the allow-listed tools are still there and read-only, makes its calls
// and closes it: a 3-hourly poll gains nothing from a kept-open connection, and a fresh one never
// straddles a sleep. No retries here or in the SDK: a failed call throws a classified SourceError
// and the wisprMcp breaker decides when to try again (FR-14.3).

export type Connector = (signal: AbortSignal) => Promise<Client>;

export type Call = <S extends z.ZodType>(tool: WisprTool, args: Record<string, unknown>, schema: S) => Promise<z.infer<S>>;

const fail = (failure: Failure, message: string) => new SourceError('wisprMcp', failure, `Wispr Flow: ${message}`);

/** The real server over Streamable HTTP, signed in with the stored tokens; never starts a sign-in. */
export function httpConnector(authStore: WisprAuth, version: string, fetchFn: FetchFn = fetch): Connector {
  return async (signal) => {
    if (!(await authStore.status()).connected) throw fail({ state: 'auth_failed', reason: 'token_missing' }, 'not connected');
    const client = new Client({ name: 'work-os', version });
    const transport = new StreamableHTTPClientTransport(WISPR_MCP_URL, {
      authProvider: authStore.provider(false),
      // Every request, the sign-in's included, has the deadline and stops when the Mac sleeps.
      fetch: (url, init) => fetchFn(String(url), { ...init, signal: deadline(DEADLINES.wispr, init?.signal ?? undefined, signal) }),
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    await client.connect(transport, { signal, timeout: DEADLINES.wispr });
    return client;
  };
}

/** What a failure means for the wisprMcp dependency. */
export function classifyWispr(err: unknown): SourceError {
  if (err instanceof SourceError) return err;
  if (err instanceof KeychainError) return new SourceError('keychain', { state: 'degraded', reason: 'unreadable' }, 'The Keychain is locked, so the Wispr Flow sign-in could not be read.');
  if (err instanceof UnauthorizedError || err instanceof SignInNeeded) return fail({ state: 'auth_failed', reason: 'signed_out' }, 'signed out');
  if (err instanceof StreamableHTTPError) {
    if (err.code === 401 || err.code === 403) return fail({ state: 'auth_failed', reason: `http_${err.code}` }, `HTTP ${err.code}`);
    if (err.code === 429) return fail({ state: 'rate_limited', reason: 'http_429', retryAfterMs: 60_000 }, 'too many requests');
    if (err.code !== undefined) return fail({ state: 'degraded', reason: `http_${err.code}` }, `HTTP ${err.code}`);
  }
  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) return fail({ state: 'degraded', reason: 'timeout', needsProbe: true }, 'timed out');
    if (err.code === ErrorCode.MethodNotFound || err.code === ErrorCode.InvalidParams) return fail({ state: 'degraded', reason: 'tools_changed' }, err.message);
    return fail({ state: 'degraded', reason: `mcp_${err.code}` }, err.message);
  }
  const f = classifyError(err);
  return fail(f, f.reason);
}

/** A tool's answer: structuredContent, or the JSON in its first text block. */
function payload(r: Awaited<ReturnType<Client['callTool']>>): unknown {
  if (r.structuredContent) return r.structuredContent;
  const first = (r.content as { type: string; text?: string }[] | undefined)?.find((c) => c.type === 'text');
  try {
    return first?.text === undefined ? undefined : JSON.parse(first.text);
  } catch {
    return undefined;
  }
}

function errorText(r: Awaited<ReturnType<Client['callTool']>>): string {
  return ((r.content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? '').join(' ').slice(0, 200);
}

export class WisprMcp {
  /** The signed-in name, once a session has asked (identity, Settings). */
  account?: string;
  /** Failed reads per meeting, across polls: one that keeps failing is let through (adapter). */
  readonly readFailures = new Map<string, number>();

  constructor(private readonly connect: Connector) {}

  /** Opens a session, checks the tools, runs `fn` with a typed call, and always closes it. */
  async session<T>(signal: AbortSignal, fn: (call: Call) => Promise<T>): Promise<T> {
    let client: Client | undefined;
    try {
      client = await this.connect(signal);
      const c = client;
      const { tools } = await c.listTools(undefined, { signal, timeout: DEADLINES.wispr });
      for (const name of WISPR_TOOLS) {
        const t = tools.find((x) => x.name === name);
        if (!t || t.annotations?.readOnlyHint !== true) throw fail({ state: 'degraded', reason: 'tools_changed' }, `tool ${name} is ${t ? 'no longer read-only' : 'gone'}`);
      }
      const call: Call = async (tool, args, schema) => {
        if (!WISPR_TOOLS.includes(tool)) throw new Error(`${tool} is not on the Wispr Flow allow-list.`);
        const r = await c.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: DEADLINES.wispr });
        if (r.isError) {
          const text = errorText(r);
          if (/too many requests|rate.?limit/i.test(text)) throw fail({ state: 'rate_limited', reason: 'too_many_requests', retryAfterMs: retryAfterMs('60') }, text);
          throw fail({ state: 'degraded', reason: 'tool_error' }, `${tool}: ${text}`);
        }
        const parsed = schema.safeParse(payload(r));
        if (!parsed.success) throw fail({ state: 'degraded', reason: 'tools_changed' }, `${tool} answered in an unexpected shape`);
        return parsed.data;
      };
      return await fn(call);
    } catch (err) {
      throw classifyWispr(err);
    } finally {
      await client?.close().catch(() => undefined);
    }
  }
}
