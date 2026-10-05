import { useEffect } from 'react';
import { Link, useParams } from 'react-router';
import type { EvalReport } from '@work-os/shared';
import { api } from '../api';
import { Icon } from '../components/icons';
import { SectionCard, cx } from '../components/ui';
import { onTopics, useApiQuery } from '../hooks/useApiQuery';
import { fmtDate, fmtMoney, fmtPct, fmtTime, fmtTokens } from '../lib/format';
import { evalPath } from './Usage';

const CATS = [
  ['now', 'Attention: Now'],
  ['today', 'Attention: Today'],
  ['none', 'Attention: None'],
  ['confluence', 'Filing: Confluence'],
  ['vault', 'Filing: Vault'],
] as const;
const ATT = ['Now', 'Today', 'None'];

/** S1 is precision on now + today together; S2 is recall on now (PLAN success criteria). */
export function headline(r: EvalReport) {
  const c = r.confusion;
  const predictedUrgent = c[0][0] + c[1][0] + c[2][0] + c[0][1] + c[1][1] + c[2][1];
  const s1 = predictedUrgent ? (c[0][0] + c[1][1]) / predictedUrgent : 0;
  const nowRow = c[0][0] + c[0][1] + c[0][2];
  const s2 = nowRow ? c[0][0] / nowRow : 0;
  return { s1, s2 };
}

function Delta({ now, before }: { now: number; before?: number }) {
  if (before === undefined) return <span className="text-muted">—</span>;
  const d = Math.round((now - before) * 100);
  if (d === 0) return <span className="text-muted">±0</span>;
  return (
    <span className={cx('font-medium', d > 0 ? 'text-green-fg' : 'text-red-fg')}>
      {d > 0 ? '+' : '−'}
      {Math.abs(d)} pt
    </span>
  );
}

export function EvalReportPage() {
  const { id = '' } = useParams();
  const q = useApiQuery(() => api.getEvalReports(), onTopics('evals'), []);
  useEffect(() => {
    document.title = 'Eval report · Work OS';
  }, []);
  const reports = q.data;
  if (!reports) return <div className="p-8 text-muted">{q.error ? 'Could not load eval reports.' : 'Loading…'}</div>;
  const idx = reports.findIndex((r) => r.id === id);
  const r = reports[idx];
  if (!r)
    return (
      <div className="flex flex-col gap-3 px-8 pt-6">
        <BackLink />
        <h1 className="m-0 text-xl font-semibold">Eval report not found</h1>
        <p className="m-0 text-sm text-ink-2">It may have been removed by a data reset.</p>
      </div>
    );
  const prev = reports[idx + 1];
  const h = headline(r);
  const hp = prev ? headline(prev) : undefined;
  const max = Math.max(...r.confusion.flat());

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5 px-8 pb-12 pt-6">
      <BackLink />
      <header className="flex flex-col gap-1">
        <h1 className="m-0 text-[26px] font-semibold tracking-[-0.015em]">Eval report</h1>
        <div className="font-mono text-xs text-muted">
          {fmtDate(r.at)} {fmtTime(r.at)} · {r.labelCount} labels · {r.model} · {r.promptVersion} · {fmtTokens(r.tokens)} tokens · {fmtMoney(r.costEquivalent)} cost-equivalent
        </div>
      </header>

      <section aria-label="Headline" className="grid gap-4 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {(
          [
            ['S1', 'Precision, now + today', h.s1, hp?.s1, 0.8],
            ['S2', 'Recall, now', h.s2, hp?.s2, 0.9],
          ] as const
        ).map(([sid, name, v, before, target]) => (
          <SectionCard key={sid} className="flex flex-col gap-1.5 p-4">
            <div className="flex items-center gap-2 text-xs text-muted">
              <span className="font-mono">{sid}</span>
              <span className="flex-1">{name}</span>
              <span className={cx('font-semibold', v >= target ? 'text-green-fg' : 'text-red-fg')}>{v >= target ? 'Meets target' : 'Below target'}</span>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-[28px] font-semibold tracking-[-0.02em]">{fmtPct(v)}</span>
              <span className="text-xs text-muted">target ≥ {fmtPct(target)}</span>
              <span className="flex-1" />
              <span className="text-xs">
                <Delta now={v} before={before} />
              </span>
            </div>
          </SectionCard>
        ))}
        <SectionCard className="flex flex-col justify-center gap-1 p-4 text-[13px] text-ink-2">
          {prev ? (
            <>
              Compared with{' '}
              <Link to={evalPath(prev.id)} className="font-medium">
                {fmtDate(prev.at)}
              </Link>{' '}
              ({prev.labelCount} labels, {prev.promptVersion}).
            </>
          ) : (
            'First report, so there is nothing to compare with yet.'
          )}
        </SectionCard>
      </section>

      <SectionCard className="flex flex-col gap-2.5 p-4">
        <h2 className="m-0 text-[15px] font-semibold">By category</h2>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse text-[13px]">
            <thead>
              <tr className="text-left text-xs text-muted">
                {['Category', 'Precision', 'Recall', 'Support', 'Δ precision', 'Δ recall'].map((c, i) => (
                  <th key={c} scope="col" className={cx('border-b border-line px-2 py-2 font-medium', i === 0 ? 'pl-0' : 'text-right', i === 5 && 'pr-0')}>
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CATS.map(([k, label]) => {
                const c = r.categories[k];
                const p = prev?.categories[k];
                const td = 'border-b border-line-soft-2 px-2 py-[9px] text-right';
                return (
                  <tr key={k}>
                    <th scope="row" className="border-b border-line-soft-2 py-[9px] pr-2 text-left font-normal">
                      {label}
                    </th>
                    <td className={td}>{fmtPct(c.precision)}</td>
                    <td className={td}>{fmtPct(c.recall)}</td>
                    <td className={cx(td, 'text-muted')}>{c.support}</td>
                    <td className={td}>
                      <Delta now={c.precision} before={p?.precision} />
                    </td>
                    <td className={cx(td, 'pr-0')}>
                      <Delta now={c.recall} before={p?.recall} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SectionCard>

      <SectionCard className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-baseline gap-2">
          <h2 className="m-0 flex-1 text-[15px] font-semibold">Attention confusion matrix</h2>
          <span className="text-xs text-muted">Rows: your label · columns: model’s prediction</span>
        </div>
        <table className="w-auto self-start border-separate border-spacing-1 text-[13px]" aria-label="Attention confusion matrix">
          <thead>
            <tr>
              <td />
              {ATT.map((a) => (
                <th key={a} scope="col" className="px-3 pb-1 text-xs font-medium text-muted">
                  Predicted {a}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {r.confusion.map((row, i) => (
              <tr key={ATT[i]}>
                <th scope="row" className="pr-3 text-right text-xs font-medium text-muted">
                  Labelled {ATT[i]}
                </th>
                {row.map((v, j) => {
                  const strength = max ? v / max : 0;
                  return (
                    <td
                      key={j}
                      className={cx('h-14 w-28 rounded-lg text-center font-mono text-base', i === j ? 'font-semibold text-ink' : v ? 'text-red-fg' : 'text-muted')}
                      style={{
                        background: i === j ? `color-mix(in srgb, var(--teal) ${Math.round(12 + strength * 30)}%, var(--surface))` : v ? `color-mix(in srgb, var(--red) ${Math.round(6 + strength * 40)}%, var(--surface))` : 'var(--surface-2)',
                      }}
                    >
                      {v}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="text-xs leading-normal text-muted">
          The costly misses are labelled Now predicted Today or None ({r.confusion[0][1] + r.confusion[0][2]} here). Corrections from the inbox add to the labelled set for the next run.
        </div>
      </SectionCard>
    </div>
  );
}

function BackLink() {
  return (
    <Link to="/usage" className="inline-flex min-h-9 items-center gap-1.5 self-start text-[13px] no-underline">
      <Icon name="back" /> Usage &amp; health
    </Link>
  );
}
