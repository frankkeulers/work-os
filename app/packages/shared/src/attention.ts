import type { AttentionEntry, AttentionView, AttentionWork, BudgetState, DraftProgress, HealthView, ItemSummary } from './api';
import type { DepId } from './events';
import type { ActionState } from './projection/state';
import { currentAction } from './projection/views';
import type { ActionType, EvalReport, FailureReason, PromptFileId } from './schemas';

// The bell (FR-11.3, FR-11.4): what needs Frank's follow-up, derived from state as it stands. Nothing
// is stored but dismissals, so an entry goes as soon as Frank deals with it. The server and the mock
// build it the same way, from this.

/** A ready draft waiting longer than this says so. */
export const DRAFT_WAIT_MS = 24 * 3_600_000;
/** A finished eval shows this long. */
export const EVAL_SHOWN_MS = 24 * 3_600_000;

export interface GuidanceChange {
  id: PromptFileId;
  label: string;
  /** The sources that changed since the file was distilled from them, by label. */
  changed: string[];
  /** When the server first saw them changed. */
  since: string;
}

export interface AttentionInput {
  now: string;
  /** Items the actions belong to, and those that may need a nudge: topics' anchors, not parts. */
  items: readonly Pick<ItemSummary, 'id' | 'title' | 'status' | 'doneAt' | 'revision' | 'backFromSnooze' | 'backAt' | 'looksFinished' | 'replyCheck' | 'lastActivityAt'>[];
  actions: readonly Pick<ActionState, 'id' | 'itemId' | 'type' | 'status' | 'failureReason' | 'failedWhile' | 'supersedes' | 'itemRevision' | 'createdAt' | 'updatedAt'>[];
  /** The drafts being made now, by action id. A drafting action without one waits its turn. */
  progress: Record<string, DraftProgress>;
  /** Why a failed action failed, in the server's words, by action id. */
  results?: Record<string, string>;
  health: Pick<HealthView, 'mode' | 'deps' | 'checks' | 'checkedAt' | 'startedAt'>;
  budgets: Pick<BudgetState, 'drafts'>;
  lastEval?: Pick<EvalReport, 'id' | 'at' | 'labelCount'>;
  guidance: readonly GuidanceChange[];
  dismissed: Record<string, string>;
}

const LABEL: Record<ActionType, string> = { vault_note: 'Vault note', confluence_entry: 'Confluence entry', todo: 'To-do' };
const NOUN: Record<ActionType, string> = { vault_note: 'the vault note', confluence_entry: 'the Confluence entry', todo: 'the to-do' };

/** When the server has no message for a failure. */
const REASON: Record<FailureReason, string> = {
  conflict: 'The target changed after drafting.',
  people_check: 'The people check flagged it.',
  allow_list: 'The target is outside the allowed pages or folders.',
  no_fit: 'No page in the Confluence scope fits it.',
  model_error: 'The model’s answer couldn’t be used.',
  unreachable: 'The target couldn’t be reached.',
  draft_missing: 'The draft file is missing.',
};

/** What Frank knows each dependency as. */
const DEP: Record<DepId, string> = {
  network: 'Network',
  slack: 'Slack',
  claude: 'Claude',
  confluence: 'Confluence',
  keychain: 'Keychain',
  storage: 'Data disk',
  wisprDb: 'Wispr Flow',
  wisprMcp: 'Wispr Flow',
  ms365: 'Outlook',
};

/** A failed startup check that a dependency's entry already covers. */
const CHECK_DEP: Partial<Record<string, DepId>> = { slack_token: 'slack', claude_login: 'claude', keychain: 'keychain' };

const HEALTH = '/usage#health';
const CONNECTORS = 'https://claude.ai/settings/connectors';

const down = (h: AttentionInput['health'], id: DepId) => h.deps.some((d) => d.id === id && d.state !== 'ok' && d.state !== 'unknown');

function fixes(input: AttentionInput, waiting: number): AttentionEntry[] {
  const h = input.health;
  const out: AttentionEntry[] = [];
  const fix = (e: Omit<AttentionEntry, 'kind' | 'dismissible' | 'cta'> & { cta?: string }) => out.push({ kind: 'fix_needed', dismissible: false, cta: 'Fix', ...e });
  if (h.mode === 'safe') fix({ key: 'fix:safe', at: h.startedAt, title: 'Safe mode: nothing is being read', subject: 'Work OS', detail: 'Polling, triage and drafting are off until it starts normally.', to: HEALTH, cta: 'Open' });
  for (const d of h.deps) {
    if (d.state !== 'auth_failed' && d.state !== 'paused') continue;
    const connector = d.id === 'ms365' || d.id === 'wisprMcp';
    const title = d.state === 'paused' ? `${DEP[d.id]} paused` : connector ? `${DEP[d.id]} not connected` : `${DEP[d.id]} rejected the login`;
    const elsewhere = d.id === 'ms365' && d.state === 'auth_failed' && d.reason !== 'token_missing';
    fix({ key: `fix:${d.id}:${d.since}`, at: d.since, title, subject: DEP[d.id], detail: d.fix, ...(elsewhere ? { href: CONNECTORS } : { to: HEALTH }) });
  }
  for (const c of h.checks) {
    if (c.status !== 'fail') continue;
    const dep = CHECK_DEP[c.id];
    if (dep && out.some((e) => e.key.startsWith(`fix:${dep}:`))) continue;
    fix({ key: `fix:check:${c.id}`, at: h.checkedAt, title: c.label, subject: 'Work OS', detail: c.note, to: c.id === 'settings' ? '/settings' : HEALTH });
  }
  if (input.budgets.drafts.hit && waiting) {
    const at = input.actions
      .filter((a) => a.status === 'drafting')
      .map((a) => a.createdAt)
      .sort()[0]!;
    fix({
      key: `fix:drafts_budget:${at}`,
      at,
      title: 'Drafts wait for the budget',
      subject: `${waiting} ${waiting === 1 ? 'draft' : 'drafts'} waiting`,
      detail: `Today’s ${input.budgets.drafts.limit} drafts are used up. They start tomorrow, or when the budget is raised.`,
      to: '/usage',
      cta: 'Open',
    });
  }
  return out;
}

export function buildAttention(input: AttentionInput): AttentionView {
  const now = Date.parse(input.now);
  const items = new Map(input.items.map((i) => [i.id, i]));
  const byItem = new Map<string, AttentionInput['actions'][number][]>();
  for (const a of [...input.actions].sort((x, y) => y.createdAt.localeCompare(x.createdAt))) {
    const list = byItem.get(a.itemId);
    if (list) list.push(a);
    else byItem.set(a.itemId, [a]);
  }

  const entries: AttentionEntry[] = [];
  const working: (AttentionWork & { createdAt: string })[] = [];
  const claudeDown = down(input.health, 'claude') || input.health.mode === 'safe';
  const confluenceDown = down(input.health, 'confluence') || down(input.health, 'network');

  for (const [itemId, list] of byItem) {
    const it = items.get(itemId);
    if (!it) continue; // gone with retention: nothing to open
    for (const type of ['confluence_entry', 'vault_note', 'todo'] as const) {
      const a = currentAction(list, type);
      if (!a) continue;
      // Frank closed the item after this draft was ready or failed: he has left it. One that is ready
      // or fails after he closed the item is the draft he asked for on his way out, so it shows.
      if (it.status === 'done' && it.doneAt && it.doneAt >= a.updatedAt && a.status !== 'drafting') continue;
      const base = { itemId, actionId: a.id, actionType: type, subject: it.title, to: `/item/${encodeURIComponent(itemId)}` };
      if (a.status === 'drafting') {
        const progress = input.progress[a.id];
        const held = progress
          ? undefined
          : input.budgets.drafts.hit
            ? 'Waits for the drafts budget'
            : claudeDown
              ? 'Waits for Claude'
              : type === 'confluence_entry' && confluenceDown
                ? 'Waits for Confluence'
                : undefined;
        working.push({ itemId, actionId: a.id, type, subject: it.title, createdAt: a.createdAt, ...(progress && { progress }), ...(held && { held }) });
      } else if (a.status === 'ready') {
        const stale = a.itemRevision < it.revision;
        const waited = now - Date.parse(a.updatedAt) > DRAFT_WAIT_MS;
        const detail = stale ? 'New replies since it was drafted: re-draft to include them.' : waited ? 'Waiting for review for over a day.' : undefined;
        entries.push({ ...base, key: `draft_ready:${a.id}`, kind: 'draft_ready', at: a.updatedAt, title: `${LABEL[type]} draft ready`, ...(detail && { detail }), cta: 'Review', dismissible: false });
      } else if (a.status === 'failed') {
        const writing = a.failedWhile === 'writing';
        const detail = input.results?.[a.id] ?? (a.failureReason ? REASON[a.failureReason] : undefined);
        entries.push({
          ...base,
          key: `${writing ? 'write_failed' : 'draft_failed'}:${a.id}`,
          kind: writing ? 'write_failed' : 'draft_failed',
          at: a.updatedAt,
          title: writing ? `Couldn’t file ${NOUN[type]}` : `${LABEL[type]} draft failed`,
          ...(detail && { detail }),
          cta: 'Open',
          dismissible: true,
        });
      }
    }
  }

  for (const it of input.items) {
    if (it.status !== 'open') continue;
    const base = { itemId: it.id, subject: it.title, to: `/item/${encodeURIComponent(it.id)}`, cta: 'Open', dismissible: true };
    if (it.backFromSnooze) {
      const at = it.backAt ?? it.lastActivityAt;
      entries.push({ ...base, key: `snooze_back:${it.id}:${at}`, kind: 'snooze_back', at, title: 'Back from snooze' });
    }
    if (it.looksFinished) {
      entries.push({
        ...base,
        key: `looks_finished:${it.id}:${it.looksFinished.at}`,
        kind: 'looks_finished',
        at: it.looksFinished.at,
        title: 'Looks finished',
        detail: it.looksFinished.why ?? 'Others’ messages seem to settle what it asked of you.',
      });
    }
    if (it.replyCheck && !it.replyCheck.allSettled && !it.replyCheck.handedOn) {
      entries.push({
        ...base,
        key: `reply_unsettled:${it.id}:${it.replyCheck.at}`,
        kind: 'reply_unsettled',
        at: it.replyCheck.at,
        title: 'Your reply left asks open',
        detail: it.replyCheck.why ?? 'The check found asks your reply didn’t settle.',
      });
    }
  }

  const waiting = working.filter((w) => !w.progress).length;
  entries.push(...fixes(input, waiting));

  const ev = input.lastEval;
  if (ev && now - Date.parse(ev.at) <= EVAL_SHOWN_MS) {
    entries.push({ key: `eval_done:${ev.id}`, kind: 'eval_done', at: ev.at, title: 'Triage eval finished', subject: `${ev.labelCount} labelled threads`, to: `/usage/eval/${encodeURIComponent(ev.id)}`, cta: 'View report', dismissible: true });
  }
  for (const g of input.guidance) {
    if (!g.changed.length) continue;
    entries.push({
      key: `guidance_changed:${g.id}:${[...g.changed].sort().join(',')}`,
      kind: 'guidance_changed',
      at: g.since,
      title: 'Guidance sources changed',
      subject: g.label,
      detail: `Changed since it was distilled: ${g.changed.join(', ')}.`,
      to: `/settings/prompts#${g.id}`,
      cta: 'Review',
      dismissible: true,
    });
  }

  return {
    entries: entries.filter((e) => !(e.dismissible && input.dismissed[e.key])).sort((a, b) => b.at.localeCompare(a.at) || a.key.localeCompare(b.key)),
    working: working.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(({ createdAt: _createdAt, ...w }) => w),
  };
}

/** How many entries arrived since Frank last opened the bell: its badge. */
export const unseenCount = (entries: readonly Pick<AttentionEntry, 'at'>[], lastSeenAt?: string): number => (lastSeenAt ? entries.filter((e) => e.at > lastSeenAt).length : entries.length);
