import { readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { Attention, EventDraft, Item, LoggedDecision } from '@work-os/shared';
import { initDataDir } from '../config/dataDir';
import { DEFAULT_RULES, defaultSettings } from '../config/defaults';
import { isoToTs } from '../sources/slack/normalise';
import { ItemFiles } from '../store/items';
import { Store } from '../store/store';

// Synthetic history for performance work (PLAN.md NF-11): about 60 Slack items a day with replies,
// decisions, opens, dones and snoozes, plus a poll every 10 minutes in work hours. Made-up text
// only. Events are appended an hour at a time, through the real store, so the log, snapshot and
// item files look like a real data directory's.

const CHANNELS = ['product', 'mvi-launch', 'apidog-migration', 'pole-star-labs', 'eng-platform', 'sales-emea', 'ext-pilot-alpha', 'design', 'data-licensing', 'support-escalations'];
const PEOPLE = Array.from({ length: 40 }, (_, i) => ({ id: `U${String(i + 10).padStart(4, '0')}`, name: `Person ${i + 1}` }));
const WORDS = 'the release notes draft port call eta confidence bulk export pilot customer licence wording sign off blocker review checklist deadline api portal dns change ticket approve decision meeting agenda follow up thursday board pack numbers'.split(' ');
const HOUR = 3600_000;

export const SYNTHETIC_MARKER = '.workos-synthetic';

/** Why synthetic data may not go into this directory, or undefined if it may: never a real data
 * directory, and never one with anything in it. */
export async function targetProblem(dir: string, home = homedir()): Promise<string | undefined> {
  const abs = resolve(dir);
  const app = resolve(home, 'Library/Application Support/WorkOS');
  if (abs.startsWith(resolve(home, 'WorkOS-data')) || abs === app || abs.startsWith(app + sep))
    return `${abs} looks like a real Work OS data directory. Choose a new folder.`;
  const entries = await readdir(abs).catch(() => [] as string[]);
  if (entries.length) return `${abs} is not empty. Choose a new folder.`;
  return undefined;
}

/** A small seeded random generator, so runs are comparable. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GenOptions {
  days: number;
  now?: Date;
  itemsPerDay?: number;
  seed?: number;
}

export interface GenResult {
  items: number;
  events: number;
  ms: number;
}

export async function generate(dataDir: string, o: GenOptions): Promise<GenResult> {
  const t0 = performance.now();
  const r = rng(o.seed ?? 42);
  const pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const text = (n: number) => Array.from({ length: n }, () => pick(WORDS)).join(' ');
  const end = (o.now ?? new Date()).getTime();
  const start = end - o.days * 24 * HOUR;
  const perDay = o.itemsPerDay ?? 60;

  const problem = await targetProblem(dataDir);
  if (problem) throw new Error(problem);
  await initDataDir(dataDir, { settings: defaultSettings(dataDir), rules: DEFAULT_RULES });
  await writeFile(join(dataDir, SYNTHETIC_MARKER), 'Made by npm run gen-data: synthetic text only.\n');
  let clock = start;
  const { store } = await Store.open({ dataDir, now: () => new Date(clock) });
  const files = new ItemFiles(join(dataDir, 'items'));

  // Everything that happens, by the hour it happens in.
  const hours = new Map<number, EventDraft[]>();
  const at = (ms: number, e: EventDraft) => {
    if (ms > end) return;
    const h = Math.floor(ms / HOUR);
    const list = hours.get(h);
    if (list) list.push(e);
    else hours.set(h, [e]);
  };

  let itemCount = 0;
  for (let day = 0; day < o.days; day++) {
    const dayStart = start + day * 24 * HOUR;
    for (let k = 0; k < perDay; k++) {
      const first = Math.floor(dayStart + (7 + r() * 12) * HOUR); // 07:00–19:00, whole ms like Slack's ts
      if (first > end - 5 * 60_000) continue;
      const channel = pick(CHANNELS);
      const dm = r() < 0.2;
      const cid = dm ? `D${String(k).padStart(6, '0')}` : `C${CHANNELS.indexOf(channel).toString().padStart(6, '0')}`;
      const ts = isoToTs(first);
      const id = `slack:${cid}:${ts}`;
      const people = [pick(PEOPLE), pick(PEOPLE), pick(PEOPLE)];
      const revisions = 1 + Math.floor(r() * 4);
      let msgAt = first;
      const messages: Item['messages'] = [];
      let revision = 0;
      for (let rev = 1; rev <= revisions; rev++) {
        for (let m = 0; m < 1 + Math.floor(r() * 3); m++) {
          messages.push({ id: isoToTs(msgAt), authorId: pick(people).id, ts: new Date(msgAt).toISOString(), text: text(12 + Math.floor(r() * 30)) });
          msgAt += Math.floor((2 + r() * 40) * 60_000);
        }
        if (Date.parse(messages.at(-1)!.ts) + 12 * 60_000 > end) break;
        revision = rev;
        const last = messages.at(-1)!.ts;
        at(Date.parse(last) + 60_000, {
          type: 'item.upserted',
          itemId: id,
          data: { source: 'slack', kind: dm ? 'dm' : 'thread', title: dm ? people[0].name : `#${channel}`, permalink: `https://polestar.slack.com/archives/${cid}/p${ts.replace('.', '')}`, participants: people, lastActivityAt: last, revision: rev, messageCount: messages.length, fromMeOnly: false },
        });
        const attention: Attention = r() < 0.1 ? 'now' : r() < 0.4 ? 'today' : 'none';
        const decision: LoggedDecision = { itemId: id, itemRevision: rev, attention, confluence: { suggested: r() < 0.1 }, vault: { suggested: r() < 0.2 }, containsPeopleObservations: false, decidedBy: r() < 0.3 ? 'rule' : 'model', decidedAt: new Date(Date.parse(last) + 12 * 60_000).toISOString() };
        at(Date.parse(last) + 12 * 60_000, { type: 'triage.decided', itemId: id, data: { decision } });
        if (r() < 0.7) at(Date.parse(last) + 30 * 60_000, { type: 'item.seen', itemId: id, data: undefined });
      }
      if (!revision) continue;
      while (Date.parse(messages.at(-1)!.ts) + 12 * 60_000 > end) messages.pop();
      const lastAt = Date.parse(messages.at(-1)!.ts);
      if (r() < 0.05) {
        const until = lastAt + 20 * HOUR;
        at(lastAt + HOUR, { type: 'item.snoozed', itemId: id, data: { until: new Date(until).toISOString() } });
        if (until < end) at(until, { type: 'item.unsnoozed', itemId: id, data: undefined });
      }
      // Most items older than two days are done.
      if (end - lastAt > 48 * HOUR ? r() < 0.92 : r() < 0.3) at(Math.min(end - 60_000, lastAt + (1 + r() * 20) * HOUR), { type: 'item.done', itemId: id, data: undefined });
      await files.write({ item: { id, source: 'slack', kind: dm ? 'dm' : 'thread', title: dm ? people[0].name : `#${channel}`, permalink: `https://polestar.slack.com/archives/${cid}/p${ts.replace('.', '')}`, participants: people, messages, messageCount: messages.length, lastActivityAt: messages.at(-1)!.ts, revision, schemaVersion: 1 }, text: { summary: text(10), reason: text(6) }, schemaVersion: 1 });
      itemCount++;
    }
    // Polls: every 10 minutes 08:00–18:30, hourly otherwise.
    for (let m = 0; m < 24 * 60; m += 10) {
      const t = dayStart + m * 60_000;
      const h = m / 60;
      if (t > end || (!(h >= 8 && h < 18.5) && m % 60)) continue;
      at(t, { type: 'source.polled', data: { source: 'slack', reason: 'scheduled', fetched: Math.floor(r() * 4), cursor: isoToTs(t), durationMs: 300 + Math.floor(r() * 900) } });
    }
  }

  let events = 0;
  for (const h of [...hours.keys()].sort((a, b) => a - b)) {
    clock = Math.min(end, (h + 1) * HOUR - 1);
    // An upsert must come before its item's other events within the hour.
    const batch = hours.get(h)!.sort((a, b) => Number(b.type === 'item.upserted') - Number(a.type === 'item.upserted'));
    await store.append(...batch);
    events += batch.length;
  }
  clock = end;
  await store.close();
  return { items: itemCount, events, ms: Math.round(performance.now() - t0) };
}
