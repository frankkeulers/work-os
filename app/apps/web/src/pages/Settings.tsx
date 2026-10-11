import { useEffect, useState, useSyncExternalStore } from 'react';
import { Navigate, NavLink, useBlocker, useLocation, useParams } from 'react-router';
import type { Settings } from '@work-os/shared';
import { api, isApiError } from '../api';
import { HealthBanner } from '../components/HealthBanner';
import { Icon } from '../components/icons';
import { ConfirmDialog, Spinner, cx } from '../components/ui';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useHashScroll } from '../hooks/useHashScroll';
import { useNow } from '../hooks/useNow';
import { fmtDayDate, fmtTime } from '../lib/format';
import { SettingsEditor, type EditorState, type SaveInfo } from '../lib/settingsEditor';
import { usePrefs } from '../store/prefs';
import { errorToast, toast } from '../store/toasts';
import { LEGACY_ANCHORS, SECTIONS, type Confirm, type Ctx } from './settings/sections';
import { NotificationBell } from '../components/NotificationBell';

const GROUPS = ['Account', 'Inbox', 'Sources', 'Actions', 'Claude', 'System'] as const;

function SaveStatus({ st, savedAt, onRetry }: { st: EditorState; savedAt: string; onRetry: () => void }) {
  const now = useNow(60_000);
  const errs = Object.keys(st.errors).length;
  const when = fmtDayDate(savedAt) === fmtDayDate(now.toISOString()) ? fmtTime(savedAt) : `${fmtDayDate(savedAt)}, ${fmtTime(savedAt)}`;
  return (
    <div data-testid="saved-note" aria-live="polite" className="inline-flex min-h-9 items-center gap-1.5 text-[13px] text-muted">
      {st.saving || st.pending ? (
        <>
          <Spinner size={12} /> Saving…
        </>
      ) : errs ? (
        <span className="inline-flex items-center gap-1.5 text-red-fg">
          <Icon name="alert" size={14} /> {errs} {errs === 1 ? 'field' : 'fields'} not saved
        </span>
      ) : st.failed ? (
        <span className="inline-flex items-center gap-1.5 text-red-fg">
          <Icon name="alert" size={14} /> Couldn’t save.
          <button type="button" className="font-medium text-accent hover:underline cursor-pointer" onClick={onRetry}>
            Try again
          </button>
        </span>
      ) : (
        <>
          <Icon name="check" size={14} className="text-green-fg" /> All changes saved · {when}
        </>
      )}
    </div>
  );
}

const savedText = ({ settings, rules }: SaveInfo) =>
  settings && rules ? 'Logged as settings.changed and rules.changed.' : rules ? 'Logged as rules.changed.' : 'Logged as settings.changed.';

export function SettingsPage() {
  const { section: sectionId } = useParams();
  const { hash } = useLocation();
  const q = useApiQuery(() => api.getSettings(), onTopics('settings'), []);
  const usage = useApiQuery(() => api.getUsage(), onTopics('usage'), []);
  const full = usePrefs((s) => s.scope === 'full');
  const view = q.data;

  const [editor] = useState(
    () =>
      new SettingsEditor({
        save: (d, base) => api.saveSettings(d.settings, d.rules, base),
        onSaved: (kind, undo, info) =>
          toast(kind === 'undone' ? 'Change undone' : 'Changes saved', {
            tone: 'success',
            key: 'settings-saved',
            description: kind === 'undone' ? 'The previous value is back.' : savedText(info),
            action: kind === 'saved' ? { label: 'Undo', run: undo } : undefined,
          }),
        onError: (e) => {
          if (!(isApiError(e) && e.code === 'validation')) errorToast(e);
        },
      }),
  );
  const st = useSyncExternalStore(editor.subscribe, editor.getState);
  useEffect(() => {
    if (view) editor.receive({ settings: view.settings, rules: view.rules });
  }, [view, editor]);
  // Anything still waiting for its typing pause is saved on the way out.
  useEffect(() => () => editor.dispose(), [editor]);

  const [confirm, setConfirm] = useState<Confirm | null>(null);
  // A prompt file open with unsaved text (its label), from the Prompts section.
  const [unsavedPrompt, setUnsavedPrompt] = useState<string | null>(null);
  const errorPaths = Object.keys(st.errors);
  const unsaved = st.pending || st.saving || errorPaths.length > 0 || !!unsavedPrompt;
  // Moving between sections keeps every change. Only leaving Settings with an invalid field loses
  // anything, or leaving the Prompts section with a prompt file edited but not saved.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      (Object.keys(editor.getState().errors).length > 0 && !nextLocation.pathname.startsWith('/settings')) || (!!unsavedPrompt && nextLocation.pathname !== currentLocation.pathname),
  );
  useHashScroll(!!st.draft);
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  const section = SECTIONS.find((x) => x.id === sectionId);
  useEffect(() => {
    document.title = `${section ? `${section.label} · ` : ''}Settings · Work OS`;
  }, [section]);

  if (!section) {
    // /settings and the old single-page anchors (/settings#budgets) land on the right view.
    const legacy = LEGACY_ANCHORS[hash.slice(1)];
    return <Navigate replace to={`/settings/${legacy ?? SECTIONS[0].id}`} />;
  }
  if (!view || !st.draft) return <div className="p-8 text-muted">{q.error ? 'Could not load settings.' : 'Loading…'}</div>;

  const draft = st.draft;
  const ctx: Ctx = {
    s: draft.settings,
    rules: draft.rules,
    view,
    usage: usage.data,
    full,
    set: (fn: (s: Settings) => void) => editor.change((d) => fn(d.settings)),
    type: (fn: (s: Settings) => void) => editor.change((d) => fn(d.settings), 'typing'),
    flush: () => void editor.flush(),
    setRules: (rules) => editor.change((d) => (d.rules = rules)),
    err: (path) => st.errors[`settings.${path}`],
    ruleError: (i) => Object.entries(st.errors).find(([k]) => k.startsWith(`rules.${i}.`) || k === `rules.${i}`)?.[1],
    confirm: setConfirm,
    setUnsaved: setUnsavedPrompt,
  };
  const { View } = section;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* 64px, like the Inbox top bar, lined up with the sidebar's header. It stays put; the body below scrolls. */}
      <header className="flex h-16 shrink-0 items-center border-b border-line px-8">
        <div className="flex max-w-[1008px] flex-1 items-center gap-x-6">
          <h1 className="m-0 flex-1 text-xl font-semibold tracking-[-0.01em]">Settings &amp; rules</h1>
          <SaveStatus st={st} savedAt={view.savedAt} onRetry={ctx.flush} />
        </div>
        <div className="ml-auto pl-4">
          <NotificationBell />
        </div>
      </header>
      <div data-page-scroll className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-[1072px] px-8 pt-6 empty:hidden">
          <HealthBanner />
        </div>
        <div className="flex max-w-[1072px] items-start gap-12 px-8 pb-24 pt-8">
          <nav aria-label="Settings sections" className="sticky top-8 flex w-[200px] shrink-0 flex-col gap-6">
            {GROUPS.map((g) => (
              <div key={g} className="flex flex-col gap-0.5">
                <span className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">{g}</span>
                {SECTIONS.filter((x) => x.group === g && (full || !x.fullOnly)).map((x) => {
                  const hasError = errorPaths.some(x.owns);
                  return (
                    <NavLink
                      key={x.id}
                      to={`/settings/${x.id}`}
                      className={({ isActive }) =>
                        cx('flex min-h-9 items-center gap-2 rounded-md px-3 text-sm no-underline', isActive ? 'bg-track font-medium !text-ink' : '!text-ink-2 hover:bg-surface-2 hover:!text-ink')
                      }
                    >
                      <span className="flex-1">{x.label}</span>
                      {x.id === 'writing' && draft.settings.dryRun && <span className="rounded bg-amber-wash px-1.5 py-px text-[11px] font-medium text-amber-fg">Dry-run</span>}
                      {hasError && (
                        <span className="h-2 w-2 rounded-full bg-red" title="Has a field that isn’t saved">
                          <span className="sr-only">(has an unsaved field)</span>
                        </span>
                      )}
                    </NavLink>
                  );
                })}
              </div>
            ))}
          </nav>
          <main className="flex min-w-0 max-w-[760px] flex-1 flex-col" aria-label={section.label}>
            <View {...ctx} />
          </main>
        </div>
      </div>

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            confirm.run();
            setConfirm(null);
          }}
        />
      )}
      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title="Leave with unsaved changes?"
          body={
            unsavedPrompt
              ? `Your edit to ${unsavedPrompt} isn’t saved. Leaving drops it; the file stays as it was.`
              : `${errorPaths.length} ${errorPaths.length === 1 ? 'field has an error, so it wasn’t' : 'fields have errors, so they weren’t'} saved. Leaving drops ${errorPaths.length === 1 ? 'that change' : 'those changes'}; everything else is already saved.`
          }
          confirmLabel="Leave"
          danger
          onCancel={() => blocker.reset()}
          onConfirm={() => {
            setUnsavedPrompt(null);
            blocker.proceed();
          }}
        />
      )}
    </div>
  );
}
