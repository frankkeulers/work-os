import { Draft, EvalReport, Item, Rule, Settings, TriageDecision, UsageRecord, WorkEvent } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { buildState } from './seed';

// The seed doubles as the fixture set for the future server (CLAUDE.md rule 10),
// so it must validate against the shared schemas.
describe.each(['default', 'firstRun', 'inboxZero', 'heavy', 'noBaseline'] as const)('seed preset %s', (preset) => {
  const s = buildState(preset);

  it('validates against the shared schemas', () => {
    for (const rec of Object.values(s.items)) {
      expect(() => Item.parse(rec.item), rec.key).not.toThrow();
      if (rec.decision) expect(() => TriageDecision.parse(rec.decision), rec.key).not.toThrow();
    }
    for (const d of Object.values(s.drafts)) Draft.parse(d);
    for (const e of s.events) WorkEvent.parse(e);
    for (const u of s.usage) UsageRecord.parse(u);
    for (const r of s.evals) EvalReport.parse(r);
    for (const r of s.rules) Rule.parse(r);
    Settings.parse(s.settings);
  });

  it('keeps message bodies out of events', () => {
    const bodies = Object.values(s.items).flatMap((r) => r.item.messages.map((m) => m.text));
    const serialised = JSON.stringify(s.events);
    for (const b of bodies) expect(serialised.includes(b)).toBe(false);
  });
});

describe('default seed', () => {
  const s = buildState('default');
  const byKey = Object.fromEntries(Object.values(s.items).map((r) => [r.key, r]));

  it('has the lane spread the journeys rely on', () => {
    expect(byKey.n1.decision?.decidedBy).toBe('rule');
    expect(byKey.n1.decision?.ruleId).toBe('vip-dm');
    expect(byKey.t4.decision?.containsPeopleObservations).toBe(true);
    expect(byKey.t4.decision?.confluence.suggested).toBe(false);
    expect(byKey.x1.triageState).toBe('failed');
    expect(byKey.q1.triageState).toBe('pending');
    expect(byKey.d2.item.contentExpired).toBe(true);
    expect(Object.values(s.actions).filter((a) => a.status === 'ready')).toHaveLength(2);
  });
});
