import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeEdit } from '@work-os/shared';
import { SEED_RULES, SEED_SETTINGS } from '../mock/seed/config';
import { SettingsEditor, savable, type Draft, type SaveInfo, type SaveKind } from './settingsEditor';

const seed = (): Draft => structuredClone({ settings: SEED_SETTINGS, rules: SEED_RULES });

let saved: Draft[];
let toasts: { kind: SaveKind; undo: () => void; info: SaveInfo }[];
let editor: SettingsEditor;

beforeEach(() => {
  vi.useFakeTimers();
  saved = [];
  toasts = [];
  editor = new SettingsEditor({
    save: async (d) => {
      saved.push(structuredClone(d));
      return { savedAt: '2026-10-05T09:00:00.000Z' };
    },
    onSaved: (kind, undo, info) => toasts.push({ kind, undo, info }),
    onError: (e) => {
      throw e;
    },
    delay: 700,
  });
  editor.receive(seed());
});
afterEach(() => vi.useRealTimers());

describe('settings autosave (FR-1.3, FR-1.5)', () => {
  it('saves a click straight away', async () => {
    editor.change((d) => (d.settings.notifications.enabled = false));
    await editor.flush();
    expect(saved).toHaveLength(1);
    expect(saved[0].settings.notifications.enabled).toBe(false);
    expect(toasts.map((t) => t.kind)).toEqual(['saved']);
    expect(toasts[0].info).toEqual({ settings: true, rules: false });
  });

  it('waits for a pause in typing, then saves once', async () => {
    editor.change((d) => (d.settings.schedule.intervalWorkMinutes = 1), 'typing');
    editor.change((d) => (d.settings.schedule.intervalWorkMinutes = 15), 'typing');
    expect(editor.getState().pending).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(saved).toHaveLength(1);
    expect(saved[0].settings.schedule.intervalWorkMinutes).toBe(15);
    expect(editor.getState().pending).toBe(false);
  });

  it('holds back an invalid field but still saves the valid ones', async () => {
    editor.change((d) => (d.settings.schedule.intervalWorkMinutes = 0));
    editor.change((d) => (d.settings.retentionDays = 14));
    await editor.flush();
    const last = saved[saved.length - 1];
    expect(last.settings.retentionDays).toBe(14);
    expect(last.settings.schedule.intervalWorkMinutes).toBe(SEED_SETTINGS.schedule.intervalWorkMinutes);
    expect(editor.getState().errors['settings.schedule.intervalWorkMinutes']).toBeTruthy();
    expect(editor.getState().draft!.settings.schedule.intervalWorkMinutes).toBe(0);
    expect(editor.unsaved()).toBe(true);
  });

  it('clears an error as soon as the field is fixed', async () => {
    editor.change((d) => (d.settings.schedule.intervalWorkMinutes = 0));
    await editor.flush();
    expect(Object.keys(editor.getState().errors)).toHaveLength(1);
    editor.change((d) => (d.settings.schedule.intervalWorkMinutes = 20), 'typing');
    expect(editor.getState().errors).toEqual({});
    await vi.advanceTimersByTimeAsync(800);
    expect(saved[saved.length - 1].settings.schedule.intervalWorkMinutes).toBe(20);
  });

  it('undo puts the previous files back and saves them', async () => {
    editor.change((d) => (d.settings.people.vips = []));
    await editor.flush();
    toasts[0].undo();
    await editor.flush();
    expect(saved[saved.length - 1].settings.people.vips).toEqual(SEED_SETTINGS.people.vips);
    expect(toasts.map((t) => t.kind)).toEqual(['saved', 'undone']);
  });

  it('does not save when nothing changed', async () => {
    editor.change(() => {});
    await editor.flush();
    expect(saved).toHaveLength(0);
  });

  it('keeps a waiting change when the server sends new files', () => {
    editor.change((d) => (d.settings.retentionDays = 7), 'typing');
    editor.receive(seed());
    expect(editor.getState().draft!.settings.retentionDays).toBe(7);
  });
});

describe('savable', () => {
  it('returns the draft untouched when it is valid', () => {
    const d = seed();
    expect(savable(d, seed()).payload).toBe(d);
  });
  it('puts a bad regex in a rule back to its saved value', () => {
    const d = seed();
    const i = d.rules.findIndex((r) => r.conditions.some((c) => c.type === 'keyword'));
    const c = d.rules[i].conditions.find((x) => x.type === 'keyword')!;
    if (c.type === 'keyword') c.pattern = '/(unclosed/';
    const r = savable(d, seed());
    expect(Object.keys(r.errors).some((k) => k.startsWith(`rules.${i}`))).toBe(true);
    expect(r.payload).not.toBeNull();
  });
});

describe('a change made on the server meanwhile, such as Connect (FR-1.5)', () => {
  // A server that applies only what changed from the base the form sent, as PUT /api/settings does.
  let server: Draft;
  let sent: { d: Draft; base: Draft }[];
  let ed: SettingsEditor;
  const outlookOn = (d: Draft) => !!d.settings.sources?.outlook?.enabled;
  const connect = () => (server.settings = { ...server.settings, sources: { ...server.settings.sources, outlook: { ...server.settings.sources?.outlook, enabled: true } } });

  beforeEach(() => {
    server = seed();
    sent = [];
    toasts = [];
    ed = new SettingsEditor({
      save: async (d, base) => {
        sent.push(structuredClone({ d, base }));
        server = { settings: mergeEdit(server.settings, base.settings, d.settings), rules: mergeEdit(server.rules, base.rules, d.rules) };
        return { savedAt: '2026-10-05T09:00:00.000Z', ...structuredClone(server) };
      },
      onSaved: (kind, undo, info) => toasts.push({ kind, undo, info }),
      onError: (e) => {
        throw e;
      },
      delay: 700,
    });
    ed.receive(seed());
    expect(outlookOn(server)).toBe(false);
  });

  it('a save before the form has caught up with Connect leaves Outlook on, and the form then shows it on', async () => {
    connect();
    ed.change((d) => (d.settings.dryRun = !d.settings.dryRun));
    await ed.flush();
    expect(sent[0].base).toEqual(seed()); // what the form had when the change was made
    expect(outlookOn(server)).toBe(true);
    expect(server.settings.dryRun).toBe(!SEED_SETTINGS.dryRun);
    expect(outlookOn(ed.getState().base!)).toBe(true);
    expect(outlookOn(ed.getState().draft!)).toBe(true);
  });

  it('keeps an edit still waiting to save when the server’s files arrive, on top of them', async () => {
    ed.change((d) => (d.settings.schedule.intervalWorkMinutes = 15), 'typing');
    connect();
    ed.receive(structuredClone(server));
    expect(ed.getState().draft!.settings.schedule.intervalWorkMinutes).toBe(15);
    expect(outlookOn(ed.getState().draft!)).toBe(true);
    await vi.advanceTimersByTimeAsync(800);
    expect(server.settings.schedule.intervalWorkMinutes).toBe(15);
    expect(outlookOn(server)).toBe(true);
  });

  it('undo takes back only that change, not Connect’s', async () => {
    ed.change((d) => (d.settings.dryRun = !d.settings.dryRun));
    await ed.flush();
    connect();
    toasts[0].undo();
    await ed.flush();
    expect(server.settings.dryRun).toBe(SEED_SETTINGS.dryRun);
    expect(outlookOn(server)).toBe(true);
    expect(toasts.map((t) => t.kind)).toEqual(['saved', 'undone']);
  });
});
