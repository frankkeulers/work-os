import type { Settings } from '@work-os/shared';
import type { ConfluenceApi, FoundPage } from './confluenceApi';

// The live Confluence catalogue (FR-10.2, FR-10.6), as the psg-context-builder skill builds it in
// its Step 1: rebuilt from CQL for every draft, so a page added to the PRD tree a minute ago is
// offered. In scope: every root and every page below it, every page in the space with one of the
// labels, and the single pages; minus the excluded pages and everything under them. Roots are
// mostly indexes; the catalogue marks them as hubs and the routing guidance files to the child.
// The executor asks the same question about one page before every write.

export type ConfluenceScope = Settings['confluence'];

export interface CatalogueEntry {
  id: string;
  title: string;
  /** Ancestor titles below the space home, then the page's own: "DP › DP - Pricing". */
  path: string;
  /** Root first, without the space home. */
  ancestorIds: string[];
  /** The scope root it sits under, if any. */
  rootId?: string;
  /** psg-* labels only. */
  labels: string[];
  /** Another page in the catalogue sits under it: an index, so entries go to its children. */
  hub: boolean;
}

const numericIds = (xs: { id: string }[]) => xs.map((p) => p.id).filter((id) => /^\d+$/.test(id));
const quote = (s: string) => `"${s.replace(/["\\]/g, '\\$&')}"`;

/** The CQL for everything in scope (null when nothing could be), narrowed by `extra` if given. */
export function scopeCql(c: ConfluenceScope, extra?: string): string | null {
  const roots = numericIds(c.roots);
  const pages = numericIds(c.pages);
  const exclude = numericIds(c.exclude);
  const ids = [...roots, ...pages];
  const anyOf = [ids.length && `id in (${ids.join(',')})`, roots.length && `ancestor in (${roots.join(',')})`, c.labels.length && `label in (${c.labels.map(quote).join(',')})`].filter(Boolean);
  if (!anyOf.length) return null;
  return [
    `space = ${quote(c.spaceKey)} AND type = page AND (${anyOf.join(' OR ')})`,
    ...(exclude.length ? [`id not in (${exclude.join(',')}) AND ancestor not in (${exclude.join(',')})`] : []),
    ...(extra ? [extra] : []),
  ].join(' AND ');
}

export function toCatalogue(found: FoundPage[], c: ConfluenceScope): CatalogueEntry[] {
  const rootIds = new Set(c.roots.map((r) => r.id));
  const parents = new Set(found.flatMap((p) => p.ancestors.map((a) => a.id)));
  const seen = new Set<string>();
  const out: CatalogueEntry[] = [];
  for (const p of found) {
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    // The first ancestor is the space home: everyone has it, so it says nothing.
    const below = p.ancestors.slice(1);
    out.push({
      id: p.id,
      title: p.title,
      path: [...below.map((a) => a.title), p.title].join(' › '),
      ancestorIds: below.map((a) => a.id),
      rootId: rootIds.has(p.id) ? p.id : p.ancestors.find((a) => rootIds.has(a.id))?.id,
      labels: p.labels.filter((l) => l.startsWith('psg-')).sort(),
      hub: parents.has(p.id),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** Every page in scope, read now. Empty when nothing is configured. */
export async function buildCatalogue(api: ConfluenceApi, c: ConfluenceScope, signal?: AbortSignal): Promise<CatalogueEntry[]> {
  const cql = scopeCql(c);
  return cql ? toCatalogue(await api.search(cql, signal), c) : [];
}

/** Whether one page is in scope right now: the executor's check before every write (FR-10.6). */
export async function inScope(api: ConfluenceApi, c: ConfluenceScope, pageId: string, signal?: AbortSignal): Promise<boolean> {
  if (!/^\d+$/.test(pageId)) return false;
  const cql = scopeCql(c, `id = ${pageId}`);
  return cql ? (await api.search(cql, signal)).some((p) => p.id === pageId) : false;
}
