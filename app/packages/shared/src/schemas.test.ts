import { describe, expect, it } from 'vitest';
import { Rule, Rules, isValidRegex } from './schemas';

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
