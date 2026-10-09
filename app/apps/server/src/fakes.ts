import { realpathSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { londonAt } from '@work-os/shared';
import { z } from 'zod';
import { tokenAccount } from './api/auth';
import { fakeClaude } from './claude/fakeClaude';
import type { RuntimeConfig } from './config/env';
import { CONFLUENCE_TOKEN_ACCOUNT, memoryKeychain, SLACK_TOKEN_ACCOUNT } from './config/keychain';
import { FAKE_CONFLUENCE_CREDS, FakeConfluence } from './actions/fakeConfluence';
import type { Exec } from './runtime/checks';
import { calendarFactory } from './sources/calendar/adapter';
import { CalendarStore } from './sources/calendar/store';
import { FakeMs365, fakeEmail, fakeEvent } from './sources/ms365/fakeMs365';
import { ms365Link } from './sources/ms365/link';
import { outlookFactory } from './sources/outlook/adapter';
import { slackFactory } from './sources/slack/adapter';
import { SlackApi } from './sources/slack/api';
import { SlackDirectory } from './sources/slack/directory';
import { FakeSlack } from './sources/slack/fakeSlack';
import { isoToTs } from './sources/slack/normalise';
import { wisprFactory } from './sources/wispr/adapter';
import { FakeWispr } from './sources/wispr/fakeWispr';
import { fakeWisprLink } from './sources/wispr/link';
import { WisprMcp } from './sources/wispr/mcp';

// `server.mjs --fakes` (M1 step 11): the real server against a made-up Slack workspace, for the
// e2e:server tests. Never near real data: refused unless dry-run is forced (the dev instance) and
// the data directory is under the system temp folder. The Keychain is an in-memory one, and Claude
// is a keyword-matching fake: no live calls.

export const FAKE_API_TOKEN = 'workos-fakes-token-0123456789abcdefghijklmnop';

/** Why fakes may not run with this config, or undefined if they may. */
export function fakesRefusal(config: RuntimeConfig): string | undefined {
  if (!config.forceDryRun) return '--fakes runs only on the development instance, where dry-run is forced.';
  const tmp = realpathSync(tmpdir());
  let dir = config.dataDir;
  // The data directory may not exist yet: check the nearest folder that does.
  for (;;) {
    try {
      dir = realpathSync(dir);
      break;
    } catch {
      const up = dirname(dir);
      if (up === dir) break;
      dir = up;
    }
  }
  if (!(dir + sep).startsWith(tmp + sep)) return `--fakes needs a data directory under ${tmp}, not ${config.dataDir}.`;
  return undefined;
}

const RespondBody = z.object({ eventId: z.string().min(1), response: z.enum(['accepted', 'tentativelyAccepted', 'declined', 'none']) }).strict();
const PostBody = z.object({ channel: z.string(), text: z.string(), user: z.string().default('U02DANA'), threadTs: z.string().optional() }).strict();
const Person = z.object({ name: z.string(), address: z.string() });
const EmailBody = z
  .object({ subject: z.string(), text: z.string(), conversation: z.string().optional(), from: Person.default({ name: 'Dana Lee', address: 'dana.lee@polestar.example' }) })
  .strict();

export function fakeWorld(now: Date) {
  const slack = new FakeSlack();
  const at = (minsAgo: number) => isoToTs(now.getTime() - minsAgo * 60_000);
  slack.users.set('U02DANA', 'Dana Lee').set('U03SAM', 'Sam Okafor').set('U04MATT', 'Matt M.');
  slack.channel({ id: 'C01PROD', name: 'product' }).channel({ id: 'C02LAUNCH', name: 'mvi-launch' }).channel({ id: 'D01MATT', is_im: true, user: 'U04MATT' });
  const p = at(95);
  slack
    .post('C01PROD', { ts: p, user: 'U02DANA', text: 'Release notes draft for 3.4 is up. Can someone check the ETA wording?' })
    .post('C01PROD', { ts: at(80), thread_ts: p, user: 'U03SAM', text: 'Looks fine to me apart from the port-call line.' })
    .post('C02LAUNCH', { ts: at(40), user: 'U03SAM', text: 'Launch checklist is green apart from the data-licensing wording.' })
    .post('D01MATT', { ts: at(25), user: 'U04MATT', text: 'Morning Frank. Go/no-go on MVI V2 before Thursday?' });

  const confluence = new FakeConfluence(FAKE_CONFLUENCE_PAGE.spaceKey)
    .page(FAKE_CONFLUENCE_PAGE.root.id, FAKE_CONFLUENCE_PAGE.root.title, '<p>Index of the MVI context pages.</p>')
    .page(
      FAKE_CONFLUENCE_PAGE.id,
      FAKE_CONFLUENCE_PAGE.title,
      '<h1>MVI V2</h1><p>Product requirements.</p><h2>Decisions</h2><ul><li>Bulk export ships first.</li></ul><h2>Open questions</h2><p>Pricing tiers.</p>',
      7,
      { parent: FAKE_CONFLUENCE_PAGE.root.id },
    );
  const secrets = memoryKeychain({ [SLACK_TOKEN_ACCOUNT]: slack.token, [tokenAccount('dev')]: FAKE_API_TOKEN, [CONFLUENCE_TOKEN_ACCOUNT]: FAKE_CONFLUENCE_CREDS });
  const directory = new SlackDirectory(new SlackApi(secrets, slack.fetch));
  // FileVault on, Power Nap off: the checks pass, so the UI starts in normal mode.
  const exec: Exec = async (cmd) => ({ code: 0, stdout: cmd.endsWith('fdesetup') ? 'FileVault is On.\n' : ' powernap 0\n' });

  // Wispr Flow: two finished meetings, not connected until Connect in Settings (R2.7).
  const wispr = new FakeWispr();
  wispr.signedIn = false;
  const iso = (minsAgo: number) => new Date(now.getTime() - minsAgo * 60_000).toISOString().replace('Z', '000Z');
  wispr
    .add({
      id: '5f0c1e2a-0000-4000-8000-000000000001',
      title: 'MVI V2 launch readiness',
      start: iso(150),
      end: iso(120),
      modified_at: iso(118),
      summary: '### Context and Goals\n- Confirm MVI V2 is ready to launch on Thursday.\n\n### Next Steps\n- Frank to confirm the rollback owner by Wednesday.\n- Sam to share the support briefing.\n\n### Decisions Made\n- Launch stays on Thursday if the licensing wording is signed off.',
      content: 'Check the data-licensing wording with Legal.',
      transcript: 'Frank: Are we still on for Thursday?\nSam Okafor: Yes, apart from the licensing wording.\nFrank: I will confirm the rollback owner by Wednesday.',
      participants: [{ name: 'Sam Okafor', is_self: false, spoke: true, relationship: 'colleague' }],
    })
    .add({
      id: '5f0c1e2a-0000-4000-8000-000000000002',
      title: 'Insights APIs roadmap',
      start: iso(300),
      end: iso(270),
      modified_at: iso(268),
      summary: '### Discussion\n- Webhooks for vessel events were discussed.\n\n### Decisions Made\n- Vessel-event webhooks move to v2.1; v2.0 ships with polling only.',
      participants: [{ name: 'Dana Lee', is_self: false, spoke: true, relationship: 'colleague' }],
    });
  const wisprMcp = new WisprMcp(wispr.connector);

  // Outlook: two conversations, one with Frank's reply in Sent Items. The connector is signed in on
  // the (fake) claude.ai, but Work OS isn't connected to it until Connect in Settings (R2.5).
  const ms365 = new FakeMs365({ me: { displayName: 'Frank Keulers', mail: 'frank.keulers@polestar.example', userPrincipalName: 'frank.keulers@polestar.example' } });
  const frank = { name: 'Frank Keulers', address: 'frank.keulers@polestar.example' };
  const dana = { name: 'Dana Lee', address: 'dana.lee@polestar.example' };
  const sam = { name: 'Sam Okafor', address: 'sam.okafor@polestar.example' };
  const minsAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();
  ms365.deliver(
    'Inbox',
    fakeEmail({
      conversation: 'AAQkFAKECONVNORDICSTAR',
      subject: 'Nordic Star port call: revised ETA',
      from: { name: 'Ingrid Berg', address: 'ingrid.berg@nordicshipping.example' },
      to: [frank],
      cc: [sam],
      at: minsAgo(70),
      html: '<div><p>Hi Frank,</p><p>The port authority has moved our berth window to Friday 06:00. Could you check the revised ETA shows in MVI?</p><p>Thanks,<br>Ingrid</p></div>',
    }),
  );
  ms365.deliver('Inbox', fakeEmail({ conversation: 'AAQkFAKECONVPRICING', subject: 'MVI V2 pricing tiers', from: dana, to: [frank], at: minsAgo(45), html: '<p>Frank, here are the three pricing tiers we discussed. They are ready for the board pack.</p>' }));
  ms365.deliver('Sent Items', fakeEmail({ conversation: 'AAQkFAKECONVPRICING', subject: 'RE: MVI V2 pricing tiers', from: frank, to: [dana], at: minsAgo(30), html: '<p>Thanks Dana, these look right. I’ll add them to the pack.</p>' }));

  // Outlook Calendar (R2.8): the meeting Wispr Flow took notes in, which Frank accepted; an
  // unanswered invite from a customer for tomorrow; and Frank's own weekly meeting.
  const ingrid = { name: 'Ingrid Berg', address: 'ingrid.berg@nordicshipping.example' };
  const calendar = CalendarStore.memory();
  ms365.calendar.push(
    fakeEvent({ id: 'AAMkFAKEEVENTLAUNCH', subject: 'MVI V2 launch readiness', organizer: sam, attendees: [{ ...frank, response: 'accepted' }, { ...dana, response: 'accepted' }], start: minsAgo(150), end: minsAgo(120), created: minsAgo(3 * 1440), categories: ['Product'] }),
    fakeEvent({
      id: 'AAMkFAKEEVENTNORDIC',
      subject: 'Nordic Star renewal review',
      organizer: ingrid,
      attendees: [{ ...frank }, { ...sam, type: 'optional' }],
      start: londonAt(now, '14:00', 1),
      end: londonAt(now, '15:00', 1),
      created: minsAgo(50),
      categories: ['Customer'],
      html: '<p>Hi Frank,</p><p>Ahead of the renewal, could we walk through the fleet coverage and the new port-call alerts?</p><p>Ingrid</p><p>________________________________________________________________________________</p><p>Microsoft Teams meeting</p><p>Meeting ID: 123 456 789 0</p><p>Passcode: AbC123</p>',
    }),
    fakeEvent({ id: 'AAMkFAKEEVENTWEEKLY', subject: 'Product weekly', organizer: frank, attendees: [{ ...frank, response: 'organizer' }, { ...dana }, { ...sam }], start: londonAt(now, '16:00'), end: londonAt(now, '16:30'), created: minsAgo(30 * 1440) }),
  );

  /** POST /api/fake/slack/messages: a new message in the fake workspace, for tests. */
  const routes = (app: FastifyInstance) => {
    app.post('/api/fake/slack/messages', async (req, reply) => {
      const b = PostBody.parse(req.body);
      const ts = isoToTs(Date.now());
      slack.post(b.channel, { ts, user: b.user, text: b.text, ...(b.threadTs && { thread_ts: b.threadTs }) });
      return reply.code(201).send({ ts });
    });
    /** POST /api/fake/outlook/messages: a new email in the fake Inbox, for tests. */
    app.post('/api/fake/outlook/messages', async (req, reply) => {
      const b = EmailBody.parse(req.body);
      const e = fakeEmail({ conversation: b.conversation ?? `AAQkFAKECONV${Date.now()}`, subject: b.subject, from: b.from, to: [frank], at: new Date().toISOString(), html: `<p>${b.text.replace(/[<&]/g, (c) => (c === '<' ? '&lt;' : '&amp;'))}</p>` });
      ms365.deliver('Inbox', e);
      return reply.code(201).send({ id: e.id, conversation: e.conversationId });
    });
    /** POST /api/fake/calendar/respond: Frank answers an invite in Outlook, for tests. */
    app.post('/api/fake/calendar/respond', async (req, reply) => {
      const b = RespondBody.parse(req.body);
      ms365.answer(b.eventId, b.response);
      return reply.code(204).send();
    });
  };

  return { slack, wispr, confluence, secrets, exec, fetch: slack.fetch, confluenceFetch: confluence.fetch, sources: { slack: slackFactory(directory), outlook: outlookFactory(ms365), calendar: calendarFactory(ms365, calendar), wispr: wisprFactory(wisprMcp) }, wisprLink: fakeWisprLink(wispr), ms365, outlookLink: ms365Link((id) => ms365.forId(id)), calendar, claude: fakeClaude().query, routes };
}

/** When the fake world began: the first start in this data dir, kept in fake-world.json. */
export async function fakeAnchor(dataDir: string, now: Date): Promise<Date> {
  const file = join(dataDir, 'fake-world.json');
  try {
    return new Date((JSON.parse(await readFile(file, 'utf8')) as { anchor: string }).anchor);
  } catch {
    await mkdir(dataDir, { recursive: true });
    await writeFile(file, JSON.stringify({ anchor: now.toISOString() }));
    return now;
  }
}

/** The one page in scope in a `--fakes` run, under its root on a made-up site. */
export const FAKE_CONFLUENCE_PAGE = { id: '1234567', title: 'MVI V2 PRD', siteUrl: 'https://fake-workos.atlassian.net', spaceKey: 'MVI', root: { id: '1100000', title: 'MVI Context' } };

/** A made-up vault inside the temp data directory, so `--fakes` never reads or writes the real one. */
export async function seedFakeVault(dir: string) {
  await mkdir(join(dir, 'Projects'), { recursive: true });
  await writeFile(join(dir, 'Projects/MVI V2.md'), '---\ntags: [mvi]\n---\n# MVI V2\n\n## Decisions\n\n- Bulk export ships first.\n', { flag: 'wx' }).catch(() => undefined);
}
