import type { DepId, DepState, Item, PollReason, SourceId } from '@work-os/shared';

// The source adapter interface (PLAN.md R2.1, robustness §7). Slack is the only adapter in
// Phase 1; email (through the connector relay) and Wispr Flow (a local read-only database) follow
// in Phase 2 behind the same interface. Adapters fetch and normalise only: persisting items,
// events and cursors, in that order, is the poll pipeline's job (FR-2.8).

export interface FetchContext {
  signal: AbortSignal; // aborts on the call's deadline and when the Mac sleeps
  now: Date;
  reason: PollReason;
  /** Items to read again whole, whatever the cursor: stored before their content could be read. */
  refetch?: string[];
}

export interface FetchResult {
  items: Item[];
  nextCursor: string;
}

export interface SourceAdapter {
  id: SourceId;
  /** What it needs to work, e.g. outlook → network and claude, wispr → wisprDb only. */
  deps: DepId[];
  /** False for local sources, which keep working offline. */
  needsNetwork: boolean;
  fetchSince(cursor: string | undefined, ctx: FetchContext): Promise<FetchResult>;
  /** A cheap health check for "Check again". */
  probe(signal: AbortSignal): Promise<DepState>;
  /** Frank's own ID in this source, once known: his own messages don't need triage again (§5.3). */
  identity?(): { id: string; name?: string } | undefined;
}

/** Priority for catch-up after a wake: one source after another, so a wake is not a burst. */
export const SOURCE_PRIORITY: SourceId[] = ['slack', 'outlook', 'wispr', 'teams', 'plaud'];
