import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Link, useBlocker } from 'react-router';
import type { ModelId, Settings } from '@work-os/shared';
import { api, isApiError, type CheckStatus, type SlackStatus } from '../api';
import { Icon } from '../components/icons';
import { RulesList, newRuleEdit, type RuleEdit } from '../components/Rules';
import { Button, ConfirmDialog, FutureButton, IconButton, MvpTag, PhaseTag, Segmented, Spinner, Switch, cx, inputBase, inputClass, type Phase } from '../components/ui';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useHashScroll } from '../hooks/useHashScroll';
import { useNow } from '../hooks/useNow';
import { fmtDayDate, fmtMoney, fmtTime } from '../lib/format';
import { SettingsEditor, type EditorState } from '../lib/settingsEditor';
import { usePrefs, type Theme } from '../store/prefs';
import { errorToast, toast } from '../store/toasts';

// Ordered by how often each is likely to change: rules and Slack lists weekly, storage almost never.
const SECTIONS = [
  ['rules', 'Triage rules'],
  ['sources', 'Slack'],
  ['notify', 'Notifications'],
  ['budgets', 'Budgets'],
  ['targets', 'Writing'],
  ['models', 'Claude & models'],
  ['storage', 'Storage & data'],
  ['appearance', 'Appearance'],
] as const;

// ---------- Layout primitives ----------

function Section({ id, title, description, action, children }: { id: string; title: string; description?: ReactNode; action?: ReactNode; children: ReactNode }) {
  const full = usePrefs((s) => s.scope === 'full');
  return (
    <section id={id} aria-labelledby={`h-${id}`} className="flex scroll-mt-6 flex-col gap-3.5">
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-1">
          <div className="flex items-center gap-2">
            <h2 id={`h-${id}`} className="m-0 text-[17px] font-semibold tracking-[-0.01em]">
              {title}
            </h2>
            {full && <MvpTag />}
          </div>
          {description && <p className="m-0 text-[13px] leading-normal text-muted">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const Panel = ({ children, label }: { children: ReactNode; label?: string }) => (
  <div className="flex flex-col divide-y divide-line-soft overflow-hidden rounded-xl border border-line bg-surface" aria-label={label} role={label ? 'group' : undefined}>
    {children}
  </div>
);

const SubHeading = ({ children }: { children: ReactNode }) => <h3 className="m-0 mt-1.5 text-xs font-semibold uppercase tracking-[0.06em] text-muted">{children}</h3>;

/** One setting: what it is on the left, the control on the right, errors under the control. */
function Row({ label, help, htmlFor, error, children, id, tone }: { label: ReactNode; help?: ReactNode; htmlFor?: string; error?: string; children: ReactNode; id?: string; tone?: 'warn' }) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div id={id} className={cx('grid scroll-mt-24 gap-x-8 gap-y-2.5 px-5 py-4 md:grid-cols-[230px_minmax(0,1fr)]', tone === 'warn' && 'bg-amber-wash')}>
      <div className="flex flex-col gap-1">
        <Label htmlFor={htmlFor} className="text-sm font-medium text-ink">
          {label}
        </Label>
        {help && <div className="text-xs leading-normal text-muted">{help}</div>}
      </div>
      <div className="flex min-w-0 flex-col items-start justify-center gap-1.5">
        {children}
        {error && <span className="text-xs text-red-fg">{error}</span>}
      </div>
    </div>
  );
}

function NumInput({ id, label, value, onChange, onBlur, invalid, suffix, prefix, step, width = 'w-[84px]', placeholder }: { id?: string; label: string; value: number | null; onChange: (v: number | null) => void; onBlur: () => void; invalid?: boolean; suffix?: string; prefix?: string; step?: string; width?: string; placeholder?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-muted">
      {prefix}
      <input
        id={id}
        type="number"
        step={step}
        aria-label={label}
        aria-invalid={invalid}
        placeholder={placeholder}
        className={cx(inputBase, width, 'text-ink')}
        value={value === null || Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))}
        onBlur={onBlur}
      />
      {suffix}
    </span>
  );
}

function ChipInput({ label, items, onChange, channel, placeholder = 'Add…' }: { label: string; items: string[]; onChange: (v: string[]) => void; channel?: boolean; placeholder?: string }) {
  const [text, setText] = useState('');
  const add = () => {
    let v = text.trim().replace(/,$/, '');
    if (!v) return;
    if (channel && !v.startsWith('#')) v = `#${v}`;
    if (!items.includes(v)) onChange([...items, v]);
    setText('');
  };
  return (
    <div className="flex min-h-10 w-full flex-wrap items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2 py-1.5 focus-within:border-accent">
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
        placeholder={items.length ? 'Add…' : placeholder}
        className="min-w-[120px] flex-1 border-0 bg-transparent px-1 text-[13px] text-ink outline-none"
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
  );
}

function Meter({ used, limit, text }: { used: number; limit: number; text: string }) {
  const pct = limit > 0 ? Math.min(1, used / limit) : 0;
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted">
      <span className="h-1.5 w-20 overflow-hidden rounded-full bg-track">
        <span className={cx('block h-full rounded-full', pct >= 1 ? 'bg-red' : pct >= 0.8 ? 'bg-amber' : 'bg-accent')} style={{ width: `${pct * 100}%` }} />
      </span>
      {text}
    </span>
  );
}

function FutureRow({ title, phase, children, cta }: { title: string; phase: Phase; children: ReactNode; cta?: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border-[1.5px] border-dashed border-violet-line bg-violet-wash px-5 py-3.5">
      <div className="flex min-w-0 flex-[1_1_320px] flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{title}</span>
          <PhaseTag phase={phase} />
        </div>
        <div className="text-[13px] leading-[1.45] text-ink-2">{children}</div>
      </div>
      {cta && <FutureButton phase={phase} label={cta} />}
    </div>
  );
}

const CHECK_ICON: Record<CheckStatus, { icon: 'check' | 'alert' | 'x'; cls: string }> = {
  ok: { icon: 'check', cls: 'text-green-fg' },
  warn: { icon: 'alert', cls: 'text-amber-fg' },
  fail: { icon: 'x', cls: 'text-red-fg' },
};

const SLACK_STATUS: Record<SlackStatus, { dot: string; text: string }> = {
  healthy: { dot: 'bg-green', text: 'Connected' },
  backoff: { dot: 'bg-amber', text: 'Rate-limited, retrying' },
  auth_failed: { dot: 'bg-red', text: 'Token rejected' },
  never: { dot: 'bg-gray-mid', text: 'Not polled yet' },
};

// ---------- Page chrome ----------

function useActiveSection(ready: boolean) {
  const [active, setActive] = useState<string>(SECTIONS[0][0]);
  useEffect(() => {
    if (!ready) return;
    const onScroll = () => {
      let cur: string = SECTIONS[0][0];
      for (const [id] of SECTIONS) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= window.innerHeight * 0.35) cur = id;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) cur = SECTIONS[SECTIONS.length - 1][0];
      setActive(cur);
    };
    const raf = requestAnimationFrame(onScroll);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('scroll', onScroll);
    };
  }, [ready]);
  return active;
}

function SaveStatus({ st, savedAt, onRetry }: { st: EditorState; savedAt: string; onRetry: () => void }) {
  const now = useNow(60_000);
  const errs = Object.keys(st.errors).length;
  const when = fmtDayDate(savedAt) === fmtDayDate(now.toISOString()) ? fmtTime(savedAt) : `${fmtDayDate(savedAt)} ${fmtTime(savedAt)}`;
  return (
    <div data-testid="saved-note" aria-live="polite" className="inline-flex min-h-8 items-center gap-1.5 text-xs text-muted">
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

// ---------- Page ----------

export function SettingsPage() {
  const q = useApiQuery(() => api.getSettings(), onTopics('settings'), []);
  const usage = useApiQuery(() => api.getUsage(), onTopics('usage'), []);
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  const full = usePrefs((s) => s.scope === 'full');
  const view = q.data;

  const [editor] = useState(
    () =>
      new SettingsEditor({
        save: (d) => api.saveSettings(d.settings, d.rules),
        onSaved: (kind, undo) => toast(kind === 'undone' ? 'Change undone' : 'Changes saved', { tone: 'success', key: 'settings-saved', action: kind === 'saved' ? { label: 'Undo', run: undo } : undefined }),
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

  const [confirm, setConfirm] = useState<{ title: string; body: ReactNode; label: string; danger?: boolean; run: () => void } | null>(null);
  const [ruleEdit, setRuleEdit] = useState<RuleEdit>(null);
  const [rebuilding, setRebuilding] = useState(false);
  const [addingPage, setAddingPage] = useState<{ title: string; ref: string; error?: string } | null>(null);
  const [showBatching, setShowBatching] = useState(false);

  const errorCount = Object.keys(st.errors).length;
  const unsaved = st.pending || st.saving || errorCount > 0;
  // Only invalid fields can be lost: everything else is already saved, or saves as the page unmounts.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => Object.keys(editor.getState().errors).length > 0 && currentLocation.pathname !== nextLocation.pathname);
  const ready = !!st.draft;
  useHashScroll(ready);
  const active = useActiveSection(ready);
  useEffect(() => {
    document.title = 'Settings & rules · Work OS';
  }, []);
  useEffect(() => {
    if (!unsaved) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [unsaved]);

  if (!view || !st.draft) return <div className="p-8 text-muted">{q.error ? 'Could not load settings.' : 'Loading…'}</div>;

  const s = st.draft.settings;
  const rules = st.draft.rules;
  const err = (path: string) => st.errors[`settings.${path}`];
  const set = (fn: (s: Settings) => void, when: 'now' | 'typing' = 'now') => editor.change((d) => fn(d.settings), when);
  const type = (fn: (s: Settings) => void) => set(fn, 'typing');
  const flush = () => void editor.flush();
  const ruleError = (i: number) => Object.entries(st.errors).find(([k]) => k.startsWith(`rules.${i}.`) || k === `rules.${i}`)?.[1];
  const today = usage.data?.today;
  const slack = usage.data ? SLACK_STATUS[usage.data.source.status] : undefined;
  const batchingErr = ['maxThreadsPerCall', 'maxInputTokens', 'keepLastMessages'].some((k) => err(`triage.${k}`));

  const addPage = () => {
    if (!addingPage) return;
    const m = /pages\/(\d+)/.exec(addingPage.ref) ?? /^\s*(\d+)\s*$/.exec(addingPage.ref);
    if (!addingPage.title.trim()) return setAddingPage({ ...addingPage, error: 'Give the page a title, e.g. Space › Page' });
    if (!m) return setAddingPage({ ...addingPage, error: 'Paste a page URL or a numeric page ID' });
    if (s.confluence.pages.some((p) => p.id === m[1])) return setAddingPage({ ...addingPage, error: 'That page is already on the allow-list' });
    set((x) => x.confluence.pages.push({ title: addingPage.title.trim(), id: m[1] }));
    setAddingPage(null);
  };

  return (
    <div className="mx-auto flex max-w-[1180px] items-start gap-12 px-8 pb-24 pt-6">
      <nav aria-label="Settings sections" className="sticky top-6 hidden w-[170px] shrink-0 flex-col gap-0.5 pt-[88px] lg:flex">
        {SECTIONS.map(([id, label]) => (
          <a
            key={id}
            href={`#${id}`}
            aria-current={active === id ? 'true' : undefined}
            className={cx('rounded-md px-2.5 py-1.5 text-[13px] no-underline', active === id ? 'bg-accent-wash font-medium !text-accent-ink' : '!text-ink-2 hover:bg-surface-2 hover:!text-ink')}
          >
            {label}
          </a>
        ))}
      </nav>

      <div className="flex min-w-0 max-w-[880px] flex-1 flex-col gap-12">
        <header className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <div className="flex flex-[1_1_360px] flex-col gap-1">
            <h1 className="m-0 text-[26px] font-semibold tracking-[-0.015em]">Settings &amp; rules</h1>
            <p className="m-0 text-[13px] text-muted">Changes save as you make them. Each one is checked first and logged as an event.</p>
          </div>
          <SaveStatus st={st} savedAt={view.savedAt} onRetry={flush} />
        </header>

        {/* Rules */}
        <Section
          id="rules"
          title="Triage rules"
          description="Checked top to bottom before the model. The first match wins, and a fixed outcome skips the model call."
          action={
            <Button variant="solid" icon="plus" onClick={() => setRuleEdit(newRuleEdit())}>
              Add rule
            </Button>
          }
        >
          <RulesList rules={rules} hits={view.ruleHits} errorFor={ruleError} editing={ruleEdit} setEditing={setRuleEdit} onChange={(next) => editor.change((d) => (d.rules = next))} />
          <p className="m-0 text-xs text-muted">
            Labelled set: {view.labelCount} examples, {view.correctionCount} from your corrections. <Link to="/usage">Run an eval</Link> after big rule changes.
          </p>
          {full && (
            <>
              <FutureRow title="More conditions" phase="P2">
                Sender domain, meeting organiser and source, for Outlook and Teams items.
              </FutureRow>
              <FutureRow title="Learning loop" phase="P4" cta="Review examples">
                Use your triage corrections as few-shot examples, chosen by similarity. Every prompt change is gated by the eval. {view.correctionCount} corrections available.
              </FutureRow>
            </>
          )}
        </Section>

        {/* Slack */}
        <Section
          id="sources"
          title="Slack"
          description="Who counts as important, which channels are read, and how often Work OS polls."
          action={
            slack && (
              <Link to="/usage#health" className="inline-flex min-h-8 items-center gap-1.5 text-xs !text-muted no-underline hover:!text-ink">
                <span className={cx('h-2 w-2 rounded-full', slack.dot)} />
                {slack.text} · read-only token in Keychain
              </Link>
            )
          }
        >
          <SubHeading>People and channels</SubHeading>
          <Panel>
            <Row label="VIPs" help="DMs from these people skip the quiet window and go straight to Now.">
              <ChipInput label="VIPs" placeholder="Add a name…" items={s.slack.vips} onChange={(v) => set((x) => (x.slack.vips = v))} />
            </Row>
            <Row label="Customer channels" help="Used by the customer-channels rule.">
              <ChipInput channel label="Customer channels" placeholder="Add #channel…" items={s.slack.customerChannels} onChange={(v) => set((x) => (x.slack.customerChannels = v))} />
            </Row>
            <Row label="Only read these channels" help="Leave empty to read every channel you can see.">
              <ChipInput channel label="Include channels" placeholder="Every channel you can see" items={s.slack.includeChannels} onChange={(v) => set((x) => (x.slack.includeChannels = v))} />
            </Row>
            <Row label="Never read these channels" help="Dropped as they’re fetched, and never stored.">
              <ChipInput channel label="Exclude channels" placeholder="Add #channel…" items={s.slack.excludeChannels} onChange={(v) => set((x) => (x.slack.excludeChannels = v))} />
            </Row>
          </Panel>
          <SubHeading>Polling</SubHeading>
          <Panel>
            <Row label="Poll every" help="More often in work hours, less often outside them." error={err('schedule.intervalWorkMinutes') ?? err('schedule.intervalOffMinutes')}>
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                <NumInput label="Poll every, work hours" suffix="min in work hours" value={s.schedule.intervalWorkMinutes} invalid={!!err('schedule.intervalWorkMinutes')} onBlur={flush} onChange={(v) => type((x) => (x.schedule.intervalWorkMinutes = v ?? NaN))} />
                <NumInput label="Poll every, off hours" suffix="min outside" value={s.schedule.intervalOffMinutes} invalid={!!err('schedule.intervalOffMinutes')} onBlur={flush} onChange={(v) => type((x) => (x.schedule.intervalOffMinutes = v ?? NaN))} />
              </div>
            </Row>
            <Row label="Work hours" htmlFor="work-hours" error={err('schedule.workHours')}>
              <input id="work-hours" className={cx(inputBase, 'w-[220px]')} aria-invalid={!!err('schedule.workHours')} value={s.schedule.workHours} onBlur={flush} onChange={(e) => type((x) => (x.schedule.workHours = e.target.value))} />
            </Row>
            <Row label="Quiet window" help="How long a thread must be quiet before it’s triaged, so a live conversation is read once." error={err('triage.quietMinutes')}>
              <NumInput label="Quiet window before triage" suffix="min" value={s.triage.quietMinutes} invalid={!!err('triage.quietMinutes')} onBlur={flush} onChange={(v) => type((x) => (x.triage.quietMinutes = v ?? NaN))} />
            </Row>
            <Row label="Fetch mode" help="search.messages finds threads you’re in across channels. history reads each channel in turn.">
              <Segmented
                label="Fetch mode"
                size="sm"
                value={s.slack.fetchMode}
                onChange={(v) => set((x) => (x.slack.fetchMode = v))}
                options={[
                  { value: 'search', label: 'search.messages' },
                  { value: 'history', label: 'history' },
                ]}
              />
            </Row>
          </Panel>
          {full && (
            <>
              <SubHeading>More sources</SubHeading>
              <FutureRow title="Outlook mail" phase="P2" cta="Request consent">
                Graph delta query on the Inbox. Needs delegated Mail.Read with admin consent. Retires the daily Outlook digest.
              </FutureRow>
              <FutureRow title="Teams chats and transcripts" phase="P2" cta="Request consent">
                Graph delta on chats, plus transcripts for meetings you attended. Retires the daily Teams transcript sweep.
              </FutureRow>
              <FutureRow title="Gong · Salesforce · HubSpot" phase="P4" cta="Connect">
                Read-only sources for pre-meeting account briefs. Needs data-rights checks.
              </FutureRow>
            </>
          )}
        </Section>

        {/* Notifications */}
        <Section id="notify" title="Notifications">
          <Panel>
            <Row label="Notify me about new Now items" help="A macOS notification per item, with its one-line summary. Clicking it opens the item.">
              <Switch label="macOS notifications" checked={s.notifications.enabled} onChange={(v) => set((x) => (x.notifications.enabled = v))} />
            </Row>
            <Row label="Quiet hours" htmlFor="quiet-hours" help="Now items still land in the inbox, just without a notification." error={err('notifications.quietHours')}>
              <input
                id="quiet-hours"
                disabled={!s.notifications.enabled}
                className={cx(inputBase, 'w-[150px] font-mono text-[13px] disabled:opacity-50')}
                aria-invalid={!!err('notifications.quietHours')}
                value={s.notifications.quietHours}
                onBlur={flush}
                onChange={(e) => type((x) => (x.notifications.quietHours = e.target.value))}
              />
            </Row>
          </Panel>
          {full && (
            <FutureRow title="Briefs" phase="P4" cta="Configure">
              Daily brief at 07:30, weekly review on Friday at 16:00, and an account brief 30 minutes before customer meetings.
            </FutureRow>
          )}
        </Section>

        {/* Budgets */}
        <Section id="budgets" title="Budgets" description="When one runs out, model triage pauses until tomorrow. Rules keep running and the inbox shows a banner.">
          <Panel>
            <Row label="Triage calls" htmlFor="b-triage" help="Batched model calls that triage threads." error={err('budgets.triageCallsPerDay')}>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <NumInput id="b-triage" label="Triage calls per day" suffix="per day" value={s.budgets.triageCallsPerDay} invalid={!!err('budgets.triageCallsPerDay')} onBlur={flush} onChange={(v) => type((x) => (x.budgets.triageCallsPerDay = v ?? NaN))} />
                {today && <Meter used={today.triageCalls} limit={s.budgets.triageCallsPerDay} text={`${today.triageCalls} used today`} />}
              </div>
            </Row>
            <Row label="Drafts" htmlFor="b-drafts" help="Vault notes and Confluence entries drafted on request." error={err('budgets.draftsPerDay')}>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <NumInput id="b-drafts" label="Drafts per day" suffix="per day" value={s.budgets.draftsPerDay} invalid={!!err('budgets.draftsPerDay')} onBlur={flush} onChange={(v) => type((x) => (x.budgets.draftsPerDay = v ?? NaN))} />
                {today && <Meter used={today.draftsVault + today.draftsConfluence} limit={s.budgets.draftsPerDay} text={`${today.draftsVault + today.draftsConfluence} used today`} />}
              </div>
            </Row>
            <Row label="Cost-equivalent" htmlFor="b-cost" help="What today’s calls would cost at API prices. The subscription isn’t billed per call." error={err('budgets.costEquivalentPerDay')}>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                <NumInput id="b-cost" label="Cost-equivalent per day" prefix="$" suffix="per day" step="0.1" value={s.budgets.costEquivalentPerDay} invalid={!!err('budgets.costEquivalentPerDay')} onBlur={flush} onChange={(v) => type((x) => (x.budgets.costEquivalentPerDay = v ?? NaN))} />
                {today && <Meter used={today.costEquivalent} limit={s.budgets.costEquivalentPerDay} text={`${fmtMoney(today.costEquivalent)} used today`} />}
              </div>
            </Row>
            <Row label="Baseline" htmlFor="b-baseline" help="Average daily cost of the scheduled tasks Work OS replaces, measured in Phase 0 (P0-3). Leave empty until it’s measured." error={err('baselineCostPerDay')}>
              <NumInput id="b-baseline" label="Baseline per day" prefix="$" suffix="per day" step="0.1" placeholder="—" value={s.baselineCostPerDay} invalid={!!err('baselineCostPerDay')} onBlur={flush} onChange={(v) => type((x) => (x.baselineCostPerDay = v))} />
            </Row>
          </Panel>
        </Section>

        {/* Writing */}
        <Section id="targets" title="Writing" description="Where approved actions can write. The executor checks all of this again at write time, whatever the draft says.">
          <Panel>
            <Row
              id="dry-run"
              label={
                <span className="inline-flex items-center gap-2">
                  Dry-run
                  {s.dryRun && <span className="rounded bg-amber px-1.5 py-px text-[11px] font-semibold text-ink-strong">On</span>}
                </span>
              }
              tone={s.dryRun ? 'warn' : undefined}
              help={s.dryRun ? `Vault writes go to ${s.dataDir}/sandbox/vault, and Confluence writes are logged only.` : 'Off: approved actions write to your real vault and Confluence pages.'}
            >
              <Switch
                label="Dry-run"
                checked={s.dryRun}
                onChange={(v) =>
                  v
                    ? set((x) => (x.dryRun = true))
                    : setConfirm({
                        title: 'Turn dry-run off?',
                        body: 'From now on, approved actions write to your real Obsidian vault and to the allow-listed Confluence pages. Keep dry-run on while testing (FR-1.6).',
                        label: 'Turn off dry-run',
                        danger: true,
                        run: () => set((x) => (x.dryRun = false)),
                      })
                }
              />
            </Row>
            <Row label="Obsidian vault" htmlFor="vault-path" help="Vault notes are written here, following the vault’s conventions file." error={err('vaultPath')}>
              <input id="vault-path" className={cx(inputClass, 'max-w-[440px] font-mono text-[13px]')} aria-invalid={!!err('vaultPath')} value={s.vaultPath} onBlur={flush} onChange={(e) => type((x) => (x.vaultPath = e.target.value))} />
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                <Icon name={view.vaultConventionsLoaded ? 'check' : 'alert'} size={13} className={view.vaultConventionsLoaded ? 'text-green-fg' : 'text-amber-fg'} />
                vault-conventions.md {view.vaultConventionsLoaded ? 'loaded' : 'not found'} ·
                <button type="button" className="text-accent hover:underline cursor-pointer" onClick={() => toast('Opens vault-conventions.md in Obsidian. The prototype doesn’t launch apps.')}>
                  Open
                </button>
              </span>
            </Row>
            <Row
              label="Confluence pages"
              help={
                <>
                  Entries can only go to these pages in space <span className="font-mono">{s.confluence.spaceKey}</span>. Drafts for any other page are refused (FR-10.6).
                </>
              }
            >
              <div className="flex w-full flex-col rounded-lg border border-line" aria-label="Allow-listed pages">
                {s.confluence.pages.map((p, i) => (
                  <div key={`${p.id}-${i}`} className="flex flex-wrap items-center gap-3 border-b border-line-soft py-1.5 pl-3 pr-1.5 last:border-b-0">
                    <span className="flex-1 text-[13px]">{p.title}</span>
                    <span className={cx('font-mono text-xs', err(`confluence.pages.${i}.id`) ? 'text-red-fg' : 'text-muted')}>{p.id}</span>
                    <IconButton label={`Remove ${p.title}`} icon="x" size={32} onClick={() => set((x) => x.confluence.pages.splice(i, 1))} />
                    {err(`confluence.pages.${i}.id`) && <span className="w-full text-xs text-red-fg">{err(`confluence.pages.${i}.id`)}</span>}
                  </div>
                ))}
                {s.confluence.pages.length === 0 && <div className="px-3 py-3 text-[13px] text-muted">No pages, so every Confluence draft will be refused.</div>}
              </div>
              {addingPage ? (
                <form
                  className="flex w-full flex-col gap-2.5 rounded-lg border border-line bg-surface-2 p-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    addPage();
                  }}
                >
                  <div className="flex flex-wrap gap-2.5">
                    <label className="flex flex-[1_1_180px] flex-col gap-1 text-xs font-medium text-ink-2">
                      Title
                      <input className={inputClass} placeholder="Space › Page" value={addingPage.title} onChange={(e) => setAddingPage({ ...addingPage, title: e.target.value, error: undefined })} />
                    </label>
                    <label className="flex flex-[1_1_220px] flex-col gap-1 text-xs font-medium text-ink-2">
                      Page ID or URL
                      <input className={cx(inputClass, 'font-mono text-[13px]')} placeholder="48213377 or https://…/pages/48213377/…" value={addingPage.ref} onChange={(e) => setAddingPage({ ...addingPage, ref: e.target.value, error: undefined })} />
                    </label>
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
                <Button size="sm" variant="ghost" className="-ml-2 text-accent" icon="plus" onClick={() => setAddingPage({ title: '', ref: '' })}>
                  Add page by ID or URL
                </Button>
              )}
            </Row>
          </Panel>
          {full && (
            <>
              <FutureRow title="Jira projects" phase="P3">
                An allow-list of projects that Create Jira task may write to.
              </FutureRow>
              <FutureRow title="JPD ideas (PSPD)" phase="P3">
                Pipeline Stage = triage, with a Work OS label so each idea traces back to its thread.
              </FutureRow>
              <FutureRow title="Batched execution" phase="P3">
                Run approved actions together, grouped by target, at 12:30 and 17:00.
              </FutureRow>
            </>
          )}
        </Section>

        {/* Claude & models */}
        <Section id="models" title="Claude & models" description="Anthropic models only. Every call sets its model, tools and prompt explicitly.">
          <Panel>
            <Row
              label="Claude backend"
              help={
                <>
                  The server refuses to start if <span className="font-mono">ANTHROPIC_API_KEY</span> is set while the subscription is in use (CL-2).
                </>
              }
            >
              <div role="radiogroup" aria-label="Claude backend" className="flex w-full max-w-[440px] flex-col gap-1.5">
                {(
                  [
                    ['subscription', 'Claude subscription (Agent SDK)'],
                    ['api_key', 'API key'],
                    ['bedrock', 'Amazon Bedrock'],
                  ] as const
                ).map(([v, label]) => (
                  <label key={v} className={cx('flex min-h-10 items-center gap-2.5 rounded-lg border px-3 text-[13px] cursor-pointer', s.claudeBackend === v ? 'border-accent bg-accent-wash' : 'border-line hover:bg-surface-2')}>
                    <input
                      type="radio"
                      name="backend"
                      checked={s.claudeBackend === v}
                      onChange={() =>
                        v === 'subscription'
                          ? set((x) => (x.claudeBackend = v))
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
                              run: () => set((x) => (x.claudeBackend = v)),
                            })
                      }
                    />
                    <span className="flex-1">{label}</span>
                    <span className={cx('text-xs', v === 'subscription' ? 'font-medium text-green-fg' : 'text-muted')}>{v === 'subscription' ? 'Recommended' : 'Fallback'}</span>
                  </label>
                ))}
              </div>
            </Row>
            {(
              [
                ['Triage', 'One batched call per poll. No tools, no MCP.', 'triage', 'triage.md v3'],
                ['Vault drafts', 'One call per click, with read-only vault access.', 'draftVault', 'draft-vault.md v2'],
                ['Confluence drafts', 'One call per click, reading allow-listed pages only.', 'draftConfluence', 'draft-confluence.md v2'],
              ] as const
            ).map(([purpose, shape, key, prompt]) => (
              <Row key={key} label={purpose} help={shape} htmlFor={`model-${key}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <select id={`model-${key}`} aria-label={`Model for ${purpose}`} className={cx(inputBase, 'w-[150px] font-mono text-[13px]')} value={s.models[key]} onChange={(e) => set((x) => (x.models[key] = e.target.value as ModelId))}>
                    {(['haiku-4.5', 'sonnet-5.5', 'opus-5.5'] as const).map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                  <button type="button" className="font-mono text-xs text-muted hover:text-accent hover:underline cursor-pointer" onClick={() => toast(`${prompt} lives in apps/server/src/claude/prompts and is versioned with the eval.`)}>
                    {prompt}
                  </button>
                </div>
              </Row>
            ))}
            <div>
              <button
                type="button"
                aria-expanded={showBatching || batchingErr}
                onClick={() => setShowBatching((v) => !v)}
                className="flex w-full items-center gap-3 px-5 py-3.5 text-left cursor-pointer hover:bg-surface-2"
              >
                <Icon name="arrow" size={14} className={cx('text-muted transition-transform', (showBatching || batchingErr) && 'rotate-90')} />
                <span className="text-sm font-medium">Batching limits</span>
                <span className="text-xs text-muted">
                  {s.triage.maxThreadsPerCall} threads per call · {Number.isNaN(s.triage.maxInputTokens) ? '–' : s.triage.maxInputTokens.toLocaleString('en-GB')} input tokens · last {s.triage.keepLastMessages} messages
                </span>
              </button>
              {(showBatching || batchingErr) && (
                <div className="divide-y divide-line-soft border-t border-line-soft">
                  <Row label="Threads per call" help="Above this, a poll splits into several triage calls." error={err('triage.maxThreadsPerCall')}>
                    <NumInput label="Max threads per call" value={s.triage.maxThreadsPerCall} invalid={!!err('triage.maxThreadsPerCall')} onBlur={flush} onChange={(v) => type((x) => (x.triage.maxThreadsPerCall = v ?? NaN))} />
                  </Row>
                  <Row label="Input tokens per call" help="Long threads are trimmed to fit." error={err('triage.maxInputTokens')}>
                    <NumInput label="Max input tokens" width="w-[110px]" value={s.triage.maxInputTokens} invalid={!!err('triage.maxInputTokens')} onBlur={flush} onChange={(v) => type((x) => (x.triage.maxInputTokens = v ?? NaN))} />
                  </Row>
                  <Row label="Messages kept per thread" help="The first message is always kept, plus this many of the latest." error={err('triage.keepLastMessages')}>
                    <NumInput label="Keep last N messages" value={s.triage.keepLastMessages} invalid={!!err('triage.keepLastMessages')} onBlur={flush} onChange={(v) => type((x) => (x.triage.keepLastMessages = v ?? NaN))} />
                  </Row>
                </div>
              )}
            </div>
          </Panel>
          {full && (
            <>
              <FutureRow title="Meeting summaries" phase="P2">
                One call per transcript, on haiku-4.5.
              </FutureRow>
              <FutureRow title="Briefs and synthesis" phase="P4">
                Daily and weekly, on opus-5.5.
              </FutureRow>
            </>
          )}
        </Section>

        {/* Storage */}
        <Section id="storage" title="Storage & data">
          <Panel>
            <Row label="Keep message text for" help="After that, thread text is deleted. Events keep IDs, decisions and permalinks, never message bodies (FR-12.1)." error={err('retentionDays')}>
              <NumInput label="Retention days" suffix="days" value={s.retentionDays} invalid={!!err('retentionDays')} onBlur={flush} onChange={(v) => type((x) => (x.retentionDays = v ?? NaN))} />
            </Row>
            <Row label="Data directory" help="Event log, state, items, drafts, labels and logs. No database.">
              <span className="font-mono text-[13px]">{s.dataDir}</span>
            </Row>
            <Row label="Rebuild inbox state" help="Regenerates snapshot.json from the event log. Nothing is lost.">
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
            <Row label="Startup checks" help={`Last run at login, ${fmtTime(view.checkedAt)}.`}>
              <div className="flex w-full max-w-[440px] flex-col gap-2">
                {view.checks.map((k) => (
                  <div key={k.id} className="flex items-center gap-2.5 text-[13px]" data-check={k.id}>
                    <Icon name={CHECK_ICON[k.status].icon} size={15} strokeWidth={2.5} className={CHECK_ICON[k.status].cls} />
                    <span className="flex-1">{k.label}</span>
                    <span className={cx('font-mono text-[11px]', k.status === 'ok' ? 'text-muted' : CHECK_ICON[k.status].cls)}>{k.note}</span>
                  </div>
                ))}
              </div>
            </Row>
          </Panel>
          {full && (
            <FutureRow title="Plugins" phase="P4" cta="Manage plugins">
              Sources and actions as folders with a manifest, so adding one needs no change to the core.
            </FutureRow>
          )}
        </Section>

        {/* Appearance */}
        <Section id="appearance" title="Appearance">
          <Panel>
            <Row label="Theme" help="Saved in this browser only, not in settings.json.">
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
            </Row>
          </Panel>
        </Section>
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
          body={`${errorCount} ${errorCount === 1 ? 'field has an error, so it wasn’t' : 'fields have errors, so they weren’t'} saved. Leaving drops ${errorCount === 1 ? 'that change' : 'those changes'}; everything else is already saved.`}
          confirmLabel="Leave"
          danger
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      )}
    </div>
  );
}
