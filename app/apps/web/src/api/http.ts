import type { Action, ActionType, ApiErrorBody, ConfluenceCatalogueView, CorrectionInput, GuideFilesView, EarlierView, EvalReport, HealthView, InboxView, ItemView, Notice, PersonOption, PromptFileId, PromptFileView, Rule, Settings, SettingsView, UsageView, WorkOsApi } from '@work-os/shared';
import { ApiError } from './errors';

// The real client: HTTP to the local server plus a server-sent event stream for change notices
// (PLAN.md "Web client"). The stream is read with fetch, not EventSource, so it can send the
// bearer token and Last-Event-ID.
//
// Connection: the stream open → up. An error, or 45 s without even a ping → reconnecting, with
// retries after 0.5, 1, 2, then every 5 s. More than 15 s without a connection → down. Each change
// is announced as a health notice, so the UI asks for /api/health again.

export type Connection = HealthView['connection'];

const SILENCE_MS = 45_000; // the server pings every 20 s
const DOWN_AFTER_MS = 15_000;
const BACKOFF_MS = [500, 1000, 2000, 5000];

/** The token the server puts in index.html. In development Vite's proxy adds it instead. */
function readToken(): string | undefined {
  return document.querySelector<HTMLMetaElement>('meta[name="workos-token"]')?.content || undefined;
}

export class HttpApi implements WorkOsApi {
  private listeners = new Set<(n: Notice) => void>();
  private conn: Connection = 'up'; // until shown otherwise: the first queries find out
  private lastEventId?: string;
  private lostAt?: number;
  private attempt = 0;
  private stream?: AbortController;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private silenceTimer?: ReturnType<typeof setTimeout>;
  private lastHealth?: HealthView;
  private inbox?: { etag: string; view: InboxView }; // memory only: never the browser's disk cache

  constructor(
    private readonly base = '',
    private readonly token = readToken(),
    private readonly fetchFn: typeof fetch = (...a) => fetch(...a),
    private readonly onUnauthorised: () => void = () => location.reload(),
  ) {}

  now() {
    return new Date();
  }

  get connection(): Connection {
    return this.conn;
  }

  // ---------------------------------------------------------------- requests

  private async send(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Response> {
    const headers: Record<string, string> = { ...extra };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await this.fetchFn(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      this.lost();
      throw new ApiError('network', 'Work OS server is not reachable on 127.0.0.1.');
    }
    // The server never answers 502 or 504; a proxy in front of it does (Vite in development) when
    // the server is down. That is the same as not reaching it.
    if (res.status === 502 || res.status === 504) {
      await res.body?.cancel().catch(() => undefined);
      this.lost();
      throw new ApiError('network', 'Work OS server is not reachable on 127.0.0.1.');
    }
    if (res.status === 401) {
      // A new token after a restart from a fresh Keychain entry: the page has the old one.
      this.onUnauthorised();
      throw new ApiError('unauthorized', 'The page is out of date. Reloading.');
    }
    if (!res.ok && res.status !== 304) {
      const err = (await res.json().catch(() => undefined)) as ApiErrorBody | undefined;
      throw new ApiError(err?.code ?? (res.status === 503 ? 'unavailable' : 'internal'), err?.message ?? `Work OS answered ${res.status}.`, err?.issues);
    }
    return res;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, body);
    if (res.status === 204 || res.status === 202) return undefined as T;
    return (await res.json()) as T;
  }

  private get = <T>(path: string) => this.request<T>('GET', path);
  private post = <T = void>(path: string, body?: unknown) => this.request<T>('POST', path, body ?? {});
  private item = (id: string) => `/api/items/${encodeURIComponent(id)}`;
  private action = (id: string) => `/api/actions/${encodeURIComponent(id)}`;

  /** Health from the server; while it is unreachable, a view that says so. */
  async getHealth(): Promise<HealthView> {
    if (this.conn !== 'up' && this.lastHealth) return { ...this.lastHealth, connection: this.conn };
    try {
      const h = await this.get<HealthView>('/api/health');
      this.lastHealth = h;
      return { ...h, connection: this.conn === 'down' ? 'reconnecting' : 'up' };
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'network') throw e;
      return {
        connection: this.conn === 'up' ? 'reconnecting' : this.conn,
        mode: 'degraded',
        phase: 'running',
        deps: [],
        checks: [],
        checkedAt: new Date().toISOString(),
        outbox: { approved: 0, waiting: 0 },
        instance: 'prod',
        version: '',
        startedAt: '',
      };
    }
  }

  recheck = () => this.post('/api/health/recheck');
  /** The inbox, revalidated with its ETag: unchanged, it costs a 304 and the copy held here. */
  getInbox = async (): Promise<InboxView> => {
    const held = this.inbox;
    const res = await this.send('GET', '/api/inbox', undefined, held ? { 'if-none-match': held.etag } : {});
    if (res.status === 304 && held) return held.view;
    const view = (await res.json()) as InboxView;
    const etag = res.headers.get('etag');
    this.inbox = etag ? { etag, view } : undefined;
    return view;
  };
  getItem = (id: string) => this.get<ItemView>(this.item(id));
  getEarlier = (id: string) => this.get<EarlierView>(`${this.item(id)}/earlier`);
  getChannels = () => this.get<string[]>('/api/channels');
  getPeople = () => this.get<PersonOption[]>('/api/people');
  getConfluenceCatalogue = () => this.get<ConfluenceCatalogueView>('/api/confluence/catalogue');
  getGuide = () => this.get<GuideFilesView>('/api/guide');
  getUsage = () => this.get<UsageView>('/api/usage');
  getEvalReports = () => this.get<EvalReport[]>('/api/evals');
  getSettings = () => this.get<SettingsView>('/api/settings');

  pollNow = () => this.post('/api/poll');
  markDone = (id: string) => this.post(`${this.item(id)}/done`);
  reopen = (id: string) => this.post(`${this.item(id)}/reopen`);
  markDoneMany = (ids: string[]) => this.post<{ count: number }>('/api/items/done', { ids });
  reopenMany = (ids: string[]) => this.post<{ count: number }>('/api/items/reopen', { ids });
  snooze = (id: string, until: string) => this.post(`${this.item(id)}/snooze`, { until });
  correctTriage = (id: string, input: CorrectionInput) => this.post<{ labelCount: number }>(`${this.item(id)}/correction`, input);
  retryTriage = (id: string) => this.post(`${this.item(id)}/retry-triage`);
  markAskDone = (id: string, askId: string) => this.post(`${this.item(id)}/asks/${encodeURIComponent(askId)}/done`);
  splitPiece = (pieceId: string) => this.post(`${this.item(pieceId)}/split`);
  regroup = (conversation: string) => this.post<{ merged: number }>('/api/topics/regroup', { conversation });

  requestDraft = (itemId: string, type: ActionType) => this.post<Action>(`${this.item(itemId)}/actions`, { type });
  cancelDraft = (id: string) => this.post(`${this.action(id)}/cancel`);
  saveDraftEdit = (id: string, content: string) => this.request<void>('PUT', `${this.action(id)}/draft`, { content });
  redraft = (id: string) => this.post<Action>(`${this.action(id)}/redraft`);
  discardAction = (id: string) => this.post(`${this.action(id)}/discard`);
  approveAction = (id: string) => this.post(`${this.action(id)}/approve`);

  runEval = () => this.post('/api/evals');
  rebuildState = () => this.post<{ events: number }>('/api/admin/rebuild-state');
  saveSettings = (settings: Settings, rules: Rule[]) => this.request<{ savedAt: string }>('PUT', '/api/settings', { settings, rules });
  getPrompts = () => this.get<PromptFileView[]>('/api/prompts');
  savePrompt = (id: PromptFileId, text: string, baseVersion: string) => this.request<PromptFileView>('PUT', `/api/prompts/${id}`, { text, baseVersion });
  resetPrompt = (id: PromptFileId, baseVersion: string) => this.post<PromptFileView>(`/api/prompts/${id}/reset`, { baseVersion });
  markPromptReviewed = (id: PromptFileId, baseVersion: string) => this.post<PromptFileView>(`/api/prompts/${id}/reviewed`, { baseVersion });

  // ---------------------------------------------------------------- notices

  subscribe(onNotice: (n: Notice) => void) {
    this.listeners.add(onNotice);
    if (this.listeners.size === 1) this.connect();
    return () => {
      this.listeners.delete(onNotice);
      if (!this.listeners.size) this.disconnect();
    };
  }

  private emit(...notices: Notice[]) {
    for (const n of notices) for (const l of [...this.listeners]) l(n);
  }

  private setConnection(next: Connection) {
    if (next === this.conn) return;
    this.conn = next;
    this.emit({ topic: 'health' });
  }

  /** A request failed to connect: the stream will notice too, but say so now. */
  private lost() {
    if (this.conn === 'up') {
      this.lostAt = Date.now();
      this.setConnection('reconnecting');
    }
  }

  private disconnect() {
    this.stream?.abort();
    this.stream = undefined;
    clearTimeout(this.retryTimer);
    clearTimeout(this.silenceTimer);
  }

  private connect() {
    this.disconnect();
    const ctrl = new AbortController();
    this.stream = ctrl;
    void this.read(ctrl).catch(() => undefined);
  }

  private resetSilence(ctrl: AbortController) {
    clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => ctrl.abort(new Error('silent')), SILENCE_MS);
  }

  private async read(ctrl: AbortController) {
    const headers: Record<string, string> = { accept: 'text/event-stream' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    if (this.lastEventId) headers['last-event-id'] = this.lastEventId;
    try {
      const res = await this.fetchFn(`${this.base}/api/events`, { headers, signal: ctrl.signal, cache: 'no-store' });
      if (res.status === 401) return this.onUnauthorised();
      if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);
      const wasDown = this.conn !== 'up';
      this.attempt = 0;
      this.lostAt = undefined;
      this.setConnection('up');
      if (wasDown) this.emit({ topic: 'inbox' }, { topic: 'usage' }, { topic: 'settings' }, { topic: 'evals' });
      this.resetSilence(ctrl);
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        this.resetSilence(ctrl);
        buf += value;
        let end: number;
        while ((end = buf.indexOf('\n\n')) >= 0) {
          this.onMessage(buf.slice(0, end));
          buf = buf.slice(end + 2);
        }
      }
    } catch {
      // Reconnect below.
    }
    clearTimeout(this.silenceTimer);
    if (this.stream !== ctrl || !this.listeners.size) return; // replaced or unsubscribed
    this.lostAt ??= Date.now();
    this.setConnection(Date.now() - this.lostAt > DOWN_AFTER_MS ? 'down' : 'reconnecting');
    const wait = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)];
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private onMessage(block: string) {
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // a comment: ping or "connected"
      const i = line.indexOf(':');
      const field = i < 0 ? line : line.slice(0, i);
      const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (id) this.lastEventId = id;
    if (event === 'reset') {
      // The server restarted or we missed too much: refetch everything.
      this.lastEventId = undefined;
      this.emit({ topic: 'health' }, { topic: 'inbox' }, { topic: 'usage' }, { topic: 'settings' }, { topic: 'evals' });
      return;
    }
    if (event === 'shutdown') {
      this.lostAt = Date.now();
      this.stream?.abort();
      return;
    }
    if (event !== 'message' || !data.length) return;
    try {
      this.emit(JSON.parse(data.join('\n')) as Notice);
    } catch {
      // Not ours; ignore.
    }
  }
}
