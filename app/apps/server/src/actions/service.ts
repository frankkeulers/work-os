import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Action, ActionState, ActionType, ConfluenceDraft, Draft, DraftProgress, FailureReason, Item, Me, Notice, Settings, SourceId, VaultMultiDraft } from '@work-os/shared';
import { draftTarget, filedAll, isFiledDraft, londonParts, topicItem } from '@work-os/shared';
import { HttpError } from '../api/errors';
import type { ClaudeAdapter } from '../claude/adapter';
import { ClaudeError, ClaudeOutputError } from '../claude/errors';
import type { Prompt } from '../claude/prompts';
import { expandHome } from '../config/env';
import type { Logger } from '../log';
import type { DepId } from '@work-os/shared';
import type { Failure } from '../net/classify';
import type { DraftStore, StoredDraft } from '../store/drafts';
import type { ItemFiles } from '../store/items';
import type { Store } from '../store/store';
import { writeFileAtomic } from '../store/atomic';
import { crashPoint } from '../runtime/crash';
import { ConfluenceError, type ConfluenceApi } from './confluenceApi';
import { scopeCql } from './confluenceCatalogue';
import { draftConfluenceEntry } from './confluenceDrafter';
import { marker, planConfluenceWrite } from './confluenceExecutor';
import { readTopic } from '../pipeline/topics';
import { itemLinks } from './alreadyFiled';
import { DraftError } from './errors';
import { draftVaultNote, vaultExists } from './vaultDrafter';
import { NoteExistsError, planVaultWrite, writeVaultFile, type VaultTargets } from './vaultExecutor';

// Actions (FR-9.x, FR-10.x, FR-14.4, FR-14.5): requested, drafted by a model, edited and approved
// by Frank, then written by code. The event log is the queue, so nothing waits in memory alone:
//   - drafting actions are drafted one at a time, when Claude may be called (awake 45 s, online,
//     breaker ready; Confluence also needs its breaker ready); a sleep or a lost login leaves them
//     drafting, and they run again later;
//   - approved and executing actions are the outbox: written one at a time, when the Mac has been
//     awake 45 s, after reconciling against the target. `action.executing` is synced before every
//     attempt (with the expected hash for the vault, the version marker for Confluence), so a crash
//     or sleep mid-write is never repeated. Offline time doesn't use up attempts.

const ACTIVE: ActionState['status'][] = ['drafting', 'ready', 'approved', 'executing'];
export const DRAFT_STAGES: Record<ActionType, string[]> = {
  vault_note: ['Reading the thread', 'Finding related notes in the vault', 'Drafting the note'],
  confluence_entry: ['Reading the thread', 'Reading the Confluence catalogue', 'Picking the page', 'Drafting the entry', 'People check (Haiku)'],
};
export const MAX_ATTEMPTS = 5; // transient write failures before `unreachable` (FR-14.5)
const RETRY_BASE_MS = 30_000;

export interface ActionDeps {
  store: Store;
  items: ItemFiles;
  drafts: DraftStore;
  claude: ClaudeAdapter;
  dataDir: string;
  now: () => Date;
  logger?: Logger;
  settings: () => Settings;
  /** Dry-run in force: the settings, or forced on for the development instance. */
  dryRun: () => boolean;
  /** Frank in a source (Slack by default). */
  me: (source?: SourceId) => Me;
  draftsBudgetHit: () => boolean;
  /** Awake 45 s, online and the Claude breaker ready (CL-10). */
  claudeReady: () => boolean;
  /** Awake 45 s and not stopping: approved writes wait out a Power Nap (FR-14.2). */
  canWrite: () => boolean;
  /** Aborts on sleep and shutdown. */
  signal: () => AbortSignal;
  /** Health: a failed call, whether a dependency's breaker would let a call through, and the network. */
  reportFailure: (dep: DepId, f: Failure) => Promise<void>;
  depReady: (dep: DepId) => boolean;
  reportOk: (dep: DepId) => Promise<void> | void;
  online: () => boolean;
  confluence: ConfluenceApi;
  prompt: (id: 'draft-vault' | 'pick-confluence' | 'draft-confluence' | 'people-check') => Promise<Prompt>;
  /** The vault conventions for vault drafts. */
  conventions: () => Promise<string>;
  /** A meeting's transcript from its source, read live for a draft (R2.3, R2.7). */
  transcript?: (item: Item, signal: AbortSignal) => Promise<string | undefined>;
  /** The Confluence routing guidance (from psg-context-builder) for Confluence drafts. */
  routing: () => Promise<string>;
  notify: (n: Notice) => void;
  /** A draft is ready or failed: a macOS notification, as Frank may have moved on (FR-11.6). Not for quiet drafts. */
  notifyDraft?: (n: DraftOutcomeNotice) => void;
}

export interface DraftOutcomeNotice {
  itemId: string;
  type: ActionType;
  title: string;
  outcome: 'ready' | 'failed';
  message?: string;
}

export interface ActionsView {
  actions: Action[];
  drafts: Record<string, Draft>;
  progress: Record<string, DraftProgress>;
  results: Record<string, string>;
}

export class ActionService {
  private progress = new Map<string, DraftProgress>();
  private drafting?: { id: string; ctrl: AbortController };
  private executing = false;
  private attempts = new Map<string, number>();
  /** Transient failures per action, however far each attempt got: what MAX_ATTEMPTS counts. */
  private failures = new Map<string, number>();
  private retryAt = new Map<string, number>();
  private inFlight = new Set<Promise<unknown>>();

  constructor(private readonly d: ActionDeps) {}

  vaultRoot() {
    return resolve(expandHome(this.d.settings().vaultPath, homedir()));
  }

  private targets(): VaultTargets {
    return {
      vaultRoot: this.vaultRoot(),
      sandboxRoot: join(this.d.dataDir, 'sandbox/vault'),
      dryRun: this.d.dryRun(),
      today: londonParts(this.d.now()).dateKey,
    };
  }

  private get actions() {
    return this.d.store.projection.actions;
  }

  private action(id: string): ActionState {
    const a = this.actions[id];
    if (!a) throw new HttpError('not_found', 'Action not found.');
    return a;
  }

  // ---------------------------------------------------------------- commands

  /** `quiet`: drafted ahead while filing in a batch, so no macOS notification (FR-11.6). */
  async request(itemId: string, type: ActionType, opts: { quiet?: boolean } = {}): Promise<Action> {
    const existing = Object.values(this.actions).find((a) => a.itemId === itemId && a.type === type && ACTIVE.includes(a.status));
    if (existing) return this.toAction(existing);
    return this.create(itemId, type, undefined, opts.quiet);
  }

  private async create(itemId: string, type: ActionType, supersedes?: string, quiet?: boolean): Promise<Action> {
    const it = this.d.store.projection.items[itemId];
    if (!it) throw new HttpError('not_found', 'Item not found. It may have been removed by retention.');
    if (type === 'confluence_entry') {
      if (!scopeCql(this.d.settings().confluence)) throw new HttpError('conflict', 'Nothing is in the Confluence scope yet. Add root pages, labels or single pages in Settings › Write targets.');
    }
    if (this.d.draftsBudgetHit()) throw new HttpError('budget', 'Drafts budget reached for today. Drafting resumes tomorrow, or raise the budget in Settings.');
    if (type === 'vault_note' && !(await vaultExists(this.vaultRoot()))) throw new HttpError('unavailable', `The vault folder ${this.vaultRoot()} doesn't exist. Set the vault path in Settings.`);
    const id = `act-${randomUUID()}`;
    await this.d.store.append({
      type: 'action.requested',
      itemId,
      actionId: id,
      data: { type, revision: it.revision, ...(supersedes && { supersedes }), ...(quiet && { quiet: true as const }) },
    });
    this.progress.set(id, {
      stages: DRAFT_STAGES[type],
      stage: 0,
      startedAt: Date.now(),
    });
    this.pump();
    return this.toAction(this.actions[id]);
  }

  async cancel(id: string) {
    const a = this.action(id);
    if (a.status !== 'drafting') return;
    this.stopDrafting(id);
    await this.d.store.append({
      type: 'action.discarded',
      itemId: a.itemId,
      actionId: id,
      data: { reason: 'cancelled' },
    });
  }

  /** `part`: which note, for a draft that files into several (FR-9.7). */
  async edit(id: string, content: string, part?: number) {
    const a = this.action(id);
    const stored = await this.d.drafts.read(id);
    if (a.status !== 'ready' || !stored?.draft) throw new HttpError('conflict', 'This draft can no longer be edited.');
    if (isFiledDraft(stored.draft)) throw new HttpError('conflict', 'This draft files nothing, so there is nothing to edit. Re-draft to file it anyway.');
    const multi = stored.draft.kind === 'vault_multi';
    if (multi !== (part !== undefined) || (multi && !(part! < (stored.draft as VaultMultiDraft).parts.length)))
      throw new HttpError('validation', multi ? 'Say which note of the draft to edit.' : 'This draft has one text to edit.');
    await this.d.drafts.update(id, a.itemId, (s) => {
      const d = s.draft!;
      return { ...s, draft: d.kind === 'vault_multi' ? { ...d, parts: d.parts.map((p, i) => (i === part ? { ...p, content, edited: true } : p)), edited: true } : { ...d, content, edited: true } as Draft };
    });
    await this.d.store.append({
      type: 'action.edited',
      itemId: a.itemId,
      actionId: id,
      data: undefined,
    });
  }

  async redraft(id: string): Promise<Action> {
    const a = this.action(id);
    if (a.status === 'executing' || a.status === 'done') throw new HttpError('conflict', 'This action has already been written.');
    if (this.d.draftsBudgetHit()) throw new HttpError('budget', 'Drafts budget reached for today.');
    if (a.status !== 'failed' && a.status !== 'discarded') {
      this.stopDrafting(id);
      await this.d.store.append({
        type: 'action.discarded',
        itemId: a.itemId,
        actionId: id,
        data: { reason: 'redraft' },
      });
    }
    return this.create(a.itemId, a.type, id);
  }

  async discard(id: string) {
    const a = this.action(id);
    if (a.status === 'executing' || a.status === 'done') throw new HttpError('conflict', 'This action has already been written.');
    if (a.status === 'discarded') return;
    this.stopDrafting(id);
    await this.d.store.append({
      type: 'action.discarded',
      itemId: a.itemId,
      actionId: id,
      data: { reason: 'discarded' },
    });
  }

  /** `markDoneWhenFiled`: approved while filing in a batch (cockpit CK-4.4). */
  async approve(id: string, opts: { markDoneWhenFiled?: boolean } = {}) {
    const a = this.action(id);
    if (a.status !== 'ready') throw new HttpError('conflict', 'This draft is no longer ready to approve.');
    await this.d.store.append({
      type: 'action.approved',
      itemId: a.itemId,
      actionId: id,
      data: opts.markDoneWhenFiled ? { markDoneWhenFiled: true } : undefined,
    });
    this.pump();
  }

  // ---------------------------------------------------------------- views

  async view(itemId: string): Promise<ActionsView> {
    // Newest first; requests in the same millisecond keep their order (newest first too).
    const list = Object.values(this.actions)
      .filter((a) => a.itemId === itemId)
      .reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const out: ActionsView = {
      actions: [],
      drafts: {},
      progress: {},
      results: {},
    };
    for (const a of list) {
      const stored = await this.d.drafts.read(a.id);
      if (stored?.draft) out.drafts[a.id] = stored.draft;
      if (stored?.result) out.results[a.id] = stored.result;
      if (a.status === 'drafting')
        out.progress[a.id] = this.progress.get(a.id) ?? {
          stages: DRAFT_STAGES[a.type],
          stage: 0,
          startedAt: Date.parse(a.createdAt),
        };
      out.actions.push({
        ...a,
        ...(a.status === 'failed' && stored?.result && { error: stored.result }),
      });
    }
    return out;
  }

  private toAction(a: ActionState): Action {
    return { ...a };
  }

  /** The draft being made now, by action id: the bell shows its stage (FR-11.3). Others wait their turn. */
  running(): Record<string, DraftProgress> {
    const id = this.drafting?.id;
    const p = id && this.progress.get(id);
    return p ? { [id]: p } : {};
  }

  /** Why a failed action failed, in the words the item's panel shows. */
  async result(id: string): Promise<string | undefined> {
    return (await this.d.drafts.read(id))?.result;
  }

  // ---------------------------------------------------------------- the queue and the outbox

  /** After a restart: a draft file lost with its action ready or approved can't be written (FR-14.7). */
  async recover() {
    for (const a of Object.values(this.actions)) {
      if (a.status !== 'ready' && a.status !== 'approved' && a.status !== 'executing') continue;
      if (!(await this.d.drafts.read(a.id))?.draft) await this.fail(a, 'draft_missing', 'The draft file is missing, so nothing was written. Re-draft to try again.');
    }
  }

  /** Starts what can run now: one draft and one write. Called on every tick and after commands. */
  pump(): Promise<unknown> {
    const started: Promise<unknown>[] = [];
    const now = this.d.now().getTime();
    const confluenceReady = this.d.online() && this.d.depReady('confluence');
    if (!this.drafting && this.d.claudeReady() && !this.d.draftsBudgetHit()) {
      const next = this.oldest((a) => a.status === 'drafting' && (this.retryAt.get(a.id) ?? 0) <= now && (a.type === 'vault_note' || confluenceReady));
      if (next) started.push(this.track(this.startDraft(next)));
    }
    if (!this.executing && this.d.canWrite()) {
      const next = this.oldest((a) => (a.status === 'approved' || a.status === 'executing') && (this.retryAt.get(a.id) ?? 0) <= now && (a.type === 'vault_note' || confluenceReady));
      if (next) started.push(this.track(this.execute(next)));
    }
    return Promise.all(started);
  }

  /** Waits for every draft and write started so far, and what they start. For tests. */
  async settled() {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  async stop() {
    this.drafting?.ctrl.abort(new Error('stopping'));
    await this.settled();
  }

  private oldest(f: (a: ActionState) => boolean) {
    return Object.values(this.actions)
      .filter(f)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p)).catch(() => undefined);
    return p;
  }

  private stopDrafting(id: string) {
    if (this.drafting?.id === id) this.drafting.ctrl.abort(new Error('cancelled'));
    this.progress.delete(id);
  }

  private stage(id: string, stage: number) {
    const p = this.progress.get(id);
    if (p && p.stage < stage) {
      this.progress.set(id, { ...p, stage });
      const a = this.actions[id];
      if (a) this.d.notify({ topic: 'item', id: a.itemId });
    }
  }

  /** `silent`: a conflict that is re-drafted at once, so nothing needs Frank. */
  private async fail(a: ActionState, reason: FailureReason, message: string, silent = false) {
    await this.d.drafts.update(a.id, a.itemId, (s) => ({
      ...s,
      result: message,
    }));
    await this.d.store.append({
      type: 'action.failed',
      itemId: a.itemId,
      actionId: a.id,
      data: { reason },
    });
    this.progress.delete(a.id);
    this.attempts.delete(a.id);
    this.failures.delete(a.id);
    this.retryAt.delete(a.id);
    if (silent) return;
    // Frank may have moved on since he asked for it (FR-11.4, FR-11.6).
    const title = this.d.store.projection.items[a.itemId]?.title ?? '';
    this.d.notify({ topic: 'draft_failed', itemId: a.itemId, actionId: a.id, type: a.type, title, message });
    if (!this.actions[a.id]?.quiet) this.d.notifyDraft?.({ itemId: a.itemId, type: a.type, title, outcome: 'failed', message });
  }

  private async startDraft(a: ActionState) {
    const ctrl = new AbortController();
    this.drafting = { id: a.id, ctrl };
    try {
      await this.runDraft(a, AbortSignal.any([ctrl.signal, this.d.signal()]));
    } finally {
      this.drafting = undefined;
    }
    this.pump();
  }

  /** The transcript, or undefined: a draft goes ahead from the summary when it can't be read. */
  private async transcriptFor(item: Item, signal: AbortSignal): Promise<string | undefined> {
    try {
      return await this.d.transcript?.(item, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      this.d.logger?.warn({ itemId: item.id, err: String(err) }, 'Could not read the meeting transcript; drafting from the summary');
      return undefined;
    }
  }

  private async runDraft(a: ActionState, signal: AbortSignal) {
    const stillDrafting = () => this.actions[a.id]?.status === 'drafting';
    if (!this.progress.has(a.id))
      this.progress.set(a.id, {
        stages: DRAFT_STAGES[a.type],
        stage: 0,
        startedAt: Date.now(),
      });
    let stored = await this.d.drafts.read(a.id);
    if (!stored?.draft) {
      // A topic is drafted from all its pieces.
      const topic = await readTopic(this.d.store.projection, this.d.items, a.itemId);
      const content = topic && { item: topicItem(topic.anchor.item, topic.parts).item, links: itemLinks(topic.anchor.item, topic.parts) };
      if (!content) return this.fail(a, 'model_error', 'The thread’s content is no longer available, so it can’t be drafted.');
      try {
        this.stage(a.id, 1);
        const transcript = content.item.kind === 'meeting' ? await this.transcriptFor(content.item, signal) : undefined;
        const result: { draft: Draft; baseHash?: string | null; baseHashes?: Record<string, string | null> } =
          a.type === 'vault_note'
            ? await draftVaultNote(
                {
                  claude: this.d.claude,
                  settings: this.d.settings(),
                  vaultRoot: this.vaultRoot(),
                  prompt: await this.d.prompt('draft-vault'),
                  conventions: await this.d.conventions(),
                  now: this.d.now,
                  signal,
                  onTurn: (usedTool) => this.stage(a.id, usedTool ? 1 : 2),
                  transcript,
                  links: content.links,
                  ...(this.d.dryRun() && { sandboxRoot: this.targets().sandboxRoot }),
                },
                content.item,
                this.d.me(content.item.source),
              )
            : await draftConfluenceEntry(
                {
                  claude: this.d.claude,
                  api: this.d.confluence,
                  settings: this.d.settings(),
                  pickPrompt: await this.d.prompt('pick-confluence'),
                  prompt: await this.d.prompt('draft-confluence'),
                  peoplePrompt: await this.d.prompt('people-check'),
                  routing: await this.d.routing(),
                  now: this.d.now,
                  signal,
                  onStage: (n) => this.stage(a.id, n),
                  transcript,
                  links: content.links,
                },
                content.item,
                this.d.me(content.item.source),
              );
        if (a.type === 'confluence_entry') await this.d.reportOk('confluence');
        if (!stillDrafting()) return; // cancelled or discarded during the call
        stored = await this.d.drafts.update(a.id, a.itemId, (s) => ({
          ...s,
          draft: result.draft,
          ...(result.baseHash !== undefined && { baseHash: result.baseHash }),
          ...(result.baseHashes !== undefined && { baseHashes: result.baseHashes }),
        }));
      } catch (err) {
        if (signal.aborted) return; // cancelled, or asleep: still drafting, so it runs again
        if (err instanceof ClaudeOutputError) return this.fail(a, 'model_error', 'The draft did not match the expected format twice, so it was dropped.');
        if (err instanceof DraftError) return this.fail(a, err.reason, `${err.message} Nothing was written; re-draft to try again.`);
        // Still drafting: it waits for the dependency, and for a while in any case, so a transient
        // failure the breaker lets through does not retry at once.
        if (err instanceof ClaudeError || err instanceof ConfluenceError) {
          this.retryAt.set(a.id, this.d.now().getTime() + RETRY_BASE_MS);
          return this.d.reportFailure(err instanceof ClaudeError ? 'claude' : 'confluence', err.failure);
        }
        this.d.logger?.error({ err, actionId: a.id }, 'Drafting failed');
        return this.fail(a, 'model_error', 'Drafting failed unexpectedly. The log has the details.');
      }
    }
    if (!stillDrafting()) return;
    const draft = stored.draft!;
    await this.d.store.append({
      type: 'action.drafted',
      itemId: a.itemId,
      actionId: a.id,
      data: {
        type: a.type,
        revision: a.itemRevision,
        draftRef: `drafts/${a.id}.json`,
        tokens: draft.tokens,
        target: draftTarget(draft),
      },
    });
    this.progress.delete(a.id);
    this.retryAt.delete(a.id);
    const it = this.d.store.projection.items[a.itemId];
    this.d.notify({
      topic: 'draft_ready',
      itemId: a.itemId,
      actionId: a.id,
      type: a.type,
      title: it?.title ?? '',
    });
    if (!a.quiet) this.d.notifyDraft?.({ itemId: a.itemId, type: a.type, title: it?.title ?? '', outcome: 'ready' });
  }

  private async execute(a: ActionState) {
    this.executing = true;
    try {
      await this.executeOnce(a);
    } finally {
      this.executing = false;
    }
    this.pump();
  }

  private async executeOnce(a: ActionState) {
    const stored = await this.d.drafts.read(a.id);
    if (!stored?.draft) return this.fail(a, 'draft_missing', 'The draft file is missing, so nothing was written. Re-draft to try again.');
    if (stored.draft.kind === 'confluence') return this.executeConfluence(a, stored.draft);
    if (stored.draft.kind === 'confluence_filed') {
      // FR-10.7: already on the page, so nothing is written, in dry-run or not.
      const d = stored.draft;
      return this.done(a, `Already on ${d.pageTitle} under ${d.section}. Nothing was written. Logged action.executed.`, { dryRun: this.d.dryRun(), pageId: d.pageId, unchanged: true });
    }
    return this.executeVault(a, stored);
  }

  private async executeVault(a: ActionState, stored: StoredDraft) {
    const t = this.targets();
    try {
      const plan = await planVaultWrite(t, stored);
      if (plan.kind === 'refused') return this.fail(a, 'allow_list', plan.message);
      if (plan.kind === 'conflict') return this.conflict(a, plan.message);
      if (plan.kind === 'filed') return await this.done(a, plan.message, { dryRun: t.dryRun, path: plan.file, unchanged: true });
      if (plan.kind === 'writes') {
        // Several notes (FR-9.7): every expected hash is saved before the first write, so an
        // attempt cut short is finished, note by note, rather than repeated.
        const attempt = this.nextAttempt(a.id);
        await this.d.drafts.update(a.id, a.itemId, (s) => ({ ...s, expectedHashes: plan.expectedHashes }));
        await this.d.store.append({ type: 'action.executing', itemId: a.itemId, actionId: a.id, data: { attempt, expectedHashes: plan.expectedHashes } });
        crashPoint('before-write');
        for (const w of plan.writes) await writeVaultFile(w);
        crashPoint('after-write');
        return await this.done(a, plan.message, { dryRun: t.dryRun, path: plan.files[0], paths: plan.files });
      }
      if (plan.kind === 'already' && plan.files) return await this.done(a, plan.message, { dryRun: t.dryRun, path: plan.files[0], paths: plan.files });
      if (plan.kind === 'write') {
        const attempt = this.nextAttempt(a.id);
        await this.d.drafts.update(a.id, a.itemId, (s) => ({ ...s, expectedHash: plan.expectedHash }));
        await this.d.store.append({ type: 'action.executing', itemId: a.itemId, actionId: a.id, data: { attempt, expectedHash: plan.expectedHash } });
        crashPoint('before-write');
        await writeVaultFile(plan);
        crashPoint('after-write');
      }
      await this.done(a, plan.message, { dryRun: t.dryRun, path: plan.file });
    } catch (err) {
      if (err instanceof NoteExistsError) return this.conflict(a, `${err.message} Re-drafting instead of overwriting it.`);
      await this.retryLater(a, err, 'Writing to the vault');
    }
  }

  private async executeConfluence(a: ActionState, d: ConfluenceDraft) {
    const dryRun = this.d.dryRun();
    const signal = this.d.signal();
    try {
      const plan = await planConfluenceWrite(this.d.confluence, this.d.settings().confluence, a.id, d, signal);
      if (plan.kind !== 'refused') await this.d.reportOk('confluence'); // the page was read
      if (plan.kind === 'refused') return this.fail(a, 'allow_list', plan.message);
      if (plan.kind === 'conflict') return this.conflict(a, plan.message);
      if (plan.kind === 'already') return this.done(a, plan.message, { dryRun: false, pageId: d.pageId, pageVersion: plan.version });
      if (dryRun) {
        // What would have been saved, for inspection; the page itself is only read.
        await mkdir(join(this.d.dataDir, 'sandbox/confluence'), { recursive: true });
        await writeFileAtomic(join(this.d.dataDir, 'sandbox/confluence', `${d.pageId}-${a.id}.html`), plan.storage);
        return this.done(a, plan.dryMessage, { dryRun: true, pageId: d.pageId, pageVersion: d.baseVersion });
      }
      const attempt = this.nextAttempt(a.id);
      await this.d.store.append({ type: 'action.executing', itemId: a.itemId, actionId: a.id, data: { attempt } });
      await this.d.confluence.updatePage({ id: d.pageId, title: plan.page.title, storage: plan.storage, version: plan.version, message: marker(a.id) }, signal);
      await this.done(a, plan.message, { dryRun: false, pageId: d.pageId, pageVersion: plan.version });
    } catch (err) {
      if (signal.aborted) return; // asleep or stopping: reconciled on the next attempt
      // A 409 lost a save race: not a health problem; the next attempt re-reads and reconciles.
      if (err instanceof ConfluenceError && !err.conflict) {
        await this.d.reportFailure('confluence', err.failure);
        // Offline time doesn't use up attempts (FR-14.5): the breaker holds the outbox meanwhile.
        if (err.failure.state === 'offline' || err.failure.needsProbe || err.failure.state === 'auth_failed' || err.failure.state === 'rate_limited') {
          this.forgetAttempt(a.id);
          this.retryAt.set(a.id, this.d.now().getTime() + RETRY_BASE_MS);
          return;
        }
      }
      await this.retryLater(a, err, 'Writing to Confluence');
    }
  }

  private nextAttempt(id: string) {
    const n = (this.attempts.get(id) ?? 0) + 1;
    this.attempts.set(id, n);
    return n;
  }

  private forgetAttempt(id: string) {
    const n = this.attempts.get(id);
    if (n) this.attempts.set(id, n - 1);
  }

  private async done(a: ActionState, message: string, data: { dryRun: boolean; path?: string; paths?: string[]; pageId?: string; pageVersion?: number; unchanged?: true }) {
    await this.d.drafts.update(a.id, a.itemId, (s) => ({ ...s, result: message }));
    // Filed in a batch (CK-4.4): the write that completes the item's filings also marks it done, in the same append.
    const it = this.d.store.projection.items[a.itemId];
    const mine = Object.values(this.actions)
      .filter((b) => b.itemId === a.itemId)
      .map((b) => (b.id === a.id ? { ...b, status: 'done' as const } : b))
      .reverse()
      .sort((x, y) => y.createdAt.localeCompare(x.createdAt));
    const close = a.markDoneWhenFiled && it?.status === 'open' && filedAll(it, mine);
    await this.d.store.append({ type: 'action.executed', itemId: a.itemId, actionId: a.id, data }, ...(close ? [{ type: 'item.done' as const, itemId: a.itemId, data: undefined }] : []));
    this.attempts.delete(a.id);
    this.failures.delete(a.id);
    this.retryAt.delete(a.id);
  }

  /**
   * A failure: try again later, up to MAX_ATTEMPTS (FR-14.5). Every failure counts, including one
   * before the write started; offline time and an open breaker never get here, so they don't.
   * macOS refusing access is not transient: it fails at once, with what to allow.
   */
  private async retryLater(a: ActionState, err: unknown, what: string) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'EPERM' || code === 'EACCES')
      return this.fail(a, 'unreachable', `${what} failed: macOS refused access (${code}). Allow Work OS (node) in System Settings › Privacy & Security › Full Disk Access, or Files and Folders for the vault's folder, then re-draft. Nothing was written.`);
    const n = (this.failures.get(a.id) ?? 0) + 1;
    this.failures.set(a.id, n);
    this.d.logger?.warn({ err, actionId: a.id, attempt: n }, `${what} failed`);
    if (n >= MAX_ATTEMPTS) return this.fail(a, 'unreachable', `${what} failed ${n} times (${(err as Error).message}). Nothing was written.`);
    this.retryAt.set(a.id, this.d.now().getTime() + RETRY_BASE_MS * n);
  }

  /** The target changed after drafting: fail this one and draft again, budget permitting. */
  private async conflict(a: ActionState, message: string) {
    const redraft = !this.d.draftsBudgetHit() && !!this.d.store.projection.items[a.itemId];
    await this.fail(a, 'conflict', message, redraft);
    if (!redraft) return;
    try {
      await this.create(a.itemId, a.type, a.id, a.quiet);
    } catch (err) {
      this.d.logger?.warn({ err, actionId: a.id }, 'Could not re-draft after a conflict');
    }
  }
}
