import type { DepId } from '@work-os/shared';
import type { Failure } from '../net/classify';

/** A fetch that failed in a classified way: the poll pipeline hands `failure` to health (FR-2.9). */
export class SourceError extends Error {
  constructor(
    readonly dep: DepId,
    readonly failure: Failure,
    message = `${dep}: ${failure.reason}`,
  ) {
    super(message);
    this.name = 'SourceError';
  }
}
