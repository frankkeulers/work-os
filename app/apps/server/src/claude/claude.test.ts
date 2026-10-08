import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ESLint } from 'eslint';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defaultSettings } from '../config/defaults';
import { memoryKeychain } from '../config/keychain';
import { ClaudeAdapter, type QueryFn } from './adapter';
import { API_KEY_ACCOUNT, backendEnv } from './backends';
import { ClaudeError, ClaudeOutputError } from './errors';
import { extractJson } from './outputs';
import { loadPromptFile, PROMPT_FILES, sha1, sourceStates, withCurrentSourceHashes } from './promptFiles';
import { argKey, relayBatch, relayToolCall, RELAY_MAX_CALLS, type Connector } from './relay';
import { UsageLog } from './usage';

// The Claude module against a fake SDK (never a live call, never a real key: env objects here
// are synthetic and the Keychain is in memory).

const NOW = new Date('2026-10-06T09:00:00.000Z');
const APP = resolve(import.meta.dirname, '../../../..');

type Options = Parameters<QueryFn>[0]['options'];
type Script = (options: Options) => AsyncGenerator<unknown> | Promise<unknown[]>;

let dir: string;
let usage: UsageLog;
let seen: { prompt: string; options: Options }[];
let settings: ReturnType<typeof defaultSettings>;

const result = (text: string, over: object = {}) => ({
  type: 'result',
  subtype: 'success',
  result: text,
  num_turns: 1,
  total_cost_usd: 0.0021,
  usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 1000, outputTokens: 150, cacheReadInputTokens: 300, cacheCreationInputTokens: 200, costUSD: 0.0021 } },
  ...over,
});

function fakeQuery(...scripts: Script[]): QueryFn {
  let call = 0;
  return ({ prompt, options }) => {
    seen.push({ prompt, options });
    const script = scripts[Math.min(call++, scripts.length - 1)];
    return (async function* () {
      const out = script(options);
      if (Symbol.asyncIterator in out) yield* out as AsyncGenerator<unknown>;
      else yield* await out;
    })();
  };
}

const adapter = (query: QueryFn, env: NodeJS.ProcessEnv = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'synthetic-should-be-removed' }) =>
  new ClaudeAdapter({ usage, settings: () => settings, secrets: memoryKeychain(), now: () => NOW, cwd: dir, env, query });

const spec = { purpose: 'triage' as const, model: 'haiku-5.5' as const, system: 'Triage these threads.', prompt: 'Threads: […]', promptVersion: 'triage v1', timeoutMs: 5000, itemIds: ['slack:C1:1.000100'] };

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-claude-'));
  usage = await UsageLog.open(dir, () => NOW);
  seen = [];
  settings = defaultSettings(dir);
});
afterEach(async () => {
  await usage.close();
  await rm(dir, { recursive: true, force: true });
});

describe('a call (CL-3, CL-4, CL-5)', () => {
  it('states every option, with no tools, servers, settings or session, and no key in the SDK’s environment', async () => {
    const r = await adapter(fakeQuery(async () => [{ type: 'system', subtype: 'init', mcp_servers: [] }, result('{"ok":true}')])).run(spec);
    expect(r.text).toBe('{"ok":true}');
    const o = seen[0].options;
    expect(o).toMatchObject({
      model: 'claude-haiku-5-5',
      systemPrompt: 'Triage these threads.',
      tools: [],
      allowedTools: [],
      disallowedTools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      maxTurns: 1,
      permissionMode: 'default',
      thinking: { type: 'disabled' },
      persistSession: false,
      cwd: dir,
      hooks: {},
    });
    expect(o.env).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(o.env).toMatchObject({ PATH: '/usr/bin', CLAUDE_AGENT_SDK_CLIENT_APP: 'work-os' });
    expect(await o.canUseTool!('Bash', {}, { signal: new AbortController().signal } as never)).toMatchObject({ behavior: 'deny' });
  });

  it('logs usage from the per-model totals, to the day’s file and in memory', async () => {
    const r = await adapter(fakeQuery(async () => [result('x')])).run(spec);
    expect(r.usage).toMatchObject({ purpose: 'triage', model: 'haiku-5.5', inputTokens: 1000, outputTokens: 150, cacheTokens: 500, costEquivalent: 0.0021, itemIds: ['slack:C1:1.000100'], promptVersion: 'triage v1', at: NOW.toISOString() });
    const lines = (await readFile(join(dir, 'usage-2026-10-06.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).id).toBe(r.usage.id);
    expect(usage.records()).toHaveLength(1);
  });

  it('turns thinking off on Haiku, and runs Sonnet 5.5 and Opus 5.5, which refuse that, at low effort', async () => {
    const a = adapter(fakeQuery(async () => [result('x')]));
    await a.run(spec);
    await a.run({ ...spec, model: 'sonnet-5.5' });
    await a.run({ ...spec, model: 'opus-5.5' });
    expect(seen.map((s) => [s.options.model, s.options.thinking, s.options.effort])).toEqual([
      ['claude-haiku-5-5', { type: 'disabled' }, undefined],
      ['claude-sonnet-5-5', { type: 'adaptive' }, 'low'],
      ['claude-opus-5-5', { type: 'adaptive' }, 'low'],
    ]);
  });

  it('prices the call from the list prices when the SDK only guesses the model’s price', async () => {
    const guessed = { 'claude-haiku-5-5': { inputTokens: 1000, outputTokens: 150, cacheReadInputTokens: 300, cacheCreationInputTokens: 200, costUSD: 0.33, costBasis: 'unknown' } };
    const r = await adapter(fakeQuery(async () => [result('x', { total_cost_usd: 0.33, modelUsage: guessed })])).run(spec);
    expect(r.usage.costEquivalent).toBe(0.0002); // 1000 × $0.10 + 150 × $0.50 + 500 × $0.01 per million
  });

  it('classifies API errors, and still logs the call’s usage', async () => {
    const failing = (error: string) => adapter(fakeQuery(async () => [{ type: 'assistant', error, message: { content: [] } }, result('', { subtype: 'success' })])).run(spec);
    await expect(failing('authentication_failed')).rejects.toMatchObject({ failure: { state: 'auth_failed' } });
    await expect(failing('rate_limit')).rejects.toMatchObject({ failure: { state: 'rate_limited', retryAfterMs: 15 * 60_000 } });
    await expect(failing('overloaded')).rejects.toMatchObject({ failure: { state: 'degraded', reason: 'overloaded' } });
    expect(usage.records()).toHaveLength(3);
  });

  it('treats a call that could not connect as offline, for the probe to confirm', async () => {
    const err = await adapter(fakeQuery(async () => Promise.reject(new TypeError('fetch failed')))).run(spec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeError);
    expect((err as ClaudeError).failure).toMatchObject({ state: 'offline', needsProbe: true });
  });

  it('passes a sleep or shutdown abort through, and turns the deadline into a timeout', async () => {
    const started: string[] = [];
    const hang: Script = (o) => {
      started.push('call');
      return new Promise((_r, reject) => o.abortController!.signal.addEventListener('abort', () => reject(new Error('aborted'))));
    };
    const sleep = new AbortController();
    const p = adapter(fakeQuery(hang)).run({ ...spec, signal: sleep.signal });
    setTimeout(() => sleep.abort(new Error('asleep')), 20);
    await expect(p).rejects.toThrow('asleep');
    expect(started).toEqual(['call']);
    // Already asleep: the call never starts.
    await expect(adapter(fakeQuery(hang)).run({ ...spec, signal: AbortSignal.abort(new Error('asleep')) })).rejects.toThrow('asleep');
    expect(started).toEqual(['call']);
    await expect(adapter(fakeQuery(hang)).run({ ...spec, timeoutMs: 20 })).rejects.toMatchObject({ failure: { reason: 'timeout' } });
  });
});

describe('structured output (CL-7)', () => {
  const Schema = z.object({ decisions: z.array(z.object({ id: z.string(), attention: z.enum(['now', 'today', 'none']) })) });

  it('asks once more with the issues, then accepts a valid answer', async () => {
    const q = fakeQuery(
      async () => [result('```json\n{"decisions":[{"id":"a","attention":"urgent"}]}\n```')],
      async () => [result('Here you go: {"decisions":[{"id":"a","attention":"now"}]}')],
    );
    const r = await adapter(q).structured(spec, Schema);
    expect(r).toMatchObject({ attempts: 2, value: { decisions: [{ id: 'a', attention: 'now' }] } });
    expect(r.usage).toHaveLength(2);
    expect(seen[1].prompt).toContain('decisions.0.attention');
    expect(seen[1].prompt).not.toContain('urgent'); // issues name paths, not values
  });

  it('gives up after the second invalid answer', async () => {
    const err = await adapter(fakeQuery(async () => [result('not json')])).structured(spec, Schema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ClaudeOutputError);
    expect(err).toMatchObject({ attempts: 2, issues: 'no JSON object in the answer' });
  });

  it('finds the JSON in fences and prose', () => {
    expect(extractJson('```json\n[1,2]\n```')).toBe('[1,2]');
    expect(extractJson('Sure. {"a":{"b":1}} Done.')).toBe('{"a":{"b":1}}');
    expect(extractJson('nothing here')).toBeUndefined();
  });
});

describe('backends (CL-8)', () => {
  const base = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'synthetic-1', CLAUDE_CODE_USE_VERTEX: '1' };

  it('gives the subscription a clean environment, Bedrock its flag, and the API key only from the Keychain', async () => {
    const sub = await backendEnv('subscription', base, memoryKeychain(), 'work-os');
    expect(sub).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(sub).not.toHaveProperty('CLAUDE_CODE_USE_VERTEX');
    expect(await backendEnv('bedrock', base, memoryKeychain(), 'work-os')).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '1' });
    const key = await backendEnv('api_key', base, memoryKeychain({ [API_KEY_ACCOUNT]: 'synthetic-from-keychain' }), 'work-os');
    expect(key.ANTHROPIC_API_KEY).toBe('synthetic-from-keychain');
    await expect(backendEnv('api_key', base, memoryKeychain(), 'work-os')).rejects.toMatchObject({ failure: { state: 'auth_failed' } });
  });
});

describe('connector relay (CL-9)', () => {
  const ms365: Connector = { name: 'ms365', id: 'synthetic-connector-id', tools: ['outlook_email_search', 'outlook_send_mail', 'outlook_delete_event'] };
  const RAW = [{ type: 'text', text: '{"emails":[]}' }];

  /** Plays the SDK: init, then the model's tool call through canUseTool and the PostToolUse hook. */
  const relayScript =
    (o: { status?: string; call?: string; extra?: string; input?: object } = {}): Script =>
    async (options) => {
      const msgs: unknown[] = [{ type: 'system', subtype: 'init', mcp_servers: [{ name: 'ms365', status: o.status ?? 'connected' }] }];
      const signal = new AbortController().signal;
      if (o.extra) await options.canUseTool!(o.extra, {}, { signal } as never);
      const tool = o.call;
      if (tool) {
        const input = o.input ?? {};
        const verdict = await options.canUseTool!(tool, input as Record<string, unknown>, { signal } as never);
        if (verdict?.behavior === 'allow') {
          msgs.push({ type: 'assistant', message: { content: [{ type: 'tool_use', name: tool }] } });
          const hook = options.hooks!.PostToolUse![0];
          expect(hook.matcher).toBe(tool);
          const out = await hook.hooks[0]({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input, tool_response: RAW } as never, 'tu1', { signal });
          msgs.push({ type: 'tool_output_seen_by_model', out });
        }
      }
      msgs.push(result('OK', { num_turns: 2 }));
      return msgs;
    };

  /** Plays a batch: each call in turn through canUseTool, then the result or failure hook. */
  const batchScript =
    (o: { calls: { input: object; error?: string }[]; status?: string; tools?: string[] }): Script =>
    async (options) => {
      const msgs: unknown[] = [{ type: 'system', subtype: 'init', mcp_servers: [{ name: 'ms365', status: o.status ?? 'connected' }], tools: o.tools ?? [] }];
      const signal = new AbortController().signal;
      for (const c of o.calls) {
        const tool = 'mcp__ms365__read_resource';
        const verdict = await options.canUseTool!(tool, c.input as Record<string, unknown>, { signal } as never);
        if (verdict?.behavior !== 'allow') continue;
        if (c.error) await options.hooks!.PostToolUseFailure![0].hooks[0]({ hook_event_name: 'PostToolUseFailure', tool_name: tool, tool_input: c.input, error: c.error } as never, 'tu', { signal });
        else await options.hooks!.PostToolUse![0].hooks[0]({ hook_event_name: 'PostToolUse', tool_name: tool, tool_input: c.input, tool_response: [{ type: 'text', text: JSON.stringify(c.input) }] } as never, 'tu', { signal });
      }
      msgs.push(result('OK', { num_turns: 2 }));
      return msgs;
    };
  const reads = (n: number) => Array.from({ length: n }, (_, i) => ({ uri: `mail:///messages/m${i}` }));

  it('makes the one call, hands the raw result to code and shows the model only "ok"', async () => {
    const q = fakeQuery(relayScript({ call: 'mcp__ms365__outlook_email_search', extra: 'mcp__ms365__outlook_send_mail', input: { limit: 25, folderName: 'Inbox' } }));
    const r = await relayToolCall(adapter(q), { connector: ms365, tool: 'outlook_email_search', args: { folderName: 'Inbox', limit: 25 } });
    expect(r.raw).toEqual(RAW);
    expect(r.run.denied).toEqual(['mcp__ms365__outlook_send_mail']);
    expect(r.run.usage.purpose).toBe('fetch');
    const o = seen[0].options;
    expect(o).toMatchObject({
      model: 'claude-haiku-5-5',
      tools: [],
      allowedTools: [],
      strictMcpConfig: true,
      settingSources: [],
      maxTurns: 2,
      mcpServers: { ms365: { type: 'claudeai-proxy', id: 'synthetic-connector-id', url: 'https://mcp-proxy.anthropic.com/v1/mcp/synthetic-connector-id' } },
      disallowedTools: ['mcp__ms365__outlook_send_mail', 'mcp__ms365__outlook_delete_event'],
    });
    expect(seen[0].prompt).toContain('"limit":25');
    const hookOut = await o.hooks!.PostToolUse![0].hooks[0]({ tool_response: RAW } as never, 'tu2', { signal: new AbortController().signal });
    expect(hookOut).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: 'ok' } });
  });

  it('says to re-connect a connector that needs it', async () => {
    const err = await relayToolCall(adapter(fakeQuery(relayScript({ status: 'needs-auth' }))), { connector: ms365, tool: 'outlook_email_search', args: {} }).catch((e: unknown) => e);
    expect(err).toMatchObject({ failure: { state: 'auth_failed', reason: 'connector needs-auth' } });
    expect((err as Error).message).toMatch(/re-connect it on claude\.ai/);
  });

  it('tries once more when the model did not make the call, then reports it', async () => {
    const once = fakeQuery(relayScript(), relayScript({ call: 'mcp__ms365__outlook_email_search' }));
    expect(await relayToolCall(adapter(once), { connector: ms365, tool: 'outlook_email_search', args: {} })).toMatchObject({ attempts: 2, raw: RAW });
    seen = [];
    const never = fakeQuery(relayScript());
    await expect(relayToolCall(adapter(never), { connector: ms365, tool: 'outlook_email_search', args: {} })).rejects.toMatchObject({ failure: { reason: 'relay: the tool was not called' } });
    expect(seen).toHaveLength(2);
  });

  it('asks for a call with no arguments in words, not as "{}"', async () => {
    await relayToolCall(adapter(fakeQuery(relayScript({ call: 'mcp__ms365__get_me' }))), { connector: ms365, tool: 'get_me', args: {} });
    expect(seen[0].prompt).toContain('exactly once with no arguments.');
  });

  it('refuses a call with other arguments than the ones asked for', async () => {
    const q = fakeQuery(relayScript({ call: 'mcp__ms365__outlook_email_search', input: { folderName: 'Sent Items' } }));
    await expect(relayToolCall(adapter(q), { connector: ms365, tool: 'outlook_email_search', args: { folderName: 'Inbox' } })).rejects.toMatchObject({ failure: { reason: 'relay: the tool was not called' } });
  });

  it('keys arguments the same whatever the order of their fields', () => {
    expect(argKey({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: 'x' } })).toBe(argKey({ a: { c: 'x', d: [1, { x: 1, y: 2 }] }, b: 1 }));
    expect(argKey({ a: 1, b: undefined })).toBe(argKey({ a: 1 }));
    expect(argKey({ a: 1 })).not.toBe(argKey({ a: '1' }));
  });

  describe('batches', () => {
    const batch = (calls: object[]) => ({ connector: ms365, tool: 'read_resource', calls: calls as Record<string, unknown>[] });

    it('makes several calls in one run and hands back each result in the order asked', async () => {
      const asked = reads(3);
      // The model makes them in another order: results still line up with the request.
      const q = fakeQuery(batchScript({ calls: [asked[2], asked[0], asked[1]].map((input) => ({ input })) }));
      const r = await relayBatch(adapter(q), batch(asked));
      expect(r.runs).toHaveLength(1);
      expect(r.results.map((x) => x?.ok && JSON.parse((x.raw as { text: string }[])[0].text).uri)).toEqual(asked.map((a) => a.uri));
      expect(seen[0].options.maxTurns).toBe(4);
      expect(seen[0].prompt).toContain('3 argument sets');
      expect(seen[0].prompt).toContain('2. {"uri":"mail:///messages/m1"}');
    });

    it('refuses repeats and sets not asked for, and records what was refused', async () => {
      const asked = reads(2);
      const q = fakeQuery(batchScript({ calls: [{ input: asked[0] }, { input: asked[0] }, { input: { uri: 'mail:///messages/other' } }, { input: asked[1] }] }));
      const r = await relayBatch(adapter(q), batch(asked));
      expect(r.results.every((x) => x?.ok)).toBe(true);
      expect(r.runs[0].denied).toEqual(['mcp__ms365__read_resource', 'mcp__ms365__read_resource']);
    });

    it('asks again for the calls the model left out, and only those', async () => {
      const asked = reads(3);
      const q = fakeQuery(batchScript({ calls: [{ input: asked[0] }] }), batchScript({ calls: [{ input: asked[1] }, { input: asked[2] }] }));
      const r = await relayBatch(adapter(q), batch(asked));
      expect(r.runs).toHaveLength(2);
      expect(r.results.every((x) => x?.ok)).toBe(true);
      expect(seen[1].prompt).not.toContain('m0');
      expect(seen[1].prompt).toContain('2 argument sets');
    });

    it('gives back calls still missing after the second run as undefined, for the caller to keep', async () => {
      const asked = reads(2);
      const q = fakeQuery(batchScript({ calls: [{ input: asked[1] }] }), batchScript({ calls: [] }));
      const r = await relayBatch(adapter(q), batch(asked));
      expect(r.results[0]).toBeUndefined();
      expect(r.results[1]).toMatchObject({ ok: true });
      expect(r.runs).toHaveLength(2);
    });

    it("captures a tool's failure for that call alone", async () => {
      const asked = reads(2);
      const q = fakeQuery(batchScript({ calls: [{ input: asked[0], error: 'Item not found' }, { input: asked[1] }] }));
      const r = await relayBatch(adapter(q), batch(asked));
      expect(r.results[0]).toEqual({ ok: false, error: 'Item not found' });
      expect(r.results[1]).toMatchObject({ ok: true });
      expect(r.runs).toHaveLength(1);
    });

    it('caps a run at RELAY_MAX_CALLS and makes no run for nothing', async () => {
      await expect(relayBatch(adapter(fakeQuery(batchScript({ calls: [] }))), batch(reads(RELAY_MAX_CALLS + 1)))).rejects.toThrow(/at most/);
      expect(await relayBatch(adapter(fakeQuery(batchScript({ calls: [] }))), batch([]))).toEqual({ results: [], runs: [], tools: [] });
      expect(seen).toHaveLength(0);
    });

    it('tells a signed-out connector from one that is not answering', async () => {
      for (const [status, state] of [['needs-auth', 'auth_failed'], ['disabled', 'auth_failed'], ['pending', 'degraded'], ['failed', 'degraded']]) {
        const err = await relayBatch(adapter(fakeQuery(batchScript({ calls: [], status }))), batch(reads(1))).catch((e: unknown) => e);
        expect(err).toMatchObject({ name: 'ConnectorError', failure: { state, reason: `connector ${status}` } });
      }
    });

    it('reports the tools the connector offers, and stops if the one needed is gone', async () => {
      const tools = ['mcp__ms365__read_resource', 'mcp__ms365__outlook_email_search', 'Read'];
      const r = await relayBatch(adapter(fakeQuery(batchScript({ calls: [{ input: reads(1)[0] }], tools }))), batch(reads(1)));
      expect(r.tools).toEqual(['read_resource', 'outlook_email_search']);
      const err = await relayBatch(adapter(fakeQuery(batchScript({ calls: [], tools: ['mcp__ms365__outlook_email_search'] }))), batch(reads(1))).catch((e: unknown) => e);
      expect(err).toMatchObject({ name: 'ConnectorError', failure: { state: 'degraded', reason: 'tools_changed' } });
    });
  });
});

describe('MCP server status (connector discovery)', () => {
  type StatusFn = NonNullable<ConstructorParameters<typeof ClaudeAdapter>[0]['statusQuery']>;
  const statusAdapter = (statusQuery: StatusFn) => new ClaudeAdapter({ usage, settings: () => settings, secrets: memoryKeychain(), now: () => NOW, cwd: dir, env: { PATH: '/usr/bin' }, query: fakeQuery(), statusQuery });
  /** Plays a session whose servers report the given lists, one per mcpServerStatus() call. */
  const statusSession = (lists: object[][], opts: { seen?: { options: object }[] } = {}): StatusFn => {
    let n = 0;
    return ({ options }) => {
      opts.seen?.push({ options });
      const closed = new Promise<void>((r) => options.abortController!.signal.addEventListener('abort', () => r(), { once: true }));
      const messages: AsyncIterable<unknown> = { [Symbol.asyncIterator]: () => ({ next: async () => (await closed, { done: true as const, value: undefined }) }) };
      return Object.assign(messages, { mcpServerStatus: async () => lists[Math.min(n++, lists.length - 1)] });
    };
  };
  const ms = { name: 'claude.ai Microsoft 365', status: 'connected', source: 'claudeai', config: { type: 'claudeai-proxy', url: 'https://mcp-proxy.anthropic.com/v1/mcp/srv1', id: 'srv1' }, tools: [{ name: 'outlook_email_search' }] };

  it('polls until the servers have loaded, with no model turn, and closes the session', async () => {
    const opened: { options: object }[] = [];
    const servers = await statusAdapter(statusSession([[{ ...ms, status: 'pending' }], [ms]], { seen: opened })).mcpStatus({ timeoutMs: 2000, intervalMs: 5 });
    expect(servers).toEqual([ms]);
    expect(opened[0].options).toMatchObject({ tools: [], allowedTools: [], settingSources: [], persistSession: false });
    expect((opened[0].options as { abortController: AbortController }).abortController.signal.aborted).toBe(true);
  });

  it('stops when `done` says so, and returns the last list when time runs out', async () => {
    const found = await statusAdapter(statusSession([[], [ms]])).mcpStatus({ timeoutMs: 2000, intervalMs: 5, done: (l) => l.some((s) => s.config?.type === 'claudeai-proxy') });
    expect(found).toEqual([ms]);
    const late = await statusAdapter(statusSession([[{ ...ms, status: 'pending' }]])).mcpStatus({ timeoutMs: 60, intervalMs: 5 });
    expect(late).toEqual([{ ...ms, status: 'pending' }]);
  });
});

describe('usage log', () => {
  it('reads the last eight days back at startup, skipping a torn line', async () => {
    const line = (at: string) => JSON.stringify({ id: at, at, purpose: 'triage', model: 'haiku-4.5', inputTokens: 1, outputTokens: 1, cacheTokens: 0, costEquivalent: 0.001, durationMs: 1, itemIds: [], promptVersion: 'v' });
    await writeFile(join(dir, 'usage-2026-10-05.jsonl'), `${line('2026-10-05T10:00:00.000Z')}\n{"torn`);
    await writeFile(join(dir, 'usage-2026-09-20.jsonl'), `${line('2026-09-20T10:00:00.000Z')}\n`);
    const log = await UsageLog.open(dir, () => NOW);
    expect(log.records().map((r) => r.id)).toEqual(['2026-10-05T10:00:00.000Z']);
    await log.close();
  });
});

describe('CL-1', () => {
  it('lets only the adapter import the Agent SDK', async () => {
    const eslint = new ESLint({ cwd: APP });
    const code = "import { query } from '@anthropic-ai/claude-agent-sdk';\nexport const q = query;\nexport const later = () => import('@anthropic-ai/claude-agent-sdk');\n";
    const [elsewhere] = await eslint.lintText(code, { filePath: join(APP, 'apps/server/src/pipeline/triage.ts') });
    expect(elsewhere.messages.map((m) => m.ruleId)).toEqual(['no-restricted-imports', 'no-restricted-syntax']);
    const [inAdapter] = await eslint.lintText(code, { filePath: join(APP, 'apps/server/src/claude/adapter.ts') });
    expect(inAdapter.messages.filter((m) => m.ruleId?.startsWith('no-restricted'))).toEqual([]);
  }, 30_000);
});

describe('read-only draft calls (FR-9.1)', () => {
  it('offers Read, Grep and Glob in the vault only, and denies the rest in the hook and in canUseTool', async () => {
    const vault = join(dir, 'vault');
    await mkdir(join(vault, 'Notes'), { recursive: true });
    const turns: boolean[] = [];
    const a = adapter(
      fakeQuery(async () => [
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Glob' }] } },
        { type: 'assistant', message: { content: [{ type: 'text' }] } },
        result('{"ok":true}'),
      ]),
    );
    await a.run({ ...spec, purpose: 'draft_vault', model: 'sonnet-5.5', readOnly: { root: vault }, maxTurns: 12, onTurn: (t) => turns.push(t) });
    expect(turns).toEqual([true, false]);
    const o = seen[0].options;
    expect(o).toMatchObject({ tools: ['Read', 'Grep', 'Glob'], allowedTools: [], cwd: vault, maxTurns: 12, mcpServers: {}, settingSources: [] });
    const hook = o.hooks!.PreToolUse![0].hooks[0];
    const pre = (tool_name: string, tool_input: object) => hook({ hook_event_name: 'PreToolUse', tool_name, tool_input } as never, undefined, { signal: new AbortController().signal });
    expect(await pre('Read', { file_path: join(vault, 'Notes/a.md') })).toEqual({});
    expect(await pre('Read', { file_path: '/etc/hosts' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await pre('Glob', { pattern: '/Users/**/*.md' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    expect(await pre('Write', { file_path: join(vault, 'Notes/a.md'), content: 'x' })).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
    const can = (name: string, input: Record<string, unknown>) => o.canUseTool!(name, input, { signal: new AbortController().signal } as never);
    expect(await can('Grep', { pattern: 'launch', path: join(vault, 'Notes') })).toMatchObject({ behavior: 'allow' });
    expect(await can('Grep', { pattern: 'launch', path: dir })).toMatchObject({ behavior: 'deny' });
    expect(await can('Bash', { command: 'ls' })).toMatchObject({ behavior: 'deny' });
  });

  it('keeps triage calls tool-free (CL-4)', async () => {
    await adapter(fakeQuery(async () => [result('{}')])).run(spec);
    expect(seen[0].options).toMatchObject({ tools: [], cwd: dir, hooks: {} });
  });
});

describe('prompt and guidance files (FR-1.1, FR-1.7)', () => {
  it('names each default after its id, keeps the paths distinct, and falls back to the default for an empty file', async () => {
    for (const f of PROMPT_FILES) expect(f.defaultText).toMatch(new RegExp(`^<!-- prompt: ${f.id} v\\d+ -->`));
    expect(new Set(PROMPT_FILES.map((f) => f.file)).size).toBe(PROMPT_FILES.length);
    for (const f of PROMPT_FILES) expect(Buffer.byteLength(f.defaultText)).toBeLessThan(12_000); // every call pays for it
    const dir = await mkdtemp(join(tmpdir(), 'workos-prompts-'));
    try {
      await mkdir(join(dir, 'config'), { recursive: true });
      await writeFile(join(dir, 'config/psg-context-builder.md'), '  \n');
      const p = await loadPromptFile(dir, 'confluence-routing');
      expect(p.version).toMatch(/^confluence-routing v3#[0-9a-f]{8}$/);
      await writeFile(join(dir, 'config/psg-context-builder.md'), '<!-- prompt: confluence-routing v9 -->\nMine');
      expect(await loadPromptFile(dir, 'confluence-routing')).toMatchObject({ text: '<!-- prompt: confluence-routing v9 -->\nMine', version: expect.stringMatching(/^confluence-routing v9#/) });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('guidance sources (FR-1.7)', () => {
  it('finds a synced skill and a vault note, flags one that changed, and records it as reviewed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'workos-sources-'));
    try {
      const home = join(dir, 'home');
      const vault = join(dir, 'vault');
      await mkdir(join(home, '.claude/skills/synced/abc/psg-context-builder'), { recursive: true });
      await mkdir(vault, { recursive: true });
      await writeFile(join(home, '.claude/skills/synced/abc/psg-context-builder/SKILL.md'), 'Skill v1\n');
      await writeFile(join(vault, 'llms.txt'), 'Manifest\n');
      const text = [
        '<!-- prompt: x v1 -->',
        `<!-- source: psg-context-builder sha1:${sha1('Skill v1').slice(0, 12)} -->`,
        `<!-- source: vault-llms sha1:${sha1('Old manifest').slice(0, 12)} -->`,
        '<!-- source: vault-notes-system sha1:000000000000 -->',
        'Body',
      ].join('\n');
      const env = { home, vault };
      expect(await sourceStates(text, env)).toEqual([
        { id: 'psg-context-builder', label: 'psg-context-builder skill', path: join(home, '.claude/skills/synced/abc/psg-context-builder/SKILL.md'), state: 'current' },
        { id: 'vault-llms', label: 'llms.txt in the vault', path: join(vault, 'llms.txt'), state: 'changed' },
        { id: 'vault-notes-system', label: 'Notes System note in the vault', path: undefined, state: 'missing' },
      ]);
      const reviewed = await withCurrentSourceHashes(text, env);
      expect(reviewed).toContain(`<!-- source: vault-llms sha1:${sha1('Manifest').slice(0, 12)} -->`);
      expect(reviewed).toContain('<!-- source: vault-notes-system sha1:000000000000 -->'); // missing: left as it was
      expect((await sourceStates(reviewed, env)).map((x) => x.state)).toEqual(['current', 'current', 'missing']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the sources of both guidance defaults', () => {
    const ids = (id: string) => [...PROMPT_FILES.find((f) => f.id === id)!.defaultText.matchAll(/<!-- source: (\S+) sha1:/g)].map((m) => m[1]);
    expect(ids('confluence-routing')).toEqual(['psg-context-builder']);
    expect(ids('vault-conventions')).toEqual(['vault-notes-system', 'vault-llms', 'obsidian-vault-reader']);
  });
});
