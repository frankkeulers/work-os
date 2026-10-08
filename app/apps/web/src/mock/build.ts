import type { Attention, EventData, EventType, Item, Message, TriageDecision, WorkEvent } from '@work-os/shared';
import type { ItemRec, ScriptedDecision, SeedMessage, ThreadSeed } from './types';
import { CHANNELS, PEOPLE, WISPR_SUMMARY } from './seed/people';

export const MIN = 60_000;

export const addMins = (iso: string, mins: number) => new Date(Date.parse(iso) + mins * MIN).toISOString();

export const slackTs = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;

export const permalinkFor = (channelId: string, ts: string) =>
  `https://polestarglobal.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;

const OUTLOOK = 'https://outlook.office.com/mail/inbox/id/';
const TEAMS = 'https://teams.microsoft.com/l/';
const WISPR = 'https://wisprflow.ai/m/';
const CALENDAR = 'https://outlook.office.com/calendar/';

export const titleFor = (seed: ThreadSeed) => seed.title || CHANNELS[seed.channelId] || seed.channelId;

export function toMessages(seedMsgs: SeedMessage[], clock: string, idPrefix: string): Message[] {
  return seedMsgs.map((m, i) => ({
    id: `${idPrefix}-m${i + 1}`,
    authorId: m.by,
    ts: addMins(clock, -m.minsAgo),
    text: m.text,
    ...(m.to && { to: m.to }),
    ...(m.cc && { cc: m.cc }),
  }));
}

export function makeItem(seed: ThreadSeed, clock: string, uniq = ''): Item {
  const messages = toMessages(seed.messages, clock, seed.key + uniq);
  const first = messages[0]?.ts ?? clock;
  const ts = slackTs(first);
  // Authors first, then an email's recipients, so To and Cc show names.
  const authorIds = [...new Set(messages.flatMap((m) => [m.authorId, ...(m.to ?? []), ...(m.cc ?? [])]))].filter((id) => id !== WISPR_SUMMARY);
  const source = seed.source ?? 'slack';
  const ref = `${seed.channelId}-${ts.replace('.', '')}`;
  return {
    id: `${source}:${seed.channelId}:${ts}`,
    source,
    kind: seed.kind,
    title: titleFor(seed),
    permalink:
      source === 'outlook'
        ? `${OUTLOOK}${ref}`
        : source === 'teams'
          ? `${TEAMS}${seed.kind === 'meeting' ? 'meetingrecap' : 'chat'}/${ref}`
          : source === 'wispr'
            ? `${WISPR}${ref}`
            : source === 'calendar'
              ? (seed.meeting?.calendar?.link ?? CALENDAR)
              : permalinkFor(seed.channelId, ts),
    participants: authorIds.map((id) => ({ id, name: PEOPLE[id] ?? id })),
    messages,
    messageCount: seed.messageCount ?? messages.length,
    lastActivityAt: messages[messages.length - 1]?.ts ?? clock,
    ...(seed.thread && { thread: true }),
    ...(seed.meeting && { meeting: seed.meeting }),
    revision: 1,
    schemaVersion: 1,
  };
}

export function newRec(seed: ThreadSeed, clock: string, uniq = ''): ItemRec {
  const item = makeItem(seed, clock, uniq);
  return {
    key: seed.key + uniq,
    item,
    status: 'open',
    triageState: 'pending',
    newReplies: false,
    backFromSnooze: false,
    failCount: 0,
    notified: false,
    routed: false,
    topicVersion: 0,
    arrivedAt: clock,
    script: seed.decision,
    failTriage: seed.failTriage ?? 0,
    drafts: seed.drafts,
    ...(seed.topic && { topicKey: seed.topic }),
    ...(seed.regroupWith && { regroupKey: seed.regroupWith }),
  };
}

/** Where a mock record keeps its activity time, for the shared topic rules. */
export const recActivity = (r: ItemRec) => r.item;

const RANK: Record<Attention, number> = { none: 0, today: 1, now: 2 };
export const atLeast = (a: Attention, min?: Attention): Attention => (min && RANK[min] > RANK[a] ? min : a);

export function buildDecision(
  rec: ItemRec,
  at: string,
  by: { kind: 'rule'; ruleId: string; attention: Attention } | { kind: 'model'; batchId: string; ruleId?: string; min?: Attention; file?: boolean; model: string },
  script: ScriptedDecision = rec.script,
): TriageDecision {
  const base = {
    itemId: rec.item.id,
    itemRevision: rec.item.revision,
    topicVersion: rec.topicVersion,
    containsPeopleObservations: !!script.people,
    summary: script.summary,
    decidedAt: at,
  };
  if (by.kind === 'rule') {
    // Rules fix attention and skip the model, so they suggest no filing (FR-4.2).
    return {
      ...base,
      attention: by.attention,
      confluence: { suggested: false },
      vault: { suggested: false },
      reason: script.reason,
      decidedBy: 'rule',
      ruleId: by.ruleId,
    };
  }
  // Confluence is never suggested for people observations (NF-2).
  const confluence = script.confluence && !script.people ? { suggested: true, targetHint: script.confluence } : { suggested: false };
  // A To file rule: attention None, and the vault when the model suggested no destination.
  const vault = script.vault ? { suggested: true, targetHint: script.vault } : { suggested: !!by.file && !confluence.suggested };
  return {
    ...base,
    attention: by.file ? 'none' : atLeast(script.attention, by.min),
    confluence,
    vault,
    reason: script.reason,
    next: script.next,
    decidedBy: 'model',
    ruleId: by.ruleId,
    model: by.model,
    promptVersion: 'triage v3',
    batchId: by.batchId,
  };
}

export type EventIds = { itemId?: string; actionId?: string };

export function makeEvent<T extends EventType>(seq: number, type: T, at: string, data: EventData<T>, ids: EventIds = {}): WorkEvent {
  return { seq, id: `ev-${seq}`, type, at, ...ids, data, schemaVersion: 1 } as WorkEvent;
}

/** item.upserted payload: the item's metadata, never message bodies. */
export const upserted = (item: Item, fromMeOnly: boolean): EventData<'item.upserted'> => ({
  source: item.source,
  kind: item.kind,
  title: item.title,
  permalink: item.permalink,
  participants: item.participants,
  lastActivityAt: item.lastActivityAt,
  revision: item.revision,
  messageCount: item.messageCount,
  fromMeOnly,
});
