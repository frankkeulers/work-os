import type { WorkOsApi } from '@work-os/shared';
import type { MockControls } from '../mock/controls';
import { MockServer } from '../mock/server';
import { noteUserMove } from '../store/userMoves';
import { HttpApi } from './http';

// VITE_API picks the client at build time: `http` (the default) talks to the local server;
// `mock` runs the in-browser MockServer, for the UX e2e tests and the Scenarios drawer.
export const API_MODE: 'http' | 'mock' = import.meta.env.VITE_API === 'mock' ? 'mock' : 'http';

// API_MODE is a build-time constant, so a real build drops the mock entirely.
const mock = API_MODE === 'mock' ? new MockServer() : undefined;

/** The calls by which Frank moves an item himself, and the items each moves (store/userMoves.ts). */
const MOVES: Partial<Record<keyof WorkOsApi, (...args: never[]) => readonly string[]>> = {
  reopen: (id: string) => [id],
  reopenMany: (ids: string[]) => ids,
  correctTriage: (id: string) => [id],
  notFinished: (id: string) => [id],
  retryTriage: (id: string) => [id],
  splitPiece: (id: string) => [id],
};

function noteMoves(client: WorkOsApi): WorkOsApi {
  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      const call = (value as (...a: unknown[]) => unknown).bind(target);
      const moves = MOVES[prop as keyof WorkOsApi] as ((...a: unknown[]) => readonly string[]) | undefined;
      return moves ? (...a: unknown[]) => (noteUserMove(moves(...a)), call(...a)) : call;
    },
  });
}

export const api: WorkOsApi = noteMoves(mock ?? new HttpApi());

/** Scenario controls for the UX round, in mock builds only. Only src/scenarios may import this. */
export const mockControls: MockControls | undefined = mock;

export type * from '@work-os/shared/api';
export * from './errors';
