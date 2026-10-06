import type { Me } from '@work-os/shared';
import { FRANK } from './seed/people';

// The signed-in user for rule matching in the mock. Seed messages mention Frank as plain "@frank".
export const ME: Me = { id: FRANK, mentionRe: /@frank\b/i };
