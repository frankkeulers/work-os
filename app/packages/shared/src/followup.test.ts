import { describe, expect, it } from 'vitest';
import { clampFollowups, FOLLOWUP_MAX, REPLY_MAX, type FollowupContext, type FollowupSuggestionAnswer } from './followup';
import type { TodoState } from './projection/state';
import { followupsOf, followupWanted } from './todos';

const NOW = new Date('2026-10-12T12:00:00.000Z');
const ctx = (over: Partial<FollowupContext> = {}): FollowupContext => ({ now: NOW, source: 'slack', permalink: true, itemOpen: true, otherOpenTodos: 0, vault: true, ...over });
const reply: FollowupSuggestionAnswer = { kind: 'reply', why: 'Matt asked for it.', reply: { text: 'Done: the checklist is in the Labs folder.' } };
const close: FollowupSuggestionAnswer = { kind: 'mark_source_done', why: 'Nothing else is open on it.' };
const next: FollowupSuggestionAnswer = { kind: 'add_todo', why: 'It leads to the review.', todo: { step: '- [ ] Book the review with Legal', dueAt: '2026-10-14T09:00:00+01:00' } };
const note: FollowupSuggestionAnswer = { kind: 'file_note', why: 'A decision worth keeping.' };

describe('follow-ups’ clamp (FR-16.11)', () => {
  it('keeps what may be suggested, in the model’s order', () => {
    expect(clampFollowups([reply, close, next], ctx())).toEqual([
      { kind: 'reply', why: 'Matt asked for it.', reply: { text: 'Done: the checklist is in the Labs folder.' } },
      { kind: 'mark_source_done', why: 'Nothing else is open on it.' },
      { kind: 'add_todo', why: 'It leads to the review.', todo: { step: 'Book the review with Legal', dueAt: '2026-10-14T08:00:00.000Z' } },
    ]);
  });

  it.each([
    ['a reply where Frank can’t answer', [reply], ctx({ source: 'wispr' })],
    ['a reply without a link to the conversation', [reply], ctx({ permalink: false })],
    ['a reply with no words', [{ ...reply, reply: { text: '  ' } }], ctx()],
    ['closing an item already closed', [close], ctx({ itemOpen: false })],
    ['closing an item with other To Dos open', [close], ctx({ otherOpenTodos: 1 })],
    ['a To Do with no step', [{ ...next, todo: { step: ' - [ ] ' } }], ctx()],
    ['a note without vault filing', [note], ctx({ vault: false })],
  ])('drops %s', (_, s, c) => {
    expect(clampFollowups(s as FollowupSuggestionAnswer[], c)).toEqual([]);
  });

  it('keeps one of each kind, at most three, and cuts long words', () => {
    const many = clampFollowups([reply, { ...reply, why: 'again' }, close, next, note], ctx());
    expect(many.map((f) => f.kind)).toEqual(['reply', 'mark_source_done', 'add_todo']);
    expect(many).toHaveLength(FOLLOWUP_MAX);
    const long = clampFollowups([{ kind: 'reply', why: `${'why '.repeat(80)}\nmore`, reply: { text: 'x'.repeat(2000) } }], ctx())[0];
    expect(long.why.length).toBeLessThanOrEqual(160);
    expect(long.why).not.toContain('\n');
    expect(long.reply!.text.length).toBe(REPLY_MAX);
  });

  it('drops a To Do’s date already gone by, keeping the To Do', () => {
    expect(clampFollowups([{ ...next, todo: { step: 'Book it', dueAt: '2026-10-11T09:00:00Z' } }], ctx())).toEqual([{ kind: 'add_todo', why: next.why, todo: { step: 'Book it' } }]);
  });
});

describe('follow-ups on a To Do (FR-16.11)', () => {
  const t = (over: Partial<TodoState>): TodoState => ({ id: 't', itemId: 'i', actionId: 'a', createdAt: '2026-10-10T09:00:00.000Z', status: 'done', doneAt: '2026-10-12T11:00:00.000Z', deadlineFrom: 'none', ...over });

  it('asks for a To Do done in the last day, once, until it has failed twice; never for one made at start', () => {
    expect(followupWanted(t({}), NOW)).toBe(true);
    expect(followupWanted(t({ status: 'open' }), NOW)).toBe(false);
    expect(followupWanted(t({ doneAt: '2026-10-11T11:00:00.000Z' }), NOW)).toBe(false);
    expect(followupWanted(t({ followups: { kinds: [] } }), NOW)).toBe(false);
    expect(followupWanted(t({ followupFailures: 1 }), NOW)).toBe(true);
    expect(followupWanted(t({ followupFailures: 2 }), NOW)).toBe(false);
    expect(followupWanted(t({ backfilled: true }), NOW)).toBe(false);
  });

  it('shows them with Frank’s answers, says when they are still coming, and nothing when none followed', () => {
    const words = [{ kind: 'reply' as const, why: 'w', reply: { text: 'Done.' } }, { kind: 'mark_source_done' as const, why: 'w' }];
    expect(followupsOf(t({ followups: { kinds: ['reply', 'mark_source_done'], answers: { 1: 'dismissed' } } }), words, NOW)).toEqual({ followups: [words[0], { ...words[1], answer: 'dismissed' }] });
    expect(followupsOf(t({}), undefined, NOW)).toEqual({ followupsPending: true });
    expect(followupsOf(t({ followups: { kinds: [] } }), [], NOW)).toEqual({});
    expect(followupsOf(t({ status: 'open' }), words, NOW)).toEqual({});
  });
});
