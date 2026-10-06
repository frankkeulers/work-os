import { describe, expect, it } from 'vitest';
import { Rule, Rules, Settings, isValidRegex, sourceSchedule } from './schemas';

describe('rule validation (FR-4.1)', () => {
  it('accepts slash-delimited and bare regular expressions', () => {
    expect(isValidRegex('/blocked|go\\/no-go|urgent/i')).toBe(true);
    expect(isValidRegex('invoice')).toBe(true);
    expect(isValidRegex('/(unclosed/i')).toBe(false);
  });

  it('rejects a keyword rule with a broken pattern', () => {
    const r = Rule.safeParse({
      id: 'bad',
      enabled: true,
      conditions: [{ type: 'keyword', pattern: '/[a-/' }],
      outcome: { type: 'today' },
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].message).toBe('Not a valid regular expression');
  });

  it('rejects duplicate rule ids', () => {
    const rule = { id: 'x', enabled: true, conditions: [{ type: 'is_dm' }], outcome: { type: 'now' } };
    const r = Rules.safeParse([rule, rule]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual([1, 'id']);
  });
});

describe('per-source schedules (R2.1)', () => {
  const schedule = { workHours: 'Mon–Fri 08:00–18:30', intervalWorkMinutes: 15, intervalOffMinutes: 90 };

  it('takes Slack’s from the global schedule, and the rest from defaults', () => {
    expect(sourceSchedule({ schedule }, 'slack')).toEqual({ enabled: true, intervalWorkMinutes: 15, intervalOffMinutes: 90 });
    expect(sourceSchedule({ schedule }, 'outlook')).toEqual({ enabled: false, intervalWorkMinutes: 30, intervalOffMinutes: 120 });
    expect(sourceSchedule({ schedule }, 'wispr')).toEqual({ enabled: false, intervalWorkMinutes: 180, intervalOffMinutes: null });
  });

  it('lets settings override single fields', () => {
    const sources = { wispr: { enabled: true }, slack: { intervalOffMinutes: null } };
    expect(sourceSchedule({ schedule, sources }, 'wispr')).toEqual({ enabled: true, intervalWorkMinutes: 180, intervalOffMinutes: null });
    expect(sourceSchedule({ schedule, sources }, 'slack').intervalOffMinutes).toBeNull();
  });

  it('keeps settings written before sources existed valid', () => {
    const parsed = Settings.shape.sources.safeParse(undefined);
    expect(parsed.success).toBe(true);
    expect(Settings.shape.sources.safeParse({ wispr: { intervalWorkMinutes: 0 } }).success).toBe(false);
    expect(Settings.shape.sources.safeParse({ fax: { enabled: true } }).success).toBe(false);
  });
});
