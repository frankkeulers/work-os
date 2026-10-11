import { describe, expect, it } from 'vitest';
import { counted, newSweep, nextInSweep, sweepTally } from './sweep';

describe('the sweep (UX-10)', () => {
  it('counts each item once per outcome, and says what happened in order', () => {
    let s = newSweep(['a', 'b', 'c', 'd']);
    expect(sweepTally(s)).toBe('Nothing changed');
    s = counted(s, 'a', 'skipped');
    s = counted(s, 'b', 'done');
    s = counted(s, 'c', 'done');
    s = counted(s, 'd', 'replied');
    expect(s.counted).toEqual(['a', 'b', 'c', 'd']);
    expect(sweepTally(s)).toBe('2 done · 1 replied · 1 skipped');
  });

  it('moves on to the next item still open, passing over any closed meanwhile', () => {
    const s = newSweep(['a', 'b', 'c']);
    const items = [
      { id: 'a', status: 'open' },
      { id: 'b', status: 'done' },
      { id: 'c', status: 'open' },
    ];
    expect(nextInSweep(s, 0, items)).toBe('a');
    expect(nextInSweep(s, 1, items)).toBe('c');
    expect(nextInSweep(s, 3, items)).toBeUndefined();
    expect(nextInSweep(s, 1, items.slice(0, 2))).toBeUndefined(); // c gone from the inbox
  });
});
