import { readFile } from 'node:fs/promises';
import { PROJECTION_VERSION, type Projection } from '@work-os/shared';
import { writeFileAtomic } from './atomic';

// state/snapshot.json: a cache of the projection, so a start replays only the log's tail
// (PLAN.md §4.3, NF-11). It is never the source of truth: anything wrong with it means a full
// replay from the log.

export interface Snapshot {
  schemaVersion: 1;
  projectionVersion: number;
  lastSeq: number;
  lastFile?: string;
  savedAt: string;
  state: Projection;
}

export type SnapshotLoad = { ok: true; snapshot: Snapshot } | { ok: false; reason: 'missing' | 'corrupt' | 'version' };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function loadSnapshot(file: string): Promise<SnapshotLoad> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'corrupt' };
  }
  let s: unknown;
  try {
    s = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'corrupt' };
  }
  if (!isRecord(s) || !isRecord(s.state)) return { ok: false, reason: 'corrupt' };
  if (s.schemaVersion !== 1 || s.projectionVersion !== PROJECTION_VERSION) return { ok: false, reason: 'version' };
  const st = s.state;
  const shaped = typeof s.lastSeq === 'number' && st.lastSeq === s.lastSeq && isRecord(st.items) && isRecord(st.actions) && isRecord(st.sources);
  return shaped ? { ok: true, snapshot: s as unknown as Snapshot } : { ok: false, reason: 'corrupt' };
}

/** Serialises synchronously, so the file matches the projection at the moment of the call. */
export function serialiseSnapshot(state: Projection, lastFile: string | undefined, now: Date): string {
  const s: Snapshot = { schemaVersion: 1, projectionVersion: PROJECTION_VERSION, lastSeq: state.lastSeq, lastFile, savedAt: now.toISOString(), state };
  return JSON.stringify(s);
}

export const saveSnapshot = (file: string, serialised: string) => writeFileAtomic(file, serialised);
