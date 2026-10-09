import { describe, expect, it } from 'vitest';
import { OUTLOOK_COLORS, OutlookColor, categoryColor, categoryTags, colorLabel } from './categories';

describe('Outlook category colours (R2.8)', () => {
  it('are the 25 Outlook offers, by the names its tools use', () => {
    expect(Object.keys(OUTLOOK_COLORS)).toHaveLength(25);
    expect(OutlookColor.safeParse('darkCranberry').success).toBe(true);
    expect(OutlookColor.safeParse('pink').success).toBe(false);
    expect(colorLabel('darkSteel')).toBe('Dark steel');
    expect(colorLabel('red')).toBe('Red');
  });

  it('takes the colour Frank chose, whatever the case of the name', () => {
    expect(categoryColor('Customer', { customer: 'darkRed' })).toBe('darkRed');
    expect(categoryTags(['Customer', 'Focus'], { CUSTOMER: 'black' })[0]).toEqual({ name: 'Customer', color: 'black' });
  });

  it('gives a category without a chosen colour one of its own that never changes', () => {
    const own = categoryColor('Focus', undefined);
    expect(categoryColor('Focus', { Customer: 'red' })).toBe(own);
    expect(categoryColor(' focus ', undefined)).toBe(own);
    expect(new Set(['Customer', 'Internal', 'Focus', 'Board', 'Travel', 'Hiring'].map((n) => categoryColor(n, undefined))).size).toBeGreaterThan(1);
  });
});
