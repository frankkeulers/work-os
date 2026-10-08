import type { HookCallbackMatcher, McpServerConfig, Options } from '@anthropic-ai/claude-agent-sdk';
import { costOf, type ModelId, type Settings, type UsagePurpose, type UsageRecord } from '@work-os/shared';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { SecretStore } from '../config/keychain';
import type { Logger } from '../log';
import { deadline } from '../net/http';
import { backendEnv, SDK_MODEL } from './backends';
import { ClaudeError, ClaudeOutputError, failureFromAssistantError, failureFromThrown } from './errors';
import { parseJsonOutput } from './outputs';
import { READ_TOOLS, readVerdict } from './readGuard';
import type { UsageLog } from './usage';

// The only module that talks to the Agent SDK (CL-1; ESLint enforces it). Every call states its
// model, system prompt, tools, MCP servers, setting sources and turns (CL-3), checked against the
// SDK 0.3.293 types and the P0-9 spike. Triage gets no tools, no MCP servers, no filesystem
// settings and no Claude Code prompt (CL-4); a vault draft may read inside the vault only (FR-9.1,
// readGuard.ts); a relay call (relay.ts) gets exactly one connector tool, gated by canUseTool (CL-9). Sessions are not saved to ~/.claude, so message text
// never lands there. The SDK is loaded on the first call, not at startup (NF-11).

/** The SDK's query(), or a fake in tests. Messages are read defensively, by the fields used here. */
export type QueryFn = (params: { prompt: string; options: Options }) => AsyncIterable<unknown>;

export interface RunSpec {
  purpose: UsagePurpose;
  model: ModelId;
  system: string;
  prompt: string;
  promptVersion: string;
  timeoutMs: number;
  signal?: AbortSignal;
  itemIds?: string[];
  maxTurns?: number; // 1 unless a tool call needs a second turn
  /** Relay calls only (CL-9). */
  tool?: {
    servers: Record<string, unknown>; // claudeai-proxy configs, which the SDK's public type doesn't list
    allow: string; // the one tool canUseTool allows
    disallow: string[]; // the connector's other tools, hidden from the model
    onResult: (response: unknown) => void; // the raw result, for code; the model sees "ok"
  };
  /** Draft calls: Read, Grep and Glob inside this folder only, which is also the cwd (FR-9.1). */
  readOnly?: { root: string };
  /** Each assistant turn: whether it used a tool. Drives the draft progress stages. */
  onTurn?: (usedTool: boolean) => void;
}

export interface RunResult {
  text: string;
  usage: UsageRecord;
  turns: number;
  toolCalls: string[];
  denied: string[];
  mcpServers: { name: string; status: string }[];
}

export interface ClaudeAdapterOptions {
  usage: UsageLog;
  settings: () => Settings;
  secrets: SecretStore;
  now?: () => Date;
  logger?: Logger;
  /** A folder with nothing in it for the SDK to pick up (no CLAUDE.md, no .claude/). */
  cwd: string;
  env?: NodeJS.ProcessEnv;
  client?: string;
  query?: QueryFn;
}

type Msg = {
  type?: string;
  subtype?: string;
  error?: string;
  message?: { content?: { type?: string; name?: string }[] };
  mcp_servers?: { name: string; status: string }[];
  result?: string;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
  modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUSD: number }>;
};

const loadQuery = async (): Promise<QueryFn> => (await import('@anthropic-ai/claude-agent-sdk')).query as QueryFn;

export class ClaudeAdapter {
  private query?: QueryFn;

  constructor(private readonly o: ClaudeAdapterOptions) {
    this.query = o.query;
  }

  private now() {
    return this.o.now?.() ?? new Date();
  }

  /** One call. Throws ClaudeError for failures health should hear about, or the abort reason. */
  async run(spec: RunSpec): Promise<RunResult> {
    const settings = this.o.settings();
    const signal = deadline(spec.timeoutMs, spec.signal);
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort(signal.reason);
    if (signal.aborted) onAbort();
    signal.addEventListener('abort', onAbort, { once: true });

    const at = this.now().toISOString();
    const t0 = performance.now();
    const toolCalls: string[] = [];
    const denied: string[] = [];
    let mcpServers: RunResult['mcpServers'] = [];
    let apiError: string | undefined;
    let result: Msg | undefined;
    try {
      const env = await backendEnv(settings.claudeBackend, this.o.env ?? process.env, this.o.secrets, this.o.client ?? 'work-os');
      this.query ??= await loadQuery();
      this.throwIfAborted(spec, signal); // asleep or stopping before it started: don't start
      const t = spec.tool;
      const postToolUse: HookCallbackMatcher[] = t
        ? [
            {
              matcher: t.allow,
              hooks: [
                async (input) => {
                  t.onResult((input as { tool_response?: unknown }).tool_response);
                  return { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, updatedToolOutput: 'ok' } };
                },
              ],
            },
          ]
        : [];
      const ro = spec.readOnly;
      const preToolUse: HookCallbackMatcher[] = ro
        ? [
            {
              hooks: [
                async (input) => {
                  const i = input as { tool_name?: string; tool_input?: unknown };
                  const v = await readVerdict(ro.root, i.tool_name ?? '', i.tool_input);
                  if (v.ok) return {};
                  denied.push(i.tool_name ?? '');
                  return { hookSpecificOutput: { hookEventName: 'PreToolUse' as const, permissionDecision: 'deny' as const, permissionDecisionReason: v.reason } };
                },
              ],
            },
          ]
        : [];
      const hooks: Options['hooks'] = {};
      if (postToolUse.length) hooks.PostToolUse = postToolUse;
      if (preToolUse.length) hooks.PreToolUse = preToolUse;
      const options: Options = {
        model: SDK_MODEL[spec.model],
        systemPrompt: spec.system,
        tools: ro ? [...READ_TOOLS] : [],
        allowedTools: [],
        disallowedTools: t?.disallow ?? [],
        mcpServers: (t?.servers ?? {}) as Record<string, McpServerConfig>,
        strictMcpConfig: true,
        settingSources: [],
        maxTurns: spec.maxTurns ?? 1,
        permissionMode: 'default',
        canUseTool: async (name, input) => {
          if (t && name === t.allow) return { behavior: 'allow', updatedInput: input };
          if (ro && (await readVerdict(ro.root, name, input)).ok) return { behavior: 'allow', updatedInput: input };
          denied.push(name);
          return { behavior: 'deny', message: 'Not allowed' };
        },
        hooks,
        thinking: { type: 'disabled' },
        persistSession: false,
        cwd: ro?.root ?? this.o.cwd,
        env,
        abortController: ctrl,
      };
      for await (const raw of this.query({ prompt: spec.prompt, options })) {
        const m = raw as Msg;
        if (m.type === 'system' && m.subtype === 'init') mcpServers = m.mcp_servers ?? [];
        else if (m.type === 'assistant') {
          if (m.error) apiError = m.error;
          const content = m.message?.content ?? [];
          for (const b of content) if (b.type === 'tool_use' && b.name) toolCalls.push(b.name);
          spec.onTurn?.(content.some((b) => b.type === 'tool_use'));
        } else if (m.type === 'result') result = m;
      }
    } catch (err) {
      this.throwIfAborted(spec, signal);
      if (err instanceof ClaudeError) throw err;
      throw new ClaudeError(failureFromThrown(err));
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
    this.throwIfAborted(spec, signal);

    const usage = result ? await this.recordUsage(spec, result, at, Math.round(performance.now() - t0)) : undefined;
    if (apiError) throw new ClaudeError(failureFromAssistantError(apiError));
    if (!result || !usage) throw new ClaudeError({ state: 'degraded', reason: 'no result' });
    if (result.subtype !== 'success') throw new ClaudeError({ state: 'degraded', reason: result.subtype ?? 'error' });
    this.o.logger?.info({ purpose: spec.purpose, model: spec.model, turns: result.num_turns, ms: usage.durationMs, cost: usage.costEquivalent, items: usage.itemIds.length }, 'Claude call');
    return { text: result.result ?? '', usage, turns: result.num_turns ?? 0, toolCalls, denied, mcpServers };
  }

  /** The caller's abort (sleep, shutdown) passes through as is; the deadline is a failure. */
  private throwIfAborted(spec: RunSpec, signal: AbortSignal) {
    if (spec.signal?.aborted) throw spec.signal.reason;
    if (signal.aborted) throw new ClaudeError({ state: 'degraded', reason: 'timeout', needsProbe: true });
  }

  /**
   * A call whose answer must be JSON matching `schema`. On a mismatch it asks once more, saying
   * what was wrong (paths only), then gives up with ClaudeOutputError (CL-7).
   */
  async structured<T>(spec: RunSpec, schema: z.ZodType<T>): Promise<{ value: T; attempts: number; usage: UsageRecord[] }> {
    const usage: UsageRecord[] = [];
    let issues = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const prompt = attempt === 1 ? spec.prompt : `${spec.prompt}\n\nYour previous answer was not valid: ${issues}. Answer again with only the JSON, exactly as specified.`;
      const r = await this.run({ ...spec, prompt });
      usage.push(r.usage);
      const parsed = parseJsonOutput(r.text, schema);
      if (parsed.ok) return { value: parsed.value, attempts: attempt, usage };
      issues = parsed.issues;
      this.o.logger?.warn({ purpose: spec.purpose, attempt, issues }, 'Claude output did not validate');
    }
    throw new ClaudeOutputError(2, issues);
  }

  private async recordUsage(spec: RunSpec, m: Msg, at: string, durationMs: number): Promise<UsageRecord> {
    const per = Object.values(m.modelUsage ?? {});
    const sum = (f: (u: (typeof per)[number]) => number) => per.reduce((n, u) => n + f(u), 0);
    const u = m.usage ?? {};
    const inputTokens = per.length ? sum((x) => x.inputTokens) : (u.input_tokens ?? 0);
    const outputTokens = per.length ? sum((x) => x.outputTokens) : (u.output_tokens ?? 0);
    const cacheTokens = per.length ? sum((x) => x.cacheReadInputTokens + x.cacheCreationInputTokens) : (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    const reported = m.total_cost_usd ?? 0;
    const record: UsageRecord = {
      id: randomUUID(),
      at,
      purpose: spec.purpose,
      model: spec.model,
      inputTokens,
      outputTokens,
      cacheTokens,
      costEquivalent: reported > 0 ? reported : costOf(spec.model, inputTokens, outputTokens, cacheTokens),
      durationMs,
      itemIds: spec.itemIds ?? [],
      promptVersion: spec.promptVersion,
    };
    await this.o.usage.record(record);
    return record;
  }
}
