import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tokenAccount } from './api/auth';
import type { RuntimeConfig } from './config/env';
import { memoryKeychain, SLACK_TOKEN_ACCOUNT } from './config/keychain';
import type { Exec } from './runtime/checks';
import { slackFactory } from './sources/slack/adapter';
import { SlackApi } from './sources/slack/api';
import { SlackDirectory } from './sources/slack/directory';
import { FakeSlack } from './sources/slack/fakeSlack';
import { isoToTs } from './sources/slack/normalise';

// `server.mjs --fakes` (M1 step 11): the real server against a made-up Slack workspace, for the
// e2e:server tests. Never near real data: refused unless dry-run is forced (the dev instance) and
// the data directory is under the system temp folder. The Keychain is an in-memory one.

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

const PostBody = z.object({ channel: z.string(), text: z.string(), user: z.string().default('U02DANA'), threadTs: z.string().optional() }).strict();

export function fakeWorld(now: Date) {
  const slack = new FakeSlack();
  const at = (minsAgo: number) => isoToTs(now.getTime() - minsAgo * 60_000);
  slack.users.set('U02DANA', 'Dana Lee').set('U03SAM', 'Sam Okafor').set('U04MATT', 'Matt M.');
  slack
    .channel({ id: 'C01PROD', name: 'product' })
    .channel({ id: 'C02LAUNCH', name: 'mvi-launch' })
    .channel({ id: 'D01MATT', is_im: true, user: 'U04MATT' });
  const p = at(95);
  slack
    .post('C01PROD', { ts: p, user: 'U02DANA', text: 'Release notes draft for 3.4 is up. Can someone check the ETA wording?' })
    .post('C01PROD', { ts: at(80), thread_ts: p, user: 'U03SAM', text: 'Looks fine to me apart from the port-call line.' })
    .post('C02LAUNCH', { ts: at(40), user: 'U03SAM', text: 'Launch checklist is green apart from the data-licensing wording.' })
    .post('D01MATT', { ts: at(25), user: 'U04MATT', text: 'Morning Frank. Go/no-go on MVI V2 before Thursday?' });

  const secrets = memoryKeychain({ [SLACK_TOKEN_ACCOUNT]: slack.token, [tokenAccount('dev')]: FAKE_API_TOKEN });
  const directory = new SlackDirectory(new SlackApi(secrets, slack.fetch));
  // FileVault on, Power Nap off: the checks pass, so the UI starts in normal mode.
  const exec: Exec = async (cmd) => ({ code: 0, stdout: cmd.endsWith('fdesetup') ? 'FileVault is On.\n' : ' powernap 0\n' });

  /** POST /api/fake/slack/messages: a new message in the fake workspace, for tests. */
  const routes = (app: FastifyInstance) => {
    app.post('/api/fake/slack/messages', async (req, reply) => {
      const b = PostBody.parse(req.body);
      const ts = isoToTs(Date.now());
      slack.post(b.channel, { ts, user: b.user, text: b.text, ...(b.threadTs && { thread_ts: b.threadTs }) });
      return reply.code(201).send({ ts });
    });
  };

  return { slack, secrets, exec, fetch: slack.fetch, sources: { slack: slackFactory(directory) }, routes };
}
