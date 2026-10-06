import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { FastifyReply, FastifyRequest } from 'fastify';

// Large JSON views (the inbox, NF-11): an ETag from the body, so an unchanged view costs a 304, and
// gzip above 8 KB. Still `no-store`: summaries paraphrase messages and must not outlive retention
// in the browser's disk cache. The web client keeps the last body in memory and revalidates itself.

export const GZIP_MIN_BYTES = 8 * 1024;

const matches = (header: string | undefined, etag: string) =>
  !!header &&
  header
    .split(',')
    .map((t) => t.trim().replace(/^W\//, ''))
    .some((t) => t === etag || t === '*');

export function sendJson(req: FastifyRequest, reply: FastifyReply, value: unknown) {
  const body = Buffer.from(JSON.stringify(value));
  const etag = `"${createHash('sha1').update(body).digest('base64url')}"`;
  reply.headers({ 'cache-control': 'no-store', etag, vary: 'accept-encoding' });
  if (matches(req.headers['if-none-match'], etag)) return reply.code(304).send();
  reply.type('application/json; charset=utf-8');
  const accepts = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
  if (body.length >= GZIP_MIN_BYTES && accepts) return reply.header('content-encoding', 'gzip').send(gzipSync(body, { level: 1 }));
  return reply.send(body);
}
