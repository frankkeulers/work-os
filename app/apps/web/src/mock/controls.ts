import type { WorkEvent } from '@work-os/shared';
import type { Preset } from './seed';
import type { DraftOutcome, MockFlags } from './types';

// Scenario-only controls for the UX round. Pages never use these; only src/scenarios does.

export type PollOutcome = 'nothing' | 'vip_dm' | 'batch12' | 'reply_done' | 'reply_snoozed' | 'reply_corrected' | 'reply_drafted';

/** Scenarios › Frank replies (cockpit CK-2.2): what the settle check makes of his reply. */
export type SettleOutcome = 'settled' | 'open' | 'handed' | 'failed';

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
  /** The cockpit's afternoon (CK-3): Outlook connected with its calendar on, at 13:48, twelve minutes before the renewal call. */
  cockpitAfternoon(): void;
  /** The cockpit's afternoon, with the filing policy's say on the To file seeds (E14): what is pre-drafted and ready to approve, and a to-do on offer. */
  applyFilingPolicy(): void;
  /** The cockpit's afternoon with To Dos written over the past few days (E15): overdue, due today, later, undated and done. */
  seedTodos(): void;
  simulatePoll(outcome: PollOutcome): void;
  /** Frank answers the top item in Needs you, or `itemId`; a moment later the settle check settles it, leaves it open, or fails. */
  frankReplies(outcome: SettleOutcome, itemId?: string): void;
  setNextDraftOutcome(o: DraftOutcome): void;
  setFlag(flag: StateFlag): void;
  dismissRebuiltNotice(): void;
  getEvents(): WorkEvent[];
  getControlsState(): ControlsState;
  itemIdForKey(key: string): string | undefined;
}
