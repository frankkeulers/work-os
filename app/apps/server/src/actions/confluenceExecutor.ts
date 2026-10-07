import type { ConfluenceDraft } from '@work-os/shared';
import type { ConfluenceApi, Page } from './confluenceApi';
import { inScope, type ConfluenceScope } from './confluenceCatalogue';
import { entryStorage } from './markdown';
import { findHeading, insertIntoSection } from './storage';

// The Confluence executor (FR-10.5, FR-10.6, FR-14.5, NF-5): code, never a model, applies an
// approved entry. Before every attempt it asks Confluence whether the page is in scope as the
// settings and the tree are now (a live CQL query; a failed query is a failed attempt, never a
// yes), then re-reads the page:
//   - the drafted version: write version + 1, marked "Work OS <actionId>";
//   - version + 1 with that marker: an earlier attempt already wrote it, so it is done;
//   - anything else: someone edited the page, so re-draft rather than overwrite.
// A 409 on the write means another save won the race; the next attempt re-reads and reconciles.

export const marker = (actionId: string) => `Work OS ${actionId}`;

export type ConfluencePlan =
  | { kind: 'write'; page: Page; storage: string; version: number; message: string; dryMessage: string }
  | { kind: 'already'; version: number; message: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'refused'; message: string };

export async function planConfluenceWrite(api: ConfluenceApi, scope: ConfluenceScope, actionId: string, d: ConfluenceDraft, signal?: AbortSignal): Promise<ConfluencePlan> {
  if (!(await inScope(api, scope, d.pageId, signal))) return { kind: 'refused', message: `Page ${d.pageId} (${d.pageTitle}) is not in the Confluence scope. The executor refused the write.` };
  let page: Page;
  try {
    page = await api.getPage(d.pageId, signal);
  } catch (err) {
    if ((err as { notFound?: boolean }).notFound) return { kind: 'conflict', message: `${d.pageTitle} no longer exists. Re-drafting instead of writing.` };
    throw err;
  }
  const next = d.baseVersion + 1;
  if (page.version === next && page.versionMessage.includes(marker(actionId))) return { kind: 'already', version: next, message: `Written to ${page.title}, now v${next}. Logged action.executed.` };
  if (page.version !== d.baseVersion) return { kind: 'conflict', message: `The page changed after drafting (v${d.baseVersion} → v${page.version}). Re-drafting instead of writing.` };
  const section = findHeading(page.storage, d.section);
  const storage = section && insertIntoSection(page.storage, d.section, entryStorage(d.title, d.content, section.level));
  if (!storage) return { kind: 'conflict', message: `${page.title} no longer has the section ${d.section}. Re-drafting instead of writing.` };
  return {
    kind: 'write',
    page,
    storage,
    version: next,
    message: `Written to ${page.title}, now v${next}. Logged action.executed.`,
    dryMessage: `Dry-run: write logged only. ${page.title} stays at v${d.baseVersion}. Logged action.executed.`,
  };
}
