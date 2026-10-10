import type { Item } from '@work-os/shared';
import type { Page } from './confluenceApi';
import { sectionsLinking } from './storage';

// What identifies a thread or meeting wherever it was filed before (FR-9.6, FR-10.7): its links.
// Every vault note and Confluence entry links back to its source, so a link found in a note or a
// page section means this source was filed there already.

/** Links that stand for no particular source, such as Wispr Flow's app link for a meeting with no share link. */
const PLACEHOLDER = /^[a-z-]+:\/\/$/i;

/** The permalinks of a topic's pieces, anchor first, without placeholders or repeats. */
export function itemLinks(anchor: Item, parts: Item[] = []): string[] {
  return [...new Set([anchor, ...parts].map((p) => p.permalink.trim()).filter((l) => l && !PLACEHOLDER.test(l)))];
}

/** A section of a candidate page that already links to this thread or meeting (FR-10.7). */
export interface FiledSection {
  pageId: string;
  pageTitle: string;
  section: string;
  text: string;
}

export const FILED_SECTION_CHARS = 3000; // the whole section as a rule; the latest entries if it is long

/** The sections of these pages that hold one of the item's links, with their text. */
export function findOnPages(pages: Page[], links: string[]): FiledSection[] {
  if (!links.length) return [];
  return pages.flatMap((p) =>
    sectionsLinking(p.storage, links).map((s) => ({
      pageId: p.id,
      pageTitle: p.title,
      section: s.heading,
      text: s.text.length > FILED_SECTION_CHARS ? `…${s.text.slice(-(FILED_SECTION_CHARS - 1))}` : s.text,
    })),
  );
}
