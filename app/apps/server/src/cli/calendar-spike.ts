import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter, type McpStatus } from '../claude/adapter';
import { relayBatch, relayToolCall, type Connector } from '../claude/relay';
import { UsageLog } from '../claude/usage';
import { defaultSettings } from '../config/defaults';
import { macKeychain } from '../config/keychain';
import { API_KEY_FIX, apiKeySet } from '../runtime/refuse';

// npm run spike:calendar (P0-12, B1 of the Outlook plan): does the Microsoft 365 connector's
// calendar give the calendar source what it needs? Prints shapes, counts, timings, cost and the
// values of enumerations (showAs, response, event type, time zones) only: never a subject, address,
// name, body or join link. Read-only: it calls search and read tools only.
//
//   spike:calendar search [days]   one outlook_calendar_search from yesterday to `days` ahead (14)
//   spike:calendar read [n]        that search, then read n events (10) in ONE batched run
//   spike:calendar mail [n]        read the n newest Inbox emails (10): is a meeting request marked?
//   spike:calendar categories      how events carry categories, and whether any URI reads the
//                                  mailbox's category list with its colours (names never printed)
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
  const list = Array.isArray(raw) ? raw : Array.isArray((raw as { content?: unknown })?.content) ? (raw as { content: unknown[] }).content : [raw];
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

type Obj = Record<string, unknown>;
const get = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Obj)[k] : undefined), o);
/** How often each value of an enumeration appears, e.g. "busy 7, tentative 2, (none) 1". */
function tally(list: unknown[], path: string): string {
  const n = new Map<string, number>();
  for (const o of list) {
    const v = get(o, path);
    const k = v === undefined ? '(none)' : v === null ? 'null' : typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? String(v) : `(${typeof v})`;
    n.set(k, (n.get(k) ?? 0) + 1);
  }
  return [...n].map(([k, c]) => `${k} ${c}`).join(', ');
}
const has = (list: unknown[], path: string) => `${list.filter((o) => get(o, path) !== undefined && get(o, path) !== null).length} of ${list.length}`;
const keys = (list: unknown[]) => [...new Set(list.flatMap((o) => (o && typeof o === 'object' ? Object.keys(o) : [])))].sort().join(', ');

async function main(): Promise<number> {
  if (apiKeySet(process.env)) {
    console.error(`ANTHROPIC_API_KEY is set, so the spike would not run on the subscription (CL-2). ${API_KEY_FIX}`);
    return 2;
  }
  const [cmd = 'search', a1] = process.argv.slice(2);
  const dir = await mkdtemp(join(tmpdir(), 'work-os-calendar-spike-'));
  const usage = await UsageLog.open(dir);
  const settings = defaultSettings(dir);
  const claude = new ClaudeAdapter({ usage, settings: () => settings, secrets: macKeychain(), cwd: dir, client: 'work-os-calendar-spike' });
  try {
    const servers = await claude.mcpStatus({ timeoutMs: STATUS_MS, done: (l) => l.some((s) => isMs365(s) && s.status !== 'pending') });
    const found = servers.find(isMs365);
    if (!found?.config?.id) {
      console.error('No Microsoft 365 connector found: run `spike:outlook status`.');
      return 1;
    }
    const connector: Connector = { name: 'ms365', id: found.config.id, url: found.config.url, tools: (found.tools ?? []).map((t) => t.name) };
    const report = (label: string, runs: { usage: { inputTokens: number; outputTokens: number; costEquivalent: number; durationMs: number }; turns: number; toolCalls: string[]; denied: string[] }[]) => {
      for (const r of runs) console.log(`${label}: ${r.turns} turns · ${r.toolCalls.length} tool calls · ${r.denied.length} denied · ${r.usage.inputTokens} in / ${r.usage.outputTokens} out · $${r.usage.costEquivalent.toFixed(4)} · ${r.usage.durationMs} ms`);
    };

    if (cmd === 'search' || cmd === 'read') {
      const days = cmd === 'search' ? Number(a1 ?? 14) : 14;
      const day = 86_400_000;
      const args = { query: '*', afterDateTime: new Date(Date.now() - day).toISOString(), beforeDateTime: new Date(Date.now() + days * day).toISOString(), order: 'oldest', limit: 25, offset: 0 };
      const s = await relayToolCall(claude, { connector, tool: 'outlook_calendar_search', args });
      report('search', [s.run]);
      const items = blocks(s.raw);
      const events = items.filter((x) => (x as Obj)?.uri || (x as Obj)?.id);
      const tail = items.filter((x) => !((x as Obj)?.uri || (x as Obj)?.id));
      console.log(`\n${events.length} event(s); first: ${JSON.stringify(shape(events[0]), null, 1)}`);
      console.log(`paging item(s): ${JSON.stringify(tail.map((t) => shape(t)))}`);
      console.log(`fields seen: ${keys(events)}`);
      console.log(`start.timeZone: ${tally(events, 'start.timeZone')}`);
      console.log(`showAs: ${tally(events, 'showAs')}`);
      console.log(`responseStatus.response: ${tally(events, 'responseStatus.response')}`);
      console.log(`isCancelled: ${tally(events, 'isCancelled')} · isAllDay: ${tally(events, 'isAllDay')} · type: ${tally(events, 'type')}`);
      const withAttendees = events.find((e) => get(e, 'attendees') !== null && get(e, 'attendees') !== undefined);
      console.log(`attendees: ${has(events, 'attendees')}; shape ${JSON.stringify(shape(get(withAttendees, 'attendees')))} · recurrence: ${has(events, 'recurrence')}, shape ${JSON.stringify(shape(get(events.find((e) => get(e, 'recurrence')), 'recurrence')))} · summary: ${has(events, 'summary')}`);
      const starts = events.map((e) => String(get(e, 'start.dateTime') ?? ''));
      console.log(`start ascending: ${starts.every((t, i) => i === 0 || starts[i - 1] <= t)}; dateTime lengths ${[...new Set(starts.map((t) => t.length))].join(', ')}`);
      if (cmd === 'search') return 0;

      const n = Math.min(Number(a1 ?? 10), 10);
      const uris = events
        .map((x) => (x as Obj).uri)
        .filter((u): u is string => typeof u === 'string')
        .slice(0, n);
      const b = await relayBatch(claude, { connector, tool: 'read_resource', calls: uris.map((uri) => ({ uri })) });
      report('read batch', b.runs);
      const reads = b.results.flatMap((x) => (x?.ok ? blocks(x.raw).slice(0, 1) : []));
      console.log(`\n${reads.length} read, ${b.results.filter((x) => x && !x.ok).length} failed, ${b.results.filter((x) => !x).length} never called, of ${uris.length}`);
      console.log(`first read: ${JSON.stringify(shape(reads[0]), null, 1)}`);
      console.log(`fields seen: ${keys(reads)}`);
      console.log(`type: ${tally(reads, 'type')}`);
      console.log(`seriesMasterId: ${has(reads, 'seriesMasterId')} · iCalUId: ${has(reads, 'iCalUId')} · onlineMeeting: ${has(reads, 'onlineMeeting')} · meetingTranscriptUrl: ${has(reads, 'meetingTranscriptUrl')}`);
      console.log(`responseRequested: ${tally(reads, 'responseRequested')} · isOrganizer: ${tally(reads, 'isOrganizer')}`);
      console.log(`responseStatus.response: ${tally(reads, 'responseStatus.response')}`);
      console.log(`showAs: ${tally(reads, 'showAs')} · isCancelled: ${tally(reads, 'isCancelled')}`);
      console.log(`originalStartTimeZone: ${tally(reads, 'originalStartTimeZone')} · start.timeZone: ${tally(reads, 'start.timeZone')}`);
      const attendees = reads.flatMap((r) => (Array.isArray(get(r, 'attendees')) ? (get(r, 'attendees') as unknown[]) : []));
      console.log(`attendees: ${attendees.length}; first: ${JSON.stringify(shape(attendees[0]))}; responseStatus: ${tally(attendees, 'responseStatus')}; type: ${tally(attendees, 'type')}`);
      // Frank's own answer: his entry among the attendees, by the address get_me gives.
      const me = await relayBatch(claude, { connector, tool: 'get_me', calls: [{}] });
      const meRead = me.results[0]?.ok ? (blocks(me.results[0].raw)[0] as Obj) : undefined;
      const mine = [meRead?.mail, meRead?.userPrincipalName].filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
      const own = reads.map((r) => ((get(r, 'attendees') as Obj[] | null) ?? []).find((a) => mine.includes(String(a.address ?? '').toLowerCase())));
      const organised = reads.map((r) => mine.includes(String(get(r, 'organizer.address') ?? '').toLowerCase()));
      console.log(`me among attendees: ${own.filter(Boolean).length} of ${reads.length}; organiser: ${organised.filter(Boolean).length}; my responseStatus: ${tally(own.filter(Boolean), 'responseStatus')}`);
      console.log(`events with no attendees: ${reads.filter((r) => !Array.isArray(get(r, 'attendees'))).length}`);
      console.log(`body.contentType: ${tally(reads, 'body.contentType')} · lastModifiedDateTime: ${has(reads, 'lastModifiedDateTime')} · changeKey: ${has(reads, 'changeKey')}`);
      return 0;
    }
    if (cmd === 'mail') {
      const n = Math.min(Number(a1 ?? 10), 10);
      const s = await relayToolCall(claude, { connector, tool: 'outlook_email_search', args: { folderName: 'Inbox', order: 'newest', limit: n } });
      report('search', [s.run]);
      const rows = blocks(s.raw).filter((x) => (x as Obj)?.uri);
      console.log(`search fields: ${keys(rows)}`);
      const uris = rows.map((x) => (x as Obj).uri as string);
      const b = await relayBatch(claude, { connector, tool: 'read_resource', calls: uris.map((uri) => ({ uri })) });
      report('read batch', b.runs);
      const reads = b.results.flatMap((x) => (x?.ok ? blocks(x.raw).slice(0, 1) : []));
      console.log(`\nread fields: ${keys(reads)}`);
      console.log(`@odata.type: ${tally(reads, '@odata.type')} · meetingMessageType: ${tally(reads, 'meetingMessageType')} · type: ${tally(reads, 'type')}`);
      console.log(`event link: ${has(reads, 'event')} · meetingRequestType: ${tally(reads, 'meetingRequestType')}`);
      return 0;
    }
    if (cmd === 'categories') {
      const day = 86_400_000;
      const args = { query: '*', afterDateTime: new Date(Date.now() - day).toISOString(), beforeDateTime: new Date(Date.now() + 14 * day).toISOString(), order: 'oldest', limit: 25, offset: 0 };
      const s = await relayToolCall(claude, { connector, tool: 'outlook_calendar_search', args });
      report('search', [s.run]);
      const events = blocks(s.raw).filter((x) => (x as Obj)?.uri);
      const cats = events.map((e) => get(e, 'categories'));
      const tagged = events.filter((e) => Array.isArray(get(e, 'categories')) && (get(e, 'categories') as unknown[]).length);
      const all = cats.flatMap((c) => (Array.isArray(c) ? c : []));
      console.log(`
categories: ${has(events, 'categories')} have the field; ${tagged.length} of ${events.length} have one or more; per event ${[...new Set(cats.map((c) => (Array.isArray(c) ? c.length : -1)))].join(', ')}`);
      console.log(`entry shape: ${JSON.stringify(shape(all[0]))}; distinct ${new Set(all.map((c) => JSON.stringify(c))).size}`);
      // Outlook's preset names ("Red category") carry their colour; renamed ones don't. Counted, not printed.
      const preset = all.filter((c) => typeof c === 'string' && /^(red|orange|yellow|green|blue|purple) category$/i.test(c));
      console.log(`preset-named entries: ${preset.length} of ${all.length}`);
      if (tagged[0]) {
        const r = await relayToolCall(claude, { connector, tool: 'read_resource', args: { uri: (tagged[0] as Obj).uri as string } });
        report('read tagged event', [r.run]);
        const read = blocks(r.raw)[0];
        console.log(`read categories shape: ${JSON.stringify(shape(get(read, 'categories')))}; colour-like fields: ${keys([read]).split(', ').filter((k) => /colou?r|categor/i.test(k)).join(', ') || '(none)'}`);
      }
      for (const uri of ['mail:///masterCategories', 'mail:///categories', 'mail:///outlook/masterCategories', 'calendar:///categories', 'mail:///labels']) {
        try {
          const r = await relayToolCall(claude, { connector, tool: 'read_resource', args: { uri } });
          const out = blocks(r.raw);
          console.log(`${uri}: ok · ${JSON.stringify(shape(out[0]))}`);
        } catch (e) {
          console.log(`${uri}: ${(e as Error).name} · ${(e as Error).message.slice(0, 160)}`);
        }
      }
      console.log(`tools mentioning labels or categories: ${connector.tools.filter((t) => /label|categor/i.test(t)).join(', ')}`);
      return 0;
    }
    console.error(`Unknown command ${cmd}. Use search, read, mail or categories.`);
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
