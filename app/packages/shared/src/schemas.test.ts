import { describe, expect, it } from 'vitest';
import { EvalReport, Message, Ms365Connector, Rule, Rules, Settings, SettingsFile, isValidRegex, pollIntervalMinutes, sourceSchedule, upgradeSettings } from './schemas';

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

  it('accepts a rule without a source scope, as rules.json files from before scopes have', () => {
    expect(Rule.safeParse({ id: 'x', enabled: true, conditions: [{ type: 'is_dm' }], outcome: { type: 'now' } }).success).toBe(true);
  });

  it('rejects a rule scoped to sources that cannot check its conditions', () => {
    const r = Rule.safeParse({ id: 'x', enabled: true, sources: ['outlook'], conditions: [{ type: 'channel_in', values: ['#a'] }], outcome: { type: 'now' } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]).toMatchObject({ path: ['sources'], message: 'None of the chosen sources supports every condition' });
    expect(Rule.safeParse({ id: 'x', enabled: true, sources: ['outlook'], conditions: [{ type: 'keyword', pattern: 'x' }], outcome: { type: 'now' } }).success).toBe(true);
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

  it('gives the interval in force: work hours, off hours, or none', () => {
    const sources = { outlook: { enabled: true } };
    const monMorning = '2026-10-05T09:00:00Z';
    const monNight = '2026-10-05T21:00:00Z';
    expect(pollIntervalMinutes({ schedule }, 'slack', monMorning)).toBe(15);
    expect(pollIntervalMinutes({ schedule }, 'slack', monNight)).toBe(90);
    expect(pollIntervalMinutes({ schedule, sources }, 'outlook', monNight)).toBe(120);
    expect(pollIntervalMinutes({ schedule }, 'outlook', monMorning)).toBeUndefined(); // off
    expect(pollIntervalMinutes({ schedule, sources: { wispr: { enabled: true } } }, 'wispr', monNight)).toBeUndefined(); // no off-hours polls
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

describe('settings upgrade (sources)', () => {
  it('moves slack.vips to people.vips in a file from before People existed', () => {
    const old = { dataDir: '/x', slack: { fetchMode: 'search', vips: ['Dana Lee'] }, schemaVersion: 1 };
    expect(upgradeSettings(old)).toEqual({ dataDir: '/x', slack: { fetchMode: 'search' }, people: { vips: ['Dana Lee'] }, schemaVersion: 1 });
  });

  it('leaves a current file, and anything that is not an object, as it is', () => {
    const current = { slack: { fetchMode: 'search' }, people: { vips: [] } };
    expect(upgradeSettings(current)).toBe(current);
    expect(upgradeSettings(null)).toBeNull();
  });

  it('is what settings files are read with, while Settings itself wants the new shape', () => {
    const shape = { ...Settings.shape };
    expect(shape.people).toBeDefined();
    expect(SettingsFile.safeParse({ slack: { vips: [] } }).error?.issues.some((i) => i.path[0] === 'people')).toBe(false);
  });
});

describe('Outlook (amendments)', () => {
  it('keeps the Microsoft 365 connector in settings, and refuses an id that would not fit the proxy URL', () => {
    const c = { id: 'mcpsrv_01RM1g8G4CFZVJykAVjtu8iW', account: { name: 'Frank Keulers', address: 'frank@example.com', upn: 'frank@example.com' } };
    expect(Settings.shape.connectors.parse({ ms365: c })).toEqual({ ms365: c });
    expect(Settings.shape.connectors.parse(undefined)).toBeUndefined();
    expect(Ms365Connector.safeParse({ id: 'mcpsrv_01/../x' }).success).toBe(false);
    expect(Ms365Connector.safeParse({ id: '' }).success).toBe(false);
  });

  it('lets an email message say who it went to, and a chat message leave that out', () => {
    const m = { id: '<a@b>', authorId: 'dana@example.com', ts: '2026-10-08T09:00:00.000Z', text: 'Hi' };
    expect(Message.parse({ ...m, to: ['frank@example.com'], cc: [] })).toMatchObject({ to: ['frank@example.com'], cc: [] });
    expect(Message.parse(m)).toEqual(m);
  });

  it('keeps the colour chosen for each calendar category, one of Outlook’s (R2.8)', () => {
    expect(Settings.shape.calendar.parse({ categoryColors: { Customer: 'darkRed' } })).toEqual({ categoryColors: { Customer: 'darkRed' } });
    expect(Settings.shape.calendar.parse(undefined)).toBeUndefined();
    expect(Settings.shape.calendar.safeParse({ categoryColors: { Customer: 'pink' } }).success).toBe(false);
    expect(Settings.shape.calendar.safeParse({ categoryColors: { '': 'red' } }).success).toBe(false);
  });
});

describe('eval reports (FR-6.3, Waiting on others)', () => {
  const pr = (support: number) => ({ precision: 1, recall: 1, support });
  const base = { id: 'eval-1', at: '2026-10-01T09:00:00.000Z', labelCount: 6, promptVersion: 'triage v8#abc', model: 'haiku-5.5', tokens: 10, costEquivalent: 0.01 };

  it('reads a report saved before follow with an empty follow row and column', () => {
    const old = { ...base, categories: { now: pr(1), today: pr(2), none: pr(3), confluence: pr(0), vault: pr(0) }, confusion: [[1, 0, 0], [0, 2, 0], [0, 1, 2]] };
    const r = EvalReport.parse({ ...old, bySource: { slack: { labelCount: 6, categories: old.categories, confusion: old.confusion } } });
    expect(r.confusion).toEqual([
      [1, 0, 0, 0],
      [0, 2, 0, 0],
      [0, 0, 0, 0],
      [0, 1, 0, 2],
    ]);
    expect(r.categories.follow).toEqual({ precision: 0, recall: 0, support: 0 });
    expect(r.bySource?.slack?.confusion[3]).toEqual([0, 1, 0, 2]);
  });

  it('keeps a 4×4 report as it is, and refuses other shapes', () => {
    const c = [[1, 0, 0, 0], [0, 1, 1, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
    expect(EvalReport.parse({ ...base, categories: { now: pr(1), today: pr(2), follow: pr(2), none: pr(1), confluence: pr(0), vault: pr(0) }, confusion: c }).confusion).toEqual(c);
    expect(EvalReport.safeParse({ ...base, categories: { now: pr(1), today: pr(2), none: pr(1), confluence: pr(0), vault: pr(0) }, confusion: [[1, 0], [0, 1]] }).success).toBe(false);
  });
});
