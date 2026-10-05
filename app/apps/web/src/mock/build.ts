import type { Attention, Item, Message, TriageDecision, WorkEvent } from '@work-os/shared';
import type { ItemRec, ScriptedDecision, SeedMessage, ThreadSeed } from './types';
import { CHANNELS, PEOPLE } from './seed/people';

export const MIN = 60_000;

export const addMins = (iso: string, mins: number) => new Date(Date.parse(iso) + mins * MIN).toISOString();

export const slackTs = (iso: string) => `${Math.floor(Date.parse(iso) / 1000)}.000100`;

export const permalinkFor = (channelId: string, ts: string) =>
  `https://polestarglobal.slack.com/archives/${channelId}/p${ts.replace('.', '')}`;

export const titleFor = (seed: ThreadSeed) => seed.title || CHANNELS[seed.channelId] || seed.channelId;

export function toMessages(seedMsgs: SeedMessage[], clock: string, idPrefix: string): Message[] {
  return seedMsgs.map((m, i) => ({
    id: `${idPrefix}-m${i + 1}`,
    authorId: m.by,
    ts: addMins(clock, -m.minsAgo),
    text: m.text,
  }));
}

export function makeItem(seed: ThreadSeed, clock: string, uniq = ''): Item {
  const messages = toMessages(seed.messages, clock, seed.key + uniq);
  const first = messages[0]?.ts ?? clock;
  const ts = slackTs(first);
  const authorIds = [...new Set(messages.map((m) => m.authorId))];
  return {
    id: `slack:${seed.channelId}:${ts}`,
    source: 'slack',
    kind: seed.kind,
    title: titleFor(seed),
    permalink: permalinkFor(seed.channelId, ts),
    participants: authorIds.map((id) => ({ id, name: PEOPLE[id] ?? id })),
    messages,
    messageCount: seed.messageCount ?? messages.length,
    lastActivityAt: messages[messages.length - 1]?.ts ?? clock,
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
    arrivedAt: clock,
    script: seed.decision,
    failTriage: seed.failTriage ?? 0,
    drafts: seed.drafts,
  };
}

const RANK: Record<Attention, number> = { none: 0, today: 1, now: 2 };
export const atLeast = (a: Attention, min?: Attention): Attention => (min && RANK[min] > RANK[a] ? min : a);

export function buildDecision(
  rec: ItemRec,
  at: string,
  by: { kind: 'rule'; ruleId: string; attention: Attention } | { kind: 'model'; batchId: string; ruleId?: string; min?: Attention; model: string },
  script: ScriptedDecision = rec.script,
): TriageDecision {
  const base = {
    itemId: rec.item.id,
    itemRevision: rec.item.revision,
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
  return {
    ...base,
    attention: atLeast(script.attention, by.min),
    // Confluence is never suggested for people observations (NF-2).
    confluence: script.confluence && !script.people ? { suggested: true, targetHint: script.confluence } : { suggested: false },
    vault: script.vault ? { suggested: true, targetHint: script.vault } : { suggested: false },
    reason: script.reason,
    decidedBy: 'model',
    ruleId: by.ruleId,
    model: by.model,
    promptVersion: 'triage v3',
    batchId: by.batchId,
  };
}

export function makeEvent(seq: number, type: WorkEvent['type'], at: string, extra: Partial<Omit<WorkEvent, 'id' | 'type' | 'at' | 'schemaVersion'>> = {}): WorkEvent {
  return { id: `ev-${seq}`, type, at, schemaVersion: 1, ...extra };
}
