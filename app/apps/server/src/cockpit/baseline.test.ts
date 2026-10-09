import { describe, expect, it } from 'vitest';
import { toLoggedDecision, type EventData, type EventType, type SourceId, type TriageDecision, type WorkEvent } from '@work-os/shared';
import { BaselineAnalyser, describeBaseline, workDays } from './baseline';

// London is UTC+1 in October: 09:00 London is 08:00Z.
const MON = '2026-10-05';
const at = (day: string, utc: string) => `${day}T${utc}:00.000Z`;
const NOW = new Date(at('2026-10-09', '18:00')); // Fri 19:00 London

function log() {
  const events: WorkEvent[] = [];
  const add = <T extends EventType>(type: T, when: string, itemId: string | undefined, data: EventData<T>) => {
    events.push({ seq: events.length + 1, id: `ev-${events.length + 1}`, type, at: when, itemId, data, schemaVersion: 1 } as WorkEvent);
  };
  const upsert = (id: string, when: string, revision: number, fromMeOnly = false, source: SourceId = 'slack') =>
    add('item.upserted', when, id, {
      source,
      kind: source === 'outlook' ? 'email' : 'thread',
      title: id,
      permalink: `https://example.com/${id}`,
      participants: [],
      lastActivityAt: when,
      revision,
      messageCount: revision,
      fromMeOnly,
    });
  const decide = (id: string, when: string, revision: number, attention: TriageDecision['attention'], extra: Partial<TriageDecision> = {}) =>
    add('triage.decided', when, id, {
      decision: toLoggedDecision({
        itemId: id,
        itemRevision: revision,
        attention,
        confluence: { suggested: false },
        vault: { suggested: false },
        containsPeopleObservations: false,
        summary: 's',
        reason: 'r',
        decidedBy: 'model',
        decidedAt: when,
        ...extra,
      }),
    });
  const done = (id: string, when: string, data?: EventData<'item.done'>) => add('item.done', when, id, data);
  return { events, add, upsert, decide, done };
}

const run = (events: WorkEvent[], days = 14) => {
  const a = new BaselineAnalyser({ now: NOW, days, workHours: 'Mon–Fri 08:00–18:30' });
  for (const e of events) a.add(e);
  return a.report();
};

describe('workDays', () => {
  it('reads the days of a work-hours spec, wrapping the week, and falls back to Mon–Fri', () => {
    expect([...workDays('Mon–Fri 08:00–18:30')]).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect([...workDays('Sun–Thu 07:00–16:00')]).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Sun']);
    expect([...workDays('nonsense')]).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  });
});

describe('BaselineAnalyser (CK-0.1)', () => {
  function week() {
    const l = log();
    // Before the window: ignored, though it still builds the state.
    l.upsert('old', at('2026-09-01', '08:00'), 1);
    l.decide('old', at('2026-09-01', '08:05'), 1, 'now');
    l.done('old', at('2026-09-01', '09:00'));
    // A: Now with a deadline; Frank replies in the thread, then presses Done.
    l.upsert('A', at(MON, '08:00'), 1);
    l.decide('A', at(MON, '08:05'), 1, 'now', { next: { need: 'reply', step: 'Reply', why: 'w', dueAt: at(MON, '13:00') } });
    l.upsert('A', at(MON, '08:30'), 2, true);
    l.done('A', at(MON, '08:40'));
    // B: an email, Today, done without a reply. A replayed poll of the same revision changes nothing.
    l.upsert('B', at(MON, '08:00'), 1, false, 'outlook');
    l.decide('B', at(MON, '08:05'), 1, 'today', { next: { need: 'decide', step: 'Pick', why: 'w' } });
    l.upsert('B', at(MON, '08:10'), 1, true, 'outlook');
    l.done('B', at(MON, '09:00'));
    // C: Frank replies, then someone else does: his reply no longer settles it.
    l.upsert('C', at(MON, '08:00'), 1);
    l.decide('C', at(MON, '08:05'), 1, 'today');
    l.upsert('C', at(MON, '09:00'), 2, true);
    l.upsert('C', at(MON, '10:00'), 3);
    l.decide('C', at(MON, '10:05'), 3, 'today');
    l.done('C', at(MON, '11:00'));
    // D: Today, still open at 18:00 Monday; a source closes it on Tuesday.
    l.upsert('D', at(MON, '08:00'), 1);
    l.decide('D', at(MON, '08:05'), 1, 'today');
    l.done('D', at('2026-10-06', '09:00'), { by: 'source', reason: 'You accepted it in Outlook.' });
    // E: to file.
    l.upsert('E', at(MON, '08:00'), 1);
    l.decide('E', at(MON, '08:05'), 1, 'none', { vault: { suggested: true } });
    return l.events;
  }

  it('counts items entering each lane per day, and Frank’s Dones on Needs you', () => {
    const r = run(week());
    const quiet = { entered: { now: 0, today: 0, file: 0, else: 0, failed: 0 }, needsYouDoneByFrank: 0 };
    expect(r.perDay).toHaveLength(15); // every London day in the window, quiet ones too
    expect(r.perDay.at(0)?.date).toBe('2026-09-25');
    expect(r.perDay.at(-1)?.date).toBe('2026-10-09');
    expect(r.perDay.find((d) => d.date === MON)).toEqual({ date: MON, entered: { now: 1, today: 3, file: 1, else: 0, failed: 0 }, needsYouDoneByFrank: 3 });
    expect(r.perDay.find((d) => d.date === '2026-10-06')).toEqual({ date: '2026-10-06', ...quiet });
    expect(r.dones).toEqual({ byFrank: 3, bySource: 1 });
  });

  it('measures deadline coverage of Needs you decisions, by source and by need', () => {
    const r = run(week());
    expect(r.deadlineCoverage.all).toEqual({ of: 5, withDue: 1, pct: 20 });
    expect(r.deadlineCoverage.bySource).toEqual({ outlook: { of: 1, withDue: 0, pct: 0 }, slack: { of: 4, withDue: 1, pct: 25 } });
    expect(r.deadlineCoverage.byNeed).toMatchObject({ reply: { of: 1, withDue: 1 }, decide: { of: 1, withDue: 0 }, none: { of: 3, withDue: 0 } });
  });

  it('finds the Dones that followed Frank’s own last word: the auto-close ceiling', () => {
    const r = run(week());
    expect(r.autoClosePotential).toEqual({ frankDones: 3, afterOwnReply: 1, pct: 33.3, gap: { n: 1, medianMinutes: 10, p90Minutes: 10 } });
  });

  it('times first appearance to Done by the lane the item was in', () => {
    const r = run(week());
    expect(r.timeToDone.now).toEqual({ n: 1, medianMinutes: 40, p90Minutes: 40 });
    expect(r.timeToDone.today).toEqual({ n: 3, medianMinutes: 180, p90Minutes: 1500 });
  });

  it('counts Needs you at 18:00 London on working days only', () => {
    const r = run(week());
    const byDate = Object.fromEntries(r.endOfDay.map((d) => [d.date, d.needsYou]));
    expect(byDate[MON]).toBe(1); // D
    expect(byDate['2026-10-06']).toBe(0);
    expect(byDate['2026-10-03']).toBeUndefined(); // a Saturday
    expect(r.endOfDay.map((d) => d.date)).toContain('2026-10-09'); // Friday's 18:00 is inside the window
  });

  it('credits a reply in a topic part to the topic, and ignores the part itself', () => {
    const l = log();
    l.upsert('F', at(MON, '08:00'), 1);
    l.upsert('G', at(MON, '08:01'), 1);
    l.add('topic.routed', at(MON, '08:02'), 'G', { into: 'F', by: 'model' });
    l.decide('F', at(MON, '08:05'), 1, 'today');
    l.upsert('G', at(MON, '08:30'), 2, true);
    l.done('F', at(MON, '09:00'));
    const r = run(l.events);
    expect(r.autoClosePotential).toMatchObject({ frankDones: 1, afterOwnReply: 1 });
    expect(r.perDay.find((d) => d.date === MON)?.entered.today).toBe(1);
  });

  it('describes the report in plain text', () => {
    const text = describeBaseline(run(week()));
    expect(text).toContain('Auto-close potential: 1 of 3 Dones came after Frank\'s own reply (33.3%)');
    expect(text).toContain('Deadline coverage: 1 of 5 Needs you decisions set dueAt (20%)');
  });
});
