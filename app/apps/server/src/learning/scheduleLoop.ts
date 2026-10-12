import type { Settings } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import type { Logger } from '../log';
import { predictSchedule, scheduleMiss, scheduleRows, type ScheduleCase } from '../pipeline/evalSchedule';
import { strings } from './checkLoop';
import type { LoopAdapter } from './tuner';

// The schedule loop's adapter for the tuner (E15, FR-16.14): the schedule prompt over
// labels/schedule.jsonl, one case per labelled To Do. Each To Do whose estimate the prompt now gets
// far wrong, or whose ideal deadline misses Frank's, becomes a miss.

export function scheduleLoop(d: { claude: ClaudeAdapter; settings: () => Settings; now: () => Date; logger?: Logger }): LoopAdapter<ScheduleCase> {
  return {
    loop: 'schedule',
    promptId: 'schedule',
    itemId: (c) => c.itemId,
    texts: (c) => strings(c.input),
    evaluate: async (policy, cases, signal) => {
      const { rows, failed, tokens, cost } = await predictSchedule({ claude: d.claude, settings: d.settings(), prompt: policy, now: d.now, signal, logger: d.logger }, cases);
      return { scores: scheduleRows(rows), misses: rows.map(scheduleMiss).filter((m) => !!m), failed, tokens, cost };
    },
  };
}
