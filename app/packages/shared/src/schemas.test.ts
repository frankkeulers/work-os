import { describe, expect, it } from 'vitest';
import { Message, Ms365Connector, Rule, Rules, Settings, SettingsFile, isValidRegex, sourceSchedule, upgradeSettings } from './schemas';

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
});
