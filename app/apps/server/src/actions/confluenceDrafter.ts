import type { ConfluenceDraft, Item, Me, Settings } from '@work-os/shared';
import { z } from 'zod';
import type { ClaudeAdapter } from '../claude/adapter';
import type { Prompt } from '../claude/prompts';
import { DEADLINES } from '../net/http';
import type { ConfluenceApi, Page } from './confluenceApi';
import { buildCatalogue, type CatalogueEntry } from './confluenceCatalogue';
import { DraftError } from './errors';
import { entryStorage } from './markdown';
import { findHeading, outline, textOf } from './storage';
import { draftThread } from './vaultDrafter';

// "Draft Confluence entry" (FR-10.1–10.4), in two calls, because the PSG context tree is too big to
// outline in one. Code reads the live catalogue (every page in scope, from CQL: path, labels, hub)
// and a first call picks up to three candidate pages from it, or declines with noFit. Code then
// reads only those pages over REST and the draft call gets their outlines. Neither call has tools,
// so the model only ever sees pages in scope (FR-10.2). The draft answers with a page, a section, a
// title and Markdown; code checks the page and section exist, records the page version (FR-10.3),
// and a Haiku call checks the entry for observations about people before anyone sees it (FR-10.4).

export const ConfluenceEntryAnswer = z.object({
  pageId: z.string().min(1),
  section: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
});

export const ConfluenceNoFitAnswer = z.object({
  noFit: z.literal(true),
  reason: z.string().min(1).max(400),
  suggestedHome: z.string().max(200).optional(),
});

export const ConfluenceAnswer = z.union([ConfluenceNoFitAnswer, ConfluenceEntryAnswer]);

export const MAX_CANDIDATES = 3;

export const ConfluencePickAnswer = z.union([
  ConfluenceNoFitAnswer,
  z.object({
    candidates: z
      .array(z.object({ pageId: z.string().min(1), why: z.string().max(400).optional() }))
      .min(1)
      .max(MAX_CANDIDATES),
  }),
]);

export const PeopleCheckAnswer = z.object({ containsPeopleObservations: z.boolean(), reason: z.string().max(400) });

const OUTLINE_CHARS = 8000; // per page, so the three candidates fit one call easily

export interface ConfluenceDraftDeps {
  claude: ClaudeAdapter;
  api: ConfluenceApi;
  settings: Settings;
  pickPrompt: Prompt;
  prompt: Prompt;
  peoplePrompt: Prompt;
  /** The psg-context-builder routing guidance, if Frank has made it available. */
  routing: string;
  now: () => Date;
  signal?: AbortSignal;
  /** 1 while the catalogue is read, 2 while picking, 3 while drafting, 4 for the people check. */
  onStage?: (stage: number) => void;
  /** A meeting's transcript, read live for this draft (R2.3). */
  transcript?: string;
}

/** The catalogue as the picker sees it: one compact object per page. */
export function renderPickRequest(item: Item, me: Me, catalogue: CatalogueEntry[], routing: string, now: Date, transcript?: string): string {
  const thread = draftThread(item, me, transcript);
  const pages = catalogue.map((c) => ({ id: c.id, path: c.path, ...(c.labels.length && { labels: c.labels }), ...(c.hub && { hub: true }) }));
  return [
    `Today: ${now.toISOString().slice(0, 10)}`,
    ...(routing.trim() ? ['<routing-guidance>', routing.trim(), '</routing-guidance>'] : []),
    '<confluence-catalogue>',
    ...pages.map((p) => JSON.stringify(p)),
    '</confluence-catalogue>',
    '<thread>',
    JSON.stringify(thread),
    '</thread>',
    'Pick the candidate pages. Answer with the JSON only.',
  ].join('\n');
}

const noFit = (a: { reason: string; suggestedHome?: string }) => new DraftError(a.suggestedHome?.trim() ? `${a.reason} Suggested home: ${a.suggestedHome.trim()}.` : a.reason, 'no_fit');

export function renderConfluenceRequest(item: Item, me: Me, pages: Page[], routing: string, now: Date, transcript?: string): string {
  const thread = draftThread(item, me, transcript);
  const outlines = pages.map((p) => {
    let budget = OUTLINE_CHARS;
    const sections = outline(p.storage).filter((s) => (budget -= s.heading.length + s.excerpt.length) > 0);
    return { pageId: p.id, title: p.title, sections };
  });
  return [
    `Today: ${now.toISOString().slice(0, 10)}`,
    ...(routing.trim() ? ['<routing-guidance>', routing.trim(), '</routing-guidance>'] : []),
    '<confluence-pages>',
    JSON.stringify(outlines),
    '</confluence-pages>',
    '<thread>',
    JSON.stringify(thread),
    '</thread>',
    'Draft the Confluence entry. Answer with the JSON only.',
  ].join('\n');
}

export async function draftConfluenceEntry(d: ConfluenceDraftDeps, item: Item, me: Me): Promise<{ draft: ConfluenceDraft }> {
  const t0 = performance.now();
  const model = d.settings.models.draftConfluence;
  const catalogue = await buildCatalogue(d.api, d.settings.confluence, d.signal);
  if (!catalogue.length) throw new DraftError(`No Confluence pages are in scope: nothing in space ${d.settings.confluence.spaceKey} matches the root pages, labels and single pages in Settings.`, 'allow_list');

  // Step 1: pick up to three candidates from the catalogue.
  d.onStage?.(2);
  const pick = await d.claude.structured(
    {
      purpose: 'confluence_pick',
      model,
      system: d.pickPrompt.text,
      prompt: renderPickRequest(item, me, catalogue, d.routing, d.now(), d.transcript),
      promptVersion: d.pickPrompt.version,
      timeoutMs: DEADLINES.draft,
      signal: d.signal,
      itemIds: [item.id],
    },
    ConfluencePickAnswer,
  );
  if ('noFit' in pick.value) throw noFit(pick.value);
  const inCatalogue = new Set(catalogue.map((c) => c.id));
  const picked = [...new Set(pick.value.candidates.map((c) => c.pageId))].filter((id) => inCatalogue.has(id));
  if (!picked.length) throw new DraftError('The page picker chose pages that are not in the Confluence scope.', 'allow_list');

  // Step 2: read only the candidates, and draft against their outlines.
  const pages: Page[] = [];
  for (const id of picked) {
    try {
      pages.push(await d.api.getPage(id, d.signal));
    } catch (err) {
      if ((err as { notFound?: boolean }).notFound) continue; // deleted since the search: offer the rest
      throw err;
    }
  }
  if (!pages.length) throw new DraftError('None of the picked Confluence pages could be read.', 'allow_list');
  d.onStage?.(3);

  const r = await d.claude.structured(
    {
      purpose: 'draft_confluence',
      model,
      system: d.prompt.text,
      prompt: renderConfluenceRequest(item, me, pages, d.routing, d.now(), d.transcript),
      promptVersion: d.prompt.version,
      timeoutMs: DEADLINES.draft,
      signal: d.signal,
      itemIds: [item.id],
    },
    ConfluenceAnswer,
  );
  if ('noFit' in r.value) throw noFit(r.value);
  const a = r.value;
  const page = pages.find((p) => p.id === a.pageId);
  if (!page) throw new DraftError(`The draft targets page ${a.pageId}, which is not one of the picked pages.`, 'allow_list');
  const section = findHeading(page.storage, a.section);
  if (!section) throw new DraftError(`The draft would file under “${a.section}”, but ${page.title} has no such section.`);

  // FR-10.4: a second, cheap look at the entry itself, before it is shown.
  d.onStage?.(4);
  const check = await d.claude.structured(
    {
      purpose: 'people_check',
      model: 'haiku-5.5',
      system: d.peoplePrompt.text,
      prompt: `<entry>\n${a.title}\n${textOf(entryStorage(a.title, a.content, section.level))}\n</entry>`,
      promptVersion: d.peoplePrompt.version,
      timeoutMs: DEADLINES.triage,
      signal: d.signal,
      itemIds: [item.id],
    },
    PeopleCheckAnswer,
  );
  if (check.value.containsPeopleObservations) {
    throw new DraftError(`The people check found observations about named people in the draft (${check.value.reason}). Nothing will be written to Confluence.`, 'people_check');
  }
  const tokens = [...pick.usage, ...r.usage, ...check.usage].reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheTokens, 0);
  return {
    draft: {
      kind: 'confluence',
      pageId: page.id,
      pageTitle: page.title,
      ancestorIds: catalogue.find((c) => c.id === page.id)?.ancestorIds,
      section: section.text,
      baseVersion: page.version,
      title: a.title,
      content: a.content,
      model,
      promptVersion: d.prompt.version,
      durationMs: Math.round(performance.now() - t0),
      tokens,
      edited: false,
    },
  };
}
