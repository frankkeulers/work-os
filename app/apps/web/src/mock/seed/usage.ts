import type { EvalReport, UsageRecord } from '@work-os/shared';
import { costOf } from '../pricing';

// Seven days of usage up to the seed clock (CL-5), and two eval reports (FR-6.3).

const day = (iso: string, hour: number, min: number) => {
  const d = new Date(iso);
  d.setUTCHours(hour - 1, min, 0, 0); // London is UTC+1 in October
  return d.toISOString();
};

let n = 0;
const triage = (at: string, threads: number): UsageRecord => {
  const input = 2200 + threads * 900;
  const output = 120 + threads * 95;
  const cache = 1800;
  return {
    id: `u-seed-${++n}`,
    at,
    purpose: 'triage',
    model: 'haiku-4.5',
    inputTokens: input,
    outputTokens: output,
    cacheTokens: cache,
    costEquivalent: costOf('haiku-4.5', input, output, cache),
    durationMs: 2400 + threads * 300,
    itemIds: [],
    promptVersion: 'triage v3',
  };
};
const draft = (at: string, purpose: 'draft_vault' | 'draft_confluence', input: number, output: number, itemIds: string[] = []): UsageRecord => ({
  id: `u-seed-${++n}`,
  at,
  purpose,
  model: 'sonnet-5.5',
  inputTokens: input,
  outputTokens: output,
  cacheTokens: 3200,
  costEquivalent: costOf('sonnet-5.5', input, output, 3200),
  durationMs: 38000 + (input % 9000),
  itemIds,
  promptVersion: purpose === 'draft_vault' ? 'draft-vault v2' : 'draft-confluence v2',
});

// [date, triage calls, threads per call, vault drafts, confluence drafts]
const HISTORY: [string, number, number, number, number][] = [
  ['2026-09-29', 30, 4, 1, 1],
  ['2026-09-30', 34, 4, 0, 1],
  ['2026-10-01', 32, 4, 2, 1],
  ['2026-10-02', 22, 4, 1, 0],
  ['2026-10-03', 5, 2, 0, 0],
  ['2026-10-04', 4, 2, 0, 0],
];

export function seedUsage(f1Id: string): UsageRecord[] {
  n = 0;
  const out: UsageRecord[] = [];
  for (const [date, calls, threads, vault, conf] of HISTORY) {
    const base = `${date}T00:00:00.000Z`;
    for (let i = 0; i < calls; i++) out.push(triage(day(base, 8 + Math.floor((i * 10) / calls), (i * 17) % 60), threads + (i % 3)));
    for (let i = 0; i < vault; i++) out.push(draft(day(base, 11 + i * 3, 12), 'draft_vault', 29000 + i * 4000, 1500));
    for (let i = 0; i < conf; i++) out.push(draft(day(base, 14 + i, 40), 'draft_confluence', 15000 + i * 3000, 1200));
  }
  // Today, up to 09:45: two off-hours polls overnight, four in the morning, two drafts on #insights-api.
  const today = '2026-10-05T00:00:00.000Z';
  [[2, 10], [6, 40], [8, 12], [8, 52], [9, 22], [9, 42]].forEach(([h, m], i) => out.push(triage(day(today, h, m), [2, 1, 5, 6, 4, 6][i])));
  out.push(draft(day(today, 9, 20), 'draft_confluence', 16600, 1600, [f1Id]));
  out.push(draft(day(today, 9, 31), 'draft_vault', 33400, 1700, [f1Id]));
  return out;
}

export const SEED_EVALS: EvalReport[] = [
  {
    id: 'eval-2026-09-28',
    at: '2026-09-28T15:10:00.000Z',
    labelCount: 186,
    promptVersion: 'triage v2',
    model: 'haiku-4.5',
    categories: {
      now: { precision: 0.75, recall: 0.875, support: 24 },
      today: { precision: 0.784, recall: 0.714, support: 56 },
      none: { precision: 0.887, recall: 0.896, support: 106 },
      confluence: { precision: 0.71, recall: 0.77, support: 31 },
      vault: { precision: 0.74, recall: 0.81, support: 42 },
    },
    confusion: [
      [21, 2, 1],
      [5, 40, 11],
      [2, 9, 95],
    ],
    tokens: 412000,
    costEquivalent: 0.61,
  },
  {
    id: 'eval-2026-10-02',
    at: '2026-10-02T16:25:00.000Z',
    labelCount: 200,
    promptVersion: 'triage v3',
    model: 'haiku-4.5',
    categories: {
      now: { precision: 0.852, recall: 0.92, support: 25 },
      today: { precision: 0.828, recall: 0.8, support: 60 },
      none: { precision: 0.922, recall: 0.922, support: 115 },
      confluence: { precision: 0.79, recall: 0.82, support: 34 },
      vault: { precision: 0.8, recall: 0.86, support: 44 },
    },
    confusion: [
      [23, 2, 0],
      [3, 48, 9],
      [1, 8, 106],
    ],
    tokens: 438000,
    costEquivalent: 0.66,
  },
];
