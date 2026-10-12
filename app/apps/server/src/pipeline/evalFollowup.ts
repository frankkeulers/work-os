import { FOLLOWUP_MAX_PER_CALL, FollowupAnswer, FollowupKind, clampFollowups, type LoopScore, type Settings, type SourceId } from '@work-os/shared';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import type { Logger } from '../log';
import { DEADLINES } from '../net/http';
import type { FollowupLabelRecord } from '../store/followupLabels';
import type { LoopEvalReport } from './evalSchedule';
import { renderFollowup, type FollowupInput } from './followup';

// The follow-up eval (E15, FR-16.15): the followup prompt and model over labels/followup.jsonl,
// one case per labelled To Do, scored per kind. A kind Frank used (as suggested or changed), or did
// himself soon after, was wanted; one he dismissed, or that wasn't suggested and he didn't do, was
// not. A suggestion he never answered says nothing. Saved to logs/followup-eval-<timestamp>.json.

/** PLAN FR-16.14: a reply Frank would send most of the time; closing the item almost always right. */
const TARGET: Partial<Record<FollowupKind, number>> = { reply: 0.7, mark_source_done: 0.9 };
const NAME: Record<FollowupKind, string> = { reply: 'Reply', mark_source_done: 'Mark the item done', add_todo: 'Add a To Do', file_note: 'File a vault note' };

/** What Frank's labels say of one kind: wanted or not, and how we know. */
export interface FollowupTruth {
  wanted: boolean;
  how: string;
}

/** One labelled To Do: what the prompt saw, and what Frank wanted of each kind we know. */
export interface FollowupCase {
  todoId: string;
  itemId: string;
  source: SourceId;
  /** When it was asked: the first label's time, within a day of Done. */
  now: string;
  input: FollowupInput;
  truth: Partial<Record<FollowupKind, FollowupTruth>>;
  /** Frank's own words where he changed a suggestion, for the copy check. */
  edited: string[];
  /** The replies and steps suggested, for the copy check. */
  suggested: string[];
}

const HOW = { accepted: 'Frank used it', edited: 'Frank changed it, then used it', dismissed: 'Frank dismissed it' } as const;

/** Every labelled To Do, in the order first labelled. */
export function followupCases(records: readonly FollowupLabelRecord[]): FollowupCase[] {
  const by = new Map<string, FollowupLabelRecord[]>();
  for (const r of records) by.set(r.todoId, [...(by.get(r.todoId) ?? []), r]);
  const out: FollowupCase[] = [];
  for (const [todoId, lines] of by) {
    const truth: FollowupCase['truth'] = {};
    let offered: Set<FollowupKind> | undefined;
    const edited: string[] = [];
    const suggested: string[] = [];
    for (const l of lines) {
      if (l.origin === 'missed') truth[l.kind] = { wanted: true, how: 'Frank did it himself soon after' };
      else if (l.answer) truth[l.kind] = { wanted: l.answer !== 'dismissed', how: HOW[l.answer] };
      if (l.suggested) offered = new Set(l.suggested);
      if (l.text) edited.push(l.text);
      const s = l.suggestion as { reply?: { text?: unknown }; todo?: { step?: unknown } } | undefined;
      for (const t of [s?.reply?.text, s?.todo?.step]) if (typeof t === 'string') suggested.push(t);
    }
    // Not offered, and not done: not wanted. Known only once we know what was offered.
    if (offered) for (const k of FollowupKind.options) if (!offered.has(k) && !truth[k]) truth[k] = { wanted: false, how: 'none was suggested, and Frank didn’t do it' };
    const last = lines.at(-1)!;
    out.push({ todoId, itemId: last.itemId, source: last.source, now: lines[0].at, input: { ...(last.input as unknown as FollowupInput), id: todoId }, truth, edited, suggested });
  }
  return out;
}

/** One case and the kinds the prompt now suggests for it, after code's clamp. */
export interface FollowupPredicted {
  case: FollowupCase;
  kinds: FollowupKind[];
}

/**
 * Each kind as a tuner's row: precision is the share of its suggestions Frank wanted, recall the
 * share of what he wanted that it suggests, over the cases where we know. With none suggested, or
 * none wanted, there is nothing to be wrong about.
 */
export function followupRows(rows: readonly FollowupPredicted[]): LoopScore[] {
  return FollowupKind.options.map((k) => {
    const known = rows.filter((r) => r.case.truth[k]);
    const said = known.filter((r) => r.kinds.includes(k));
    const wanted = known.filter((r) => r.case.truth[k]!.wanted);
    const hit = said.filter((r) => r.case.truth[k]!.wanted).length;
    return { key: k, label: NAME[k], precision: said.length ? hit / said.length : 1, recall: wanted.length ? hit / wanted.length : 1, n: known.length, ...(TARGET[k] !== undefined && { target: TARGET[k] }) };
  });
}

/** What the prompt got wrong on one To Do, or nothing. */
export function followupMiss(r: FollowupPredicted): object | undefined {
  const wrong: string[] = [];
  for (const k of FollowupKind.options) {
    const t = r.case.truth[k];
    const said = r.kinds.includes(k);
    if (!t || t.wanted === said) continue;
    wrong.push(`${k}: ${t.wanted ? 'wanted' : 'not wanted'} (${t.how}); the prompt ${said ? 'suggested it' : 'didn’t suggest it'}`);
  }
  return wrong.length ? { done: r.case.input, wrong } : undefined;
}

export interface FollowupEvalDeps {
  claude: ClaudeAdapter;
  settings: Settings;
  prompt: Prompt;
  now: () => Date;
  signal?: AbortSignal;
  logger?: Logger;
}

/** What the prompt suggests for each case. Throws ClaudeError when Claude can't be called. */
export async function predictFollowups(d: FollowupEvalDeps, cases: readonly FollowupCase[]): Promise<{ rows: FollowupPredicted[]; failed: number; tokens: number; cost: number }> {
  const rows: FollowupPredicted[] = [];
  let failed = 0;
  let tokens = 0;
  let cost = 0;
  const sorted = [...cases].sort((a, b) => a.now.localeCompare(b.now));
  for (let i = 0; i < sorted.length; i += FOLLOWUP_MAX_PER_CALL) {
    const batch = sorted.slice(i, i + FOLLOWUP_MAX_PER_CALL);
    const now = new Date(batch.at(-1)!.now);
    try {
      const out = await d.claude.structured(
        {
          purpose: 'eval',
          model: d.settings.models.triage,
          system: d.prompt.text,
          prompt: renderFollowup(
            batch.map((c) => c.input),
            now,
          ),
          promptVersion: d.prompt.version,
          timeoutMs: DEADLINES.triage,
          signal: d.signal,
          itemIds: [...new Set(batch.map((c) => c.itemId))],
        },
        FollowupAnswer,
      );
      for (const u of out.usage) {
        tokens += u.inputTokens + u.outputTokens + u.cacheTokens;
        cost += u.costEquivalent;
      }
      const byId = new Map(out.value.todos.map((a) => [a.id, a]));
      for (const c of batch) {
        const a = byId.get(c.todoId);
        if (!a) {
          failed++;
          continue;
        }
        // As the item was when the To Do was done: the input says.
        const kept = clampFollowups(a.suggestions, { now, source: c.input.source, permalink: c.input.canReply, itemOpen: c.input.itemOpen, otherOpenTodos: c.input.otherTodos?.length ?? 0, vault: !!d.settings.vaultPath });
        rows.push({ case: c, kinds: kept.map((s) => s.kind) });
      }
    } catch (err) {
      if (!(err instanceof ClaudeOutputError)) throw err;
      failed += batch.length;
    }
  }
  return { rows, failed, tokens, cost };
}

/** Asks again for every labelled To Do. Throws ClaudeError when Claude can't be called. */
export async function runFollowupEval(d: FollowupEvalDeps, records: readonly FollowupLabelRecord[]): Promise<LoopEvalReport> {
  const cases = followupCases(records);
  if (!cases.length) throw new Error('No follow-up labels yet.');
  const { rows, failed, tokens, cost } = await predictFollowups(d, cases);
  const at = d.now().toISOString();
  d.logger?.info({ labels: cases.length, failed, tokens }, 'Follow-up eval finished');
  return { id: `followup-eval-${at}`, at, loop: 'followup', model: d.settings.models.triage, promptVersion: d.prompt.version, labelCount: cases.length, failed, scores: followupRows(rows), tokens, costEquivalent: Math.round(cost * 10_000) / 10_000 };
}
