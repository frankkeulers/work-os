import { useEffect, useState, type ReactNode } from 'react';
import { Link, useBlocker } from 'react-router';
import type { ModelId, Rule, Settings } from '@work-os/shared';
import { api, isApiError, type CheckStatus, type SettingsView } from '../api';
import { Icon } from '../components/icons';
import { RulesList } from '../components/Rules';
import { Button, ConfirmDialog, FutureButton, IconButton, MvpTag, PhaseTag, Segmented, Spinner, Switch, cx, inputBase, inputClass } from '../components/ui';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useHashScroll } from '../hooks/useHashScroll';
import { fmtDayDate, fmtMoney, fmtTime } from '../lib/format';
import { usePrefs, type Theme } from '../store/prefs';
import { errorToast, toast } from '../store/toasts';

interface Draft {
  settings: Settings;
  rules: Rule[];
}
type Errors = Record<string, string>;

const SECTIONS = [
  ['rules', 'Rules'],
  ['sources', 'Sources'],
  ['models', 'Triage & models'],
  ['budgets', 'Budgets'],
  ['targets', 'Write targets'],
  ['notify', 'Notifications'],
  ['storage', 'Storage & safety'],
] as const;

const friendly = (m: string) => (/expected number/.test(m) ? 'Enter a number' : m);

// ---------- Field primitives ----------

function Section({ id, title, mvp = true, note, children, action }: { id: string; title: string; mvp?: boolean; note?: string; children: ReactNode; action?: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`h-${id}`} className="flex scroll-mt-20 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 id={`h-${id}`} className="m-0 text-lg font-semibold">
          {title}
        </h2>
        {mvp && <MvpTag />}
        {note && <span className="flex-[1_1_300px] text-[13px] text-muted">{note}</span>}
        {action}
      </div>
      {children}
    </section>
  );
}

const Card = ({ children, className }: { children: ReactNode; className?: string }) => <div className={cx('rounded-xl border border-line bg-surface', className)}>{children}</div>;

function NumField({ label, value, onChange, error, suffix, help, step, width = 'w-[110px]', id }: { label: string; value: number; onChange: (v: number) => void; error?: string; suffix?: string; help?: ReactNode; step?: string; width?: string; id?: string }) {
  return (
    <label className="flex flex-col gap-1.5 text-[13px] font-medium" data-field={id}>
      {label}
      <span className="flex items-center gap-2">
        <input
          type="number"
          step={step}
          className={cx(inputBase, width)}
          aria-invalid={!!error}
          value={Number.isNaN(value) ? '' : value}
          onChange={(e) => onChange(e.target.value === '' ? NaN : Number(e.target.value))}
        />
        {suffix && <span className="text-[13px] font-normal text-muted">{suffix}</span>}
      </span>
      {error ? <span className="text-xs font-normal text-red-fg">{error}</span> : help ? <span className="text-xs font-normal text-muted">{help}</span> : null}
    </label>
  );
}

function TextField({ label, value, onChange, error, help, mono, className, placeholder, id }: { label: string; value: string; onChange: (v: string) => void; error?: string; help?: ReactNode; mono?: boolean; className?: string; placeholder?: string; id?: string }) {
  return (
    <label className={cx('flex flex-col gap-1.5 text-[13px] font-medium', className)} data-field={id}>
      {label}
      <input className={cx(inputClass, mono && 'font-mono text-[13px]')} aria-invalid={!!error} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
      {error ? <span className="text-xs font-normal text-red-fg">{error}</span> : help ? <span className="text-xs font-normal text-muted">{help}</span> : null}
    </label>
  );
}

function ChipList({ label, items, onChange, help, channel }: { label: string; items: string[]; onChange: (v: string[]) => void; help: string; channel?: boolean }) {
  const [text, setText] = useState('');
  const add = () => {
    let v = text.trim().replace(/,$/, '');
    if (!v) return;
    if (channel && !v.startsWith('#')) v = `#${v}`;
    if (!items.includes(v)) onChange([...items, v]);
    setText('');
  };
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-[13px] font-medium">{label}</span>
      <div className="flex min-h-10 flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent">
        {items.map((it) => (
          <span key={it} className="inline-flex items-center gap-1 rounded-md bg-track py-0.5 pl-2 pr-0.5 text-[13px]">
            {it}
            <button type="button" aria-label={`Remove ${it}`} className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:bg-track-2 hover:text-ink cursor-pointer" onClick={() => onChange(items.filter((x) => x !== it))}>
              <Icon name="x" size={12} />
            </button>
          </span>
        ))}
        <input
          aria-label={`Add to ${label}`}
          placeholder="Add…"
          className="min-w-[80px] flex-1 border-0 bg-transparent text-[13px] text-ink outline-none"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add();
            } else if (e.key === 'Backspace' && !text && items.length) onChange(items.slice(0, -1));
          }}
          onBlur={add}
        />
      </div>
      <span className="text-xs text-muted">{help}</span>
    </div>
  );
}

function Row({ title, help, children, tone }: { title: string; help?: ReactNode; children: ReactNode; tone?: 'warn' }) {
  return (
    <div className={cx('flex min-h-[60px] flex-wrap items-center gap-x-4 gap-y-2 border-b border-line-soft px-[18px] py-2 last:border-b-0', tone === 'warn' && 'bg-amber-wash')}>
      <div className="flex flex-[1_1_300px] flex-col gap-0.5">
        <span className="font-medium">{title}</span>
        {help && <span className="text-xs text-muted">{help}</span>}
      </div>
      {children}
    </div>
  );
}

const CHECK_ICON: Record<CheckStatus, { icon: 'check' | 'alert' | 'x'; cls: string }> = {
  ok: { icon: 'check', cls: 'text-green-fg' },
  warn: { icon: 'alert', cls: 'text-amber-fg' },
  fail: { icon: 'x', cls: 'text-red-fg' },
};

// ---------- Page ----------

export function SettingsPage() {
  const q = useApiQuery(() => api.getSettings(), onTopics('settings'), []);
  const usage = useApiQuery(() => api.getUsage(), onTopics('usage'), []);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const full = usePrefs((s) => s.scope === 'full');
  const view = q.data;

  // The draft is rebased on server changes only while it has no edits.
  const [seen, setSeen] = useState<SettingsView | undefined>();
  const [base, setBase] = useState<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [saving, setSaving] = useState(false);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<{ title: string; body: ReactNode; label: string; danger?: boolean; run: () => void } | null>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [addingPage, setAddingPage] = useState<{ title: string; ref: string; error?: string } | null>(null);

  const dirty = !!draft && !!base && JSON.stringify(draft) !== JSON.stringify(base);
  if (view && view !== seen) {
    setSeen(view);
    if (!dirty) {
      const fresh = { settings: view.settings, rules: view.rules };
      setBase(fresh);
      setDraft(fresh);
    }
  }

  const blocker = useBlocker(({ currentLocation, nextLocation }) => dirty && currentLocation.pathname !== nextLocation.pathname);
  useHashScroll(!!draft);
  useEffect(() => {
    document.title = 'Settings & rules · Work OS';
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  if (!view || !draft) return <div className="p-8 text-muted">{q.error ? 'Could not load settings.' : 'Loading…'}</div>;

  const s = draft.settings;
  const err = (path: string) => errors[path];
  /** Applies a change to the draft and clears errors under the touched path. */
  const patch = (path: string, fn: (d: Draft) => void) => {
    setDraft((d) => {
      const n = structuredClone(d!);
      fn(n);
      return n;
    });
    if (Object.keys(errors).some((k) => k.startsWith(path)))
      setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith(path))));
  };
  const setS = (path: string, fn: (s: Settings) => void) => patch(`settings.${path}`, (d) => fn(d.settings));
  const ruleError = (i: number) => {
    const hit = Object.entries(errors).find(([k]) => k.startsWith(`rules.${i}.`) || k === `rules.${i}`);
    return hit?.[1];
  };

  const save = async () => {
    setSaving(true);
    try {
      const settingsChanged = JSON.stringify(draft.settings) !== JSON.stringify(base!.settings);
      const rulesChanged = JSON.stringify(draft.rules) !== JSON.stringify(base!.rules);
      const r = await api.saveSettings(draft.settings, draft.rules);
      setErrors({});
      const logged = [settingsChanged && 'settings.changed', rulesChanged && 'rules.changed'].filter(Boolean).join(' and ');
      setSavedNote(`Saved ${fmtTime(r.savedAt)} · ${logged} logged`);
      setBase(draft);
      toast(`Saved. ${logged} logged.`, { tone: 'success' });
    } catch (e) {
      if (isApiError(e) && e.code === 'validation' && e.issues) {
        const next: Errors = {};
        for (const i of e.issues) next[i.path] ??= friendly(i.message);
        setErrors(next);
        toast(e.message, { tone: 'error' });
        requestAnimationFrame(() => document.querySelector('[aria-invalid="true"], [data-rule].bg-red-line\\/10')?.scrollIntoView({ block: 'center' }));
      } else errorToast(e);
    } finally {
      setSaving(false);
    }
  };
  const discard = () => {
    setDraft(base);
    setErrors({});
  };

  const errorCount = Object.keys(errors).length;
  const budgets = usage.data?.today;

  const addPage = () => {
    if (!addingPage) return;
    const m = /pages\/(\d+)/.exec(addingPage.ref) ?? /^\s*(\d+)\s*$/.exec(addingPage.ref);
    if (!m) return setAddingPage({ ...addingPage, error: 'Paste a page URL or a numeric page ID' });
    if (!addingPage.title.trim()) return setAddingPage({ ...addingPage, error: 'Give the page a title, e.g. Space › Page' });
    if (s.confluence.pages.some((p) => p.id === m[1])) return setAddingPage({ ...addingPage, error: 'That page is already on the allow-list' });
    setS('confluence.pages', (x) => x.confluence.pages.push({ title: addingPage.title.trim(), id: m[1] }));
    setAddingPage(null);
  };

  return (
    <div className="mx-auto flex max-w-[1360px] flex-col gap-6 px-8 pb-16 pt-6">
      <header className="flex flex-wrap items-end gap-3">
        <div className="flex flex-[1_1_360px] flex-col gap-1">
          <h1 className="m-0 text-[26px] font-semibold tracking-[-0.015em]">Settings &amp; rules</h1>
          <div className="text-[13px] text-muted">
            Edits <span className="font-mono text-xs">settings.json</span> and <span className="font-mono text-xs">rules.json</span>. Validated before saving; every change is logged as an event.
          </div>
        </div>
        <span className="font-mono text-[11px] text-muted" data-testid="saved-note">
          {savedNote ?? `Last saved ${fmtDayDate(view.savedAt)} ${fmtTime(view.savedAt)}`}
        </span>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted">Theme</span>
          <Segmented<Theme>
            label="Theme"
            size="sm"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </div>
      </header>

      <nav aria-label="Sections" className="flex flex-wrap gap-1.5">
        {SECTIONS.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="inline-flex min-h-9 items-center rounded-full border border-line-strong bg-surface px-3 text-[13px] !text-ink no-underline hover:bg-surface-2">
            {label}
          </a>
        ))}
      </nav>

      {dirty && (
        <div role="status" className="sticky top-3 z-30 flex flex-wrap items-center gap-x-3.5 gap-y-2.5 rounded-[10px] bg-solid py-2.5 pl-4 pr-3 text-on-solid shadow-[0_12px_32px_rgba(20,23,28,0.24)]">
          <span className="flex-[1_1_260px] text-[13px]">
            {errorCount ? (
              <>
                <Icon name="alert" size={14} className="mr-1.5 inline align-[-2px] text-amber" />
                {errorCount} {errorCount === 1 ? 'field needs' : 'fields need'} fixing before saving.
              </>
            ) : (
              'Unsaved changes. Saving validates both files first.'
            )}
          </span>
          <button type="button" className="min-h-9 rounded-lg border border-gray-fg px-3 text-[13px] cursor-pointer hover:bg-white/10" onClick={discard}>
            Discard
          </button>
          <button type="button" disabled={saving} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-surface px-3.5 text-[13px] font-semibold text-ink cursor-pointer disabled:opacity-70" onClick={() => void save()}>
            {saving && <Spinner size={12} />} Save
          </button>
        </div>
      )}

      {/* Rules */}
      <Section id="rules" title="Rules" note="Run before the model, top to bottom. The first match wins. A fixed outcome skips the model call.">
        <RulesList rules={draft.rules} hits={view.ruleHits} errorFor={ruleError} onChange={(rules) => patch('rules', (d) => (d.rules = rules))} />
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-xs text-muted">
          <span>Conditions:</span>
          <span className="text-ink-2">sender in list · channel in list · mentions you · is DM · keyword regex</span>
          {full && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-violet-line px-2 py-0.5 text-violet-fg">
              sender domain · meeting organiser · source is <span className="font-mono text-[10px]">P2</span>
            </span>
          )}
        </div>
        {full && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2.5 rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-wash px-4 py-3.5">
            <div className="flex flex-[1_1_360px] flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-semibold">Learning loop</span>
                <PhaseTag phase="P4" />
              </div>
              <div className="text-[13px] leading-[1.45] text-ink-2">Use your triage corrections as few-shot examples, chosen by similarity. Every prompt change is gated by the eval.</div>
            </div>
            <span className="text-xs text-muted">{view.correctionCount} corrections available</span>
            <FutureButton phase="P4" label="Review examples" />
          </div>
        )}
      </Section>

      {/* Sources */}
      <Section id="sources" title="Sources" mvp={false} note="Each new source retires the scheduled task it replaces.">
        <Card className="flex flex-col gap-5 p-[18px]">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-green" />
            <span className="text-[15px] font-semibold">Slack</span>
            <MvpTag />
            <span className="flex-1" />
            <span className="inline-flex items-center gap-1.5 text-xs text-muted">
              <Icon name="lock" size={12} />
              User token in Keychain · read-only scopes
            </span>
          </div>
          <div className="flex flex-wrap items-start gap-x-5 gap-y-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-[13px] font-medium">Fetch mode</span>
              <Segmented
                label="Fetch mode"
                value={s.slack.fetchMode}
                onChange={(v) => setS('slack.fetchMode', (x) => (x.slack.fetchMode = v))}
                options={[
                  { value: 'search', label: 'search.messages' },
                  { value: 'history', label: 'history' },
                ]}
              />
            </div>
            <NumField id="intervalWork" label="Poll every, work hours" suffix="min" value={s.schedule.intervalWorkMinutes} error={err('settings.schedule.intervalWorkMinutes')} onChange={(v) => setS('schedule.intervalWorkMinutes', (x) => (x.schedule.intervalWorkMinutes = v))} />
            <NumField label="Poll every, off hours" suffix="min" value={s.schedule.intervalOffMinutes} error={err('settings.schedule.intervalOffMinutes')} onChange={(v) => setS('schedule.intervalOffMinutes', (x) => (x.schedule.intervalOffMinutes = v))} />
            <TextField label="Work hours" className="w-[220px]" value={s.schedule.workHours} error={err('settings.schedule.workHours')} onChange={(v) => setS('schedule.workHours', (x) => (x.schedule.workHours = v))} />
            <NumField label="Quiet window before triage" suffix="min" value={s.triage.quietMinutes} error={err('settings.triage.quietMinutes')} onChange={(v) => setS('triage.quietMinutes', (x) => (x.triage.quietMinutes = v))} />
          </div>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
            <ChipList label="VIPs" items={s.slack.vips} onChange={(v) => setS('slack.vips', (x) => (x.slack.vips = v))} help="DMs from these people skip the quiet window and go straight to Now." />
            <ChipList channel label="Include channels" items={s.slack.includeChannels} onChange={(v) => setS('slack.includeChannels', (x) => (x.slack.includeChannels = v))} help="Empty means every channel you can see." />
            <ChipList channel label="Exclude channels" items={s.slack.excludeChannels} onChange={(v) => setS('slack.excludeChannels', (x) => (x.slack.excludeChannels = v))} help="Dropped at ingest and never stored." />
            <ChipList channel label="Customer channels" items={s.slack.customerChannels} onChange={(v) => setS('slack.customerChannels', (x) => (x.slack.customerChannels = v))} help="Used by the customer-channels rule." />
          </div>
        </Card>
        {full && (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
            {(
              [
                ['Outlook mail', 'P2', 'Graph delta query on the Inbox. Needs delegated Mail.Read with admin consent.', 'Retires: daily Outlook digest', 'Request consent'],
                ['Teams chats + transcripts', 'P2', 'Graph delta on chats; transcripts for meetings you attended.', 'Retires: daily Teams transcript sweep', 'Request consent'],
                ['Gong · Salesforce · HubSpot', 'P4', 'Read-only sources for pre-meeting account briefs. Needs data-rights checks.', 'New capability', 'Connect'],
              ] as const
            ).map(([name, phase, how, retires, cta]) => (
              <div key={name} className="flex flex-col gap-2 rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-wash p-4">
                <div className="flex items-center gap-2">
                  <span className="box-border h-2 w-2 rounded-full border-[1.5px] border-gray-mid" />
                  <span className="flex-1 font-semibold">{name}</span>
                  <PhaseTag phase={phase} />
                </div>
                <div className="text-[13px] text-ink-2">{how}</div>
                <div className="text-xs text-muted">{retires}</div>
                <div>
                  <FutureButton phase={phase} label={cta} size="sm" />
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Models */}
      <Section id="models" title="Triage & models" note="Anthropic models only. Every call sets its model, tools and prompt explicitly.">
        <div className="flex flex-wrap items-start gap-4">
          <Card className="flex min-w-0 flex-[1.3_1_420px] flex-col gap-2.5 p-[18px]">
            <span className="text-[15px] font-semibold">Model map</span>
            {(
              [
                ['Triage', 'Batched, one call per poll · no tools, no MCP', 'triage', 'triage.md v3'],
                ['Draft vault note', 'Per click · read-only vault access', 'draftVault', 'draft-vault.md v2'],
                ['Draft Confluence entry', 'Per click · read-only, allow-listed pages', 'draftConfluence', 'draft-confluence.md v2'],
              ] as const
            ).map(([purpose, shape, key, prompt]) => (
              <div key={key} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-line-soft bg-surface-2 px-3 py-2.5">
                <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-0.5">
                  <span className="text-[13px] font-medium">{purpose}</span>
                  <span className="text-xs text-muted">{shape}</span>
                </div>
                <label>
                  <span className="sr-only">Model for {purpose}</span>
                  <select className={cx(inputBase, 'w-[140px] font-mono text-[13px]')} value={s.models[key]} onChange={(e) => setS(`models.${key}`, (x) => (x.models[key] = e.target.value as ModelId))}>
                    {(['haiku-4.5', 'sonnet-5.5', 'opus-5.5'] as const).map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </label>
                <button type="button" className="font-mono text-xs text-accent hover:underline cursor-pointer" onClick={() => toast(`${prompt} lives in apps/server/src/claude/prompts and is versioned with the eval.`)}>
                  {prompt}
                </button>
              </div>
            ))}
            {full &&
              (
                [
                  ['Meeting summaries', 'Per transcript', 'haiku-4.5', 'P2'],
                  ['Briefs and synthesis', 'Daily and weekly', 'opus-5.5', 'P4'],
                ] as const
              ).map(([purpose, shape, model, phase]) => (
                <div key={purpose} className="flex flex-wrap items-center gap-3 rounded-lg border-[1.5px] border-dashed border-violet-line bg-violet-wash px-3 py-2.5">
                  <div className="flex flex-[1_1_220px] flex-col gap-0.5">
                    <span className="text-[13px] font-medium">
                      {purpose} <PhaseTag phase={phase} />
                    </span>
                    <span className="text-xs text-muted">{shape}</span>
                  </div>
                  <span className="font-mono text-[13px] text-muted">{model}</span>
                </div>
              ))}
          </Card>
          <Card className="flex min-w-0 flex-[1_1_340px] flex-col gap-3 p-[18px]">
            <span className="text-[15px] font-semibold">Batching</span>
            <div className="flex flex-wrap gap-4">
              <NumField label="Max threads per call" value={s.triage.maxThreadsPerCall} error={err('settings.triage.maxThreadsPerCall')} onChange={(v) => setS('triage.maxThreadsPerCall', (x) => (x.triage.maxThreadsPerCall = v))} width="w-[96px]" />
              <NumField label="Max input tokens" value={s.triage.maxInputTokens} error={err('settings.triage.maxInputTokens')} onChange={(v) => setS('triage.maxInputTokens', (x) => (x.triage.maxInputTokens = v))} width="w-[110px]" />
              <NumField label="Keep last N messages" value={s.triage.keepLastMessages} error={err('settings.triage.keepLastMessages')} onChange={(v) => setS('triage.keepLastMessages', (x) => (x.triage.keepLastMessages = v))} width="w-[96px]" />
            </div>
            <span className="mt-1 text-[15px] font-semibold">Claude backend</span>
            <div role="radiogroup" aria-label="Claude backend" className="flex flex-col gap-1.5">
              {(
                [
                  ['subscription', 'Claude subscription (Agent SDK)'],
                  ['api_key', 'API key'],
                  ['bedrock', 'Amazon Bedrock'],
                ] as const
              ).map(([v, label]) => (
                <label key={v} className={cx('flex min-h-10 items-center gap-2.5 rounded-lg border px-3 text-[13px] cursor-pointer', s.claudeBackend === v ? 'border-accent bg-accent-wash' : 'border-line')}>
                  <input
                    type="radio"
                    name="backend"
                    checked={s.claudeBackend === v}
                    onChange={() =>
                      v === 'subscription'
                        ? setS('claudeBackend', (x) => (x.claudeBackend = v))
                        : setConfirm({
                            title: `Switch to ${label}?`,
                            body: (
                              <>
                                <p className="mt-0">
                                  The MVP runs on your Claude subscription through the Agent SDK. {label} is a fallback that bills separately and needs its own credentials (CL-8).
                                </p>
                                <p className="mb-0">
                                  The server still refuses to start if <code className="font-mono text-[13px]">ANTHROPIC_API_KEY</code> is set while the subscription backend is active (CL-2). Only switch if the subscription is unavailable.
                                </p>
                              </>
                            ),
                            label: `Use ${label}`,
                            run: () => setS('claudeBackend', (x) => (x.claudeBackend = v)),
                          })
                    }
                  />
                  <span className="flex-1">{label}</span>
                  <span className={cx('text-xs', v === 'subscription' ? 'font-medium text-green-fg' : 'text-muted')}>{v === 'subscription' ? 'Recommended' : 'Fallback'}</span>
                </label>
              ))}
            </div>
            <span className="text-xs leading-normal text-muted">The server refuses to start if ANTHROPIC_API_KEY is set while the subscription backend is active.</span>
          </Card>
        </div>
      </Section>

      {/* Budgets */}
      <Section id="budgets" title="Budgets" note="When one is hit, model triage pauses, rules keep running, and the inbox shows a banner.">
        <Card className="flex flex-wrap gap-x-6 gap-y-4 p-[18px]">
          <NumField label="Triage calls per day" value={s.budgets.triageCallsPerDay} error={err('settings.budgets.triageCallsPerDay')} help={budgets && `Today: ${budgets.triageCalls}`} onChange={(v) => setS('budgets.triageCallsPerDay', (x) => (x.budgets.triageCallsPerDay = v))} />
          <NumField label="Drafts per day" value={s.budgets.draftsPerDay} error={err('settings.budgets.draftsPerDay')} help={budgets && `Today: ${budgets.draftsVault + budgets.draftsConfluence}`} onChange={(v) => setS('budgets.draftsPerDay', (x) => (x.budgets.draftsPerDay = v))} />
          <NumField label="Cost-equivalent per day" suffix="USD" step="0.1" value={s.budgets.costEquivalentPerDay} error={err('settings.budgets.costEquivalentPerDay')} help={budgets && `Today: ${fmtMoney(budgets.costEquivalent)}`} onChange={(v) => setS('budgets.costEquivalentPerDay', (x) => (x.budgets.costEquivalentPerDay = v))} />
          <label className="flex flex-col gap-1.5 text-[13px] font-medium">
            Baseline per day (P0-3)
            <span className="flex items-center gap-2">
              <input
                type="number"
                step="0.1"
                className={cx(inputBase, 'w-[110px]')}
                aria-invalid={!!err('settings.baselineCostPerDay')}
                placeholder="not measured"
                value={s.baselineCostPerDay ?? ''}
                onChange={(e) => setS('baselineCostPerDay', (x) => (x.baselineCostPerDay = e.target.value === '' ? null : Number(e.target.value)))}
              />
              <span className="text-[13px] font-normal text-muted">USD</span>
            </span>
            <span className={cx('text-xs font-normal', err('settings.baselineCostPerDay') ? 'text-red-fg' : 'text-muted')}>{err('settings.baselineCostPerDay') ?? 'Average daily usage of the scheduled tasks, measured in Phase 0.'}</span>
          </label>
        </Card>
      </Section>

      {/* Write targets */}
      <Section id="targets" title="Write targets" mvp={false} note="Where approved actions may write. The executor re-checks these at write time, whatever the draft says.">
        <div className="flex flex-wrap items-start gap-4">
          <Card className="flex min-w-0 flex-[1_1_340px] flex-col gap-3 p-[18px]">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold">Obsidian vault</span>
              <MvpTag />
            </div>
            <TextField mono label="Vault path" value={s.vaultPath} error={err('settings.vaultPath')} onChange={(v) => setS('vaultPath', (x) => (x.vaultPath = v))} />
            <div className="flex items-center gap-2 text-[13px]">
              <Icon name={view.vaultConventionsLoaded ? 'check' : 'alert'} size={14} className={view.vaultConventionsLoaded ? 'text-green-fg' : 'text-amber-fg'} />
              <span className="flex-1">vault-conventions.md {view.vaultConventionsLoaded ? 'loaded' : 'not found'}</span>
              <button type="button" className="text-accent hover:underline cursor-pointer" onClick={() => toast('Opens vault-conventions.md in Obsidian. The prototype doesn’t launch apps.')}>
                Open
              </button>
            </div>
          </Card>
          <Card className="flex min-w-0 flex-[1.3_1_420px] flex-col gap-3 p-[18px]">
            <div className="flex items-center gap-2">
              <span className="text-[15px] font-semibold">Confluence allow-list</span>
              <MvpTag />
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="text-muted">Space</span>
              <span className="font-mono">{s.confluence.spaceKey}</span>
              <span className="flex-1" />
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                <Icon name="lock" size={12} /> API token in Keychain
              </span>
            </div>
            <div className="flex flex-col rounded-lg border border-line" aria-label="Allow-listed pages">
              {s.confluence.pages.map((p, i) => (
                <div key={`${p.id}-${i}`} className="flex flex-wrap items-center gap-3 border-b border-line-soft px-3 py-2 last:border-b-0">
                  <span className="flex-1 text-[13px]">{p.title}</span>
                  <span className={cx('font-mono text-xs', err(`settings.confluence.pages.${i}.id`) ? 'text-red-fg' : 'text-muted')}>{p.id}</span>
                  {err(`settings.confluence.pages.${i}.id`) && <span className="w-full text-xs text-red-fg">{err(`settings.confluence.pages.${i}.id`)}</span>}
                  <IconButton label={`Remove ${p.title}`} icon="x" size={32} onClick={() => setS('confluence.pages', (x) => x.confluence.pages.splice(i, 1))} />
                </div>
              ))}
              {s.confluence.pages.length === 0 && <div className="px-3 py-3 text-[13px] text-muted">No pages. Confluence drafts will all be refused.</div>}
            </div>
            {addingPage ? (
              <form
                className="flex flex-col gap-2.5 rounded-lg border border-line bg-surface-2 p-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  addPage();
                }}
              >
                <div className="flex flex-wrap gap-2.5">
                  <TextField label="Title" className="flex-[1_1_200px]" placeholder="Space › Page" value={addingPage.title} onChange={(v) => setAddingPage({ ...addingPage, title: v, error: undefined })} />
                  <TextField mono label="Page ID or URL" className="flex-[1_1_200px]" placeholder="48213377 or https://…/pages/48213377/…" value={addingPage.ref} onChange={(v) => setAddingPage({ ...addingPage, ref: v, error: undefined })} />
                </div>
                {addingPage.error && <span className="text-xs text-red-fg">{addingPage.error}</span>}
                <div className="flex gap-2">
                  <Button type="submit" variant="solid">
                    Add page
                  </Button>
                  <Button onClick={() => setAddingPage(null)}>Cancel</Button>
                </div>
              </form>
            ) : (
              <Button className="self-start" icon="plus" onClick={() => setAddingPage({ title: '', ref: '' })}>
                Add page by ID or URL
              </Button>
            )}
          </Card>
        </div>
        {full && (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(240px,1fr))]">
            {(
              [
                ['Jira projects', 'Allow-list of projects that Create Jira task may write to.'],
                ['JPD ideas (PSPD)', 'Pipeline Stage = triage, with a Work OS label so each idea traces back to its thread.'],
                ['Batched execution', 'Run approved actions together, grouped by target, at 12:30 and 17:00.'],
              ] as const
            ).map(([t, d]) => (
              <div key={t} className="flex flex-col gap-1.5 rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-wash p-4">
                <div className="flex items-center gap-2">
                  <span className="flex-1 font-semibold">{t}</span>
                  <PhaseTag phase="P3" />
                </div>
                <div className="text-[13px] text-ink-2">{d}</div>
              </div>
            ))}
          </div>
        )}
      </Section>

      {/* Notifications */}
      <Section id="notify" title="Notifications">
        <Card>
          <Row title="macOS notification for new Now items" help="One per item, with the one-line summary. Click opens the item.">
            <Switch label="macOS notifications" checked={s.notifications.enabled} onChange={(v) => setS('notifications.enabled', (x) => (x.notifications.enabled = v))} />
          </Row>
          <Row title="Quiet hours" help="Now items still land in the inbox, without a notification.">
            <label className="flex flex-col gap-1">
              <span className="sr-only">Quiet hours</span>
              <input className={cx(inputBase, 'w-[150px] font-mono text-[13px]')} aria-invalid={!!err('settings.notifications.quietHours')} value={s.notifications.quietHours} onChange={(e) => setS('notifications.quietHours', (x) => (x.notifications.quietHours = e.target.value))} />
              {err('settings.notifications.quietHours') && <span className="text-xs text-red-fg">{err('settings.notifications.quietHours')}</span>}
            </label>
          </Row>
        </Card>
        {full && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-wash px-4 py-3.5">
            <div className="flex flex-[1_1_320px] flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-semibold">Briefs</span>
                <PhaseTag phase="P4" />
              </div>
              <div className="text-[13px] text-ink-2">Daily brief at 07:30 · weekly review Fri 16:00 · account brief 30 min before customer meetings.</div>
            </div>
            <FutureButton phase="P4" label="Configure" />
          </div>
        )}
      </Section>

      {/* Storage */}
      <Section id="storage" title="Storage & safety">
        <div className="flex flex-wrap items-start gap-4">
          <Card className="min-w-0 flex-[1.3_1_420px]">
            <Row
              title="Dry-run"
              tone={s.dryRun ? 'warn' : undefined}
              help={s.dryRun ? `On: vault writes go to ${s.dataDir}/sandbox/vault and Confluence writes are logged only.` : 'Off: approved actions write to the real vault and Confluence.'}
            >
              <Switch
                label="Dry-run"
                checked={s.dryRun}
                onChange={(v) =>
                  v
                    ? setS('dryRun', (x) => (x.dryRun = true))
                    : setConfirm({
                        title: 'Turn dry-run off?',
                        body: 'After you save, approved actions write to your real Obsidian vault and to the allow-listed Confluence pages. Keep dry-run on while testing (FR-1.6).',
                        label: 'Turn off dry-run',
                        danger: true,
                        run: () => setS('dryRun', (x) => (x.dryRun = false)),
                      })
                }
              />
            </Row>
            <Row title="Data directory" help="Event log, state, items, drafts, labels, logs. No database.">
              <span className="font-mono text-[13px]">{s.dataDir}</span>
            </Row>
            <Row title="Keep raw message content for" help="Events keep IDs, decisions and permalinks, never message bodies.">
              <NumField label="Retention days" suffix="days" value={s.retentionDays} error={err('settings.retentionDays')} onChange={(v) => setS('retentionDays', (x) => (x.retentionDays = v))} width="w-[90px]" />
            </Row>
            <Row title="Rebuild inbox state" help="Regenerates snapshot.json from the event log. Runs now; not part of the unsaved changes.">
              <Button
                disabled={rebuilding}
                onClick={async () => {
                  setRebuilding(true);
                  try {
                    const r = await api.rebuildState();
                    toast(`State rebuilt from ${r.events.toLocaleString('en-GB')} events. Nothing was lost.`, { tone: 'success' });
                  } catch (e) {
                    errorToast(e);
                  } finally {
                    setRebuilding(false);
                  }
                }}
              >
                {rebuilding ? (
                  <>
                    <Spinner size={12} /> Rebuilding…
                  </>
                ) : (
                  'Rebuild'
                )}
              </Button>
            </Row>
          </Card>
          <Card className="flex min-w-0 flex-[1_1_300px] flex-col gap-2.5 p-[18px]">
            <span className="text-[15px] font-semibold">Startup checks</span>
            {view.checks.map((k) => (
              <div key={k.id} className="flex items-center gap-2.5 text-[13px]" data-check={k.id}>
                <Icon name={CHECK_ICON[k.status].icon} size={16} strokeWidth={2.5} className={CHECK_ICON[k.status].cls} />
                <span className="flex-1">{k.label}</span>
                <span className={cx('font-mono text-[11px]', k.status === 'ok' ? 'text-muted' : CHECK_ICON[k.status].cls)}>{k.note}</span>
              </div>
            ))}
            <span className="text-xs text-muted">Last run {fmtTime(view.checkedAt)} at login</span>
          </Card>
        </div>
        {full && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-wash px-4 py-3.5">
            <div className="flex flex-[1_1_320px] flex-col gap-0.5">
              <div className="flex items-center gap-2">
                <span className="font-semibold">Plugins</span>
                <PhaseTag phase="P4" />
              </div>
              <div className="text-[13px] text-ink-2">Sources and actions as folders with a manifest, so adding one needs no core change.</div>
            </div>
            <FutureButton phase="P4" label="Manage plugins" />
          </div>
        )}
        <div className="text-xs text-muted">
          Labelled set: {view.labelCount} examples ({view.correctionCount} from your corrections). <Link to="/usage">Run an eval</Link> after big rule changes.
        </div>
      </Section>

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
          title="Leave without saving?"
          body="You have unsaved changes to settings or rules. Leaving drops them."
          confirmLabel="Leave"
          danger
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      )}
    </div>
  );
}
