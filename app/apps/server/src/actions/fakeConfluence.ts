import type { FetchFn } from '../net/probe';

// A made-up Confluence for tests and `--fakes` runs: the two REST v2 calls filing uses, with
// versions, version messages and a 409 when a save is not exactly the next version. Never the
// real site.

export const FAKE_CONFLUENCE_CREDS = 'frank@example.com:fake-confluence-token';

interface FakePage {
  title: string;
  version: number;
  message: string;
  storage: string;
}

export class FakeConfluence {
  pages = new Map<string, FakePage>();
  calls: { method: string; id: string; version?: number }[] = [];
  /** Answers the next calls with these HTTP statuses instead, in order. */
  failNext: number[] = [];
  /** Throws (as a dropped connection would) on the next call. */
  dropNext = false;

  page(id: string, title: string, storage: string, version = 7) {
    this.pages.set(id, { title, version, message: '', storage });
    return this;
  }

  /** Someone else saves the page. */
  edit(id: string, storage: string) {
    const p = this.pages.get(id)!;
    this.pages.set(id, { ...p, storage, version: p.version + 1, message: 'Edited in Confluence' });
  }

  fetch: FetchFn = async (url, init) => {
    const m = /\/wiki\/api\/v2\/pages\/([^/?]+)/.exec(url);
    const method = init?.method ?? 'GET';
    const id = decodeURIComponent(m?.[1] ?? '');
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (this.dropNext) {
      this.dropNext = false;
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    }
    const forced = this.failNext.shift();
    if (forced) return json(forced, { message: `forced ${forced}` });
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Basic ${Buffer.from(FAKE_CONFLUENCE_CREDS).toString('base64')}`) return json(401, { message: 'Unauthorized' });
    const page = this.pages.get(id);
    if (!m || !page) return json(404, { message: 'Not found' });
    if (method === 'GET') {
      this.calls.push({ method, id });
      return json(200, { id, title: page.title, version: { number: page.version, message: page.message }, body: { storage: { value: page.storage, representation: 'storage' } } });
    }
    if (method === 'PUT') {
      const body = JSON.parse(String(init?.body)) as { title: string; body: { value: string }; version: { number: number; message: string } };
      this.calls.push({ method, id, version: body.version.number });
      if (body.version.number !== page.version + 1) return json(409, { message: 'Version conflict' });
      this.pages.set(id, { title: body.title, version: body.version.number, message: body.version.message, storage: body.body.value });
      return json(200, { id, title: body.title, version: { number: body.version.number, message: body.version.message } });
    }
    return json(405, { message: 'Method not allowed' });
  };
}

/** For runs that must never reach Confluence: any call fails loudly. */
export const noConfluence: FetchFn = () => Promise.reject(new Error('This run may not call Confluence.'));
