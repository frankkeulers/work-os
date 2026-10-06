import { readFile, readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

// Serves the built web app (NF-11 first paint). index.html is sent with the API token in a meta
// tag and `no-store`, so a restart's page always carries the current token. Hashed files under
// /assets/ are immutable, with precompressed brotli or gzip copies when the build made them.
// Everything is read once into memory: the build is about 1 MB.

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
};

type Asset = { body: Buffer; br?: Buffer; gz?: Buffer; type: string };

export const injectToken = (html: string, token: string) => html.replace('</head>', `<meta name="workos-token" content="${token}">\n</head>`);

async function loadDist(dir: string): Promise<Map<string, Asset>> {
  const files = new Map<string, Asset>();
  const entries = (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
  const all = new Map(await Promise.all(entries.map(async (e) => [join(e.parentPath, e.name), await readFile(join(e.parentPath, e.name))] as const)));
  for (const [path, body] of all) {
    if (path.endsWith('.br') || path.endsWith('.gz')) continue;
    const url = `/${path.slice(dir.length + 1).split('\\').join('/')}`;
    files.set(url, { body, br: all.get(`${path}.br`), gz: all.get(`${path}.gz`), type: TYPES[extname(path)] ?? 'application/octet-stream' });
  }
  return files;
}

function send(req: FastifyRequest, reply: FastifyReply, asset: Asset, cache: string) {
  const accept = String(req.headers['accept-encoding'] ?? '');
  reply.header('content-type', asset.type).header('cache-control', cache).header('vary', 'accept-encoding');
  if (asset.br && /\bbr\b/.test(accept)) return reply.header('content-encoding', 'br').send(asset.br);
  if (asset.gz && /\bgzip\b/.test(accept)) return reply.header('content-encoding', 'gzip').send(asset.gz);
  return reply.send(asset.body);
}

export async function registerStatic(app: FastifyInstance, opts: { dir?: string; token: string }) {
  const files = opts.dir ? await loadDist(opts.dir).catch(() => undefined) : undefined;
  const index = files?.get('/index.html');
  const page = index && Buffer.from(injectToken(index.body.toString('utf8'), opts.token));

  app.get('/*', (req, reply) => {
    const path = req.url.split('?')[0];
    if (path.startsWith('/api/')) return reply.code(404).send({ code: 'not_found', message: 'No such API route.' });
    if (!page) {
      const msg = '<!doctype html><title>Work OS</title><p>The web app is not built into this server. In development, open the Vite address instead.</p>';
      return reply.code(503).header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store').send(msg);
    }
    const asset = files?.get(path);
    if (asset && path !== '/index.html') return send(req, reply, asset, path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    // Any other path is a client-side route: serve the app.
    return send(req, reply, { body: page, type: TYPES['.html'] }, 'no-store');
  });
}
