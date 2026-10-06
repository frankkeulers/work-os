// API error codes and the HTTP status the server returns for each. The web app wraps them in ApiError.
export type ApiErrorCode =
  | 'network' // 0: server unreachable
  | 'not_found' // 404
  | 'conflict' // 409: state changed under you
  | 'validation' // 422: settings or rules failed zod validation
  | 'forbidden' // 403: blocked by policy (people observations, allow-list)
  | 'budget'; // 429: daily budget reached (CL-6)

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  network: 0,
  not_found: 404,
  conflict: 409,
  validation: 422,
  forbidden: 403,
  budget: 429,
};

export interface FieldIssue {
  path: string; // dotted path, e.g. "settings.schedule.intervalWorkMinutes" or "rules.3.conditions.0.pattern"
  message: string;
}
