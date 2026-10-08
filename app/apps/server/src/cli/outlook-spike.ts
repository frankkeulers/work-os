import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, type McpStatus } from '../claude/adapter';
import { relayBatch, relayToolCall, type Connector } from '../claude/relay';
import { UsageLog } from '../claude/usage';
import { defaultSettings } from '../config/defaults';
import { macKeychain } from '../config/keychain';
import { API_KEY_FIX, apiKeySet } from '../runtime/refuse';

// npm run spike:outlook (A0 of the Outlook plan, amends P0-9): does the claude.ai Microsoft 365
// connector work the way the Outlook source needs? Prints shapes, counts, timings and cost only:
// never a subject, address, name or body. Read-only: it calls search, read and get_me tools only.
//
//   spike:outlook status                 find the connector with no model turn (mcpServerStatus)
//   spike:outlook search [folder] [n]    one outlook_email_search (folder Inbox, n 5); paging shape
//   spike:outlook read [n]               search n Inbox emails, then read them in ONE batched run
//   spike:outlook me                     the shape of get_me
//
// Usage goes to a temporary folder, not the app's usage log, so the spike never touches app data.

const STATUS_MS = 45_000;
const isMs365 = (s: McpStatus) => s.config?.type === 'claudeai-proxy' && /microsoft 365|ms365|outlook/i.test(s.name);

/** The shape of a value: field names and types, string lengths, array sizes. Never the content. */
function shape(v: unknown, depth = 0): unknown {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [`${v.length} ×`, shape(v[0], depth + 1)] : '[]';
  if (typeof v === 'object') return depth > 3 ? '{…}' : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  if (typeof v === 'string') return `string(${v.length})`;
  return typeof v;
}

/** A connector result: text blocks, one JSON value per block (P0-9). */
function blocks(raw: unknown): unknown[] {
  const list = Array.isArray(raw) ? raw : [raw];
  return list.map((b) => {
    const text = (b as { text?: unknown })?.text;
    if (typeof text !== 'string') return b;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return `unparsed text(${text.length})`;
    }
  });
}

const charset = (s: string) => [...new Set(s.replace(/[A-Za-z0-9]/g, ''))].join('');

async function main(): Promise<number> {
  if (apiKeySet(process.env)) {
    console.error(`ANTHROPIC_API_KEY is set, so the spike would not run on the subscription (CL-2). ${API_KEY_FIX}`);
    return 2;
  }
  const [cmd = 'status', a1, a2] = process.argv.slice(2);
  const dir = await mkdtemp(join(tmpdir(), 'work-os-outlook-spike-'));
  const usage = await UsageLog.open(dir);
  const settings = defaultSettings(dir);
  const claude = new ClaudeAdapter({ usage, settings: () => settings, secrets: macKeychain(), cwd: dir, client: 'work-os-outlook-spike' });
  try {
    const t0 = performance.now();
    const servers = await claude.mcpStatus({ timeoutMs: STATUS_MS, done: (l) => l.some((s) => isMs365(s) && s.status !== 'pending') });
    const found = servers.find(isMs365);
    const ms = Math.round(performance.now() - t0);
    if (cmd === 'status') {
      console.log(`mcpServerStatus after ${ms} ms: ${servers.length} server(s)`);
      for (const s of servers) console.log(`  ${s.name} · ${s.status} · source ${s.source ?? '?'} · config ${s.config?.type ?? '?'}${s.config?.id ? ` id ${s.config.id}` : ''} · ${s.tools?.length ?? 0} tools`);
      if (found) console.log(`\nMicrosoft 365 tools: ${(found.tools ?? []).map((t) => `${t.name}${t.annotations?.readOnly ? '' : '*'}`).join(', ')}\n(* = not marked read-only)`);
      else console.log('\nNo Microsoft 365 connector found.');
      return 0;
    }
    if (!found?.config?.id) {
      console.error('No Microsoft 365 connector found: run `spike:outlook status`.');
      return 1;
    }
    const connector: Connector = { name: 'ms365', id: found.config.id, url: found.config.url, tools: (found.tools ?? []).map((t) => t.name) };
    console.log(`Connector found in ${ms} ms (${connector.tools.length} tools).`);

    const report = (label: string, runs: { usage: { inputTokens: number; outputTokens: number; costEquivalent: number; durationMs: number }; turns: number; toolCalls: string[]; denied: string[] }[]) => {
      for (const r of runs) console.log(`${label}: ${r.turns} turns · ${r.toolCalls.length} tool calls · ${r.denied.length} denied · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out · $${r.usage.costEquivalent.toFixed(4)} · ${r.usage.durationMs} ms`);
    };

    if (cmd === 'search') {
      const folderName = a1 ?? 'Inbox';
      const limit = Number(a2 ?? 5);
      const r = await relayToolCall(claude, { connector, tool: 'outlook_email_search', args: { folderName, order: 'oldest', afterDateTime: new Date(Date.now() - 2 * 86_400_000).toISOString(), limit } });
      report('search', [r.run]);
      const items = blocks(r.raw);
      const emails = items.filter((x) => (x as { id?: unknown })?.id);
      const tail = items.filter((x) => !(x as { id?: unknown })?.id);
      console.log(`\n${emails.length} email(s); first: ${JSON.stringify(shape(emails[0]), null, 1)}`);
      console.log(`paging item(s): ${JSON.stringify(tail.map((t) => shape(t)))}`);
      const senders = emails.map((e) => String((e as { sender?: unknown }).sender ?? ''));
      console.log(`senders: ${senders.filter((s) => s.startsWith('/O=')).length} of ${senders.length} are /O= addresses`);
      const times = emails.map((e) => String((e as { receivedDateTime?: unknown }).receivedDateTime));
      console.log(`received ascending: ${times.every((t, i) => i === 0 || times[i - 1] <= t)}`);
      return 0;
    }
    if (cmd === 'read') {
      const n = Math.min(Number(a1 ?? 5), 10);
      const s = await relayToolCall(claude, { connector, tool: 'outlook_email_search', args: { folderName: 'Inbox', order: 'newest', limit: n } });
      report('search', [s.run]);
      const uris = blocks(s.raw)
        .map((x) => (x as { uri?: unknown })?.uri)
        .filter((u): u is string => typeof u === 'string');
      const b = await relayBatch(claude, { connector, tool: 'read_resource', calls: uris.map((uri) => ({ uri })) });
      report('read batch', b.runs);
      console.log(`\n${b.results.filter((x) => x?.ok).length} read, ${b.results.filter((x) => x && !x.ok).length} failed, ${b.results.filter((x) => !x).length} never called, of ${uris.length}`);
      const reads = b.results.flatMap((x) => (x?.ok ? blocks(x.raw) : []));
      console.log(`first read: ${JSON.stringify(shape(reads[0]), null, 1)}`);
      const convs = reads.map((r) => String((r as { conversationId?: unknown }).conversationId ?? ''));
      console.log(`conversationId lengths ${[...new Set(convs.map((c) => c.length))].join(', ')}; non-alphanumerics "${charset(convs.join(''))}"`);
      const ids = reads.map((r) => String((r as { internetMessageId?: unknown }).internetMessageId ?? ''));
      console.log(`internetMessageId max length ${Math.max(...ids.map((i) => i.length))}`);
      console.log(`sender with name: ${reads.filter((r) => (r as { sender?: { name?: unknown } }).sender?.name).length} of ${reads.length}`);
      console.log(`body types: ${[...new Set(reads.map((r) => (r as { body?: { contentType?: unknown } }).body?.contentType))].join(', ')}`);
      return 0;
    }
    if (cmd === 'me') {
      const b = await relayBatch(claude, { connector, tool: 'get_me', calls: [{}] });
      report('get_me', b.runs);
      const out = b.results[0];
      console.log(out?.ok ? JSON.stringify(blocks(out.raw).map((x) => shape(x)), null, 1) : `not read: ${out ? out.error : 'never called'}; denied ${b.runs.flatMap((r) => r.denied).join(', ') || 'nothing'}`);
      return 0;
    }
    console.error(`Unknown command ${cmd}. Use status, search, read or me.`);
    return 1;
  } catch (e) {
    console.error(`The spike failed: ${(e as Error).name}: ${(e as Error).message}`);
    return 1;
  } finally {
    await usage.close();
    await rm(dir, { recursive: true, force: true });
  }
}

process.exitCode = await main();
