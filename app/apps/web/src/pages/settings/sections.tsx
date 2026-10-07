import { useRef, useState, type ComponentType, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { CataloguePageView, ConfluenceCatalogueView, ConfluencePage, ModelId, PromptFileId, Rule, Settings } from '@work-os/shared';
import { api, isApiError, type CheckStatus, type PromptFileView, type SettingsView, type SlackStatus, type UsageView } from '../../api';
import { Avatar } from '../../components/Avatar';
import { ChannelPicker, PeoplePicker } from '../../components/LookupPicker';
import { Icon } from '../../components/icons';
import { RulesList, newRuleEdit, type RuleEdit } from '../../components/Rules';
import { Banner, Button, Chip, IconButton, Segmented, Spinner, Switch, cx, inputBase, inputClass } from '../../components/ui';
import { onTopics, useApiQuery } from '../../hooks/useApiQuery';
import { fmtMoney, fmtTime } from '../../lib/format';
import { avatarDataUrl } from '../../lib/avatar';
import { confluencePageUrl } from '../../lib/links';
import { usePrefs, type Theme } from '../../store/prefs';
import { errorToast, toast } from '../../store/toasts';
import { GuideLink } from '../../components/GuideLink';
import { FutureRow, Group, Meter, NumInput, Row, SectionHeader } from './parts';

export interface Confirm {
  title: string;
  body: ReactNode;
  label: string;
  danger?: boolean;
  run: () => void;
}

/** What every section view gets from the page. */
export interface Ctx {
  s: Settings;
  rules: Rule[];
  view: SettingsView;
  usage?: UsageView;
  full: boolean;
  set: (fn: (s: Settings) => void) => void;
  /** For typing: saves after a pause, or on blur via flush. */
  type: (fn: (s: Settings) => void) => void;
  flush: () => void;
  setRules: (rules: Rule[]) => void;
  err: (path: string) => string | undefined;
  ruleError: (index: number) => string | undefined;
  confirm: (c: Confirm) => void;
  /** A section with its own unsaved edit (a prompt file) names it here, so leaving asks first. */
  setUnsaved: (what: string | null) => void;
}

// ---------- Triage rules ----------

function RulesSection({ rules, view, full, setRules, ruleError }: Ctx) {
  const [edit, setEdit] = useState<RuleEdit>(null);
  return (
    <>
      <SectionHeader
        title="Triage rules"
        description="Checked top to bottom before the model. The first match wins, and a fixed outcome skips the model call."
        action={
          <div className="flex items-center gap-4">
            <GuideLink topic="rules" />
            <Button variant="solid" icon="plus" onClick={() => setEdit(newRuleEdit())}>
              Add rule
            </Button>
          </div>
        }
      />
      <RulesList rules={rules} hits={view.ruleHits} errorFor={ruleError} editing={edit} setEditing={setEdit} onChange={setRules} />
      <p className="m-0 mt-4 text-xs text-muted">
        Labelled set: {view.labelCount} examples, {view.correctionCount} from your corrections. <Link to="/usage">Run an eval</Link> after big rule changes.
      </p>
      {full && (
        <>
          <FutureRow title="More conditions" phase="P2">
            Sender domain, meeting organiser and source, for Outlook and Teams items.
          </FutureRow>
          <FutureRow title="Learning loop" phase="P4" cta="Review examples">
            Use your corrections as few-shot examples, chosen by similarity. Every prompt change is gated by the eval. {view.correctionCount} corrections available.
          </FutureRow>
        </>
      )}
    </>
  );
}

// ---------- Slack ----------

const SLACK_STATUS: Record<SlackStatus, { dot: string; text: string }> = {
  healthy: { dot: 'bg-green', text: 'Connected' },
  backoff: { dot: 'bg-amber', text: 'Rate-limited, retrying' },
  auth_failed: { dot: 'bg-red', text: 'Token rejected' },
  never: { dot: 'bg-gray-mid', text: 'Not polled yet' },
  offline: { dot: 'bg-gray-mid', text: 'Offline, polls when the network is back' },
  degraded: { dot: 'bg-amber', text: 'Slack errors, retrying' },
  paused: { dot: 'bg-gray-mid', text: 'Paused' },
};

function SlackSection({ s, usage, full, set, type, flush, err }: Ctx) {
  const status = usage ? SLACK_STATUS[usage.source.status] : undefined;
  return (
    <>
      <SectionHeader
        title="Slack"
        description="Who counts as important, which channels are read, and how often Work OS polls."
        action={
          status && (
            <Link to="/usage#health" className="inline-flex min-h-9 items-center gap-2 text-[13px] !text-ink-2 no-underline hover:!text-ink">
              <span className={cx('h-2 w-2 rounded-full', status.dot)} />
              {status.text}
            </Link>
          )
        }
      />
      <Group title="People and channels">
        <Row stacked label="VIPs" help="DMs from these people skip the quiet window and go straight to Now.">
          <PeoplePicker label="VIPs" placeholder="Search people…" values={s.slack.vips} onChange={(v) => set((x) => (x.slack.vips = v))} />
        </Row>
        <Row stacked label="Customer channels" help="Used by the customer-channels rule.">
          <ChannelPicker label="Customer channels" placeholder="Search channels…" values={s.slack.customerChannels} onChange={(v) => set((x) => (x.slack.customerChannels = v))} />
        </Row>
        <Row stacked label="Only read these channels" help="Leave empty to read every channel you can see.">
          <ChannelPicker label="Include channels" placeholder="Every channel you can see" values={s.slack.includeChannels} onChange={(v) => set((x) => (x.slack.includeChannels = v))} />
        </Row>
        <Row stacked label="Read app posts in these channels" help="Posts from apps such as Gong (call recaps, mentions) are read here and dropped everywhere else.">
          <ChannelPicker label="App channels" placeholder="Search channels…" values={s.slack.appChannels ?? []} onChange={(v) => set((x) => (x.slack.appChannels = v))} />
        </Row>
        <Row stacked label="Never read these channels" help="Dropped as they’re fetched, and never stored.">
          <ChannelPicker label="Exclude channels" placeholder="Search channels…" values={s.slack.excludeChannels} onChange={(v) => set((x) => (x.slack.excludeChannels = v))} />
        </Row>
      </Group>
      <Group title="Links">
        <Row label="Open Slack links in" help="Where Open in Slack and Reply in Slack go. The browser opens Slack’s web client; the app opens the message in Slack for Mac.">
          <Segmented
            label="Open Slack links in"
            size="sm"
            value={s.slack.openLinksIn ?? 'browser'}
            onChange={(v) => set((x) => (x.slack.openLinksIn = v))}
            options={[
              { value: 'browser', label: 'Browser' },
              { value: 'app', label: 'Desktop app' },
            ]}
          />
        </Row>
      </Group>
      <Group title="Polling">
        <Row label="During work hours" help="How often to poll Slack between the hours below." error={err('schedule.intervalWorkMinutes')}>
          <NumInput label="Poll every, work hours" prefix="Every" suffix="min" value={s.schedule.intervalWorkMinutes} invalid={!!err('schedule.intervalWorkMinutes')} onBlur={flush} onChange={(v) => type((x) => (x.schedule.intervalWorkMinutes = v ?? NaN))} />
        </Row>
        <Row label="Outside work hours" error={err('schedule.intervalOffMinutes')}>
          <NumInput label="Poll every, off hours" prefix="Every" suffix="min" value={s.schedule.intervalOffMinutes} invalid={!!err('schedule.intervalOffMinutes')} onBlur={flush} onChange={(v) => type((x) => (x.schedule.intervalOffMinutes = v ?? NaN))} />
        </Row>
        <Row label="Work hours" htmlFor="work-hours" error={err('schedule.workHours')}>
          <input id="work-hours" className={cx(inputBase, 'w-[200px]')} aria-invalid={!!err('schedule.workHours')} value={s.schedule.workHours} onBlur={flush} onChange={(e) => type((x) => (x.schedule.workHours = e.target.value))} />
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
      </Group>
      {full && (
        <Group title="More sources">
          <FutureRow title="Outlook mail" phase="P2" cta="Request consent" marks={['outlook']}>
            Graph delta query on the Inbox. Needs delegated Mail.Read with admin consent. Retires the daily Outlook digest.
          </FutureRow>
          <FutureRow title="Teams chats and transcripts" phase="P2" cta="Request consent" marks={['teams']}>
            Graph delta on chats, plus transcripts for meetings you attended. Retires the daily Teams transcript sweep.
          </FutureRow>
          <FutureRow title="Gong · Salesforce · HubSpot" phase="P4" cta="Connect" marks={['salesforce', 'hubspot']}>
            Read-only sources for pre-meeting account briefs. Needs data-rights checks.
          </FutureRow>
        </Group>
      )}
    </>
  );
}

// ---------- Notifications ----------

function NotificationsSection({ s, full, set, type, flush, err }: Ctx) {
  return (
    <>
      <SectionHeader title="Notifications" description="Only new Now items notify you. Everything else waits in the inbox." />
      <Group>
        <Row label="macOS notifications" help="One per item, with its one-line summary. Clicking it opens the item.">
          <Switch label="macOS notifications" checked={s.notifications.enabled} onChange={(v) => set((x) => (x.notifications.enabled = v))} />
        </Row>
        <Row label="Quiet hours" htmlFor="quiet-hours" help="Now items still land in the inbox, just without a notification." error={err('notifications.quietHours')}>
          <input
            id="quiet-hours"
            disabled={!s.notifications.enabled}
            className={cx(inputBase, 'w-[140px] font-mono text-[13px] disabled:opacity-50')}
            aria-invalid={!!err('notifications.quietHours')}
            value={s.notifications.quietHours}
            onBlur={flush}
            onChange={(e) => type((x) => (x.notifications.quietHours = e.target.value))}
          />
        </Row>
      </Group>
      {full && (
        <FutureRow title="Briefs" phase="P4" cta="Configure">
          Daily brief at 07:30, weekly review on Friday at 16:00, and an account brief 30 minutes before customer meetings.
        </FutureRow>
      )}
    </>
  );
}

// ---------- Write targets ----------

function WritingSection({ s, view, full, set, type, flush, err, confirm }: Ctx) {
  return (
    <>
      <SectionHeader title="Write targets" description="Where approved actions can write. The executor checks all of this again at write time, whatever the draft says." action={<GuideLink topic="scope" label="Guide: Confluence scope" />} />
      <Group>
        <Row
          id="dry-run"
          tone={s.dryRun ? 'warn' : undefined}
          label="Dry-run"
          help={s.dryRun ? `On. Vault writes go to ${s.dataDir}/sandbox/vault, and Confluence writes are only logged.` : 'Off. Approved actions write to your real vault and Confluence pages.'}
        >
          <Switch
            label="Dry-run"
            checked={s.dryRun}
            onChange={(v) =>
              v
                ? set((x) => (x.dryRun = true))
                : confirm({
                    title: 'Turn dry-run off?',
                    body: 'From now on, approved actions write to your real Obsidian vault and to the Confluence pages in scope. Keep dry-run on while testing (FR-1.6).',
                    label: 'Turn off dry-run',
                    danger: true,
                    run: () => set((x) => (x.dryRun = false)),
                  })
            }
          />
        </Row>
      </Group>
      <Group title="Obsidian vault">
        <Row stacked label="Vault path" htmlFor="vault-path" help="Vault notes are written here, following the vault’s conventions file." error={err('vaultPath')}>
          <input id="vault-path" className={cx(inputClass, 'font-mono text-[13px]')} aria-invalid={!!err('vaultPath')} value={s.vaultPath} onBlur={flush} onChange={(e) => type((x) => (x.vaultPath = e.target.value))} />
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <Icon name={view.vaultConventionsLoaded ? 'check' : 'alert'} size={13} className={view.vaultConventionsLoaded ? 'text-green-fg' : 'text-amber-fg'} />
            vault-conventions.md {view.vaultConventionsLoaded ? 'loaded' : 'not found'} ·
            <button type="button" className="text-accent hover:underline cursor-pointer" onClick={() => toast('Opens vault-conventions.md in Obsidian', { description: 'The prototype doesn’t launch other apps.' })}>
              Open
            </button>
          </span>
        </Row>
      </Group>
      <Group
        title="Confluence"
        aside={
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <Icon name="lock" size={12} /> API token in Keychain
          </span>
        }
      >
        <Row label="Site" htmlFor="confluence-site" help="Your Atlassian site. Pages are read and written here, and linked from drafts." error={err('confluence.siteUrl')}>
          <input id="confluence-site" className={cx(inputBase, 'w-[280px] font-mono text-[13px]')} aria-invalid={!!err('confluence.siteUrl')} value={s.confluence.siteUrl} onBlur={flush} onChange={(e) => type((x) => (x.confluence.siteUrl = e.target.value))} />
        </Row>
        <Row label="Space key" htmlFor="confluence-space" help="The space the rules below search." error={err('confluence.spaceKey')}>
          <input id="confluence-space" className={cx(inputBase, 'w-[120px] font-mono text-[13px]')} aria-invalid={!!err('confluence.spaceKey')} value={s.confluence.spaceKey} onBlur={flush} onChange={(e) => type((x) => (x.confluence.spaceKey = e.target.value))} />
        </Row>
      </Group>
      <Group title="Confluence scope">
        <p className="m-0 pt-3 text-[13px] leading-normal text-muted">
          Each draft searches Confluence for the pages these rules find, so a page added to the tree is offered without changing anything here. Before every write, the executor checks again that the page is still in scope (FR-10.6).
        </p>
        <PageList
          label="Root pages"
          help="Each page and everything below it. Index pages are offered as hubs; entries go to their children."
          pages={s.confluence.roots}
          field="roots"
          set={set}
          err={err}
          empty="No root pages."
        />
        <Row stacked label="Labels" help="Pages in the space with any of these labels, wherever they sit.">
          <LabelList labels={s.confluence.labels} onChange={(v) => set((x) => (x.confluence.labels = v))} err={err} />
        </Row>
        <PageList
          label="Excluded pages"
          help="Never offered or written, with everything below them. Wins over the rules above."
          pages={s.confluence.exclude}
          field="exclude"
          set={set}
          err={err}
          empty="Nothing excluded."
        />
        <PageList label="Single pages" help="Extra pages on their own, without the pages below them." pages={s.confluence.pages} field="pages" set={set} err={err} empty="No single pages." />
        <CataloguePreview s={s} />
      </Group>
      {full && (
        <Group title="More actions">
          <FutureRow title="Jira projects" phase="P3">
            An allow-list of projects that Create Jira task may write to.
          </FutureRow>
          <FutureRow title="JPD ideas (PSPD)" phase="P3">
            Pipeline Stage = triage, with a Work OS label so each idea traces back to its thread.
          </FutureRow>
          <FutureRow title="Batched execution" phase="P3">
            Run approved actions together, grouped by target, at 12:30 and 17:00.
          </FutureRow>
        </Group>
      )}
    </>
  );
}

type PageField = 'roots' | 'exclude' | 'pages';

/** A list of Confluence pages with an add form (by ID or URL), for one of the scope rules. */
function PageList({ label, help, pages, field, set, err, empty }: { label: string; help: string; pages: ConfluencePage[]; field: PageField; set: Ctx['set']; err: Ctx['err']; empty: string }) {
  const [adding, setAdding] = useState<{ title: string; ref: string; error?: string } | null>(null);
  const add = () => {
    if (!adding) return;
    const m = /pages\/(\d+)/.exec(adding.ref) ?? /^\s*(\d+)\s*$/.exec(adding.ref);
    if (!adding.title.trim()) return setAdding({ ...adding, error: 'Give the page a title, e.g. DP - Pricing' });
    if (!m) return setAdding({ ...adding, error: 'Paste a page URL or a numeric page ID' });
    if (pages.some((p) => p.id === m[1])) return setAdding({ ...adding, error: `That page is already in ${label.toLowerCase()}` });
    set((x) => x.confluence[field].push({ title: adding.title.trim(), id: m[1] }));
    setAdding(null);
  };
  const singular = label.replace(/s$/, '').toLowerCase();
  return (
    <Row stacked label={label} help={help}>
      <div className="flex flex-col" aria-label={label}>
        {pages.map((p, i) => (
          <div key={`${p.id}-${i}`} className="flex flex-wrap items-center gap-3 border-b border-line-soft py-2">
            <Icon name="confluence" size={15} className="text-muted" />
            <span className="flex-1 text-sm">{p.title}</span>
            <span className={cx('font-mono text-xs', err(`confluence.${field}.${i}.id`) ? 'text-red-fg' : 'text-muted')}>{p.id}</span>
            <IconButton label={`Remove ${p.title} from ${label.toLowerCase()}`} icon="x" size={32} onClick={() => set((x) => x.confluence[field].splice(i, 1))} />
            {err(`confluence.${field}.${i}.id`) && <span className="w-full text-xs text-red-fg">{err(`confluence.${field}.${i}.id`)}</span>}
          </div>
        ))}
        {pages.length === 0 && <div className="border-b border-line-soft py-2.5 text-[13px] text-muted">{empty}</div>}
      </div>
      {adding ? (
        <form
          className="flex flex-col gap-3 rounded-lg border border-line p-4"
          aria-label={`Add ${singular}`}
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-[1_1_180px] flex-col gap-1.5 text-[13px] font-medium">
              Title
              <input className={inputClass} placeholder="DP - Pricing" value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value, error: undefined })} />
            </label>
            <label className="flex flex-[1_1_240px] flex-col gap-1.5 text-[13px] font-medium">
              Page ID or URL
              <input className={cx(inputClass, 'font-mono text-[13px]')} placeholder="3031007299 or https://…/pages/3031007299/…" value={adding.ref} onChange={(e) => setAdding({ ...adding, ref: e.target.value, error: undefined })} />
            </label>
          </div>
          {adding.error && <span className="text-xs text-red-fg">{adding.error}</span>}
          <div className="flex gap-2">
            <Button type="submit" variant="solid">
              Add
            </Button>
            <Button onClick={() => setAdding(null)}>Cancel</Button>
          </div>
        </form>
      ) : (
        <Button variant="ghost" className="self-start text-accent" icon="plus" onClick={() => setAdding({ title: '', ref: '' })}>
          Add {singular} by ID or URL
        </Button>
      )}
    </Row>
  );
}

function LabelList({ labels, onChange, err }: { labels: string[]; onChange: (v: string[]) => void; err: Ctx['err'] }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const add = () => {
    const l = draft.trim().toLowerCase();
    if (!l) return;
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(l)) return setError('Labels are lower case, without spaces');
    if (labels.includes(l)) return setError('That label is already listed');
    onChange([...labels, l]);
    setDraft('');
  };
  const listError = labels.map((_, i) => err(`confluence.labels.${i}`)).find(Boolean);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5" aria-label="Labels">
        {labels.map((l) => (
          <span key={l} className="inline-flex items-center gap-1 rounded-full bg-bg py-0.5 pl-2.5 pr-1 font-mono text-xs text-ink-2">
            {l}
            <IconButton label={`Remove label ${l}`} icon="x" size={24} onClick={() => onChange(labels.filter((x) => x !== l))} />
          </span>
        ))}
        {labels.length === 0 && <span className="text-[13px] text-muted">No labels.</span>}
      </div>
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <input
          aria-label="New label"
          className={cx(inputBase, 'w-[240px] font-mono text-[13px]')}
          placeholder="psg-shared-glossary"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(undefined);
          }}
        />
        <Button type="submit" disabled={!draft.trim()}>
          Add label
        </Button>
      </form>
      {(error ?? listError) && <span className="text-xs text-red-fg">{error ?? listError}</span>}
    </div>
  );
}

/** "Preview catalogue": every page in scope now, grouped by root, as a draft would see them. */
function CataloguePreview({ s }: { s: Settings }) {
  const [state, setState] = useState<{ loading: boolean; data?: ConfluenceCatalogueView; error?: string }>({ loading: false });
  const load = async () => {
    setState({ loading: true });
    try {
      setState({ loading: false, data: await api.getConfluenceCatalogue() });
    } catch (e) {
      setState({ loading: false, error: isApiError(e) ? e.message : 'The catalogue could not be read.' });
    }
  };
  const groups = new Map<string, CataloguePageView[]>();
  for (const p of state.data?.pages ?? []) {
    const key = p.rootId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), p]);
  }
  const rootTitle = (id: string) => s.confluence.roots.find((r) => r.id === id)?.title ?? id;
  const ordered = [...s.confluence.roots.map((r) => r.id).filter((id) => groups.has(id)), ...(groups.has('') ? [''] : [])];
  return (
    <Row
      stacked
      label="Preview"
      help={
        state.data ? (
          <span>
            <strong className="font-semibold text-ink">{state.data.pages.length} pages in scope</strong>
            {state.data.truncated && ' (the search stopped at its limit, so there may be more)'}, read from Confluence now. Settings save as you change them, so this is what the next draft sees.
          </span>
        ) : (
          'Reads the catalogue from Confluence now, as the next draft will.'
        )
      }
    >
      <Button className="self-start" icon="search" disabled={state.loading} onClick={load}>
        {state.loading ? (
          <>
            <Spinner size={12} /> Reading Confluence…
          </>
        ) : state.data ? (
          'Read again'
        ) : (
          'Preview catalogue'
        )}
      </Button>
      {state.error && (
        <Banner tone="bad" icon="alert">
          {state.error}
        </Banner>
      )}
      {state.data && (
        <div className="flex max-h-[420px] flex-col overflow-y-auto rounded-lg border border-line" aria-label="Pages in scope">
          {ordered.map((key) => (
            <div key={key || 'other'} className="flex flex-col">
              <div className="sticky top-0 border-b border-line-soft bg-surface px-3 py-2 text-xs font-semibold text-ink-2">
                {key ? rootTitle(key) : 'By label or single page'} <span className="font-normal text-muted">· {groups.get(key)!.length}</span>
              </div>
              {groups.get(key)!.map((p) => (
                <a
                  key={p.id}
                  href={confluencePageUrl(s.confluence.siteUrl, s.confluence.spaceKey, p.id)}
                  target="_blank"
                  rel="noreferrer"
                  className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line-soft px-3 py-1.5 text-[13px] !text-ink no-underline last:border-b-0 hover:bg-bg"
                  data-page={p.id}
                >
                  <span className="min-w-0 flex-1 truncate" title={p.path}>
                    {p.path}
                  </span>
                  {p.hub && <Chip>index</Chip>}
                </a>
              ))}
            </div>
          ))}
          {state.data.pages.length === 0 && <div className="px-3 py-3 text-[13px] text-muted">No pages match. Check the space key, root pages and labels.</div>}
        </div>
      )}
    </Row>
  );
}

// ---------- Models ----------

const BACKENDS = [
  ['subscription', 'Claude subscription (Agent SDK)'],
  ['api_key', 'API key'],
  ['bedrock', 'Amazon Bedrock'],
] as const;

function ModelsSection({ s, full, set, type, flush, err, confirm }: Ctx) {
  const prompts = useApiQuery(() => api.getPrompts(), onTopics('settings'), []);
  const batchingErr = ['maxThreadsPerCall', 'maxInputTokens', 'keepLastMessages'].some((k) => err(`triage.${k}`));
  const [showBatching, setShowBatching] = useState(false);
  const open = showBatching || batchingErr;
  return (
    <>
      <SectionHeader title="Models" description="Anthropic models only. Every call sets its model, tools and prompt explicitly." />
      <Group title="Backend">
        <Row
          stacked
          label="Claude backend"
          help={
            <>
              The subscription is the MVP default. The server refuses to start if <span className="font-mono">ANTHROPIC_API_KEY</span> is set while it’s in use (CL-2).
            </>
          }
        >
          <div role="radiogroup" aria-label="Claude backend" className="flex flex-col">
            {BACKENDS.map(([v, label]) => (
              <label key={v} className="flex min-h-11 items-center gap-3 border-b border-line-soft text-sm last:border-b-0 cursor-pointer">
                <input
                  type="radio"
                  name="backend"
                  className="h-4 w-4 accent-[var(--accent)]"
                  checked={s.claudeBackend === v}
                  onChange={() =>
                    v === 'subscription'
                      ? set((x) => (x.claudeBackend = v))
                      : confirm({
                          title: `Switch to ${label}?`,
                          body: (
                            <>
                              <p className="mt-0">The MVP runs on your Claude subscription through the Agent SDK. {label} is a fallback that bills separately and needs its own credentials (CL-8).</p>
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
      </Group>
      <Group title="Model per purpose">
        {(
          [
            ['Triage', 'One batched call per poll. No tools, no MCP.', 'triage', 'triage'],
            ['Vault drafts', 'One call per click, with read-only vault access.', 'draftVault', 'draft-vault'],
            ['Confluence drafts', 'Two calls per click: pick the page from the live catalogue, then draft. Pages in scope only.', 'draftConfluence', 'draft-confluence'],
          ] as const
        ).map(([purpose, shape, key, prompt]) => (
          <Row
            key={key}
            label={purpose}
            htmlFor={`model-${key}`}
            help={
              <>
                {shape}{' '}
                <Link to="/settings/prompts" className="font-mono text-xs text-muted underline decoration-line-strong underline-offset-2 hover:text-accent">
                  {prompts.data?.find((p) => p.id === prompt)?.version ?? `${prompt}.md`}
                </Link>
              </>
            }
          >
            <select id={`model-${key}`} aria-label={`Model for ${purpose}`} className={cx(inputBase, 'w-[150px] font-mono text-[13px]')} value={s.models[key]} onChange={(e) => set((x) => (x.models[key] = e.target.value as ModelId))}>
              {(['haiku-4.5', 'sonnet-5.5', 'opus-5.5'] as const).map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Row>
        ))}
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
      </Group>
      <Group>
        <button type="button" aria-expanded={open} onClick={() => setShowBatching((v) => !v)} className="mt-6 flex items-center gap-2.5 border-b border-line-soft py-3 text-left cursor-pointer">
          <Icon name="arrow" size={13} className={cx('text-muted transition-transform', open && 'rotate-90')} />
          <span className="text-[13px] font-semibold">Batching limits</span>
          <span className="text-xs text-muted">
            {s.triage.maxThreadsPerCall} threads per call · {Number.isNaN(s.triage.maxInputTokens) ? '–' : s.triage.maxInputTokens.toLocaleString('en-GB')} input tokens · last {s.triage.keepLastMessages} messages
          </span>
        </button>
        {open && (
          <>
            <Row label="Threads per call" help="Above this, a poll splits into several triage calls." error={err('triage.maxThreadsPerCall')}>
              <NumInput label="Max threads per call" value={s.triage.maxThreadsPerCall} invalid={!!err('triage.maxThreadsPerCall')} onBlur={flush} onChange={(v) => type((x) => (x.triage.maxThreadsPerCall = v ?? NaN))} />
            </Row>
            <Row label="Input tokens per call" help="Long threads are trimmed to fit." error={err('triage.maxInputTokens')}>
              <NumInput label="Max input tokens" width="w-28" value={s.triage.maxInputTokens} invalid={!!err('triage.maxInputTokens')} onBlur={flush} onChange={(v) => type((x) => (x.triage.maxInputTokens = v ?? NaN))} />
            </Row>
            <Row label="Messages kept per thread" help="The first message is always kept, plus this many of the latest." error={err('triage.keepLastMessages')}>
              <NumInput label="Keep last N messages" value={s.triage.keepLastMessages} invalid={!!err('triage.keepLastMessages')} onBlur={flush} onChange={(v) => type((x) => (x.triage.keepLastMessages = v ?? NaN))} />
            </Row>
          </>
        )}
      </Group>
    </>
  );
}

// ---------- Prompts ----------

const GUIDANCE: PromptFileId[] = ['vault-conventions', 'confluence-routing'];

interface PromptEdit {
  id: PromptFileId;
  text: string;
  baseVersion: string;
  saving?: boolean;
  error?: string;
  /** The file changed on disk since it was opened: this version is now current. */
  conflict?: PromptFileView;
}

const kb = (text: string) => `${(new TextEncoder().encode(text).length / 1024).toFixed(1)} KB`;

/**
 * The prompt and guidance files (FR-1.7). Unlike the rest of Settings this saves on an explicit
 * Save: every Claude call reads its file fresh, so a half-typed autosave would reach a real call.
 */
function PromptsSection({ confirm, setUnsaved }: Ctx) {
  const q = useApiQuery(() => api.getPrompts(), onTopics('settings'), []);
  const [edit, setEditState] = useState<PromptEdit | null>(null);
  const files = q.data;
  const open = files?.find((f) => f.id === edit?.id);
  const dirty = !!edit && !!open && edit.text !== open.text && !edit.conflict;

  const setEdit = (e: PromptEdit | null) => {
    setEditState(e);
    const f = e && files?.find((x) => x.id === e.id);
    setUnsaved(e && f && e.text !== f.text ? f.label : null);
  };
  const done = (saved: PromptFileView, what: string) => {
    setEdit(null);
    q.reload();
    toast(`${saved.label} ${what}`, { tone: 'success', description: `Now ${saved.version}. The next call uses it.` });
  };
  const failed = (e: unknown) => {
    if (!edit) return;
    if (isApiError(e) && e.code === 'conflict') {
      void api.getPrompts().then((fresh) => setEditState((x) => x && { ...x, saving: false, conflict: fresh.find((f) => f.id === x.id) }));
    } else if (isApiError(e) && e.code === 'validation') {
      setEditState({ ...edit, saving: false, error: e.issues[0]?.message ?? e.message });
    } else {
      setEditState({ ...edit, saving: false });
      errorToast(e);
    }
  };
  const save = async () => {
    if (!edit) return;
    setEditState({ ...edit, saving: true, error: undefined });
    try {
      done(await api.savePrompt(edit.id, edit.text, edit.baseVersion), 'saved');
    } catch (e) {
      failed(e);
    }
  };
  const markReviewed = async (f: PromptFileView) => {
    try {
      const saved = await api.markPromptReviewed(f.id, f.version);
      setEdit({ id: f.id, text: saved.text, baseVersion: saved.version });
      q.reload();
      toast(`${f.label} marked reviewed`, { tone: 'success', description: 'Its sources are recorded as they are now.' });
    } catch (e) {
      q.reload();
      errorToast(e);
    }
  };
  const reset = (f: PromptFileView) =>
    confirm({
      title: `Reset ${f.label}?`,
      body: `This replaces ${f.path} with the built-in default (${f.defaultVersion}). Your edits are not kept.`,
      label: 'Reset to default',
      danger: true,
      run: async () => {
        try {
          done(await api.resetPrompt(f.id, f.version), 'reset to default');
        } catch (e) {
          q.reload(); // a conflict means the file moved on: show what is there now
          errorToast(e);
        }
      },
    });

  const row = (f: PromptFileView) =>
    edit?.id === f.id ? (
      <div key={f.id} className="flex flex-col gap-3 border-b border-line-soft py-5 last:border-b-0" data-prompt={f.id}>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-sm font-medium text-ink">{f.label}</span>
          <span className="font-mono text-xs text-muted">{f.path}</span>
          <span className="flex-1" />
          <span className="font-mono text-xs text-muted" data-testid="prompt-size">
            {kb(edit.text)}
          </span>
        </div>
        {edit.conflict && (
          <Banner
            tone="warn"
            icon="alert"
            action={
              <Button size="sm" onClick={() => setEdit({ id: f.id, text: edit.conflict!.text, baseVersion: edit.conflict!.version })}>
                Load it
              </Button>
            }
          >
            <strong>This file changed since you opened it</strong> (now {edit.conflict.version}). Load the new version to edit it; your changes here are dropped.
          </Banner>
        )}
        {f.sources.some((x) => x.state !== 'current') && (
          <Banner
            tone="warn"
            icon="alert"
            action={
              f.sources.some((x) => x.state === 'changed') && (
                <Button size="sm" disabled={dirty} onClick={() => void markReviewed(f)}>
                  Mark reviewed
                </Button>
              )
            }
          >
            <span data-testid="prompt-sources">
              {f.sources
                .filter((x) => x.state !== 'current')
                .map((x) => (
                  <span key={x.id} className="block">
                    <strong>{x.state === 'changed' ? `The ${x.label} changed` : `The ${x.label} wasn’t found`}</strong> since this was written
                    {x.path && <span className="font-mono text-xs"> · {x.path}</span>}.
                  </span>
                ))}
              {f.sources.some((x) => x.state === 'changed') && <>Check this guidance against it and edit what’s out of date, then mark it reviewed.</>}
            </span>
          </Banner>
        )}
        <textarea
          aria-label={`${f.label} text`}
          spellCheck={false}
          className="min-h-[360px] w-full resize-y rounded-lg border border-line-strong bg-surface p-3 font-mono text-[13px] leading-relaxed text-ink outline-none focus:border-accent aria-[invalid=true]:border-red"
          aria-invalid={!!edit.error}
          value={edit.text}
          onChange={(e) => setEdit({ ...edit, text: e.target.value, error: undefined })}
        />
        {edit.error && <span className="text-xs text-red-fg">{edit.error}</span>}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="solid" disabled={!dirty || edit.saving} onClick={() => void save()}>
            {edit.saving ? (
              <>
                <Spinner size={12} /> Saving…
              </>
            ) : (
              'Save'
            )}
          </Button>
          <Button onClick={() => setEdit(null)}>{dirty ? 'Cancel' : 'Close'}</Button>
          <span className="flex-1" />
          {f.edited && (
            <Button variant="ghost" icon="redraft" onClick={() => reset(f)}>
              Reset to default
            </Button>
          )}
        </div>
      </div>
    ) : (
      <Row
        key={f.id}
        label={
          <span className="inline-flex items-center gap-2">
            {f.label}
            {f.edited && <Chip tone="accent">Edited</Chip>}
            {f.sources.some((x) => x.state === 'changed') && <Chip tone="warn">Source changed</Chip>}
          </span>
        }
        help={
          <>
            {f.description} Used by: {f.usedBy}.
          </>
        }
      >
        <div className="flex items-center gap-3" data-prompt={f.id}>
          <span className="font-mono text-xs text-muted" title={f.edited ? `Built-in default: ${f.defaultVersion}` : 'The built-in default'}>
            {f.version}
          </span>
          <Button
            size="sm"
            disabled={dirty}
            aria-label={`Edit ${f.label}`}
            onClick={() => setEdit({ id: f.id, text: f.text, baseVersion: f.version })}
          >
            Edit
          </Button>
        </div>
      </Row>
    );

  return (
    <>
      <SectionHeader
        title="Prompts"
        description="What each Claude call is told. Every call reads its file from the data directory, so a saved change applies to the next call. Versions match the usage log and eval reports."
        action={<GuideLink topic="prompts" />}
      />
      {!files ? (
        <div className="py-6 text-[13px] text-muted">{q.error ? 'Could not load the prompt files.' : 'Loading…'}</div>
      ) : (
        <>
          <Group title="Prompts">{files.filter((f) => !GUIDANCE.includes(f.id)).map(row)}</Group>
          <Group title="Filing guidance" aside={<span className="text-xs text-muted">Sent with every draft request</span>}>
            {files.filter((f) => GUIDANCE.includes(f.id)).map(row)}
          </Group>
        </>
      )}
    </>
  );
}

// ---------- Budgets ----------

function BudgetsSection({ s, usage, type, flush, err }: Ctx) {
  const today = usage?.today;
  const drafts = today ? today.draftsVault + today.draftsConfluence : 0;
  return (
    <>
      <SectionHeader title="Budgets" description="When one runs out, model triage pauses until tomorrow. Rules keep running and the inbox shows a banner." />
      <Group title="Daily limits">
        <Row label="Triage calls" htmlFor="b-triage" help={today ? <Meter used={today.triageCalls} limit={s.budgets.triageCallsPerDay} text={`${today.triageCalls} used today`} /> : 'Batched model calls that triage threads.'} error={err('budgets.triageCallsPerDay')}>
          <NumInput id="b-triage" label="Triage calls per day" suffix="per day" value={s.budgets.triageCallsPerDay} invalid={!!err('budgets.triageCallsPerDay')} onBlur={flush} onChange={(v) => type((x) => (x.budgets.triageCallsPerDay = v ?? NaN))} />
        </Row>
        <Row label="Drafts" htmlFor="b-drafts" help={today ? <Meter used={drafts} limit={s.budgets.draftsPerDay} text={`${drafts} used today`} /> : 'Vault notes and Confluence entries.'} error={err('budgets.draftsPerDay')}>
          <NumInput id="b-drafts" label="Drafts per day" suffix="per day" value={s.budgets.draftsPerDay} invalid={!!err('budgets.draftsPerDay')} onBlur={flush} onChange={(v) => type((x) => (x.budgets.draftsPerDay = v ?? NaN))} />
        </Row>
        <Row
          label="Cost-equivalent"
          htmlFor="b-cost"
          help={today ? <Meter used={today.costEquivalent} limit={s.budgets.costEquivalentPerDay} text={`${fmtMoney(today.costEquivalent)} used today`} /> : 'What the calls would cost at API prices.'}
          error={err('budgets.costEquivalentPerDay')}
        >
          <NumInput id="b-cost" label="Cost-equivalent per day" prefix="$" suffix="per day" step="0.1" value={s.budgets.costEquivalentPerDay} invalid={!!err('budgets.costEquivalentPerDay')} onBlur={flush} onChange={(v) => type((x) => (x.budgets.costEquivalentPerDay = v ?? NaN))} />
        </Row>
      </Group>
      <Group title="Baseline">
        <Row label="Daily baseline" htmlFor="b-baseline" help="Average daily cost of the scheduled tasks Work OS replaces, measured in Phase 0 (P0-3). Leave empty until it’s measured." error={err('baselineCostPerDay')}>
          <NumInput id="b-baseline" label="Baseline per day" prefix="$" suffix="per day" step="0.1" placeholder="—" value={s.baselineCostPerDay} invalid={!!err('baselineCostPerDay')} onBlur={flush} onChange={(v) => type((x) => (x.baselineCostPerDay = v))} />
        </Row>
      </Group>
    </>
  );
}

// ---------- Storage ----------

const CHECK_ICON: Record<CheckStatus, { icon: 'check' | 'alert' | 'x'; cls: string }> = {
  ok: { icon: 'check', cls: 'text-green-fg' },
  warn: { icon: 'alert', cls: 'text-amber-fg' },
  fail: { icon: 'x', cls: 'text-red-fg' },
};

function StorageSection({ s, view, full, type, flush, err }: Ctx) {
  const [rebuilding, setRebuilding] = useState(false);
  return (
    <>
      <SectionHeader title="Storage & data" description="Everything lives in files in the data directory. There is no database." />
      <Group title="Data">
        <Row label="Keep message text for" help="Then thread text is deleted. Events keep IDs, decisions and permalinks, never message bodies (FR-12.1)." error={err('retentionDays')}>
          <NumInput label="Retention days" suffix="days" value={s.retentionDays} invalid={!!err('retentionDays')} onBlur={flush} onChange={(v) => type((x) => (x.retentionDays = v ?? NaN))} />
        </Row>
        <Row label="Data directory" help="Event log, state, items, drafts, labels and logs.">
          <span className="font-mono text-[13px] text-ink-2">{s.dataDir}</span>
        </Row>
        <Row label="Rebuild inbox state" help="Regenerates snapshot.json from the event log. Nothing is lost.">
          <Button
            disabled={rebuilding}
            onClick={async () => {
              setRebuilding(true);
              try {
                const r = await api.rebuildState();
                toast('State rebuilt', { tone: 'success', description: `Replayed ${r.events.toLocaleString('en-GB')} events. Nothing was lost.` });
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
      </Group>
      <Group title="Startup checks" aside={<span className="text-xs text-muted">Last run at login, {fmtTime(view.checkedAt)}</span>}>
        {view.checks.map((k) => (
          <div key={k.id} className="flex items-center gap-3 border-b border-line-soft py-3 text-sm last:border-b-0" data-check={k.id}>
            <Icon name={CHECK_ICON[k.status].icon} size={15} strokeWidth={2.5} className={CHECK_ICON[k.status].cls} />
            <span className="flex-1">{k.label}</span>
            <span className={cx('font-mono text-xs', k.status === 'ok' ? 'text-muted' : CHECK_ICON[k.status].cls)}>{k.note}</span>
          </div>
        ))}
      </Group>
      {full && (
        <FutureRow title="Plugins" phase="P4" cta="Manage plugins">
          Sources and actions as folders with a manifest, so adding one needs no change to the core.
        </FutureRow>
      )}
    </>
  );
}

// ---------- Appearance ----------

/** The avatar in the sidebar's account menu: a picture from disk, or the person icon. */
function ProfilePicture() {
  const avatar = usePrefs((s) => s.avatar);
  const setAvatar = usePrefs((s) => s.setAvatar);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      setAvatar(await avatarDataUrl(file));
      toast('Profile picture updated.', { tone: 'success' });
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = ''; // so picking the same file again still fires
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Avatar size={48} />
      <input ref={input} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-label="Profile picture file" onChange={(e) => void pick(e.target.files?.[0])} />
      <Button size="sm" disabled={busy} onClick={() => input.current?.click()}>
        {busy && <Spinner size={12} />}
        {avatar ? 'Change picture' : 'Upload picture'}
      </Button>
      {avatar && (
        <Button size="sm" variant="ghost" icon="trash" onClick={() => (setAvatar(undefined), toast('Profile picture removed.'))}>
          Remove
        </Button>
      )}
    </div>
  );
}

function AppearanceSection() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);
  return (
    <>
      <SectionHeader title="Appearance" description="Saved in this browser only, not in settings.json." />
      <Group>
        <Row label="Theme" help="System follows your macOS setting.">
          <Segmented<Theme>
            label="Theme"
            size="sm"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Row>
        <Row label="Profile picture" help="Shown in the sidebar’s account menu. Cropped to a square.">
          <ProfilePicture />
        </Row>
      </Group>
    </>
  );
}

// ---------- Registry ----------

export interface SectionDef {
  id: string;
  label: string;
  group: 'Inbox' | 'Actions' | 'Claude' | 'System';
  View: ComponentType<Ctx>;
  /** Which validation paths belong to this section, for the nav's error dot. */
  owns: (path: string) => boolean;
}

const under = (...prefixes: string[]) => (path: string) => prefixes.some((p) => path === p || path.startsWith(`${p}.`));

export const SECTIONS: SectionDef[] = [
  { id: 'rules', label: 'Triage rules', group: 'Inbox', View: RulesSection, owns: under('rules') },
  { id: 'slack', label: 'Slack', group: 'Inbox', View: SlackSection, owns: under('settings.slack', 'settings.schedule', 'settings.triage.quietMinutes') },
  { id: 'notifications', label: 'Notifications', group: 'Inbox', View: NotificationsSection, owns: under('settings.notifications') },
  { id: 'writing', label: 'Write targets', group: 'Actions', View: WritingSection, owns: under('settings.dryRun', 'settings.vaultPath', 'settings.confluence') },
  { id: 'models', label: 'Models', group: 'Claude', View: ModelsSection, owns: under('settings.models', 'settings.claudeBackend', 'settings.triage.maxThreadsPerCall', 'settings.triage.maxInputTokens', 'settings.triage.keepLastMessages') },
  { id: 'prompts', label: 'Prompts', group: 'Claude', View: PromptsSection, owns: () => false },
  { id: 'budgets', label: 'Budgets', group: 'Claude', View: BudgetsSection, owns: under('settings.budgets', 'settings.baselineCostPerDay') },
  { id: 'storage', label: 'Storage & data', group: 'System', View: StorageSection, owns: under('settings.retentionDays', 'settings.dataDir') },
  { id: 'appearance', label: 'Appearance', group: 'System', View: AppearanceSection, owns: () => false },
];

/** Where the old single-page anchors now live, so existing links keep working. */
export const LEGACY_ANCHORS: Record<string, string> = {
  rules: 'rules',
  sources: 'slack',
  notify: 'notifications',
  targets: 'writing',
  'dry-run': 'writing#dry-run',
  models: 'models',
  budgets: 'budgets',
  storage: 'storage',
  appearance: 'appearance',
};
