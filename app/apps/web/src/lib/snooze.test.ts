import { describe, expect, it } from 'vitest';
import { snoozeOptions } from './snooze';

describe('snooze options', () => {
  it('runs from 30 minutes to next Monday 09:00 London', () => {
    const tue = new Date('2026-10-06T10:00:00.000Z'); // Tuesday, 11:00 in London
    expect(snoozeOptions(tue).map((o) => [o.label, o.until])).toEqual([
      ['30 minutes', '2026-10-06T10:30:00.000Z'],
      ['1 hour', '2026-10-06T11:00:00.000Z'],
      ['3 hours', '2026-10-06T13:00:00.000Z'],
      ['Tomorrow 09:00', '2026-10-07T08:00:00.000Z'],
      ['In 2 days', '2026-10-08T08:00:00.000Z'],
      ['Next Monday', '2026-10-12T08:00:00.000Z'],
    ]);
  });

  it('drops "In 2 days" when it is next Monday', () => {
    const sat = new Date('2026-10-10T10:00:00.000Z');
    expect(snoozeOptions(sat).map((o) => o.label)).toEqual(['30 minutes', '1 hour', '3 hours', 'Tomorrow 09:00', 'In 2 days']);
  });
});
