import { londonAt, type FollowupSuggestionAnswer, type ScheduleTodoAnswer } from '@work-os/shared';

// The mock's schedule prompt (FR-16.6): the seeded To Dos get the plans a model might give, with
// their whys; any other step is sized by its first word, as the server's fake is.

type Answer = Omit<ScheduleTodoAnswer, 'id'>;

const SEEDED: Record<string, (now: Date) => Answer> = {
  'Send Matt the one-line MVI V2 go/no-go reason': () => ({ effortMinutes: 10, confidence: 'high', estimateWhy: 'A two-line reply with the reason you gave in the review.' }),
  'Share the graduation gate checklist': () => ({ effortMinutes: 15, confidence: 'high', estimateWhy: 'The checklist exists; it needs a link and a line on what is missing.' }),
  'Add the imo_str deprecation to the developer portal changelog': () => ({ effortMinutes: 30, confidence: 'medium', estimateWhy: 'A changelog entry, and a check that the migration guide link works.' }),
  'Confirm the IMO STR wording with Legal': (now) => ({
    effortMinutes: 20,
    confidence: 'medium',
    estimateWhy: 'A short note to Legal with the two wordings to choose from.',
    deadline: londonAt(now, '12:00', 1),
    deadlineWhy: 'Legal review wording on Tuesdays; asking a day ahead gets it into this week’s round.',
  }),
  'Book a kick-off with the Data team': () => ({ effortMinutes: 20, confidence: 'low', estimateWhy: 'Finding a time that suits five people may take a few rounds.' }),
};

export function mockPlan(step: string, now: Date): Answer {
  const seeded = SEEDED[step];
  if (seeded) return seeded(now);
  if (/^(send|share|reply|book)\b/i.test(step)) return { effortMinutes: 15, confidence: 'high', estimateWhy: 'A short message or booking.' };
  if (/\breview\b/i.test(step)) return { effortMinutes: 60, confidence: 'medium', estimateWhy: 'Reading it through, with comments.' };
  if (/^(write|draft)\b/i.test(step)) return { effortMinutes: 120, confidence: 'medium', estimateWhy: 'Writing something new for others to read.' };
  return { effortMinutes: 30, confidence: 'low', estimateWhy: 'Its size depends on what it turns up.' };
}

/**
 * The mock's followup prompt (FR-16.11): the seeded To Dos get what a model might suggest; any
 * other step gets a reply when it sent something, and closing its item, as the server's fake does.
 */
const FOLLOWUPS: Record<string, FollowupSuggestionAnswer[]> = {
  'Share the graduation gate checklist': [
    { kind: 'reply', why: 'The Labs team asked for the checklist to start their graduation request.', reply: { text: 'Here’s the graduation gate checklist: [link]. The security review and the support runbook are the two still open for you.' } },
    { kind: 'add_todo', why: 'The request can’t go to the board until the security review is booked.', todo: { step: 'Book the security review for the Labs prototype' } },
    { kind: 'mark_source_done', why: 'The checklist was the only thing asked of you here.' },
  ],
  'Send Matt the one-line MVI V2 go/no-go reason': [
    { kind: 'reply', why: 'Matt asked for it before Thursday’s exec sync.', reply: { text: 'MVI V2 is a go: bulk export is ready and the API follows in two weeks. Happy to say more on Thursday.' } },
    { kind: 'mark_source_done', why: 'That was all Matt asked of you.' },
  ],
};

export function mockFollowups(step: string, canReply: boolean): FollowupSuggestionAnswer[] {
  const seeded = FOLLOWUPS[step];
  if (seeded) return seeded;
  return [
    ...(canReply && /^(send|share|reply|confirm)\b/i.test(step) ? [{ kind: 'reply' as const, why: 'They asked for it.', reply: { text: `Done: ${step.replace(/^\w+\s/, '')}.` } }] : []),
    { kind: 'mark_source_done', why: 'Nothing else is open on it.' },
  ];
}
