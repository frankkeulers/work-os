import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { auth, UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { macKeychain } from '../config/keychain';

// npm run spike:wispr (P0-11): can a headless process sign in to Wispr Flow's official MCP server,
// keep its sign-in by refreshing without a browser, and list meetings incrementally? Prints shapes
// and counts only: no meeting titles, summaries, transcripts or names. Read-only: it calls only the
// tools named on the command line, and the server's tools are read-only anyway.
//
//   spike:wispr login                 sign in in the browser, report the tokens, list the tools
//   spike:wispr tools [--out <file>]  list the tools; --out writes their full schemas
//   spike:wispr call <tool> [json]    call one tool and print the shape of its result
//   spike:wispr refresh               refresh the tokens with no browser
//   spike:wispr logout                forget the spike's client and tokens
//
// The spike keeps its own Keychain item, so it never touches what the app will use.

const SERVER = new URL('https://api.wisprflow.ai/connect/mcp');
const ACCOUNT = 'wispr-oauth-spike';
const PORT = 4392;
const REDIRECT = `http://127.0.0.1:${PORT}/callback`;
const SIGN_IN_MS = 5 * 60_000; // Wispr gives 5 minutes to finish signing in

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  savedAt?: string;
  verifier?: string;
}

const keychain = macKeychain();
const load = async (): Promise<Stored> => JSON.parse((await keychain.get(ACCOUNT)) ?? '{}') as Stored;
const save = async (patch: Partial<Stored>) => keychain.set(ACCOUNT, JSON.stringify({ ...(await load()), ...patch }));

let pendingState: string | undefined;

const provider: OAuthClientProvider = {
  get redirectUrl() {
    return REDIRECT;
  },
  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Work OS (spike)',
      redirect_uris: [REDIRECT],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },
  state() {
    pendingState = randomBytes(16).toString('hex');
    return pendingState;
  },
  clientInformation: async () => (await load()).client,
  saveClientInformation: async (client) => save({ client }),
  tokens: async () => (await load()).tokens,
  saveTokens: async (tokens) => save({ tokens, savedAt: new Date().toISOString() }),
  saveCodeVerifier: async (verifier) => save({ verifier }),
  codeVerifier: async () => {
    const v = (await load()).verifier;
    if (!v) throw new Error('No PKCE verifier saved.');
    return v;
  },
  redirectToAuthorization(url) {
    console.log(`\nOpening the browser to sign in to Wispr Flow (5 minutes). If it doesn't open:\n${url.href}\n`);
    execFile('/usr/bin/open', [url.href]);
  },
  invalidateCredentials: async (scope) => {
    console.log(`server asked to invalidate: ${scope}`);
    if (scope === 'all') await keychain.set(ACCOUNT, '{}');
    if (scope === 'tokens') await save({ tokens: undefined });
    if (scope === 'client') await save({ client: undefined });
  },
};

/** Waits for the browser to come back to the loopback redirect, and checks the OAuth state. */
function waitForCode(): { code: Promise<string>; server: Server } {
  let server!: Server;
  const code = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Sign-in took longer than 5 minutes.')), SIGN_IN_MS);
    server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', REDIRECT);
      if (u.pathname !== '/callback') return void res.writeHead(404).end();
      const got = u.searchParams.get('code');
      const ok = !!got && !!pendingState && u.searchParams.get('state') === pendingState;
      res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' }).end(ok ? 'Signed in. You can close this tab.' : 'Sign-in failed.');
      clearTimeout(timer);
      if (ok) resolve(got);
      else reject(new Error(`Callback without a matching state (error: ${u.searchParams.get('error') ?? 'none'}).`));
    }).listen(PORT, '127.0.0.1');
  });
  return { code, server };
}

async function connect(interactive: boolean): Promise<Client> {
  const client = new Client({ name: 'work-os-spike', version: '0.1.0' });
  const transport = new StreamableHTTPClientTransport(SERVER, { authProvider: provider });
  const wait = interactive ? waitForCode() : undefined;
  try {
    await client.connect(transport);
    return client;
  } catch (e) {
    if (!(e instanceof UnauthorizedError) || !wait) throw e;
    const code = await wait.code;
    await transport.finishAuth(code);
    const again = new Client({ name: 'work-os-spike', version: '0.1.0' });
    await again.connect(new StreamableHTTPClientTransport(SERVER, { authProvider: provider }));
    return again;
  } finally {
    wait?.server.close();
  }
}

async function tokenFacts() {
  const s = await load();
  const t = s.tokens;
  if (!t) return console.log('tokens: none');
  console.log('tokens:');
  console.log(`  token_type ${t.token_type}, expires_in ${t.expires_in ?? 'not given'} s, refresh token ${t.refresh_token ? 'yes' : 'no'}`);
  console.log(`  scope ${t.scope ?? 'not given'}, saved ${s.savedAt ?? '?'}`);
  console.log(`  client registered: ${s.client ? 'yes' : 'no'}${s.client && 'client_secret' in s.client && s.client.client_secret ? ' (with a secret)' : ''}`);
}

/** The shape of a value with every value redacted: types, lengths and the format of dates and ids. */
function shape(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v ?? null;
  if (typeof v === 'boolean' || typeof v === 'number') return `<${typeof v}>`;
  if (typeof v === 'string') {
    if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) return `<date ${v.replace(/\d/g, '9')}>`;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) return '<uuid>';
    if (/^[a-z]+:\/\//i.test(v)) return `<url ${v.split(':')[0]}>`;
    return `<string ${v.length}>`;
  }
  if (depth > 6) return '<…>';
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1), `…${v.length} items`] : [];
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x, depth + 1)]));
  return `<${typeof v}>`;
}

function textShape(text: string): unknown {
  try {
    return { json: shape(JSON.parse(text)) };
  } catch {
    const lines = text.split('\n');
    return { text: `<${text.length} chars, ${lines.length} lines, ${lines.filter((l) => l.startsWith('#')).length} headings>` };
  }
}

async function main() {
  const [cmd = 'login', ...rest] = process.argv.slice(2);
  if (cmd === 'logout') {
    await keychain.set(ACCOUNT, '{}');
    return console.log('Forgot the spike client and tokens.');
  }
  if (cmd === 'refresh') {
    const before = (await load()).tokens;
    if (!before?.refresh_token) return console.log('No refresh token: sign in with `login` first.');
    const t0 = performance.now();
    const r = await auth(provider, { serverUrl: SERVER });
    const after = (await load()).tokens;
    console.log(`auth() → ${r} in ${Math.round(performance.now() - t0)} ms, access token changed: ${after?.access_token !== before.access_token}, refresh token rotated: ${after?.refresh_token !== before.refresh_token}`);
    return tokenFacts();
  }

  const t0 = performance.now();
  const client = await connect(cmd === 'login');
  console.log(`connected in ${Math.round(performance.now() - t0)} ms; server ${client.getServerVersion()?.name} v${client.getServerVersion()?.version}`);
  console.log(`capabilities: ${Object.keys(client.getServerCapabilities() ?? {}).join(', ')}`);

  if (cmd === 'login' || cmd === 'tools') {
    if (cmd === 'login') await tokenFacts();
    const { tools } = await client.listTools();
    console.log(`\n${tools.length} tools:`);
    for (const t of tools) {
      const args = Object.keys((t.inputSchema.properties as object | undefined) ?? {});
      const req = t.inputSchema.required ?? [];
      console.log(`  ${t.name}(${args.map((a) => (req.includes(a) ? a : `${a}?`)).join(', ')})${t.annotations?.readOnlyHint ? ' [read-only]' : ''}`);
    }
    const out = rest[0] === '--out' ? rest[1] : undefined;
    if (out) {
      await writeFile(out, JSON.stringify(tools, null, 2));
      console.log(`\nFull tool schemas written to ${out}`);
    }
  } else if (cmd === 'order') {
    // Is the no-query list newest-modified first across pages? That decides the cursor (P0-11).
    type Row = { id: string; finalized: boolean; has_transcript: boolean; attendees: unknown[]; modified_at: string };
    const rows: Row[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const r = await client.callTool({ name: 'search_meetings', arguments: { limit: 10, ...(cursor && { cursor }) } });
      const page = r.structuredContent as { meetings: Row[]; has_more: boolean; next_cursor?: string };
      rows.push(...page.meetings);
      cursor = page.has_more ? page.next_cursor : undefined;
      pages++;
    } while (cursor && pages < 20);
    const sorted = rows.every((m, i) => i === 0 || m.modified_at <= rows[i - 1].modified_at);
    console.log(`${rows.length} meetings in ${pages} pages; newest-modified first throughout: ${sorted}; unique ids: ${new Set(rows.map((m) => m.id)).size}`);
    console.log(`finalized ${rows.filter((m) => m.finalized).length}, with transcript ${rows.filter((m) => m.has_transcript).length}, with attendees ${rows.filter((m) => m.attendees.length).length}`);
    console.log(`modified_at from ${rows.at(-1)?.modified_at} to ${rows[0]?.modified_at}`);
  } else if (cmd === 'format') {
    // The layout of the newest meeting's summary and transcript, with every letter and digit masked:
    // speaker labels, timestamps and the truncation marker show, the words don't. Server-written
    // markers (they name start_char) and the summary's section headings print as they are.
    const mask = (s: string) => s.replace(/\p{L}/gu, 'a').replace(/\d/g, '9');
    const s = await client.callTool({ name: 'search_meetings', arguments: { limit: 1 } });
    const id = (s.structuredContent as { meetings: { id: string }[] }).meetings[0].id;
    const r = await client.callTool({ name: 'get_meeting', arguments: { meeting_id: id, view_transcript: { char_limit: 1500 } } });
    const m = r.structuredContent as { summary: string; transcript?: string; todos: unknown[] };
    const lines = (m.transcript ?? '').split('\n');
    console.log(`transcript: ${lines.length} lines in the first 1500 chars. First 4 and last 2, masked:`);
    for (const l of [...lines.slice(0, 4), '…', ...lines.slice(-2)]) console.log(`  ${/start_char/.test(l) ? l : mask(l)}`);
    console.log('\nsummary headings:');
    for (const l of m.summary.split('\n').filter((x) => /^#+ /.test(x))) console.log(`  ${l.length < 40 ? l : mask(l)}`);
    console.log(`summary bullets: ${m.summary.split('\n').filter((x) => /^\s*[-*] /.test(x)).length}, checkboxes: ${(m.summary.match(/\[[ x]\]/g) ?? []).length}, todos: ${m.todos.length}`);
    const p = await client.callTool({ name: 'get_meeting_participants_enriched', arguments: { meeting_id: id } });
    const ps = (p.structuredContent as { participants: { origin: string; relationship: string; is_self: boolean; spoke: boolean; emails?: string[] }[] }).participants;
    console.log(`\nparticipants: ${ps.length}; origins ${[...new Set(ps.map((x) => x.origin))].join('/')}; relationships ${[...new Set(ps.map((x) => x.relationship))].join('/')}; self ${ps.filter((x) => x.is_self).length}; with emails ${ps.filter((x) => x.emails?.length).length}`);
  } else if (cmd === 'call') {
    const [name, json = '{}'] = rest;
    if (!name) throw new Error('Usage: spike:wispr call <tool> [json args]');
    const t1 = performance.now();
    // "$latest" stands for the newest meeting's id, so no id needs copying from anywhere.
    let args = json;
    if (args.includes('$latest')) {
      const s = await client.callTool({ name: 'search_meetings', arguments: { limit: 1 } });
      args = args.replaceAll('$latest', (s.structuredContent as { meetings: { id: string }[] }).meetings[0].id);
    }
    const r = await client.callTool({ name, arguments: JSON.parse(args) as Record<string, unknown> });
    console.log(`${name} in ${Math.round(performance.now() - t1)} ms, isError ${r.isError ?? false}`);
    const content = (r.content ?? []) as { type: string; text?: string }[];
    content.forEach((c, i) => console.log(`content[${i}] ${c.type}:`, JSON.stringify(c.type === 'text' && c.text !== undefined ? textShape(c.text) : shape(c), null, 2)));
    if (r.structuredContent) console.log('structuredContent:', JSON.stringify(shape(r.structuredContent), null, 2));
  } else {
    throw new Error(`Unknown command ${cmd}. Use login, tools, call, refresh or logout.`);
  }
  await client.close();
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e);
  process.exit(1);
});
