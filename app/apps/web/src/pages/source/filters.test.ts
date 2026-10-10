import type { Lane } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { countBy, meetingState, rowState } from './filters';

describe('source view filters (cockpit CK-5.8)', () => {
  it('puts each row in one state: Now, Today and failed triage are Needs you', () => {
    const lanes: Lane[] = ['now', 'today', 'failed', 'week', 'file', 'else', 'waiting', 'snoozed', 'done'];
    expect(lanes.map((lane) => rowState({ lane }))).toEqual(['needs', 'needs', 'needs', 'week', 'file', 'else', 'waiting', 'snoozed', 'done']);
  });

  it('puts each meeting in one state: cancelled first, then Frank’s answer, his own meetings as going', () => {
    expect(meetingState({ cancelled: true, response: 'accepted' })).toBe('cancelled');
    expect(meetingState({ response: 'declined' })).toBe('declined');
    expect(meetingState({ response: 'none' })).toBe('unanswered');
    expect(meetingState({ response: 'notResponded' })).toBe('unanswered');
    expect(meetingState({ response: 'organizer' })).toBe('going');
    expect(meetingState({ response: 'tentativelyAccepted' })).toBe('going');
    expect(meetingState({})).toBe('going'); // not read yet: shown with the rest
  });

  it('counts each state, so the chips add up to the whole', () => {
    const rows = (['now', 'today', 'done', 'done', 'file'] as Lane[]).map((lane) => ({ lane }));
    expect(countBy(rows, rowState)).toEqual({ needs: 2, done: 2, file: 1 });
  });
});
