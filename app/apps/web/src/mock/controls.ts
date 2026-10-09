import type { WorkEvent } from '@work-os/shared';
import type { Preset } from './seed';
import type { DraftOutcome, MockFlags } from './types';

// Scenario-only controls for the UX round. Pages never use these; only src/scenarios does.

export type PollOutcome = 'nothing' | 'vip_dm' | 'batch12' | 'reply_done' | 'reply_snoozed' | 'reply_corrected' | 'reply_drafted';

export type StateFlag =
  | 'triage_budget'
  | 'drafts_budget'
  | 'slack_429'
  | 'slack_auth'
  | 'slack_healthy'
  | 'server_down'
  | 'reconnecting'
  | 'server_up'
  | 'api_key'
  | 'slack_token'
  | 'claude_login'
  | 'startup_ok'
  | 'filevault_off'
  | 'rebuilt_notice'
  | 'health_normal'
  | 'health_catching_up'
  | 'health_stopping'
  | 'health_safe'
  | 'health_stale'
  | 'health_ms365';

export interface ControlsState {
  clock: string;
  nextDraftOutcome: DraftOutcome;
  flags: MockFlags;
  slack: string;
  timelinePending: number;
}

export interface MockControls {
  reset(preset?: Preset): void;
  advanceClock(mins: number): void;
  setClockLondon(hhmm: string): void;
  wakeFromSleep(): void;
  simulatePoll(outcome: PollOutcome): void;
  setNextDraftOutcome(o: DraftOutcome): void;
  setFlag(flag: StateFlag): void;
  dismissRebuiltNotice(): void;
  getEvents(): WorkEvent[];
  getControlsState(): ControlsState;
  itemIdForKey(key: string): string | undefined;
}
