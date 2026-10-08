import { DEADLINES } from '../net/http';
import type { ClaudeAdapter, RunResult } from './adapter';
import { ClaudeError, ConnectorError } from './errors';

// A connector relay (R2.5, CL-9): one Haiku call that makes calls to ONE tool of a claude.ai
// connector, with argument sets given by code, and hands each raw result to code. The model sees
// "ok" instead of a result (PostToolUse hook), so source content never enters its context; every
// other tool of the connector is hidden from it, and canUseTool refuses any call whose arguments
// are not one of the sets asked for, or that repeats one. Up to RELAY_MAX_CALLS calls share one run,
// so reading ten emails costs one run, not ten (Outlook source, Phase 2).
//
// The connector is declared explicitly: claude.ai connectors load asynchronously in headless runs
// and may not be there yet otherwise (P0-9). Its ID is configuration, never in the repo.

export const RELAY_PROMPT_VERSION = 'relay v2';
export const RELAY_MAX_CALLS = 10;
const SYSTEM = 'You are a relay. Make exactly the tool calls you are asked for, with the arguments given and nothing else, then reply OK. Never call any other tool.';
const PROXY = 'https://mcp-proxy.anthropic.com/v1/mcp/';

export interface Connector {
  name: string; // the key in mcpServers, e.g. "ms365"; tools are mcp__<name>__<tool>
  id: string;
  url?: string;
  /** All of the connector's tools, so the ones not called can be hidden. */
  tools: string[];
}

export interface RelayCall {
  connector: Connector;
  tool: string;
  args: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  itemIds?: string[];
}

export interface RelayResult {
  raw: unknown;
  run: RunResult;
  attempts: number;
}

export interface RelayBatch {
  connector: Connector;
  tool: string;
  calls: Record<string, unknown>[];
  signal?: AbortSignal;
  timeoutMs?: number;
  itemIds?: string[];
}

/** Per call, in the order asked: its raw result, the tool's error, or undefined if never made. */
export type BatchOutcome = { ok: true; raw: unknown } | { ok: false; error: string } | undefined;

export interface RelayBatchResult {
  results: BatchOutcome[];
  runs: RunResult[];
  /** The connector's tools as the last run's init message listed them (names without the prefix). */
  tools: string[];
}

/** The same arguments always give the same key, whatever the order of their fields. */
export function argKey(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(argKey).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${argKey((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** One call; throws if the tool failed or was never called (twice). */
export async function relayToolCall(claude: ClaudeAdapter, call: RelayCall): Promise<RelayResult> {
  const r = await relayBatch(claude, { connector: call.connector, tool: call.tool, calls: [call.args], signal: call.signal, timeoutMs: call.timeoutMs ?? DEADLINES.relay, itemIds: call.itemIds });
  const out = r.results[0];
  const run = r.runs[r.runs.length - 1];
  if (!out) throw new ClaudeError({ state: 'degraded', reason: 'relay: the tool was not called' });
  if (!out.ok) throw new ConnectorError({ state: 'degraded', reason: `relay: ${out.error}` });
  return { raw: out.raw, run, attempts: r.runs.length };
}

/**
 * Up to RELAY_MAX_CALLS calls of one tool in one run, and one more run for any the model left out.
 * Calls still missing after that come back undefined; the caller decides (a source doesn't move its
 * cursor past them).
 */
export async function relayBatch(claude: ClaudeAdapter, b: RelayBatch): Promise<RelayBatchResult> {
  if (b.calls.length === 0) return { results: [], runs: [], tools: [] };
  if (b.calls.length > RELAY_MAX_CALLS) throw new Error(`relayBatch: at most ${RELAY_MAX_CALLS} calls per run`);
  const c = b.connector;
  const prefix = `mcp__${c.name}__`;
  const allow = `${prefix}${b.tool}`;
  const keys = b.calls.map(argKey);
  const index = new Map(keys.map((k, i) => [k, i]));
  const results: BatchOutcome[] = b.calls.map(() => undefined);
  const runs: RunResult[] = [];
  let tools: string[] = [];

  for (let attempt = 1; attempt <= 2; attempt++) {
    const todo = results.flatMap((r, i) => (r ? [] : [i]));
    if (!todo.length) break;
    const pending = new Set(todo.map((i) => keys[i]));
    const at = (input: unknown) => index.get(argKey(input));
    const list = todo.map((i, n) => `${n + 1}. ${JSON.stringify(b.calls[i])}`).join('\n');
    // An empty set is said in words: shown "{}", Haiku sent {"arguments":"{}"} (spike, 8 Oct 2026).
    const one = (args: Record<string, unknown>) => (Object.keys(args).length ? `with these arguments: ${JSON.stringify(args)}` : 'with no arguments');
    const prompt =
      todo.length === 1
        ? `Call ${allow} exactly once ${one(b.calls[todo[0]])}. Then reply with the single word OK.`
        : `Call ${allow} once for each of these ${todo.length} argument sets, with the arguments exactly as given. Make the calls in parallel where you can. Then reply with the single word OK.\n${list}`;
    const run = await claude.run({
      purpose: 'fetch',
      model: 'haiku-5.5',
      system: SYSTEM,
      prompt,
      promptVersion: RELAY_PROMPT_VERSION,
      timeoutMs: b.timeoutMs ?? (b.calls.length > 1 ? DEADLINES.relayBatch : DEADLINES.relay),
      signal: b.signal,
      itemIds: b.itemIds,
      maxTurns: todo.length + 1,
      tool: {
        servers: { [c.name]: { type: 'claudeai-proxy', url: c.url ?? `${PROXY}${c.id}`, id: c.id, timeout: 30_000 } },
        allow,
        disallow: c.tools.filter((t) => t !== b.tool).map((t) => `${prefix}${t}`),
        // Each set once: a second call with the same arguments is refused, as is any other set.
        accept: (input) => pending.delete(argKey(input)),
        onResult: (raw, input) => {
          const i = at(input);
          if (i !== undefined) results[i] = { ok: true, raw };
        },
        onError: (error, input) => {
          const i = at(input);
          if (i !== undefined) results[i] = { ok: false, error };
        },
      },
    });
    runs.push(run);
    connectorState(c.name, run);
    const seen = run.tools.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
    if (seen.length) {
      tools = seen;
      if (!seen.includes(b.tool)) throw new ConnectorError({ state: 'degraded', reason: 'tools_changed' }, `The ${c.name} connector no longer offers ${b.tool}.`);
    }
  }
  return { results, runs, tools };
}

/** A connector that isn't connected: signed out (re-connect on claude.ai) or not answering. */
function connectorState(name: string, run: RunResult) {
  const server = run.mcpServers.find((s) => s.name === name);
  if (!server || server.status === 'connected') return;
  if (server.status === 'needs-auth' || server.status === 'disabled')
    throw new ConnectorError({ state: 'auth_failed', reason: `connector ${server.status}` }, `The ${name} connector is ${server.status}: re-connect it on claude.ai (Settings → Connectors).`);
  throw new ConnectorError({ state: 'degraded', reason: `connector ${server.status}`, needsProbe: true }, `The ${name} connector is ${server.status}.`);
}
