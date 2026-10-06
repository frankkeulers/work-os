import { API_ERROR_STATUS, type ApiErrorBody, type ApiErrorCode, type FieldIssue } from '@work-os/shared';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

// Errors leave the server as { code, message, issues? } with the status for the code, so the web
// app's ApiError reads them unchanged.

export class HttpError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly issues: FieldIssue[] = [],
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function sendError(reply: FastifyReply, code: ApiErrorCode, message: string, issues?: FieldIssue[]) {
  const body: ApiErrorBody = { code, message, ...(issues?.length && { issues }) };
  return reply.code(API_ERROR_STATUS[code]).header('cache-control', 'no-store').send(body);
}

export function errorHandler(err: FastifyError | Error, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) return sendError(reply, err.code, err.message, err.issues);
  const status = (err as FastifyError).statusCode;
  if (status === 413) return sendError(reply, 'validation', 'The request body is larger than 1 MB.');
  if (status && status >= 400 && status < 500) return sendError(reply, 'validation', err.message);
  req.log.error({ err, url: req.url, method: req.method }, 'Request failed');
  return sendError(reply, 'internal', 'Something went wrong in Work OS. The log has the details.');
}
