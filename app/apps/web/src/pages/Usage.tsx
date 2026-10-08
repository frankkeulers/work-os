import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import type { SourceHealth as SourceHealthView, SourceId, UsagePurpose } from '@work-os/shared';
import { api, type BudgetLine, type Criterion, type UsageView } from '../api';
import { BrandIcon, SourceMark } from '../components/BrandIcon';
import { HealthBanner } from '../components/HealthBanner';
import { Banner, Button, MvpTag, PhaseTag, SectionCard, Spinner, cx } from '../components/ui';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { useHashScroll } from '../hooks/useHashScroll';
import { fmtDate, fmtMoney, fmtTime, fmtTokens } from '../lib/format';
import { usePrefs } from '../store/prefs';
import { errorToast, toast } from '../store/toasts';

export const PURPOSE_LABEL: Record<UsagePurpose, string> = {
  triage: 'Triage',
  draft_vault: 'Draft vault note',
  confluence_pick: 'Pick Confluence page',
  draft_confluence: 'Draft Confluence entry',
  people_check: 'People check',
  eval: 'Eval run',
  startup_check: 'Startup check',
  fetch: 'Connector fetch',
  routing: 'Topic routing',
};

export const evalPath = (id: string) => `/usage/eval/${encodeURIComponent(id)}`;

const pctOf = (b: BudgetLine) => Math.min(100, Math.round((b.used / b.limit) * 100));
const barColour = (b: BudgetLine) => (b.hit ? 'var(--red)' : b.used / b.limit >= 0.8 ? 'var(--amber)' : 'var(--accent-bg)');

function Bar({ pct, colour }: { pct: number; colour: string }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-[3px] bg-track">
      <div className="h-1.5 transition-[width]" style={{ width: `${pct}%`, background: colour }} />
    </div>
  );
}

function Kpi({ label, value, of, bar, note }: { label: string; value: ReactNode; of?: string; bar?: ReactNode; note: ReactNode }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface p-4">
      <span className="text-xs text-muted">{label}</span>
      <span className="text-[28px] font-semibold tracking-[-0.02em]">
        {value}
        {of && <span className="text-sm font-normal text-muted"> / {of}</span>}
      </span>
      {bar}
      <span className="text-xs text-muted">{note}</span>
    </div>
  );
}

function Days({ u }: { u: UsageView }) {
  const baseline = u.budgets.baseline;
  const max = Math.max(baseline ?? 0, ...u.days.map((d) => d.triage + d.drafts), 0.01) * 1.2;
  const h = (v: number) => Math.round((v / max) * 200);
  return (
    <SectionCard className="flex min-w-0 flex-[1.4_1_480px] flex-col gap-3.5 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="m-0 flex-1 text-[15px] font-semibold">Last 7 days, cost-equivalent</h2>
        <Legend swatch={<span className="h-2.5 w-2.5 rounded-sm bg-accent-bg" />}>Triage and checks</Legend>
        <Legend swatch={<span className="h-2.5 w-2.5 rounded-sm bg-accent-light" />}>Drafts</Legend>
        {baseline !== null && <Legend swatch={<span className="w-3.5 border-t-2 border-dashed border-amber" />}>Baseline {fmtMoney(baseline)}</Legend>}
      </div>
      <div className="relative h-[200px] border-b border-line" role="img" aria-label={`Daily cost-equivalent for the last 7 days${baseline !== null ? `, baseline ${fmtMoney(baseline)} a day` : ''}`}>
        {baseline !== null && <div className="absolute inset-x-0 border-t-2 border-dashed border-amber" style={{ bottom: h(baseline) }} />}
        <div className="absolute inset-0 grid grid-cols-7 items-end gap-3.5 px-1.5">
          {u.days.map((d) => (
            <div key={d.date} className="flex h-full flex-col justify-end" title={`${d.label}: triage ${fmtMoney(d.triage)}, drafts ${fmtMoney(d.drafts)}`}>
              <div className="rounded-t bg-accent-light" style={{ height: h(d.drafts) }} />
              <div className={cx('bg-accent-bg', d.drafts === 0 && 'rounded-t')} style={{ height: h(d.triage) }} />
            </div>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-7 gap-3.5 px-1.5 text-center font-mono text-[11px] text-muted">
        {u.days.map((d, i) => (
          <span key={d.date} className={cx(i === 6 && 'font-semibold text-ink')}>
            {i === 6 ? 'Today' : d.label}
          </span>
        ))}
      </div>
    </SectionCard>
  );
}

const Legend = ({ swatch, children }: { swatch: ReactNode; children: ReactNode }) => (
  <span className="inline-flex items-center gap-1.5 text-xs text-ink-2">
    {swatch}
    {children}
  </span>
);

function Budgets({ u }: { u: UsageView }) {
  const b = u.budgets;
  const rows: [string, BudgetLine, string][] = [
    ['Triage calls', b.triage, `${b.triage.used} / ${b.triage.limit}`],
    ['Drafts', b.drafts, `${b.drafts.used} / ${b.drafts.limit}`],
    ['Cost-equivalent', b.cost, `${fmtMoney(b.cost.used)} / ${fmtMoney(b.cost.limit)}`],
  ];
  return (
    <SectionCard className="flex min-w-0 flex-[1_1_320px] flex-col gap-3.5 p-4">
      <h2 className="m-0 text-[15px] font-semibold">Daily budgets</h2>
      <div className="text-xs leading-[1.45] text-muted">When a budget is hit, model triage pauses, rules-only triage continues, and the inbox shows a banner.</div>
      {rows.map(([name, line, val]) => (
        <div key={name} className="flex flex-col gap-1.5">
          <div className="flex text-[13px]">
            <span className="flex-1">
              {name}
              {line.hit && <span className="ml-2 text-xs font-medium text-red-fg">reached</span>}
            </span>
            <span className="font-mono text-ink-2">{val}</span>
          </div>
          <Bar pct={pctOf(line)} colour={barColour(line)} />
        </div>
      ))}
      <Link to="/settings/budgets" className="text-[13px]">
        Edit in settings
      </Link>
    </SectionCard>
  );
}

function ByPurpose({ u }: { u: UsageView }) {
  const full = usePrefs((s) => s.scope === 'full');
  const total = u.byPurpose.reduce((s, r) => s + r.costEquivalent, 0);
  const td = 'border-b border-line-soft-2 px-2 py-[9px]';
  return (
    <SectionCard className="flex min-w-0 flex-[1.4_1_480px] flex-col gap-2.5 p-4">
      <h2 className="m-0 text-[15px] font-semibold">By purpose and model, today</h2>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[460px] border-collapse text-[13px]">
          <thead>
            <tr className="text-left text-xs text-muted">
              {['Purpose', 'Model', 'Calls', 'Tokens', 'Share'].map((h, i) => (
                <th key={h} scope="col" className={cx('border-b border-line px-2 py-2 font-medium', i === 0 && 'pl-0', i >= 2 && 'text-right', i === 4 && 'pr-0')}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {u.byPurpose.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-muted">
                  No Claude calls yet today.
                </td>
              </tr>
            )}
            {u.byPurpose.map((r) => (
              <tr key={`${r.purpose}-${r.model}`}>
                <td className={cx(td, 'pl-0')}>{PURPOSE_LABEL[r.purpose]}</td>
                <td className={cx(td, 'font-mono text-xs')}>{r.model}</td>
                <td className={cx(td, 'text-right')}>{r.calls}</td>
                <td className={cx(td, 'text-right')}>{fmtTokens(r.tokens)}</td>
                <td className={cx(td, 'pr-0 text-right')}>{total ? `${Math.round((r.costEquivalent / total) * 100)}%` : '—'}</td>
              </tr>
            ))}
            {full &&
              (
                [
                  ['Meeting summaries', 'haiku-5.5', 'P2'],
                  ['Daily brief', 'opus-5.5', 'P4'],
                ] as const
              ).map(([p, m, phase]) => (
                <tr key={p} className="bg-violet-wash">
                  <td className={cx(td, 'pl-0')}>
                    {p} <PhaseTag phase={phase} />
                  </td>
                  <td className={cx(td, 'font-mono text-xs')}>{m}</td>
                  <td className={cx(td, 'text-right')}>—</td>
                  <td className={cx(td, 'text-right')}>—</td>
                  <td className={cx(td, 'pr-0 text-right')}>—</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

const SLACK = {
  healthy: { label: 'Healthy', dot: 'var(--green)', cls: 'text-green-fg' },
  backoff: { label: 'Backing off (429)', dot: 'var(--amber)', cls: 'text-amber-fg' },
  auth_failed: { label: 'Token rejected', dot: 'var(--red)', cls: 'text-red-fg' },
  never: { label: 'Not polled yet', dot: 'var(--gray-mid)', cls: 'text-muted' },
  offline: { label: 'Offline', dot: 'var(--gray-mid)', cls: 'text-muted' },
  degraded: { label: 'Errors, retrying', dot: 'var(--amber)', cls: 'text-amber-fg' },
  paused: { label: 'Paused', dot: 'var(--gray-mid)', cls: 'text-muted' },
} as const;

/** A source's state in words. Slack's sign-in is a token; Wispr Flow's is an account sign-in. */
const stateOf = (h: SourceHealthView) => (h.status === 'auth_failed' && h.id !== 'slack' ? { ...SLACK.auth_failed, label: 'Signed out' } : h.status === 'backoff' && h.id !== 'slack' ? { ...SLACK.backoff, label: 'Rate-limited, waiting' } : SLACK[h.status]);

const SOURCE_NAME: Partial<Record<SourceId, string>> = { slack: 'Slack', wispr: 'Wispr Flow' };

function SourceRow({ h }: { h: SourceHealthView }) {
  const st = stateOf(h);
  const slack = h.id === 'slack';
  const details = [
    slack && `mode ${h.mode === 'search' ? 'search.messages' : 'conversations.history'}`,
    h.lastPollAt && `last ${fmtTime(h.lastPollAt)}`,
    h.status === 'backoff' && h.retryAt ? `retry ${fmtTime(h.retryAt)}` : h.nextPollAt && `next ${fmtTime(h.nextPollAt)}`,
    slack && `429s today ${h.rateLimitedToday}`,
    slack && h.cursor && `cursor ${h.cursor}`,
  ].filter(Boolean);
  return (
    <div className="flex flex-col gap-1 rounded-lg bg-surface-2 px-3 py-2.5" data-testid={`${h.id}-health`}>
      <div className="flex items-center gap-2">
        <SourceMark source={h.id} size={16} decorative />
        <span className="flex-1 font-semibold">{SOURCE_NAME[h.id] ?? h.id}</span>
        <span className="h-2 w-2 rounded-full" style={{ background: st.dot }} />
        <span className={cx('text-xs font-medium', st.cls)}>{st.label}</span>
      </div>
      {details.length > 0 && <div className="font-mono text-[11px] leading-relaxed text-muted">{details.join(' · ')}</div>}
      {h.message && h.status !== 'healthy' && <div className="text-xs text-ink-2">{h.message}</div>}
      {h.id === 'wispr' && h.status === 'auth_failed' && (
        <Link to="/settings/wispr" className="text-xs font-medium">
          Reconnect in Settings
        </Link>
      )}
    </div>
  );
}

function SourceHealth({ u }: { u: UsageView }) {
  const full = usePrefs((s) => s.scope === 'full');
  return (
    <SectionCard className="flex min-w-0 flex-[1_1_320px] scroll-mt-6 flex-col gap-2.5 p-4">
      <h2 id="health" className="m-0 scroll-mt-6 text-[15px] font-semibold">
        Source health
      </h2>
      {u.sources.map((h) => (
        <SourceRow key={h.id} h={h} />
      ))}
      {full &&
        (
          [
            ['Outlook mail', 'retires Outlook digest', 'P2', ['outlook']],
            ['Teams chats + transcripts', 'retires transcript sweep', 'P2', ['teams']],
            ['Gong · Salesforce · HubSpot', 'new, read-only', 'P4', ['salesforce', 'hubspot']],
          ] as const
        ).map(([name, note, phase, marks]) => (
          <div key={name} className="flex items-center gap-2 rounded-lg border-[1.5px] border-dashed border-violet-line bg-violet-wash px-3 py-2.5">
            {marks.map((m) => (
              <BrandIcon key={m} brand={m} size={16} decorative />
            ))}
            <span className="flex-1">{name}</span>
            <span className="text-xs text-muted">{note}</span>
            <span className="font-mono text-[10px] text-violet-fg">{phase}</span>
          </div>
        ))}
    </SectionCard>
  );
}

const CRIT_COLOUR: Record<Criterion['status'], string> = {
  on_track: 'var(--green-fg)',
  met: 'var(--green-fg)',
  at_risk: 'var(--red-fg)',
  pending: 'var(--amber-fg)',
};

function Criteria({ u }: { u: UsageView }) {
  const [starting, setStarting] = useState(false);
  const last = u.lastEval;
  const running = u.evalRunning || starting;
  return (
    <SectionCard className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <h2 className="m-0 flex-1 text-[15px] font-semibold">MVP success criteria</h2>
        <span className="text-xs text-muted">
          {last ? (
            <>
              Last eval {fmtDate(last.at)} on {last.labelCount} labels ·{' '}
              <Link to={evalPath(last.id)} className="font-medium">
                View report
              </Link>
            </>
          ) : (
            'No eval run yet'
          )}
        </span>
        <Button
          disabled={running}
          onClick={async () => {
            setStarting(true);
            try {
              await api.runEval();
            } catch (e) {
              errorToast(e);
            } finally {
              setStarting(false);
            }
          }}
        >
          {running ? (
            <>
              <Spinner size={12} /> Running eval…
            </>
          ) : (
            'Run eval'
          )}
        </Button>
      </div>
      <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fit,minmax(190px,1fr))]">
        {u.criteria.map((c) => (
          <div key={c.id} className="flex flex-col gap-1 rounded-lg border border-line bg-surface-2 p-3" data-criterion={c.id}>
            <div className="flex items-center gap-1.5">
              <span className="font-mono text-[11px] text-muted">{c.id}</span>
              <span className="flex-1" />
              <span className="text-[11px] font-semibold" style={{ color: CRIT_COLOUR[c.status] }}>
                {c.statusLabel}
              </span>
            </div>
            <div className="text-[13px] font-medium leading-[1.35]">{c.name}</div>
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold">{c.value}</span>
              <span className="text-xs text-muted">target {c.target}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="text-xs leading-normal text-muted">Kill if S1 stays under 70% after two prompt-tuning rounds, S4 misses in week 2, or S3 runs more than 50% over after the batching fixes.</div>
    </SectionCard>
  );
}

/** Toasts when an eval run finishes, with a link to its report. */
function useEvalFinishedToast(u: UsageView | undefined) {
  const navigate = useNavigate();
  const wasRunning = useRef(false);
  useEffect(() => {
    if (!u) return;
    if (wasRunning.current && !u.evalRunning && u.lastEval) {
      const id = u.lastEval.id;
      toast('Eval finished.', { tone: 'success', action: { label: 'View report', run: () => navigate(evalPath(id)) } });
    }
    wasRunning.current = u.evalRunning;
  }, [u, navigate]);
}

/** The 64px top bar, like the Inbox and Settings, fixed above the scrolling page body. */
function UsageFrame({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line bg-surface">
        <div className="mx-auto flex h-16 max-w-[1360px] items-center gap-3 px-8">
          <h1 className="m-0 flex-1 text-xl font-semibold tracking-[-0.01em]">Usage &amp; health</h1>
          <MvpTag>MVP · E7, E12</MvpTag>
        </div>
      </header>
      <div data-page-scroll className="min-h-0 flex-1 overflow-y-auto">
        {children}
      </div>
    </div>
  );
}

export function UsagePage() {
  const q = useApiQuery(() => api.getUsage(), onTopics('usage', 'evals', 'inbox'), []);
  const u = q.data;
  useHashScroll(!!u);
  useEvalFinishedToast(u);
  useEffect(() => {
    document.title = 'Usage & health · Work OS';
  }, []);
  if (!u)
    return (
      <UsageFrame>
        <div className="mx-auto max-w-[1360px] p-8 text-muted">{q.error ? 'Could not load usage.' : 'Loading…'}</div>
      </UsageFrame>
    );

  const t = u.today;
  const b = u.budgets;
  const noBaseline = b.baseline === null;
  return (
    <UsageFrame>
      <div className="mx-auto flex max-w-[1360px] flex-col gap-5 px-8 pb-12 pt-6">
        <div className="font-mono text-xs text-muted">
          Claude subscription via Agent SDK · no API key · {noBaseline ? 'baseline not measured yet (P0-3)' : `baseline ${fmtMoney(b.baseline!)}/day from Phase 0 (P0-3)`}
        </div>
        <HealthBanner />
        {noBaseline && (
          <Banner tone="info" icon="info" action={<Link to="/settings/budgets" className="text-[13px] font-medium">Budgets</Link>}>
            <strong>Baseline not measured yet.</strong> Percentages appear once Phase 0 records the average daily usage of your current scheduled tasks (P0-3). Until then, usage shows as cost-equivalent only.
          </Banner>
        )}
        <section aria-label="Today" className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
          {noBaseline ? (
            <Kpi label="Cost-equivalent today" value={fmtMoney(t.costEquivalent)} of={fmtMoney(b.cost.limit)} bar={<Bar pct={pctOf(b.cost)} colour={barColour(b.cost)} />} note="S3 needs a baseline: not measured yet" />
          ) : (
            <Kpi
              label="Cost-equivalent vs baseline"
              value={`${t.pctOfBaseline}%`}
              bar={<Bar pct={Math.min(100, t.pctOfBaseline ?? 0)} colour={(t.pctOfBaseline ?? 0) > 100 ? 'var(--red)' : (t.pctOfBaseline ?? 0) >= 80 ? 'var(--amber)' : 'var(--green)'} />}
              note={`${fmtMoney(t.costEquivalent)} today · S3 target ≤ 100% incl. remaining scheduled tasks`}
            />
          )}
          <Kpi label="Triage calls" value={t.triageCalls} of={String(b.triage.limit)} bar={<Bar pct={pctOf(b.triage)} colour={barColour(b.triage)} />} note={`${t.threadsTriaged} threads · ${t.pollsSkipped} polls skipped (nothing eligible)`} />
          <Kpi label="Drafts" value={t.draftsVault + t.draftsConfluence} of={String(b.drafts.limit)} bar={<Bar pct={pctOf(b.drafts)} colour={barColour(b.drafts)} />} note={`${t.draftsVault} vault · ${t.draftsConfluence} Confluence`} />
          <Kpi label="Tokens today" value={fmtTokens(t.tokens.total)} note={`in ${fmtTokens(t.tokens.input)} · out ${fmtTokens(t.tokens.output)} · cache ${fmtTokens(t.tokens.cache)}`} />
        </section>
        <div className="flex flex-wrap items-start gap-4">
          <Days u={u} />
          <Budgets u={u} />
        </div>
        <div className="flex flex-wrap items-start gap-4">
          <ByPurpose u={u} />
          <SourceHealth u={u} />
        </div>
        <Criteria u={u} />
      </div>
    </UsageFrame>
  );
}
