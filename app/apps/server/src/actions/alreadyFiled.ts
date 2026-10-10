import type { Item } from '@work-os/shared';

// What identifies a thread or meeting wherever it was filed before (FR-9.6, FR-10.7): its links.
// Every vault note and Confluence entry links back to its source, so a link found in a note or a
// page section means this source was filed there already.

/** Links that stand for no particular source, such as Wispr Flow's app link for a meeting with no share link. */
const PLACEHOLDER = /^[a-z-]+:\/\/$/i;

/** The permalinks of a topic's pieces, anchor first, without placeholders or repeats. */
export function itemLinks(anchor: Item, parts: Item[] = []): string[] {
  return [...new Set([anchor, ...parts].map((p) => p.permalink.trim()).filter((l) => l && !PLACEHOLDER.test(l)))];
}
