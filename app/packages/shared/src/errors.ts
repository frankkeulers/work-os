// API error codes and the HTTP status the server returns for each. The web app wraps them in ApiError.
export type ApiErrorCode =
  | 'network' // 0: server unreachable
  | 'timeout' // 0: no answer in time; the request may still finish (web client only)
  | 'not_found' // 404
  | 'conflict' // 409: state changed under you
  | 'validation' // 422: settings or rules failed zod validation
  | 'forbidden' // 403: blocked by policy (people observations, allow-list)
  | 'budget' // 429: daily budget reached (CL-6)
  | 'unauthorized' // 401: missing or wrong bearer token (FR-3.3)
  | 'unavailable' // 503: shutting down, read-only after a full disk, or safe mode (FR-14.6)
  | 'internal'; // 500: a server bug; the log has the details

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  network: 0,
  timeout: 0,
  not_found: 404,
  conflict: 409,
  validation: 422,
  forbidden: 403,
  budget: 429,
  unauthorized: 401,
  unavailable: 503,
  internal: 500,
};

/** The JSON body of every error response. */
export interface ApiErrorBody {
  code: ApiErrorCode;
  message: string;
  issues?: FieldIssue[];
}

export interface FieldIssue {
  path: string; // dotted path, e.g. "settings.schedule.intervalWorkMinutes" or "rules.3.conditions.0.pattern"
  message: string;
}
