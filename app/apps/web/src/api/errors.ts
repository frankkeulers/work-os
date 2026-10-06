import { API_ERROR_STATUS, type ApiErrorCode, type FieldIssue } from '@work-os/shared';

// Typed API errors. Codes and status codes are shared with the Fastify server.
export type { ApiErrorCode, FieldIssue };

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly issues: FieldIssue[];

  constructor(code: ApiErrorCode, message: string, issues: FieldIssue[] = []) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = API_ERROR_STATUS[code];
    this.issues = issues;
  }
}

export const isApiError = (e: unknown): e is ApiError => e instanceof ApiError;
