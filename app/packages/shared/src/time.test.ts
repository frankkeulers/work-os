import { describe, expect, it } from 'vitest';
import { inTimeRange, isWorkHours, londonAt, londonParts, tomorrowAt9 } from './time';

// London is UTC+1 until 25 Oct 2026 (BST), then UTC+0 (GMT).

describe('londonParts', () => {
  it('reads the London wall clock, not UTC', () => {
    expect(londonParts('2026-10-05T23:30:00.000Z')).toEqual({ weekday: 'Tue', dateKey: '2026-10-06', hours: 0, minutes: 30 });
  });
});

describe('inTimeRange', () => {
  it('includes the start and excludes the end', () => {
    expect(inTimeRange('2026-10-05T07:00:00.000Z', '08:00–18:30')).toBe(true); // 08:00 London
    expect(inTimeRange('2026-10-05T17:30:00.000Z', '08:00–18:30')).toBe(false); // 18:30 London
  });

  it('handles ranges that wrap midnight, with either dash', () => {
    expect(inTimeRange('2026-10-05T22:30:00.000Z', '22:00-07:00')).toBe(true); // 23:30 London
    expect(inTimeRange('2026-10-05T05:00:00.000Z', '22:00–07:00')).toBe(true); // 06:00 London
    expect(inTimeRange('2026-10-05T11:00:00.000Z', '22:00–07:00')).toBe(false);
  });

  it('is false for a malformed range', () => {
    expect(inTimeRange('2026-10-05T11:00:00.000Z', 'all day')).toBe(false);
  });
});

describe('isWorkHours', () => {
  it('checks both the day range and the time range', () => {
    expect(isWorkHours('2026-10-05T08:00:00.000Z', 'Mon–Fri 08:00–18:30')).toBe(true); // Mon 09:00
    expect(isWorkHours('2026-10-10T08:00:00.000Z', 'Mon–Fri 08:00–18:30')).toBe(false); // Sat 09:00
    expect(isWorkHours('2026-10-05T18:00:00.000Z', 'Mon–Fri 08:00–18:30')).toBe(false); // Mon 19:00
  });

  it('falls back to weekdays 08:00–18:30 for an unreadable spec', () => {
    expect(isWorkHours('2026-10-05T08:00:00.000Z', 'whenever')).toBe(true);
  });
});

describe('tomorrowAt9 and londonAt', () => {
  it('returns the next London 09:00 in summer time', () => {
    expect(tomorrowAt9(new Date('2026-10-05T15:00:00.000Z'))).toBe('2026-10-06T08:00:00.000Z');
  });

  it('places a London time on the same or a later day', () => {
    expect(londonAt(new Date('2026-10-05T10:00:00.000Z'), '17:00')).toBe('2026-10-05T16:00:00.000Z');
    expect(londonAt(new Date('2026-10-05T10:00:00.000Z'), '09:00', 2)).toBe('2026-10-07T08:00:00.000Z');
  });
});
