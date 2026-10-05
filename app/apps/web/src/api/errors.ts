// Typed API errors. Status codes mirror what the Fastify server will return.
export type ApiErrorCode =
  | 'network' // 0: server unreachable
  | 'not_found' // 404
  | 'conflict' // 409: state changed under you
  | 'validation' // 422: settings or rules failed zod validation
  | 'forbidden' // 403: blocked by policy (people observations, allow-list)
  | 'budget'; // 429: daily budget reached (CL-6)

const STATUS: Record<ApiErrorCode, number> = {
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

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly issues: FieldIssue[];

  constructor(code: ApiErrorCode, message: string, issues: FieldIssue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = STATUS[code];
    this.issues = issues;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
