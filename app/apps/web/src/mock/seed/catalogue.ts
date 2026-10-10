import type { CataloguePageView, Settings } from '@work-os/shared';

// A small PSG-like Confluence tree for the mock (amendment: live catalogue, FR-10.2). The mock
// applies the scope rules as the server's CQL does: every root and every page below it, every page
// with one of the labels, the single pages, minus the excluded pages and everything under them.

interface TreePage {
  id: string;
  title: string;
  parent?: string;
  labels?: string[];
}

export const MOCK_TREE: TreePage[] = [
  { id: '31000001', title: 'Data Products (DP)' },
  { id: '39004512', title: 'Insights APIs › Decisions', parent: '31000001', labels: ['psg-bu-dp', 'psg-context'] },
  { id: '40217733', title: 'Meridia › Context: Decisions', parent: '31000001', labels: ['psg-bu-dp', 'psg-context'] },
  { id: '40217744', title: 'MVI › Context: Decisions', parent: '31000001', labels: ['psg-bu-dp', 'psg-context'] },
  { id: '31000011', title: 'DP - Pricing', parent: '31000001', labels: ['psg-bu-dp', 'psg-context'] },
  { id: '31000012', title: 'DP - Customer Personas', parent: '31000001', labels: ['psg-bu-dp', 'psg-context'] },
  { id: '31000006', title: 'Archive', parent: '31000001' },
  { id: '31000061', title: 'DP - Pricing (2024)', parent: '31000006' },
  { id: '31000002', title: 'Safety & Operations (S&O)' },
  { id: '31000021', title: 'S&O - Decisions & Open Questions', parent: '31000002', labels: ['psg-bu-sando', 'psg-context'] },
  { id: '31000022', title: 'S&O - Pricing', parent: '31000002', labels: ['psg-bu-sando', 'psg-context'] },
  { id: '31000003', title: 'Organisation-wide (ORG)' },
  { id: '41120987', title: 'Pole Star Labs › Graduation gate', parent: '31000003', labels: ['psg-bu-org', 'psg-context'] },
  { id: '31000031', title: 'ORG - Decisions & Open Questions', parent: '31000003', labels: ['psg-bu-org', 'psg-context'] },
  { id: '31000007', title: 'Product org', parent: '31000003' },
  { id: '48213377', title: 'Product org › Roadmap process', parent: '31000007' },
  { id: '31000004', title: 'Competitor Profiles', labels: ['psg-shared-competitors'] },
  { id: '31000041', title: 'Competitor Profile - Windward', parent: '31000004', labels: ['psg-shared-competitors'] },
  { id: '31000042', title: 'Competitor Profile - Kpler Maritime', parent: '31000004', labels: ['psg-shared-competitors'] },
  { id: '31000005', title: 'Shared' },
  { id: '31000051', title: 'Data Assets & Licensing', parent: '31000005', labels: ['psg-shared-data-assets'] },
  { id: '31000052', title: 'Team offsite notes', parent: '31000005' },
];

/** The mock's scope: four roots, two labels, the archive and the Product org pages excluded. */
export const MOCK_SCOPE: Pick<Settings['confluence'], 'roots' | 'labels' | 'exclude' | 'pages'> = {
  roots: [
    { id: '31000001', title: 'Data Products (DP)' },
    { id: '31000002', title: 'Safety & Operations (S&O)' },
    { id: '31000003', title: 'Organisation-wide (ORG)' },
    { id: '31000004', title: 'Competitor Profiles' },
  ],
  labels: ['psg-shared-data-assets'],
  exclude: [
    { id: '31000006', title: 'Archive' },
    { id: '31000007', title: 'Product org (owned by Product Ops)' },
  ],
  pages: [],
};

const byId = new Map(MOCK_TREE.map((p) => [p.id, p]));

/** Root first, without the space home. */
export function ancestorIdsOf(id: string): string[] {
  const out: string[] = [];
  for (let p = byId.get(id)?.parent; p && out.length < 20; p = byId.get(p)?.parent) out.unshift(p);
  return out;
}

export function inMockScope(c: Settings['confluence'], id: string): boolean {
  const page = byId.get(id);
  if (!page) return false;
  const line = [id, ...ancestorIdsOf(id)];
  if (c.exclude.some((e) => line.includes(e.id))) return false;
  return c.roots.some((r) => line.includes(r.id)) || c.pages.some((p) => p.id === id) || (page.labels ?? []).some((l) => c.labels.includes(l));
}

export function mockCatalogue(c: Settings['confluence']): CataloguePageView[] {
  const pages = MOCK_TREE.filter((p) => inMockScope(c, p.id));
  const parents = new Set(pages.flatMap((p) => ancestorIdsOf(p.id)));
  const rootIds = new Set(c.roots.map((r) => r.id));
  return pages
    .map((p) => {
      const ancestors = ancestorIdsOf(p.id);
      const rootId = [p.id, ...ancestors].find((id) => rootIds.has(id));
      return {
        id: p.id,
        title: p.title,
        path: [...ancestors.map((a) => byId.get(a)!.title), p.title].join(' › '),
        ...(rootId && { rootId }),
        labels: (p.labels ?? []).filter((l) => l.startsWith('psg-')).sort(),
        hub: parents.has(p.id),
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}
