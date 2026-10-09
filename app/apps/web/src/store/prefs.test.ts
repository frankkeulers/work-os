import { beforeEach, describe, expect, it } from 'vitest';
import { meetingKey, usePrefs } from './prefs';

// Meetings dismissed from the sidebar (R2.8). In memory here: the tests run without localStorage.

const NOW = new Date('2026-10-09T08:00:00.000Z');
const call = { id: 'AAMk1', start: '2026-10-09T08:00:00.000Z', end: '2026-10-09T09:00:00.000Z' };

describe('dismissing a meeting from the sidebar', () => {
  beforeEach(() => usePrefs.setState({ dismissedMeetings: {} }));

  it('keeps it out until it ends, as that occurrence: moved, it is a new one', () => {
    usePrefs.getState().dismissMeeting(call, NOW);
    expect(usePrefs.getState().dismissedMeetings).toEqual({ [meetingKey(call)]: call.end });
    expect(usePrefs.getState().dismissedMeetings[meetingKey({ ...call, start: '2026-10-09T10:00:00.000Z' })]).toBeUndefined();
  });

  it('undoes, and forgets dismissals of meetings that have ended', () => {
    usePrefs.getState().dismissMeeting(call, NOW);
    usePrefs.getState().undismissMeeting(call);
    expect(usePrefs.getState().dismissedMeetings).toEqual({});

    usePrefs.getState().dismissMeeting(call, NOW);
    const later = { id: 'AAMk2', start: '2026-10-09T13:00:00.000Z', end: '2026-10-09T13:30:00.000Z' };
    usePrefs.getState().dismissMeeting(later, new Date('2026-10-09T12:58:00.000Z')); // the call ended at 09:00
    expect(Object.keys(usePrefs.getState().dismissedMeetings)).toEqual([meetingKey(later)]);
  });
});
