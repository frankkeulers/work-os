import { Rules, Settings as SettingsSchema, type Rule, type Settings } from '@work-os/shared';
import { isApiError } from '../api/errors';

export interface Draft {
  settings: Settings;
  rules: Rule[];
}
export type Errors = Record<string, string>;

export interface EditorState {
  /** What the server last confirmed. */
  base: Draft | null;
  /** What the page shows, including fields that are invalid and so not saved. */
  draft: Draft | null;
  errors: Errors;
  /** A change is waiting to be saved, e.g. for the pause after typing. */
  pending: boolean;
  saving: boolean;
  failed: boolean;
}

export type SaveKind = 'saved' | 'undone';

export interface EditorDeps {
  save: (d: Draft) => Promise<{ savedAt: string }>;
  onSaved: (kind: SaveKind, undo: () => void) => void;
  onError: (e: unknown) => void;
  /** Pause after typing before a save, in ms. */
  delay?: number;
}

const friendly = (m: string) => (/expected number/.test(m) ? 'Enter a number' : m);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function validate(d: Draft): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const sp = SettingsSchema.safeParse(d.settings);
  if (!sp.success) for (const i of sp.error.issues) out.push({ path: ['settings', ...i.path].join('.'), message: friendly(i.message) });
  const rp = Rules.safeParse(d.rules);
  if (!rp.success) for (const i of rp.error.issues) out.push({ path: ['rules', ...i.path].join('.'), message: friendly(i.message) });
  return out;
}

function toErrors(issues: { path: string; message: string }[]): Errors {
  const e: Errors = {};
  for (const i of issues) e[i.path] ??= i.message;
  return e;
}

type Bag = Record<string, unknown>;
const getAt = (o: unknown, path: string) => path.split('.').reduce<unknown>((x, k) => (x as Bag | undefined)?.[k], o);
function setAt(o: unknown, path: string, v: unknown) {
  const keys = path.split('.');
  const parent = keys.slice(0, -1).reduce<unknown>((x, k) => (x as Bag | undefined)?.[k], o) as Bag | undefined;
  if (parent) parent[keys[keys.length - 1]] = v;
}

/**
 * What can be saved now: the draft with every invalid field put back to its saved value,
 * so one bad field doesn't hold up the others. Null if that still doesn't validate.
 */
export function savable(draft: Draft, base: Draft): { payload: Draft | null; errors: Errors } {
  const issues = validate(draft);
  if (!issues.length) return { payload: draft, errors: {} };
  const payload = structuredClone(draft);
  for (const i of issues) setAt(payload, i.path, structuredClone(getAt(base, i.path)));
  return { payload: validate(payload).length ? null : payload, errors: toErrors(issues) };
}

/** Autosaving editor for settings.json and rules.json. Lives outside React; the page subscribes. */
export class SettingsEditor {
  private state: EditorState = { base: null, draft: null, errors: {}, pending: false, saving: false, failed: false };
  private listeners = new Set<() => void>();
  private timer?: ReturnType<typeof setTimeout>;
  private queue: Promise<void> = Promise.resolve();
  private deps: EditorDeps;

  constructor(deps: EditorDeps) {
    this.deps = deps;
  }

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => void this.listeners.delete(l);
  };
  getState = () => this.state;
  private set(p: Partial<EditorState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l();
  }

  /** Takes the server's files. A change still waiting to save is kept. */
  receive(d: Draft) {
    const { draft, base } = this.state;
    const untouched = !draft || !base || same(draft, base);
    this.set({ base: d, draft: untouched ? d : draft });
  }

  /** Applies a change. Clicks save at once; typing saves after a pause, or on blur via flush(). */
  change(fn: (d: Draft) => void, when: 'now' | 'typing' = 'now') {
    if (!this.state.draft) return;
    const d = structuredClone(this.state.draft);
    fn(d);
    // Errors appear on the next save attempt, but clear as soon as the field is valid again.
    const still = toErrors(validate(d));
    const errors = Object.fromEntries(Object.entries(this.state.errors).filter(([k]) => k in still));
    // Pending from the first moment, so the page never says "saved" before the save has started.
    this.set({ draft: d, errors, pending: true });
    clearTimeout(this.timer);
    if (when === 'now') void this.flush();
    else this.timer = setTimeout(() => void this.flush(), this.deps.delay ?? 700);
  }

  /** Saves now whatever is waiting. Saves run one at a time, in order. */
  flush(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.queue = this.queue.then(() => this.save('saved'));
    return this.queue;
  }

  /** Invalid fields and changes still waiting to save. */
  unsaved() {
    return this.state.pending || this.state.saving || Object.keys(this.state.errors).length > 0;
  }

  dispose() {
    if (this.timer) void this.flush();
  }

  private revert(to: Draft) {
    clearTimeout(this.timer);
    this.set({ draft: to, errors: {}, pending: false });
    this.queue = this.queue.then(() => this.save('undone'));
  }

  private async save(kind: SaveKind) {
    const { draft, base } = this.state;
    if (!draft || !base) return;
    const { payload, errors } = savable(draft, base);
    this.set({ errors, pending: false });
    if (!payload || same(payload, base)) return;
    this.set({ saving: true, failed: false });
    try {
      await this.deps.save(payload);
      this.set({ base: payload });
      this.deps.onSaved(kind, () => this.revert(base));
    } catch (e) {
      if (isApiError(e) && e.code === 'validation' && e.issues) this.set({ errors: toErrors(e.issues.map((i) => ({ path: i.path, message: friendly(i.message) }))) });
      else this.set({ failed: true });
      this.deps.onError(e);
    } finally {
      this.set({ saving: false });
    }
  }
}
