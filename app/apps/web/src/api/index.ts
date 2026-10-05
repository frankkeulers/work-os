import { MockServer } from '../mock/server';
import type { MockControls } from '../mock/controls';
import type { WorkOsApi } from './types';

// The only implementation today is the in-browser mock. When the Fastify server exists,
// export an HTTP + SSE client that implements WorkOsApi here instead; pages stay unchanged.
const server = new MockServer();

export const api: WorkOsApi = server;

/** Scenario controls for the UX round. Only src/scenarios may import this. */
export const mockControls: MockControls = server;

export * from './types';
export * from './errors';
