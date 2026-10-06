import { errorCode, type Failure } from '../net/classify';

// What a failed Claude call means for the `claude` dependency (PLAN.md robustness §4). The SDK
// reports API failures as a typed `error` on the assistant message; a call that never got that
// far throws. Wording of the reasons is shown in the health view.

/** A call that failed in a way health should know about. */
export class ClaudeError extends Error {
  constructor(
    readonly failure: Failure,
    message = `claude: ${failure.reason}`,
  ) {
    super(message);
    this.name = 'ClaudeError';
  }
}

/** The model answered, but not in the expected shape, twice (CL-7). Not a health problem. */
export class ClaudeOutputError extends Error {
  constructor(
    readonly attempts: number,
    readonly issues: string,
  ) {
    super(`The model's output did not match the expected format (${attempts} attempts): ${issues}`);
    this.name = 'ClaudeOutputError';
  }
}

const USAGE_LIMIT_WAIT_MS = 15 * 60_000;

/** The SDK's SDKAssistantMessageError values. */
export function failureFromAssistantError(error: string): Failure {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'verification_required':
    case 'cloud_credential_error':
      return { state: 'auth_failed', reason: `login: ${error}` };
    case 'rate_limit':
    case 'billing_error':
      return { state: 'rate_limited', reason: `usage limit: ${error}`, retryAfterMs: USAGE_LIMIT_WAIT_MS };
    default: // overloaded, server_error, model_not_found, invalid_request, max_output_tokens, unknown
      return { state: 'degraded', reason: error };
  }
}

/** A call that threw before or instead of a result: no connection, or the CLI failed to start. */
export function failureFromThrown(err: unknown): Failure {
  const code = errorCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  if (code || /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|network|socket hang up/i.test(msg)) return { state: 'offline', reason: code ?? 'network', needsProbe: true };
  if (/log ?in|logged out|authenticat|oauth|401/i.test(msg)) return { state: 'auth_failed', reason: 'login' };
  if (/usage limit|rate limit|429/i.test(msg)) return { state: 'rate_limited', reason: 'usage limit', retryAfterMs: USAGE_LIMIT_WAIT_MS };
  return { state: 'degraded', reason: 'claude_failed' };
}
