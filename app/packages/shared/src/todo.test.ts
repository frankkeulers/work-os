import { describe, expect, it } from 'vitest';
import { askId } from './projection/topics';
import { todoContent, todoLine, todoLines, todoSteps } from './todo';

const SRC = { title: '#mvi-launch', permalink: 'https://polestar.slack.com/archives/C06/p1791' };

describe('to-dos (UX-5)', () => {
  it('writes an Obsidian Tasks line: the step, the deadline in London, and a link back', () => {
    // 23:30 UTC on 8 Oct is already 9 Oct in London (BST).
    expect(todoLine({ step: 'Send the notes', dueAt: '2026-10-08T23:30:00.000Z' }, SRC)).toBe('- [ ] Send the notes 📅 2026-10-09 [#mvi-launch](https://polestar.slack.com/archives/C06/p1791)');
    expect(todoLine({ step: '  - [ ] Already a task\nwith a break ' }, { title: 'Dana [ops]', permalink: 'https://x.test/a b' })).toBe('- [ ] Already a task with a break [Dana \\[ops\\]](https://x.test/a%20b)');
  });

  it('starts from the open asks, then a meeting’s action items, then the next step, then the summary', () => {
    const asks = [
      { need: 'approve' as const, step: 'Approve the wording', dueAt: '2026-10-06T11:00:00.000Z' },
      { need: 'review' as const, step: 'Review the deck' },
    ];
    expect(todoSteps({ next: { need: 'approve', step: asks[0].step, why: 'w', asks } }, [askId('Review the deck')])).toEqual([{ step: 'Approve the wording', dueAt: '2026-10-06T11:00:00.000Z' }]);
    expect(todoSteps({ next: { need: 'actions', step: 'Confirm', why: 'w', actionItems: ['Send the sample · by Friday', 'Book the kick-off'] } })).toEqual([{ step: 'Send the sample · by Friday' }, { step: 'Book the kick-off' }]);
    expect(todoSteps({ next: { need: 'reply', step: 'Answer Matt', why: 'w', dueAt: '2026-10-06T16:30:00.000Z' } })).toEqual([{ step: 'Answer Matt', dueAt: '2026-10-06T16:30:00.000Z' }]);
    expect(todoSteps({ summary: 'Ops is fixing access' })).toEqual([{ step: 'Follow up: Ops is fixing access' }]);
    expect(todoSteps(undefined)).toEqual([]);
    expect(todoContent([{ step: 'a' }, { step: 'b' }], SRC).split('\n')).toHaveLength(2);
  });

  it('reads Frank’s edit back as task lines: blank lines dropped, plain lines made tasks, ticked ones kept', () => {
    expect(todoLines('- [ ] One\n\n  Two  \n- [x] Done already\n* Three')).toEqual(['- [ ] One', '- [ ] Two', '- [x] Done already', '- [ ] Three']);
  });
});
