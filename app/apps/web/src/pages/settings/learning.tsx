import { useState } from 'react';
import { Link } from 'react-router';
import {
  FILING_EVAL_MIN_LABELS,
  PROPOSAL_MIN_LABELS,
  PROPOSAL_NUDGE_LABELS,
  filingRows,
  filingSettings,
  type FilingSettings,
  type LearningLoop,
  type LearningLoopView,
  type LoopScore,
  type PolicyProposal,
  type PromptFileView,
} from '@work-os/shared';
import { api } from '../../api';
import { GuideLink } from '../../components/GuideLink';
import { Button, Chip, Segmented, Spinner, Switch, cx } from '../../components/ui';
import { fmtDate, fmtPct, fmtTime } from '../../lib/format';
import { errorToast, toast } from '../../store/toasts';
import { Group, Row, SectionHeader } from './parts';
import type { Ctx } from './sections';

// Settings › Learning (E14, FR-15.10, FR-15.11) and the proposal on its file's row in Settings ›
// Prompts (FR-15.9). Nothing here changes a prompt by itself: Frank applies a proposal.

const run = (start: () => Promise<unknown>, started: string) => () => void start().then(() => toast(started), errorToast);

/**
 * Precision and recall per row against the targets. With `minLabels`, a row's score counts only
 * from that many labels (the filing eval, FR-15.8); with `before`, each value shows current → proposed.
 */
function ScoreTable({ rows, before, label, minLabels }: { rows: LoopScore[]; before?: LoopScore[]; label: string; minLabels?: number }) {
  const th = 'border-b border-line px-2 py-1.5 text-xs font-medium text-muted';
  const td = 'border-b border-line-soft-2 px-2 py-1.5 text-right';
  const was = (key: string) => before?.find((b) => b.key === key);
  const target = (r: LoopScore) => [r.target !== undefined && `≥ ${fmtPct(r.target)}`, r.recallTarget !== undefined && `recall ≥ ${fmtPct(r.recallTarget)}`].filter(Boolean).join(', ') || '—';
  return (
    <table aria-label={label} className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          <th scope="col" className={cx(th, 'pl-0 text-left')}>
            {minLabels ? 'Field' : 'Answer'}
          </th>
          <th scope="col" className={cx(th, 'text-right')}>
            Precision
          </th>
          <th scope="col" className={cx(th, 'text-right')}>
            Recall
          </th>
          <th scope="col" className={cx(th, 'text-right')}>
            Labels
          </th>
          <th scope="col" className={cx(th, 'pr-0 text-right')}>
            Target
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const counts = !minLabels || r.n >= minLabels;
          const tone = !r.n || r.target === undefined ? 'text-ink' : counts ? (r.precision >= r.target ? 'text-green-fg' : 'text-red-fg') : 'text-ink';
          const recallTone = !r.n || r.recallTarget === undefined ? '' : counts ? (r.recall >= r.recallTarget ? 'text-green-fg' : 'text-red-fg') : '';
          const b = was(r.key);
          return (
            <tr key={r.key} data-field={r.key}>
              <th scope="row" className="border-b border-line-soft-2 py-1.5 pr-2 text-left font-normal">
                {r.label}
              </th>
              <td className={cx(td, r.n ? tone : 'text-muted')}>
                {b && <span className="text-muted">{fmtPct(b.precision)} → </span>}
                {r.n ? fmtPct(r.precision) : '—'}
              </td>
              <td className={cx(td, recallTone)}>
                {b && r.recallTarget !== undefined && <span className="text-muted">{fmtPct(b.recall)} → </span>}
                {r.n ? fmtPct(r.recall) : '—'}
              </td>
              <td className={cx(td, 'text-muted')}>{r.n}</td>
              <td className={cx(td, 'pr-0 text-xs text-muted')}>{counts || !r.n ? target(r) : `counts from ${minLabels}`}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function proposalLine(p: PolicyProposal) {
  const when = `${fmtDate(p.at)} ${fmtTime(p.at)}`;
  if (p.status === 'open') return <>A proposal from {when} is waiting{p.better ? ', and scores better on labels it hasn’t seen' : ', but scores no better on labels it hasn’t seen'}.</>;
  if (p.status === 'applied') return <>The proposal from {when} was applied{p.appliedVersion && <> ({p.appliedVersion})</>}.</>;
  if (p.status === 'dismissed') return <>The proposal from {when} was dismissed.</>;
  return <>The proposal from {when} was turned down by code: {p.rejected}</>;
}

const PROPOSE: Record<LearningLoop, string> = {
  filing: 'Propose a better policy',
  triage: 'Propose a better triage prompt',
  settle: 'Propose a better settle check',
  finish: 'Propose a better Looks finished check',
};

const PROPOSE_HELP: Record<LearningLoop, string> = {
  filing:
    'Opus reads where the policy got your labels wrong and proposes a revision. Code checks it never copies a thread’s words, keeps every rule ID, keeps the file’s first line and stays a sensible length, then scores both policies on labels held back from it. You review it in Settings › Prompts.',
  triage: 'Opus reads where triage put a topic in the wrong lane and proposes a revision of what the triage prompt says about attention. The same checks apply, and both prompts are scored on labels held back from it.',
  settle: 'Opus reads where the settle check closed an item you undid, or left one you had to close, and proposes a revision. Closing must stay strict: a wrong close hides something you still owe.',
  finish: 'Opus reads where Looks finished was wrong by your answers and proposes a revision of the finish check. The same checks apply.',
};

/** A loop's proposal: what became of the latest, the nudge, and the button. */
function ProposalsRow({ loop, l }: { loop: LearningLoop; l?: LearningLoopView }) {
  const few = !!l && l.labels.items < PROPOSAL_MIN_LABELS;
  return (
    <Row stacked label="Proposals" help={PROPOSE_HELP[loop]}>
      {l?.proposal && (
        <span className="text-[13px] text-ink-2" data-testid={`proposal-status-${loop}`}>
          {proposalLine(l.proposal)}{' '}
          {l.proposal.status === 'open' && (
            <Link to={`/settings/prompts#${l.proposal.promptId}`} className="font-medium">
              Review it
            </Link>
          )}
        </span>
      )}
      {l && !few && l.newLabels >= PROPOSAL_NUDGE_LABELS && !l.proposing && (
        <span className="text-[13px] text-ink-2">
          <Chip tone="accent">{l.newLabels} new labels</Chip> {l.proposal ? 'since the last proposal: worth another run.' : 'so far: enough to try a first proposal.'}
        </span>
      )}
      {few && (
        <span className="text-[13px] text-muted">
          Needs {PROPOSAL_MIN_LABELS} labelled items; there {l.labels.items === 1 ? 'is' : 'are'} {l.labels.items}.
        </span>
      )}
      <div>
        <Button size="sm" disabled={!l || l.proposing || few} onClick={run(() => api.proposePolicy(loop), 'Working on a proposal. The bell says when it is ready.')}>
          {l?.proposing ? (
            <>
              <Spinner size={12} /> Proposing…
            </>
          ) : (
            PROPOSE[loop]
          )}
        </Button>
      </div>
    </Row>
  );
}

/** "12 items · 5 from you · 7 from your actions", or what a loop's labels are. */
function LabelsRow({ testId, l, help, only }: { testId: string; l?: LearningLoopView; help: string; only?: string }) {
  return (
    <Row label="Labels" help={help}>
      <span className="text-[13px] text-ink-2" data-testid={testId}>
        {l ? (
          <>
            <strong className="text-ink">{l.labels.items}</strong> items
            {only ? ` · ${only}` : <> · {l.labels.explicit} from you · {l.labels.implicit} from your actions</>}
          </>
        ) : (
          'Not available'
        )}
      </span>
    </Row>
  );
}

const cli = (purpose: string) => <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-xs">npm run eval -- --purpose {purpose}</code>;

export function LearningSection({ s, view, set }: Ctx) {
  const learning = view.learning;
  const l = learning?.filing;
  const f = filingSettings(s);
  const setFiling = (patch: Partial<FilingSettings>) => set((x) => void (x.triage.filing = { ...filingSettings(x), ...patch }));
  return (
    <>
      <SectionHeader
        title="Learning"
        description="How Work OS learns from your feedback. Each loop has a prompt it can revise: the filing policy, triage’s attention, the settle check and Looks finished. Nothing changes on its own: a proposed change waits for you."
        action={<GuideLink topic="learning" />}
      />
      <Group title="Filing policy">
        <LabelsRow
          testId="filing-labels"
          l={l}
          help="Your word: Filing…, corrections and Triage was right. Your actions: approving a draft as it was or after an edit, discarding one, Done with nothing filed, adding or dismissing a suggested to-do. Where you’ve said something yourself, it wins."
        />
        <Row
          stacked
          label="Filing eval"
          help={`Runs triage with the current policy over the labelled items and scores each field. A field’s score counts from ${FILING_EVAL_MIN_LABELS} labels.`}
        >
          {l?.lastEval ? (
            <div className="flex flex-col gap-1.5" data-testid="filing-eval">
              <span className="font-mono text-xs text-muted">
                {fmtDate(l.lastEval.at)} {fmtTime(l.lastEval.at)} · {l.lastEval.labelCount} items · {l.lastEval.policyVersion ?? l.lastEval.promptVersion}
              </span>
              <ScoreTable rows={filingRows(l.lastEval.scores)} minLabels={FILING_EVAL_MIN_LABELS} label="Filing eval scores" />
            </div>
          ) : (
            <span className="text-[13px] text-muted">No filing eval yet.</span>
          )}
          <div>
            <Button size="sm" disabled={!l || l.evalRunning || !l.labels.items} onClick={run(() => api.runFilingEval(), 'Filing eval started. The scores show here when it finishes.')}>
              {l?.evalRunning ? (
                <>
                  <Spinner size={12} /> Running…
                </>
              ) : (
                'Run filing eval'
              )}
            </Button>
          </div>
        </Row>
        <ProposalsRow loop="filing" l={l} />
      </Group>
      {learning?.triage && (
        <Group title="Triage attention">
          <LabelsRow testId="triage-labels" l={learning.triage} only="from your corrections and Triage was right" help="Each correction of an item’s lane, and each Triage was right, is a label for the triage prompt (the labelled set)." />
          <Row label="Triage eval" help="Scores the triage prompt over the labelled set, per lane: Now and Today precision should reach 80%, and Now recall 90%.">
            <span className="text-[13px] text-ink-2">
              {learning.triage.lastEval ? (
                <>
                  {fmtDate(learning.triage.lastEval.at)} {fmtTime(learning.triage.lastEval.at)} · {learning.triage.lastEval.labelCount} labels ·{' '}
                  <Link to={`/usage/eval/${encodeURIComponent(learning.triage.lastEval.id)}`} className="font-medium">
                    View report
                  </Link>
                </>
              ) : (
                <>
                  No eval yet. Run it from{' '}
                  <Link to="/usage" className="font-medium">
                    Usage
                  </Link>
                  .
                </>
              )}
            </span>
          </Row>
          <ProposalsRow loop="triage" l={learning.triage} />
        </Group>
      )}
      {learning?.settle && (
        <Group title="Settle on reply">
          <LabelsRow testId="settle-labels" l={learning.settle} only="from your Undo and Done" help="Undoing a close on reply says the check was wrong to close; Done soon after it said “not settled” says it should have closed." />
          <Row label="Settle eval" help="Counts false closes and missed closes. Closes should be right 98% of the time.">
            <span className="text-[13px] text-ink-2">From 30 labels, with Work OS stopped: {cli('settle')}</span>
          </Row>
          <ProposalsRow loop="settle" l={learning.settle} />
        </Group>
      )}
      {learning?.finish && (
        <Group title="Looks finished">
          <LabelsRow testId="finish-labels" l={learning.finish} only="your answers to Looks finished" help="Done on a Looks finished item says the check was right; Not finished says it wasn’t." />
          <Row label="Finish eval" help="Scored as the settle check is. Suggestions should be right 98% of the time.">
            <span className="text-[13px] text-ink-2">From 30 labels, with Work OS stopped: {cli('finish')}</span>
          </Row>
          <ProposalsRow loop="finish" l={learning.finish} />
        </Group>
      )}
      <Group title="Switches">
        <Row label="Draft ahead" help="Follow the policy, draft every filing ahead as before the policy, or draft none until you press f or v.">
          <Segmented<FilingSettings['predraft']>
            label="Draft ahead"
            size="sm"
            value={f.predraft}
            onChange={(v) => setFiling({ predraft: v })}
            options={[
              { value: 'policy', label: 'By the policy' },
              { value: 'all', label: 'All' },
              { value: 'off', label: 'None' },
            ]}
          />
        </Row>
        <Row label="Ready to approve" help="Lead To file with the filings the policy marks ready, with Approve ready. Off, they wait in To file with the rest.">
          <Switch label="Ready to approve" checked={f.ready} onChange={(v) => setFiling({ ready: v })} />
        </Row>
        <Row label="Suggest to-dos" help="Offer the to-do the policy suggests in the item panel, to add with a or dismiss.">
          <Switch label="Suggest to-dos" checked={f.todoSuggestions} onChange={(v) => setFiling({ todoSuggestions: v })} />
        </Row>
      </Group>
    </>
  );
}

const KIND = { added: 'Added', changed: 'Changed', removed: 'Removed' } as const;

/** A proposed revision of a prompt file (FR-15.9, FR-15.11): what changed, the scores and the diff, with Apply and Dismiss. */
export function ProposalBanner({ proposal: p, onDone }: { proposal: PolicyProposal; onDone: (saved?: PromptFileView) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (apply: boolean) => {
    setBusy(true);
    try {
      if (apply) {
        const saved = await api.applyProposal(p.id);
        toast(`${saved.label} updated`, { tone: 'success', description: `Now ${saved.version}. The next call uses it.` });
        onDone(saved);
      } else {
        await api.dismissProposal(p.id);
        toast('Proposal dismissed');
        onDone();
      }
    } catch (e) {
      errorToast(e);
      onDone();
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Proposed change" className="flex flex-col gap-3 rounded-xl border border-accent/40 bg-accent-wash/40 px-4 py-3.5" data-proposal={p.id}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="m-0 text-[13px] font-semibold">Proposed change</h4>
        <span className="text-xs text-muted">
          {fmtDate(p.at)} {fmtTime(p.at)} · learned from {p.train} items, scored on {p.heldOut} held back
        </span>
        <span className="flex-1" />
        {p.better ? <Chip tone="ok">Scores better</Chip> : <Chip tone="warn">Scores no better</Chip>}
      </div>
      <ul className="m-0 flex list-none flex-col gap-1 p-0 text-[13px]">
        {p.changes.map((c, i) => (
          <li key={i}>
            <span className="font-medium">
              {KIND[c.kind]}
              {c.rule && ` ${c.rule}`}:
            </span>{' '}
            {c.what}
          </li>
        ))}
      </ul>
      {p.scores && <ScoreTable rows={p.scores.after} before={p.scores.before} label="Held-out scores, current → proposed" />}
      {p.diff && (
        <details>
          <summary className="cursor-pointer text-[13px] text-ink-2">Show the changes in the text</summary>
          <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap rounded-lg border border-line bg-surface p-3 font-mono text-[12px] leading-relaxed" data-testid="proposal-diff">
            {p.diff
              .filter((d) => d.op !== 'same' || d.text.trim())
              .map((d, i) => (
                <div key={i} className={cx(d.op === 'add' ? 'bg-teal-wash text-green-fg' : d.op === 'del' ? 'bg-red-line/20 text-red-fg line-through' : 'text-muted')}>
                  {d.op === 'add' ? '+ ' : d.op === 'del' ? '− ' : '  '}
                  {d.text}
                </div>
              ))}
          </pre>
        </details>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="solid" size="sm" disabled={busy} onClick={() => void act(true)}>
          Apply
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void act(false)}>
          Dismiss
        </Button>
        <span className="text-xs text-muted">Applying saves it as the file, as an edit would. It refuses if the file changed since.</span>
      </div>
    </section>
  );
}
