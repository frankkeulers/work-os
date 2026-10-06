import type { ConfluenceDraft, Item, Me, Settings } from '@work-os/shared';
import { z } from 'zod';
import type { ClaudeAdapter } from '../claude/adapter';
import type { Prompt } from '../claude/prompts';
import { DEADLINES } from '../net/http';
import { threadForTriage } from '../pipeline/truncate';
import type { ConfluenceApi, Page } from './confluenceApi';
import { DraftError } from './errors';
import { entryStorage } from './markdown';
import { headings, outline, textOf } from './storage';
import { DRAFT_KEEP_LAST } from './vaultDrafter';

// "Draft Confluence entry" (FR-10.1–10.4). Code reads the allow-listed pages over REST and gives
// the model their outlines, so the model gets no tools and can only see allow-listed pages
// (FR-10.2). It answers with a page, a section, a title and Markdown; code checks the page and
// section exist, records the page version (FR-10.3), and a second Haiku call checks the entry for
// observations about people before anyone sees it (FR-10.4).

export const ConfluenceAnswer = z.object({
  pageId: z.string().min(1),
  section: z.string().min(1),
  title: z.string().min(1).max(200),
  content: z.string().min(1),
});

export const PeopleCheckAnswer = z.object({ containsPeopleObservations: z.boolean(), reason: z.string().max(400) });

const OUTLINE_CHARS = 8000; // per page, so many pages still fit one call

export interface ConfluenceDraftDeps {
  claude: ClaudeAdapter;
  api: ConfluenceApi;
  settings: Settings;
  prompt: Prompt;
  peoplePrompt: Prompt;
  /** The psg-context-builder routing guidance, if Frank has made it available. */
  routing: string;
  now: () => Date;
  signal?: AbortSignal;
  /** 1 once the pages are read, 2 while drafting, 3 for the people check. */
  onStage?: (stage: number) => void;
}

export function renderConfluenceRequest(item: Item, me: Me, pages: Page[], routing: string, now: Date): string {
  const thread = { ...threadForTriage(item, me, DRAFT_KEEP_LAST), permalink: item.permalink };
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
  const allowed = d.settings.confluence.pages;
  if (!allowed.length) throw new DraftError('No Confluence pages are on the allow-list yet. Add them in Settings.', 'allow_list');
  const t0 = performance.now();
  const pages: Page[] = [];
  for (const p of allowed) {
    try {
      pages.push(await d.api.getPage(p.id, d.signal));
    } catch (err) {
      if ((err as { notFound?: boolean }).notFound) continue; // deleted or moved: offer the rest
      throw err;
    }
  }
  if (!pages.length) throw new DraftError('None of the allow-listed Confluence pages could be found.', 'allow_list');
  d.onStage?.(2);

  const model = d.settings.models.draftConfluence;
  const r = await d.claude.structured(
    {
      purpose: 'draft_confluence',
      model,
      system: d.prompt.text,
      prompt: renderConfluenceRequest(item, me, pages, d.routing, d.now()),
      promptVersion: d.prompt.version,
      timeoutMs: DEADLINES.draft,
      signal: d.signal,
      itemIds: [item.id],
    },
    ConfluenceAnswer,
  );
  const a = r.value;
  const page = pages.find((p) => p.id === a.pageId);
  if (!page) throw new DraftError(`The draft targets page ${a.pageId}, which is not on the allow-list.`, 'allow_list');
  const section = headings(page.storage).find((h) => h.text.toLowerCase() === textOf(a.section).toLowerCase());
  if (!section) throw new DraftError(`The draft would file under “${a.section}”, but ${page.title} has no such section.`);

  // FR-10.4: a second, cheap look at the entry itself, before it is shown.
  d.onStage?.(3);
  const check = await d.claude.structured(
    {
      purpose: 'people_check',
      model: 'haiku-4.5',
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
  const tokens = [...r.usage, ...check.usage].reduce((n, u) => n + u.inputTokens + u.outputTokens + u.cacheTokens, 0);
  return {
    draft: {
      kind: 'confluence',
      pageId: page.id,
      pageTitle: page.title,
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
