import { execFile } from 'node:child_process';
import { Agent, request } from 'node:http';
import { promisify } from 'node:util';

// Small measuring tools for `npm run perf` (NF-11): percentiles, a keep-alive HTTP client that
// shows the bytes on the wire, an SSE reader, and process RSS and CPU from ps.

export function percentile(samples: number[], p: number): number {
  if (!samples.length) return NaN;
  const sorted = [...samples].sort((a, b) => a - b);
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}

export const round = (n: number, digits = 1) => Math.round(n * 10 ** digits) / 10 ** digits;

export interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer; // as sent: compressed if the server compressed it
  ms: number;
}

export class Client {
  private agent = new Agent({ keepAlive: true, maxSockets: 4 });

  constructor(
    readonly base: string,
    private readonly token: string,
  ) {}

  call(method: string, path: string, opts: { headers?: Record<string, string>; json?: unknown } = {}): Promise<HttpResult> {
    const payload = opts.json === undefined ? undefined : Buffer.from(JSON.stringify(opts.json));
    const headers: Record<string, string> = { authorization: `Bearer ${this.token}`, ...opts.headers };
    if (payload) headers['content-type'] = 'application/json';
    const t0 = performance.now();
    return new Promise((resolve, reject) => {
      const req = request(this.base + path, { method, headers, agent: this.agent }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks), ms: performance.now() - t0 }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  close() {
    this.agent.destroy();
  }
}

/** Reads /api/events and calls back with each message's arrival time. */
export function openEvents(base: string, token: string, onMessage: (data: string, at: number) => void): Promise<() => void> {
  return new Promise((resolve, reject) => {
    const req = request(`${base}/api/events`, { headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) return reject(new Error(`events answered ${res.statusCode}`));
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        const at = performance.now();
        buf += chunk;
        let end: number;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, end);
          buf = buf.slice(end + 2);
          const data = block
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .join('\n');
          if (data) onMessage(data, at);
        }
      });
      res.on('error', () => undefined);
      resolve(() => req.destroy());
    });
    req.on('error', reject);
    req.end();
  });
}

const run = promisify(execFile);

/** Resident memory in MB and CPU time used so far in ms, from ps. */
export async function processStats(pid: number): Promise<{ rssMb: number; cpuMs: number }> {
  const { stdout } = await run('/bin/ps', ['-o', 'rss=,time=', '-p', String(pid)]);
  const [rss, time] = stdout.trim().split(/\s+/);
  // time is [[hh:]mm:]ss.cc
  const parts = time.split(':').map(Number);
  const seconds = parts.reduce((acc, v) => acc * 60 + v, 0);
  return { rssMb: Number(rss) / 1024, cpuMs: seconds * 1000 };
}
