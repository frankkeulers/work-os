import { DEADLINES } from '../net/http';
import type { ClaudeAdapter, RunResult } from './adapter';
import { ClaudeError } from './errors';

// A connector relay (R2.5, CL-9): one Haiku call that makes exactly one call to a claude.ai
// connector's tool and hands the raw result to code. The model sees "ok" instead of the result
// (PostToolUse hook), so source content never enters its context, and every other tool of the
// connector is hidden from it. Built in Phase 1, first used by the Outlook source in Phase 2.
//
// The connector is declared explicitly: claude.ai connectors load asynchronously in headless runs
// and may not be there yet otherwise (P0-9). Its ID is configuration, never in the repo.

export const RELAY_PROMPT_VERSION = 'relay v1';
const SYSTEM = 'You are a relay. Make exactly the one tool call you are asked for, with the arguments given, then reply OK. Never call any other tool.';
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

export async function relayToolCall(claude: ClaudeAdapter, call: RelayCall): Promise<RelayResult> {
  const c = call.connector;
  const full = (tool: string) => `mcp__${c.name}__${tool}`;
  const allow = full(call.tool);
  for (let attempt = 1; ; attempt++) {
    let raw: unknown;
    let called = false;
    const run = await claude.run({
      purpose: 'fetch',
      model: 'haiku-5.5',
      system: SYSTEM,
      prompt: `Call ${allow} exactly once with these arguments: ${JSON.stringify(call.args)}. Then reply with the single word OK.`,
      promptVersion: RELAY_PROMPT_VERSION,
      timeoutMs: call.timeoutMs ?? DEADLINES.relay,
      signal: call.signal,
      itemIds: call.itemIds,
      maxTurns: 2,
      tool: {
        servers: { [c.name]: { type: 'claudeai-proxy', url: c.url ?? `${PROXY}${c.id}`, id: c.id, timeout: 30_000 } },
        allow,
        disallow: c.tools.filter((t) => t !== call.tool).map(full),
        onResult: (r) => {
          raw = r;
          called = true;
        },
      },
    });
    const server = run.mcpServers.find((s) => s.name === c.name);
    if (server && server.status !== 'connected') {
      throw new ClaudeError({ state: 'auth_failed', reason: `connector ${server.status}` }, `The ${c.name} connector is ${server.status}: re-connect it on claude.ai (Settings → Connectors).`);
    }
    if (called) return { raw, run, attempts: attempt };
    if (attempt >= 2) throw new ClaudeError({ state: 'degraded', reason: 'relay: the tool was not called' });
  }
}
