import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaudeAdapter, type QueryFn } from '../../claude/adapter';
import { UsageLog } from '../../claude/usage';
import { defaultSettings } from '../../config/defaults';
import { memoryKeychain } from '../../config/keychain';
import { SourceError } from '../errors';
import { eventPage, Ms365Relay, searchPage } from '../ms365/client';
import { FakeMs365, fakeEmail } from '../ms365/fakeMs365';
import { accountOf, ms365Link, Ms365LinkError } from '../ms365/link';
import type { EmailDetail } from '../ms365/types';
import { FIRST_POLL_MS, MAX_READS, OutlookAdapter, OVERLAP_MS, parseCursor, RecentEmails, outlookFactory } from './adapter';
import { emailText, unwrapUrl } from './html';
import { buildItems, cleanSubject, isNoise, type MeInfo } from './normalise';

// The Outlook source against the in-memory connector, and the relay client against a scripted
// SDK. All mail here is synthetic.

const NOW = new Date('2026-10-08T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

const FRANK = { name: 'Frank Keulers', address: 'frank.keulers@example.com' };
const DANA = { name: 'Dana Lee', address: 'dana.lee@customer.example' };
const SAM = { name: 'Sam Ray', address: 'sam.ray@example.com' };
const ME: MeInfo = { id: FRANK.address, name: FRANK.name, aliases: [FRANK.address, 'frank@example.onmicrosoft.com'] };

const html = (body: string) => `<html><head><style>p{margin:0}</style></head><body><div class="elementToProof">${body}</div></body></html>`;

describe('email text', () => {
  it('keeps only what an Outlook reply adds: not the quoted conversation under it', () => {
    const body = html(
      'Thanks Frank, that helps.<br><br>Jeff' +
        '<div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><b>From:</b> Frank Keulers &lt;frank@example.com&gt;<br><b>Sent:</b> Wednesday<br><b>Subject:</b> Re: Royalty report</div>' +
        '<div>Hi Jeff, one clarification…</div>',
    );
    expect(emailText({ contentType: 'html', content: body })).toBe('Thanks Frank, that helps.\n\nJeff');
  });

  it('cuts a Gmail quote and an "On … wrote:" line', () => {
    expect(emailText({ contentType: 'html', content: '<div dir="ltr">Any update?</div><div class="gmail_quote">On Tue, Oct 6, 2026 at 2:39 AM Abhijit wrote:<blockquote>Old text</blockquote></div>' })).toBe('Any update?');
    expect(emailText({ contentType: 'text', content: 'Any update?\n\nOn Tue, Oct 6, 2026 at 2:39 AM Abhijit <a@example.com> wrote:\n> Old text' })).toBe('Any update?');
  });

  it('cuts plain-text quotes: Original Message, and a From:/Sent: header', () => {
    expect(emailText({ contentType: 'text', content: 'Agreed.\n\n-----Original Message-----\nFrom: Sam\nOld' })).toBe('Agreed.');
    expect(emailText({ contentType: 'text', content: 'Agreed.\n\nFrom: Sam Ray <sam@example.com>\nSent: 07 October 2026 10:00\nTo: Frank\nOld' })).toBe('Agreed.');
  });

  it("drops the gateway's external-sender banner", () => {
    const body = 'WARNING: This email is from an external source. Please exercise caution with any links or attachments.\r\n\r\nHey Abhijit,\r\n\r\nDo you have any updates?';
    expect(emailText({ contentType: 'text', content: body })).toBe('Hey Abhijit,\n\nDo you have any updates?');
    expect(emailText({ contentType: 'html', content: html('<p>[EXTERNAL] This message came from outside the organisation.</p><p>Hello</p>') })).toBe('Hello');
  });

  it('cuts the signature and the legal disclaimer', () => {
    const body = html('See attached.<br>-- <br>Jeff Aucone<br>Director<p>This email and any files transmitted with it are confidential and intended solely…</p>');
    expect(emailText({ contentType: 'html', content: body })).toBe('See attached.');
    expect(emailText({ contentType: 'text', content: 'Yes.\n\nGet Outlook for iOS' })).toBe('Yes.');
  });

  it('keeps link addresses, unwrapped from safelinks, and names from mailto links', () => {
    const safe = 'https://eur01.safelinks.protection.outlook.com/?url=https%3A%2F%2Fwww.example.com%2Fpricing&data=05%7C02';
    expect(unwrapUrl(safe)).toBe('https://www.example.com/pricing');
    const body = html(`See <a href="${safe.replace(/&/g, '&amp;')}">the pricing page</a>, <a href="https://example.com/x">https://example.com/x</a> and ask <a href="mailto:sam@example.com">@Sam Ray</a>.`);
    expect(emailText({ contentType: 'html', content: body })).toBe('See the pricing page (https://www.example.com/pricing), https://example.com/x and ask @Sam Ray.');
  });

  it('turns lists, entities and tables into readable text', () => {
    const body = html('Points:<ul><li>Meridia&nbsp;customers&#8217; revenue</li><li>R&amp;D &lt;draft&gt;</li></ul><table><tr><td>Q1</td><td>3,800</td></tr></table>');
    expect(emailText({ contentType: 'html', content: body })).toBe('Points:\n\n- Meridia customers’ revenue\n- R&D <draft>\n\nQ1 · 3,800');
  });

  it('keeps a forward with no note of its own whole, rather than leaving nothing', () => {
    const body = html('<div id="divRplyFwdMsg"><b>From:</b> Sam<br><b>Subject:</b> Pricing</div><div>The pricing for Q4 is attached.</div>');
    expect(emailText({ contentType: 'html', content: body })).toContain('The pricing for Q4 is attached.');
  });

  it('lists attachments, not inline images, and caps long bodies', () => {
    const t = emailText({ contentType: 'html', content: html('Report attached.') }, [
      { name: 'Royalty Q3.xlsx', isInline: false },
      { name: 'image001.png', isInline: true },
    ]);
    expect(t).toBe('Report attached.\n\n📎 Royalty Q3.xlsx');
    expect(emailText({ contentType: 'text', content: 'x'.repeat(30_000) }).length).toBe(20_000);
    expect(emailText(undefined, [])).toBe('');
  });
});

describe('normalise', () => {
  it('strips reply and forward prefixes, in the languages Outlook uses', () => {
    expect(cleanSubject('RE: FW: Re: Royalty report')).toBe('Royalty report');
    expect(cleanSubject('AW: WG: Preise')).toBe('Preise');
    expect(cleanSubject('Re[2]: Hello')).toBe('Hello');
    expect(cleanSubject('Release notes')).toBe('Release notes');
    expect(cleanSubject('  ')).toBe('(no subject)');
  });

  it("knows Outlook's receipts and auto-replies", () => {
    for (const s of ['Accepted: Weekly sync', 'Declined: Demo', 'Automatic reply: Pricing', 'Undeliverable: Hello', 'Read: Report']) expect(isNoise(s)).toBe(true);
    for (const s of ['Re: Pricing', 'Accepted terms for renewal', 'Reading list']) expect(isNoise(s)).toBe(false);
  });

  it('makes one item per conversation, oldest message first, with names, To and Cc, and Frank as "me"', () => {
    const a = fakeEmail({ conversation: 'AAQkC1=', subject: 'Royalty report', from: DANA, to: [FRANK], cc: [SAM], at: ago(3 * HOUR), html: html('Can you send Q3 numbers?') });
    const b = fakeEmail({ conversation: 'AAQkC1=', subject: 'RE: Royalty report', from: FRANK, to: [DANA], at: ago(2 * HOUR), html: html('Attached.') });
    const c = fakeEmail({ conversation: 'AAQkC2=', subject: 'Lunch', from: SAM, to: [FRANK], at: ago(HOUR), html: html('Friday?') });
    const items = buildItems(
      [
        { email: b, folder: 'Sent Items' },
        { email: a, folder: 'Inbox' },
        { email: c, folder: 'Inbox' },
      ],
      ME,
    );
    expect(items.map((i) => i.id)).toEqual(['outlook:AAQkC1=', 'outlook:AAQkC2=']);
    const [thread] = items;
    expect(thread).toMatchObject({ source: 'outlook', kind: 'email', title: 'Royalty report', messageCount: 2, lastActivityAt: ago(2 * HOUR), permalink: b.webLink });
    expect(thread.messages.map((m) => [m.authorId, m.text, m.to, m.cc])).toEqual([
      [DANA.address, 'Can you send Q3 numbers?', [FRANK.address], [SAM.address]],
      [FRANK.address, 'Attached.', [DANA.address], []],
    ]);
    expect(thread.messages[0].id).toBe(a.internetMessageId);
    expect(thread.participants).toEqual([
      { id: FRANK.address, name: 'Frank Keulers' },
      { id: DANA.address, name: 'Dana Lee' },
      { id: SAM.address, name: 'Sam Ray' },
    ]);
  });

  it('matches Frank by any of his addresses, by name on an Exchange path, and as the author of all Sent Items', () => {
    const upn = fakeEmail({ conversation: 'C3', subject: 'x', from: { name: 'Frank K', address: 'Frank@Example.onmicrosoft.com' }, at: ago(HOUR), html: 'a' });
    const exch = fakeEmail({ conversation: 'C3', subject: 'x', from: { name: 'Frank Keulers', address: '/O=EXCHANGELABS/OU=EXCHANGE ADMINISTRATIVE GROUP/CN=RECIPIENTS/CN=FRANK' }, at: ago(50 * MIN), html: 'b' });
    const other = fakeEmail({ conversation: 'C3', subject: 'x', from: { name: 'Sam Ray', address: '/O=EXCHANGELABS/CN=SAM' }, at: ago(40 * MIN), html: 'c' });
    const sent = fakeEmail({ conversation: 'C3', subject: 'x', from: { name: 'On behalf', address: 'assistant@example.com' }, at: ago(30 * MIN), html: 'd' });
    const [item] = buildItems(
      [{ email: upn }, { email: exch }, { email: other }, { email: sent, folder: 'Sent Items' }].map((x) => ({ ...x, folder: x.folder as 'Sent Items' | undefined })),
      ME,
    );
    expect(item.messages.map((m) => m.authorId)).toEqual([FRANK.address, FRANK.address, 'name:sam ray', FRANK.address]);
  });
});

describe('cursor', () => {
  it('starts two days back on the first poll, and reads a cursor it wrote', () => {
    expect(parseCursor(undefined, NOW)).toEqual({ Inbox: '2026-10-06T12:00:00.000000Z', 'Sent Items': '2026-10-06T12:00:00.000000Z' });
    expect(parseCursor('2026-10-08T09:00:00.000000Z|2026-10-08T08:00:00.000000Z', NOW)).toEqual({ Inbox: '2026-10-08T09:00:00.000000Z', 'Sent Items': '2026-10-08T08:00:00.000000Z' });
    expect(parseCursor('garbage', NOW).Inbox).toBe('2026-10-06T12:00:00.000000Z');
  });
});

describe('the Outlook adapter', () => {
  let box: FakeMs365;
  let recent: RecentEmails;
  const account = { name: FRANK.name, address: FRANK.address, upn: FRANK.address };
  const adapter = (o: { account?: typeof account | undefined } = {}) => new OutlookAdapter({ api: box, account: () => ('account' in o ? o.account : account), recent });
  const poll = (a: OutlookAdapter, cursor?: string, now = NOW) => a.fetchSince(cursor, { signal: new AbortController().signal, now, reason: 'scheduled' });
  const inbox = (conversation: string, at: string, over: Partial<Parameters<typeof fakeEmail>[0]> = {}) => {
    const e = fakeEmail({ conversation, subject: `Subject ${conversation}`, from: DANA, to: [FRANK], at, html: html(`Body ${conversation}`), ...over });
    box.deliver('Inbox', e);
    return e;
  };

  beforeEach(() => {
    box = new FakeMs365();
    recent = new RecentEmails();
  });

  it('reads Inbox and Sent Items since two days back, both searches in one run, and threads them', async () => {
    inbox('OLD', ago(3 * 24 * HOUR));
    inbox('C1', ago(5 * HOUR));
    box.deliver('Sent Items', fakeEmail({ conversation: 'C1', subject: 'RE: Subject C1', from: FRANK, to: [DANA], at: ago(4 * HOUR), html: html('Done.') }));
    const r = await poll(adapter());
    expect(box.searches[0].map((s) => [s.folder, s.after])).toEqual([
      ['Inbox', ago(FIRST_POLL_MS + OVERLAP_MS)],
      ['Sent Items', ago(FIRST_POLL_MS + OVERLAP_MS)],
    ]);
    expect(r.items.map((i) => [i.id, i.messages.map((m) => m.authorId)])).toEqual([['outlook:C1', [DANA.address, FRANK.address]]]);
    expect(r.nextCursor).toBe(`${ago(5 * HOUR).replace('Z', '000Z')}|${ago(4 * HOUR).replace('Z', '000Z')}`);
    expect(box.reads).toHaveLength(1);
  });

  it('reads nothing again: not across the overlap, not after a restart within it', async () => {
    inbox('C1', ago(5 * HOUR));
    const first = await poll(adapter());
    const again = await poll(adapter(), first.nextCursor);
    expect(again.items).toEqual([]);
    expect(box.reads).toHaveLength(1);
    expect(again.nextCursor).toBe(first.nextCursor);
    inbox('C2', ago(HOUR));
    const third = await poll(adapter(), again.nextCursor);
    expect(third.items.map((i) => i.id)).toEqual(['outlook:C2']);
    expect(box.reads.at(-1)).toEqual([FakeMs365.uri(box.folders.Inbox[1].id)]);
  });

  it("stops a folder's mark before an email that wasn't read, and reads it next time", async () => {
    const a = inbox('C1', ago(5 * HOUR));
    const b = inbox('C2', ago(4 * HOUR));
    const c = inbox('C3', ago(3 * HOUR));
    box.readFaults.set(FakeMs365.uri(b.id), 'skip');
    const first = await poll(adapter());
    expect(first.items.map((i) => i.id)).toEqual(['outlook:C1', 'outlook:C3']);
    expect(first.nextCursor.split('|')[0]).toBe(a.receivedDateTime.replace('Z', '000Z'));
    box.readFaults.clear();
    const second = await poll(adapter(), first.nextCursor);
    expect(second.items.map((i) => i.id)).toEqual(['outlook:C2']); // C3 is not read twice
    expect(second.nextCursor.split('|')[0]).toBe(c.receivedDateTime.replace('Z', '000Z'));
  });

  it('keeps an email whose read failed for next time, and lets one that is gone pass', async () => {
    const a = inbox('C1', ago(5 * HOUR));
    const b = inbox('C2', ago(4 * HOUR));
    box.readFaults.set(FakeMs365.uri(a.id), 'gone');
    box.readFaults.set(FakeMs365.uri(b.id), 'Service unavailable');
    const r = await poll(adapter());
    expect(r.items).toEqual([]);
    expect(r.nextCursor.split('|')[0]).toBe(a.receivedDateTime.replace('Z', '000Z'));
  });

  it("never reads Outlook's receipts and auto-replies, but moves past them", async () => {
    const e = inbox('C1', ago(5 * HOUR), { subject: 'Accepted: Weekly sync' });
    const r = await poll(adapter());
    expect(box.reads).toEqual([]);
    expect(r.items).toEqual([]);
    expect(r.nextCursor.split('|')[0]).toBe(e.receivedDateTime.replace('Z', '000Z'));
  });

  it('reads at most MAX_READS a poll, oldest first, and the rest on the next', async () => {
    for (let i = 0; i < 70; i++) inbox(`C${String(i).padStart(2, '0')}`, ago(10 * HOUR - i * MIN));
    const first = await poll(adapter());
    expect(box.searches.map((s) => s.map((c) => c.offset))).toEqual([[0, 0], [25], [50]]);
    expect(box.reads.flat()).toHaveLength(MAX_READS);
    expect(first.items).toHaveLength(MAX_READS);
    const second = await poll(adapter(), first.nextCursor);
    expect(second.items.map((i) => i.id)).toEqual(Array.from({ length: 10 }, (_, i) => `outlook:C${60 + i}`));
  });

  it('refuses to poll before it is connected, and passes on a signed-out connector', async () => {
    await expect(poll(adapter({ account: undefined }))).rejects.toMatchObject({ dep: 'ms365', failure: { state: 'auth_failed', reason: 'token_missing' } });
    box.status_ = 'needs-auth';
    await expect(poll(adapter())).rejects.toMatchObject({ dep: 'ms365', failure: { state: 'auth_failed' } });
    expect(await adapter().probe(new AbortController().signal)).toBe('auth_failed');
  });

  it('says who Frank is, from the connected account', () => {
    expect(adapter().identity()).toEqual({ id: FRANK.address, name: FRANK.name });
    expect(adapter({ account: undefined }).identity()).toBeUndefined();
  });

  it('remembers what it read across adapters built from the same factory', async () => {
    inbox('C1', ago(5 * HOUR));
    const make = outlookFactory(box);
    const settings = { ...defaultSettings('/x'), connectors: { ms365: { id: 'mcpsrv_x', account } } };
    const first = await make(settings).fetchSince(undefined, { signal: new AbortController().signal, now: NOW, reason: 'scheduled' });
    await make(settings).fetchSince(first.nextCursor, { signal: new AbortController().signal, now: NOW, reason: 'scheduled' });
    expect(box.reads).toHaveLength(1);
  });
});

describe('the Microsoft 365 relay client (contract)', () => {
  let dir: string;
  let usage: UsageLog;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'work-os-ms365-'));
    usage = await UsageLog.open(dir);
  });
  afterEach(async () => {
    await usage.close();
    await rm(dir, { recursive: true, force: true });
  });

  type Answer = { raw: unknown } | { error: string } | undefined;
  /** Plays the SDK: each call the relay asks for, through canUseTool and the result hooks. */
  const sdk =
    (answer: (tool: string, input: Record<string, unknown>) => Answer, o: { status?: string; assistantError?: string } = {}): QueryFn =>
    ({ prompt, options }) =>
      (async function* () {
        yield { type: 'system', subtype: 'init', mcp_servers: [{ name: 'ms365', status: o.status ?? 'connected' }], tools: ['mcp__ms365__outlook_email_search', 'mcp__ms365__outlook_calendar_search', 'mcp__ms365__read_resource', 'mcp__ms365__get_me'] };
        if (o.assistantError) {
          yield { type: 'assistant', error: o.assistantError, message: { content: [] } };
        } else {
          const tool = /Call (mcp__ms365__\w+)/.exec(prompt)![1];
          const sets = /no arguments/.test(prompt) ? [{}] : [...prompt.matchAll(/(?:arguments: |^\d+\. )(\{.*\})/gm)].map((m) => JSON.parse(m[1].replace(/\.\s*Then.*$/, '')) as Record<string, unknown>);
          const signal = new AbortController().signal;
          for (const input of sets) {
            if ((await options.canUseTool!(tool, input, { signal } as never))?.behavior !== 'allow') continue;
            const a = answer(tool, input);
            if (!a) continue;
            if ('error' in a) await options.hooks!.PostToolUseFailure![0].hooks[0]({ tool_name: tool, tool_input: input, error: a.error } as never, 't', { signal });
            else await options.hooks!.PostToolUse![0].hooks[0]({ tool_name: tool, tool_input: input, tool_response: a.raw } as never, 't', { signal });
          }
        }
        yield { type: 'result', subtype: 'success', result: 'OK', num_turns: 2, total_cost_usd: 0.001, usage: { input_tokens: 1200, output_tokens: 50 } };
      })();
  const relay = (query: QueryFn, id: string | null = 'mcpsrv_test') => {
    const settings = defaultSettings(dir);
    return new Ms365Relay({ claude: new ClaudeAdapter({ usage, settings: () => settings, secrets: memoryKeychain(), cwd: dir, env: { PATH: '/usr/bin' }, query }), connectorId: () => id ?? undefined });
  };
  const text = (v: unknown) => ({ type: 'text', text: JSON.stringify(v) });
  const signal = () => new AbortController().signal;
  const row = (id: string) => ({ uri: `mail:///messages/${id}`, id, subject: 'Hi', sender: 'dana@example.com', recipients: [], receivedDateTime: '2026-10-08T09:00:00Z', summary: 'preview', internetMessageId: `<${id}@x>`, offset: 0 });

  it('searches both folders in one run and reads the paging block', async () => {
    let runs = 0;
    const q: QueryFn = (p) => (runs++, sdk((_t, input) => ({ raw: input.folderName === 'Inbox' ? [text(row('a')), text(row('b')), text({ moreResults: true, nextOffset: 25, totalResultCount: 30 })] : [text({ totalResultCount: 0 })] }))(p));
    const pages = await relay(q).search(
      [
        { folder: 'Inbox', after: '2026-10-06T12:00:00Z', offset: 0 },
        { folder: 'Sent Items', after: '2026-10-06T12:00:00Z', offset: 0 },
      ],
      signal(),
    );
    expect(runs).toBe(1);
    expect(pages).toEqual([{ emails: [expect.objectContaining({ id: 'a' }), expect.objectContaining({ id: 'b' })], nextOffset: 25 }, { emails: [] }]);
    expect(searchPage([text({ totalResultCount: 3 })])).toEqual({ emails: [] });
  });

  it('reads emails, and tells one that is gone from one that failed', async () => {
    const detail: Partial<EmailDetail> = { id: 'a', conversationId: 'C1', receivedDateTime: '2026-10-08T09:00:00Z', body: { contentType: 'html', content: '<p>Hi</p>' } };
    const q = sdk((_t, input) => (input.uri === 'mail:///messages/a' ? { raw: [text(detail)] } : input.uri === 'mail:///messages/b' ? { error: 'ErrorItemNotFound' } : { error: 'Service unavailable' }));
    const out = await relay(q).read(['mail:///messages/a', 'mail:///messages/b', 'mail:///messages/c'], signal());
    expect(out).toEqual([{ ok: true, email: expect.objectContaining({ id: 'a', conversationId: 'C1' }) }, { ok: false, error: 'ErrorItemNotFound', gone: true }, { ok: false, error: 'Service unavailable', gone: false }]);
  });

  it('reports a read the connector answered in another shape as the tools having changed', async () => {
    const q = sdk(() => ({ raw: [text({ id: 'a', subject: 'no conversation id' })] }));
    await expect(relay(q).read(['mail:///messages/a'], signal())).rejects.toMatchObject({ dep: 'ms365', failure: { state: 'degraded', reason: 'tools_changed' } });
  });

  it("charges the connector's trouble to ms365 and Claude's to claude", async () => {
    const signedOut = await relay(sdk(() => undefined, { status: 'needs-auth' }))
      .me(signal())
      .catch((e: unknown) => e);
    expect(signedOut).toBeInstanceOf(SourceError);
    expect(signedOut).toMatchObject({ dep: 'ms365', failure: { state: 'auth_failed' } });
    const login = await relay(sdk(() => undefined, { assistantError: 'authentication_failed' }))
      .me(signal())
      .catch((e: unknown) => e);
    expect(login).toMatchObject({ dep: 'claude', failure: { state: 'auth_failed' } });
    await expect(relay(sdk(() => undefined), null).me(signal())).rejects.toMatchObject({ dep: 'ms365', failure: { reason: 'token_missing' } });
  });

  it('searches the calendar by start time, oldest first, and reads its paging block (P0-12)', async () => {
    const asked: Record<string, unknown>[] = [];
    const ev = (id: string) => ({ uri: `calendar:///events/${id}`, id, subject: 'Sync', organizer: 'dana@example.com', attendees: null, start: { dateTime: '2026-10-09T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-09T15:00:00.0000000', timeZone: 'UTC' }, showAs: 'busy', recurrence: null });
    const q = sdk((_t, input) => (asked.push(input), { raw: [text(ev('e1')), text(ev('e2')), text({ moreResults: true, nextOffset: 25, totalResultCount: 31 })] }));
    const pages = await relay(q).events([{ after: '2026-10-06T23:00:00.000Z', before: '2026-10-22T23:00:00.000Z', offset: 0 }], signal());
    expect(asked).toEqual([{ query: '*', afterDateTime: '2026-10-06T23:00:00.000Z', beforeDateTime: '2026-10-22T23:00:00.000Z', order: 'oldest', limit: 25, offset: 0 }]);
    expect(pages).toEqual([{ events: [expect.objectContaining({ id: 'e1', attendees: null }), expect.objectContaining({ id: 'e2' })], nextOffset: 25, total: 31 }]);
    expect(eventPage([text({ moreResults: false, totalResultCount: 0 })])).toEqual({ events: [], total: 0 });
  });

  it('reads events whole, and tells one that is gone from one that failed', async () => {
    const detail = { id: 'e1', subject: 'Sync', start: { dateTime: '2026-10-09T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-10-09T15:00:00.0000000', timeZone: 'UTC' }, attendees: [{ name: 'Frank', address: 'frank@example.com', type: 'required', responseStatus: 'none' }] };
    const q = sdk((_t, input) => (input.uri === 'calendar:///events/e1' ? { raw: [text(detail)] } : { error: 'ErrorItemNotFound' }));
    const out = await relay(q).readEvents(['calendar:///events/e1', 'calendar:///events/e2'], signal());
    expect(out).toEqual([{ ok: true, event: expect.objectContaining({ id: 'e1', attendees: [expect.objectContaining({ responseStatus: 'none' })] }) }, { ok: false, error: 'ErrorItemNotFound', gone: true }]);
  });

  it('asks get_me with no arguments, and reads the account', async () => {
    const me = await relay(sdk(() => ({ raw: [text({ id: 'u1', displayName: 'Frank Keulers', mail: 'frank@example.com', userPrincipalName: 'frank@example.com', jobTitle: 'x' })] }))).me(signal());
    expect(me).toMatchObject({ displayName: 'Frank Keulers', mail: 'frank@example.com' });
  });
});

describe('Outlook Connect: finding and testing the connector (R2.5)', () => {
  const signal = new AbortController().signal;

  it('reads the account as a lower-case address, the name falling back to it', () => {
    expect(accountOf({ displayName: ' Frank Keulers ', mail: 'Frank.Keulers@Example.com', userPrincipalName: 'FK@example.onmicrosoft.com' })).toEqual({ name: 'Frank Keulers', address: 'frank.keulers@example.com', upn: 'fk@example.onmicrosoft.com' });
    expect(accountOf({ mail: null, userPrincipalName: 'fk@example.com' })).toEqual({ name: 'fk@example.com', address: 'fk@example.com' });
    expect(() => accountOf({ displayName: 'Frank' })).toThrow(Ms365LinkError);
  });

  it('says where to add the connector when claude.ai has none, and to reconnect a signed-out one', async () => {
    const fake = new FakeMs365();
    const none = ms365Link(() => Object.assign(Object.create(fake) as FakeMs365, { discover: async () => undefined }));
    await expect(none.connect(undefined, signal)).rejects.toThrow(/Couldn’t find the Microsoft 365 connector/);
    fake.status_ = 'needs-auth';
    await expect(ms365Link(() => fake).connect(undefined, signal)).rejects.toThrow(/signed out\. Reconnect it on claude\.ai/);
  });

  it('a Claude failure is named as Claude’s, a connector that doesn’t answer as the connector’s', async () => {
    const fake = new FakeMs365();
    const failing = (err: Error) => ms365Link(() => Object.assign(Object.create(fake) as FakeMs365, { me: async () => Promise.reject(err) }));
    await expect(failing(new SourceError('claude', { state: 'auth_failed', reason: 'login' }, 'Claude: not logged in')).connect(undefined, signal)).rejects.toThrow(/Claude can’t be called right now \(Claude: not logged in\)/);
    await expect(failing(new SourceError('ms365', { state: 'degraded', reason: 'timeout' }, 'Microsoft 365: timed out')).connect(undefined, signal)).rejects.toThrow(/connector didn’t answer \(Microsoft 365: timed out\)/);
    // Anything else is a bug: left as it is.
    await expect(failing(new TypeError('boom')).connect(undefined, signal)).rejects.toThrow(TypeError);
  });
});
