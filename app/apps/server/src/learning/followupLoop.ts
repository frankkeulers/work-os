import type { Settings } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import type { Logger } from '../log';
import { followupMiss, followupRows, predictFollowups, type FollowupCase } from '../pipeline/evalFollowup';
import { strings } from './checkLoop';
import type { LoopAdapter } from './tuner';

// The follow-up loop's adapter for the tuner (E15, FR-16.14): the followup prompt over
// labels/followup.jsonl, one case per labelled To Do. Each kind the prompt now suggests that Frank
// didn't want, or leaves out that he did, becomes a miss. The copy check covers the conversation,
// the replies suggested and Frank's own words, so none of them moves into the prompt.

export function followupLoop(d: { claude: ClaudeAdapter; settings: () => Settings; now: () => Date; logger?: Logger }): LoopAdapter<FollowupCase> {
  return {
    loop: 'followup',
    promptId: 'followup',
    itemId: (c) => c.itemId,
    texts: (c) => [...strings(c.input), ...c.suggested, ...c.edited],
    evaluate: async (policy, cases, signal) => {
      const { rows, failed, tokens, cost } = await predictFollowups({ claude: d.claude, settings: d.settings(), prompt: policy, now: d.now, signal, logger: d.logger }, cases);
      return { scores: followupRows(rows), misses: rows.map(followupMiss).filter((m) => !!m), failed, tokens, cost };
    },
  };
}
