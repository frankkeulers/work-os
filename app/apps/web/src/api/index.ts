import type { WorkOsApi } from '@work-os/shared';
import type { MockControls } from '../mock/controls';
import { MockServer } from '../mock/server';
import { HttpApi } from './http';

// VITE_API picks the client at build time: `http` (the default) talks to the local server;
// `mock` runs the in-browser MockServer, for the UX e2e tests and the Scenarios drawer.
export const API_MODE: 'http' | 'mock' = import.meta.env.VITE_API === 'mock' ? 'mock' : 'http';

// API_MODE is a build-time constant, so a real build drops the mock entirely.
const mock = API_MODE === 'mock' ? new MockServer() : undefined;

export const api: WorkOsApi = mock ?? new HttpApi();

/** Scenario controls for the UX round, in mock builds only. Only src/scenarios may import this. */
export const mockControls: MockControls | undefined = mock;

export type * from '@work-os/shared/api';
export * from './errors';
