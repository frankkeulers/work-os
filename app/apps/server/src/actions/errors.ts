import type { FailureReason } from '@work-os/shared';

/** A draft that can't be used, and why: the action fails with this reason and message. */
export class DraftError extends Error {
  constructor(
    message: string,
    readonly reason: FailureReason = 'model_error',
  ) {
    super(message);
    this.name = 'DraftError';
  }
}
