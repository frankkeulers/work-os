import { describe, expect, it } from 'vitest';
import { mergeEdit, sameValue } from './merge';

describe('applying a Settings edit to the files as they are now (FR-1.5)', () => {
  const base = { dryRun: true, sources: { outlook: { enabled: false } }, schedule: { work: 30, off: 120 }, vips: ['a'] };

  it('keeps what changed meanwhile and the edit didn’t touch: Connect turning Outlook on', () => {
    const current = { ...base, sources: { outlook: { enabled: true } } };
    const edited = { ...base, dryRun: false };
    expect(mergeEdit(current, base, edited)).toEqual({ ...base, dryRun: false, sources: { outlook: { enabled: true } } });
  });

  it('takes the edit’s value field by field, nested, and a changed list whole', () => {
    const current = { ...base, schedule: { work: 30, off: 60 }, vips: ['a', 'b'] };
    const edited = { ...base, schedule: { work: 15, off: 120 }, vips: ['c'] };
    expect(mergeEdit(current, base, edited)).toEqual({ ...base, schedule: { work: 15, off: 60 }, vips: ['c'] });
  });

  it('adds what the edit added and removes what it removed', () => {
    const current: Record<string, number> = { a: 1, b: 2, c: 3 };
    expect(mergeEdit(current, { a: 1, b: 2 }, { a: 1, d: 4 })).toEqual({ a: 1, c: 3, d: 4 });
    expect(mergeEdit<Record<string, object>>({ s: { x: 1 } }, {}, { s: { y: 2 } })).toEqual({ s: { y: 2 } }); // a new branch the edit made
  });

  it('is the current files when nothing was edited, and the edit when nothing changed meanwhile', () => {
    const current = { ...base, dryRun: false };
    expect(mergeEdit(current, base, structuredClone(base))).toBe(current);
    const edited = { ...base, schedule: { work: 15, off: 120 } };
    expect(mergeEdit(structuredClone(base), base, edited)).toEqual(edited);
  });

  it('compares values whatever order their keys are in', () => {
    expect(sameValue({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(true);
    expect(sameValue({ a: 1, x: undefined }, { a: 1 })).toBe(true);
    expect(sameValue([1, 2], [2, 1])).toBe(false);
  });
});
