import { useState } from 'react';
import { Link } from 'react-router';
import { FILING_EVAL_MIN_LABELS, FILING_TARGETS, PROPOSAL_NUDGE_LABELS, filingSettings, type FilingDimension, type FilingScores, type FilingSettings, type PolicyProposal, type PromptFileView } from '@work-os/shared';
import { api } from '../../api';
import { GuideLink } from '../../components/GuideLink';
import { Button, Chip, Segmented, Spinner, Switch, cx } from '../../components/ui';
import { fmtDate, fmtPct, fmtTime } from '../../lib/format';
import { errorToast, toast } from '../../store/toasts';
import { Group, Row, SectionHeader } from './parts';
import type { Ctx } from './sections';

// Settings › Learning (E14, FR-15.10) and the proposal on the filing policy's row in Settings ›
// Prompts (FR-15.9). Nothing here changes the policy by itself: Frank applies a proposal.

const FIELDS: [FilingDimension, string][] = [
  ['toFile', 'To file'],
  ['predraft', 'Pre-draft'],
  ['ready', 'Ready to approve'],
  ['todo', 'To-do suggestions'],
];

const run = (start: () => Promise<unknown>, started: string) => () => void start().then(() => toast(started), errorToast);

/** Precision and recall per field against the targets; a field counts from 30 labels. */
function ScoreTable({ scores, before, label }: { scores: FilingScores; before?: FilingScores; label: string }) {
  const th = 'border-b border-line px-2 py-1.5 text-xs font-medium text-muted';
  const td = 'border-b border-line-soft-2 px-2 py-1.5 text-right';
  return (
    <table aria-label={label} className="w-full border-collapse text-[13px]">
      <thead>
        <tr>
          <th scope="col" className={cx(th, 'pl-0 text-left')}>
            Field
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
        {FIELDS.map(([k, name]) => {
          const v = scores[k];
          const counts = v.n >= FILING_EVAL_MIN_LABELS;
          const meets = v.precision >= FILING_TARGETS[k];
          return (
            <tr key={k} data-field={k}>
              <th scope="row" className="border-b border-line-soft-2 py-1.5 pr-2 text-left font-normal">
                {name}
              </th>
              <td className={cx(td, !v.n ? 'text-muted' : counts ? (meets ? 'text-green-fg' : 'text-red-fg') : 'text-ink')}>
                {before && <span className="text-muted">{fmtPct(before[k].precision)} → </span>}
                {v.n ? fmtPct(v.precision) : '—'}
              </td>
              <td className={td}>{v.n ? fmtPct(v.recall) : '—'}</td>
              <td className={cx(td, 'text-muted')}>{v.n}</td>
              <td className={cx(td, 'pr-0 text-xs text-muted')}>{counts || !v.n ? `≥ ${fmtPct(FILING_TARGETS[k])}` : `counts from ${FILING_EVAL_MIN_LABELS}`}</td>
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

export function LearningSection({ s, view, set }: Ctx) {
  const l = view.learning?.filing;
  const f = filingSettings(s);
  const setFiling = (patch: Partial<FilingSettings>) => set((x) => void (x.triage.filing = { ...filingSettings(x), ...patch }));
  return (
    <>
      <SectionHeader
        title="Learning"
        description="How Work OS learns what to file from your feedback. Your filing policy decides what goes to To file, what is drafted ahead, what is ready to approve and which to-dos to suggest. Nothing changes it on its own: a proposed change waits for you."
        action={<GuideLink topic="learning" />}
      />
      <Group title="Filing policy">
        <Row label="Labels" help="Your word: Filing…, corrections and Triage was right. Your actions: approving a draft as it was or after an edit, discarding one, Done with nothing filed, adding or dismissing a suggested to-do. Where you’ve said something yourself, it wins.">
          <span className="text-[13px] text-ink-2" data-testid="filing-labels">
            {l ? (
              <>
                <strong className="text-ink">{l.labels.items}</strong> items · {l.labels.explicit} from you · {l.labels.implicit} from your actions
              </>
            ) : (
              'Not available'
            )}
          </span>
        </Row>
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
              <ScoreTable scores={l.lastEval.scores} label="Filing eval scores" />
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
        <Row
          stacked
          label="Proposals"
          help="Opus reads where the policy got your labels wrong and proposes a revision. Code checks it never copies a thread’s words, keeps every rule ID and stays a sensible length, then scores both policies on labels held back from it. You review it in Settings › Prompts."
        >
          {l?.proposal && (
            <span className="text-[13px] text-ink-2" data-testid="proposal-status">
              {proposalLine(l.proposal)}{' '}
              {l.proposal.status === 'open' && (
                <Link to={`/settings/prompts#${l.proposal.promptId}`} className="font-medium">
                  Review it
                </Link>
              )}
            </span>
          )}
          {l && l.newLabels >= PROPOSAL_NUDGE_LABELS && !l.proposing && (
            <span className="text-[13px] text-ink-2">
              <Chip tone="accent">{l.newLabels} new labels</Chip> {l.proposal ? 'since the last proposal: worth another run.' : 'so far: enough to try a first proposal.'}
            </span>
          )}
          <div>
            <Button size="sm" disabled={!l || l.proposing} onClick={run(() => api.proposePolicy(), 'Working on a proposal. The bell says when it is ready.')}>
              {l?.proposing ? (
                <>
                  <Spinner size={12} /> Proposing…
                </>
              ) : (
                'Propose a better policy'
              )}
            </Button>
          </div>
        </Row>
      </Group>
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

/** A proposed revision of a policy file (FR-15.9): what changed, the scores and the diff, with Apply and Dismiss. */
export function ProposalBanner({ proposal: p, onDone }: { proposal: PolicyProposal; onDone: (saved?: PromptFileView) => void }) {
  const [busy, setBusy] = useState(false);
  const act = async (apply: boolean) => {
    setBusy(true);
    try {
      if (apply) {
        const saved = await api.applyProposal(p.id);
        toast('Filing policy updated', { tone: 'success', description: `Now ${saved.version}. The next triage uses it.` });
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
      {p.scores && <ScoreTable scores={p.scores.after} before={p.scores.before} label="Held-out scores, current → proposed" />}
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
        <span className="text-xs text-muted">Applying saves it as the policy file, as an edit would. It refuses if the policy changed since.</span>
      </div>
    </section>
  );
}
