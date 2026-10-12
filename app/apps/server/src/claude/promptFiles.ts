import { createHash } from 'node:crypto';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PromptFileId, PromptFileView, PromptSourceView } from '@work-os/shared';
import { writeFileAtomic } from '../store/atomic';
import { DEFAULT_CONFLUENCE_ROUTING, DEFAULT_VAULT_CONVENTIONS } from './guidance';
import { DEFAULT_CONFLUENCE_PROMPT, DEFAULT_FILING_POLICY, DEFAULT_PEOPLE_CHECK_PROMPT, DEFAULT_PICK_CONFLUENCE_PROMPT, DEFAULT_FINISH_PROMPT, DEFAULT_SCHEDULE_PROMPT, DEFAULT_FOLLOWUP_PROMPT, DEFAULT_SETTLE_PROMPT, DEFAULT_TOPICS_PROMPT, DEFAULT_TRIAGE_PROMPT, DEFAULT_TUNE_POLICY, DEFAULT_VAULT_PROMPT, promptVersion, triageSystem, type Prompt } from './prompts';

// Every text file Claude calls read from config/ (FR-1.1, FR-1.7): the eight prompts and the two
// filing guidance files. Each is written on first run, read on every call (empty or missing → the
// built-in default) and editable in Settings. A file that still holds an earlier built-in default,
// byte for byte once trimmed, is replaced by the current one at start; an edited file is left alone.

export interface PromptFile {
  id: PromptFileId;
  /** Relative to the data directory's config/ folder. */
  file: string;
  label: string;
  description: string;
  usedBy: string;
  defaultText: string;
  /** sha1 of earlier built-in defaults (trimmed), replaced by defaultText at start. */
  previousDefaults: string[];
}

export const PROMPT_FILES: readonly PromptFile[] = [
  {
    id: 'triage',
    file: 'prompts/triage.md',
    label: 'Triage',
    description: 'Decides attention, filing suggestions, the summary and the open asks for each topic.',
    usedBy: 'Triage and the eval',
    defaultText: DEFAULT_TRIAGE_PROMPT,
    previousDefaults: ['a41e4946bcba81f2eb1f14d307bf3625e34eb550', 'd4b00d127a3dd9605964c0b44ac43c7967894f3f', '149c84e01c7eadef74a9eda6cfbf1994536706bc', '92c1953b699525b35e2b3e63ac1a4558852ea085', '74c0880ee869f2ab4326c4f48cffc45a2b46a514', '1778d2e9ea4326a39e614e4427150f69bccb23c3', '5bc2915dca8210f1dc53de0709d9e87920cedfae', 'd0d1898d8f28bc1836040ee6ac99fe131ab606bb'], // triage v2, v3, v4, v5, v6, v7, v8, v9
  },
  {
    id: 'filing-policy',
    file: 'prompts/filing-policy.md',
    label: 'Filing policy',
    description: 'Your rules for what triage files, drafts ahead, offers as ready to approve and suggests as a to-do. Sent with the triage prompt.',
    usedBy: 'Triage, drafts ahead and the filing eval',
    defaultText: DEFAULT_FILING_POLICY,
    previousDefaults: [],
  },
  {
    id: 'tune-policy',
    file: 'prompts/tune-policy.md',
    label: 'Policy tuner',
    description: 'How Opus revises a prompt from the labels it got wrong: the filing policy, triage attention, and the settle and Looks finished checks. Its proposals wait in Settings › Prompts for you to apply.',
    usedBy: 'Propose a better …, in Settings › Learning',
    defaultText: DEFAULT_TUNE_POLICY,
    previousDefaults: ['0db5452e381dcd7c632bba98044956f6bea28730'], // tune-policy v1
  },
  {
    id: 'topics',
    file: 'prompts/topics.md',
    label: 'Topics',
    description: 'Puts each new thread or stretch of chat in the open topic it continues, or starts a new one.',
    usedBy: 'Topic routing and Regroup',
    defaultText: DEFAULT_TOPICS_PROMPT,
    previousDefaults: ['ea33c8dd3c0dd6259817d98f1dad8142915008c1'], // topics v1
  },
  {
    id: 'settle',
    file: 'prompts/settle.md',
    label: 'Settle check',
    description: 'Decides whether your reply settles a thread’s open asks, so the item can close by itself.',
    usedBy: 'Closing items on your reply',
    defaultText: DEFAULT_SETTLE_PROMPT,
    previousDefaults: ['24f26389a61817f859938a46b92a4ed56457f653'], // settle v1
  },
  {
    id: 'finish',
    file: 'prompts/finish.md',
    label: 'Looks finished',
    description: 'Decides whether later messages, by anyone, settled what a topic asked of you, so it can be suggested as Done.',
    usedBy: 'Looks finished',
    defaultText: DEFAULT_FINISH_PROMPT,
    previousDefaults: ['a1ffd02ebeca78ff82f2a94b6b3f13495efc437b'], // finish v1
  },
  {
    id: 'schedule',
    file: 'prompts/schedule.md',
    label: 'To Do estimates',
    description: 'Estimates how long each of your To Dos takes, how sure it is, and when it would ideally be done, before any deadline it already has.',
    usedBy: 'To Dos on the inbox',
    defaultText: DEFAULT_SCHEDULE_PROMPT,
    previousDefaults: [],
  },
  {
    id: 'followup',
    file: 'prompts/followup.md',
    label: 'Follow-ups on Done',
    description: 'Once you mark a To Do done, suggests what comes next: a reply for you to send, closing its item, a next To Do, or a note to file. Never sends anything.',
    usedBy: 'To Dos on the inbox',
    defaultText: DEFAULT_FOLLOWUP_PROMPT,
    previousDefaults: [],
  },
  {
    id: 'draft-vault',
    file: 'prompts/draft-vault.md',
    label: 'Draft vault note',
    description: 'Files a thread or meeting into the Obsidian vault: appends under the topic notes that own each fact, and a new note only for what fits nowhere, after checking the vault doesn’t already hold it.',
    usedBy: 'Draft vault note',
    defaultText: DEFAULT_VAULT_PROMPT,
    previousDefaults: ['e7eb3efd72a888f525ea0b05e750f9b3f2b1060c', 'dfa8657114bbe2a91c2bbdecf3c5cceb34d6200a', 'e2c0deeb8646af8d010dee432153d54ad9347c21', 'ca6bbaf811a6d86f4c7113a9b32515cc398733a4'], // draft-vault v1, v2, v3, v4
  },
  {
    id: 'pick-confluence',
    file: 'prompts/pick-confluence.md',
    label: 'Pick Confluence page',
    description: 'Picks up to three candidate pages from the live Confluence catalogue, or declines when nothing fits.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_PICK_CONFLUENCE_PROMPT,
    previousDefaults: ['a59eb4aa2de26d243f521deabe060055485ec849'], // pick-confluence v1
  },
  {
    id: 'draft-confluence',
    file: 'prompts/draft-confluence.md',
    label: 'Draft Confluence entry',
    description: 'Drafts an entry for one of the picked Confluence pages after checking what they already hold, or declines when none fits.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_CONFLUENCE_PROMPT,
    previousDefaults: ['72bb329124bba27ca3c929afa7ee50baa7916c20', '4b97acd122e6f9a3cee48ea30d36baa1854a88b3', '3ca183c57f1c9a9b7d4947e27635de168a942cc5', '9fcb308e51e3a5be56ce00af2c4fdbb13053053a', 'aaa55dfbfecf01da7f0121a5a0342ac62ce618ce'], // draft-confluence v1, v2, v3, v4, v5
  },
  {
    id: 'people-check',
    file: 'prompts/people-check.md',
    label: 'People check',
    description: 'Checks a Confluence draft identifies no one, by name or description, before it is shown, and again before an edited one is approved.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_PEOPLE_CHECK_PROMPT,
    previousDefaults: ['852f66caf3c91f7c15086c4bb7057fc5fea51e13', 'ec4c692e2f60e81de1bbbdb807ff8cb81cb6df4e'], // people-check v1, v2
  },
  {
    id: 'vault-conventions',
    file: 'vault-conventions.md',
    label: 'Vault conventions',
    description: 'Where notes go in the vault, frontmatter, tags and style. From the vault’s Notes System note.',
    usedBy: 'Draft vault note',
    defaultText: DEFAULT_VAULT_CONVENTIONS,
    previousDefaults: ['898d14c3e478bd5da0c0143ca15980cc985e38f9', 'b6d4d9a6fe41e3699876314aa78f3ea715b816ce', '442190029d37e366c14c35110930672db7ce2f59'], // vault-conventions v1, v2, v3
  },
  {
    id: 'confluence-routing',
    file: 'psg-context-builder.md',
    label: 'Confluence routing',
    description: 'Exclusion screen, attribution and where each kind of fact goes. From psg-context-builder.',
    usedBy: 'Draft Confluence entry',
    defaultText: DEFAULT_CONFLUENCE_ROUTING,
    previousDefaults: ['bfd61af35ae154733721f70fa0b6bdd2080d9bcb', 'd2c97596843982fb215760ec923365300849c31f'], // confluence-routing v1, v2
  },
];

export const promptFile = (id: string): PromptFile | undefined => PROMPT_FILES.find((f) => f.id === id);

export const promptFilePath = (dataDir: string, f: PromptFile) => join(dataDir, 'config', f.file);

export const sha1 = (text: string) => createHash('sha1').update(text.trim()).digest('hex');

/** The file's text, or the built-in default if it is missing or empty. */
export async function readPromptFile(dataDir: string, f: PromptFile): Promise<Prompt> {
  const text = (await readFile(promptFilePath(dataDir, f), 'utf8').catch(() => '')).trim() || f.defaultText.trim();
  return { text, version: promptVersion(text) };
}

export function loadPromptFile(dataDir: string, id: PromptFileId): Promise<Prompt> {
  const f = promptFile(id);
  if (!f) throw new Error(`Unknown prompt file ${id}`);
  return readPromptFile(dataDir, f);
}

/** What triage sends as its system prompt: the triage prompt and the filing policy, both read fresh (FR-15.1). */
export async function loadTriagePrompt(dataDir: string): Promise<Prompt> {
  const [base, policy] = await Promise.all([loadPromptFile(dataDir, 'triage'), loadPromptFile(dataDir, 'filing-policy')]);
  return triageSystem(base, policy);
}

// ---------------------------------------------------------------- sources (FR-1.7)

/** Where the sources live: the home folder (for ~/.claude/skills) and the vault. */
export interface SourceEnv {
  home: string;
  vault: string;
}

const exists = (p: string) =>
  access(p).then(
    () => p,
    () => null,
  );

/** An installed skill: ~/.claude/skills/<name>, or a synced copy under ~/.claude/skills/synced/<id>/<name>. */
async function skillFile(home: string, name: string): Promise<string | null> {
  const direct = await exists(join(home, '.claude/skills', name, 'SKILL.md'));
  if (direct) return direct;
  const synced = join(home, '.claude/skills/synced');
  for (const id of (await readdir(synced).catch(() => [])).sort()) {
    const found = await exists(join(synced, id, name, 'SKILL.md'));
    if (found) return found;
  }
  return null;
}

const SOURCES: Record<string, { label: string; find: (e: SourceEnv) => Promise<string | null> }> = {
  'psg-context-builder': { label: 'psg-context-builder skill', find: (e) => skillFile(e.home, 'psg-context-builder') },
  'obsidian-vault-reader': { label: 'obsidian-vault-reader skill', find: (e) => skillFile(e.home, 'obsidian-vault-reader') },
  'vault-notes-system': { label: 'Notes System note in the vault', find: (e) => exists(join(e.vault, 'Notes System — Project Instructions.md')) },
  'vault-llms': { label: 'llms.txt in the vault', find: (e) => exists(join(e.vault, 'llms.txt')) },
};

const SOURCE_RE = /^<!--\s*source:\s*(\S+)\s+sha1:([0-9a-f]{6,40})\s*-->$/gm;
const short = (text: string) => sha1(text).slice(0, 12);

/** The sources a file's header names, each compared with the file as it is now. */
export async function sourceStates(text: string, env: SourceEnv): Promise<PromptSourceView[]> {
  const out: PromptSourceView[] = [];
  for (const [, id, recorded] of text.matchAll(SOURCE_RE)) {
    const src = SOURCES[id];
    const path = src ? await src.find(env) : null;
    const now = path ? await readFile(path, 'utf8').then(short, () => null) : null;
    out.push({ id, label: src?.label ?? id, path: path ?? undefined, state: now === null ? 'missing' : now.startsWith(recorded) || recorded.startsWith(now) ? 'current' : 'changed' });
  }
  return out;
}

/** The text with each source line's hash set to the source as it is now ("Mark reviewed"). */
export async function withCurrentSourceHashes(text: string, env: SourceEnv): Promise<string> {
  const now: Record<string, string> = {};
  for (const [, id] of text.matchAll(SOURCE_RE)) {
    const path = SOURCES[id] ? await SOURCES[id].find(env) : null;
    const t = path ? await readFile(path, 'utf8').catch(() => null) : null;
    if (t !== null) now[id] = short(t);
  }
  return text.replace(SOURCE_RE, (line: string, id: string) => (now[id] ? `<!-- source: ${id} sha1:${now[id]} -->` : line));
}

/** What Settings shows for a file (FR-1.7): the text calls use now, its version, whether it is edited, and its sources. */
export async function promptFileView(dataDir: string, f: PromptFile, env?: SourceEnv): Promise<PromptFileView> {
  const p = await readPromptFile(dataDir, f);
  return {
    id: f.id,
    label: f.label,
    description: f.description,
    usedBy: f.usedBy,
    path: `config/${f.file}`,
    text: p.text,
    version: p.version,
    defaultVersion: promptVersion(f.defaultText.trim()),
    edited: sha1(p.text) !== sha1(f.defaultText),
    sources: env ? await sourceStates(p.text, env) : [],
  };
}

/** Writes the file (owner-only, atomic). The next Claude call reads it; nothing needs a restart. */
export async function writePromptFile(dataDir: string, f: PromptFile, text: string): Promise<void> {
  await writeFileAtomic(promptFilePath(dataDir, f), `${text.trim()}\n`);
}
