import { marked, type Token, type Tokens } from 'marked';
import { frontMatterFields, splitFrontMatter } from '../lib/markdown';

// The user guide (FR-1.8): Markdown files in app/docs/guide, bundled at build time. Each file's
// name is its slug (/guide/<slug>); its front matter gives the title, nav group and order.

export const GROUPS = ['Start here', 'Inbox', 'Filing', 'Settings', 'Help'] as const;
export type GuideGroup = (typeof GROUPS)[number];

export interface GuideHeading {
  id: string;
  text: string;
  depth: number;
}

/** A run of text under one heading (or the page's intro, with no heading), for search. */
interface GuideSection {
  heading?: GuideHeading;
  text: string;
}

export interface GuidePage {
  slug: string;
  title: string;
  group: GuideGroup;
  order: number;
  summary: string;
  updated: string;
  body: string;
  headings: GuideHeading[];
  sections: GuideSection[];
}

/** GitHub-style heading ids; a repeated heading gets -1, -2… so every anchor is unique. */
export function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base =
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, '')
        .trim()
        .replace(/\s+/g, '-') || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${n}` : base;
  };
}

/** The plain text of inline tokens: what a heading says, without its Markdown. */
export const plain = (tokens: Token[] | undefined): string =>
  (tokens ?? []).map((t) => ('tokens' in t && t.tokens ? plain(t.tokens) : 'text' in t ? String(t.text) : '')).join('');

/** The words of a block, for search: Markdown punctuation dropped. */
const words = (raw: string) =>
  raw
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_|#>]+/g, ' ')
    .replace(/^\s*[-:| ]+$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();

export function parsePage(slug: string, source: string): GuidePage {
  const { frontMatter, body } = splitFrontMatter(source.replace(/\r\n/g, '\n'));
  const f = Object.fromEntries(frontMatterFields(frontMatter));
  const missing = ['title', 'group', 'order', 'updated'].filter((k) => !f[k]);
  if (missing.length) throw new Error(`docs/guide/${slug}.md: front matter needs ${missing.join(', ')}`);
  if (!GROUPS.includes(f.group as GuideGroup)) throw new Error(`docs/guide/${slug}.md: group "${f.group}" is not one of ${GROUPS.join(', ')}`);
  if (!/^\d+$/.test(f.order)) throw new Error(`docs/guide/${slug}.md: order must be a whole number`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.updated)) throw new Error(`docs/guide/${slug}.md: updated must be YYYY-MM-DD`);

  const slug_ = slugger();
  const headings: GuideHeading[] = [];
  const sections: GuideSection[] = [{ text: '' }];
  for (const t of marked.lexer(body)) {
    if (t.type === 'heading') {
      const h = t as Tokens.Heading;
      const text = plain(h.tokens);
      const heading = { id: slug_(text), text, depth: h.depth };
      headings.push(heading);
      sections.push({ heading, text: '' });
    } else {
      const s = sections[sections.length - 1];
      s.text = `${s.text} ${words(t.raw)}`.trim();
    }
  }
  return {
    slug,
    title: f.title,
    group: f.group as GuideGroup,
    order: Number(f.order),
    summary: f.summary ?? '',
    updated: f.updated,
    body,
    headings,
    sections: sections.filter((s) => s.heading || s.text),
  };
}

const FILES = import.meta.glob<string>('../../../../docs/guide/*.md', { query: '?raw', import: 'default', eager: true });

/** Every page, in nav order: by group, then by order. */
export const PAGES: GuidePage[] = Object.entries(FILES)
  .map(([path, source]) => parsePage(path.replace(/^.*\/(.+)\.md$/, '$1'), source))
  .sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || a.order - b.order);

export const pageBySlug = (slug: string | undefined) => PAGES.find((p) => p.slug === slug);

// ---------- Search ----------

export interface SearchHit {
  page: GuidePage;
  heading?: GuideHeading;
  /** About 120 characters around the first match, with the matched words. */
  snippet: string;
  terms: string[];
}

function snippetOf(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), Infinity);
  if (at === Infinity) return text.length > 120 ? `${text.slice(0, 120).trimEnd()}…` : text;
  const start = Math.max(0, at - 40);
  const end = Math.min(text.length, start + 120);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).trim()}${end < text.length ? '…' : ''}`;
}

/** Sections that contain every word of the query, best first: a title match, then a heading, then body text. */
export function search(query: string, pages: GuidePage[] = PAGES, limit = 8): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: (SearchHit & { score: number; i: number })[] = [];
  let i = 0;
  for (const page of pages) {
    for (const s of page.sections) {
      const title = page.title.toLowerCase();
      const heading = s.heading?.text.toLowerCase() ?? '';
      const text = s.text.toLowerCase();
      if (!terms.every((t) => title.includes(t) || heading.includes(t) || text.includes(t))) continue;
      const score = terms.reduce((n, t) => n + (heading.includes(t) ? 4 : 0) + (title.includes(t) ? 2 : 0) + (text.includes(t) ? 1 : 0), 0);
      scored.push({ page, heading: s.heading, snippet: snippetOf(s.text, terms), terms, score, i: i++ });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, limit)
    .map(({ score: _s, i: _i, ...hit }) => hit);
}
