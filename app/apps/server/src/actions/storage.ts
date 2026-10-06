// Confluence storage format (XHTML) as far as filing needs it (FR-10.3, FR-10.5): a page's
// outline for the drafter, and inserting an entry at the end of a section. Headings are matched by
// their text, so markup inside a heading doesn't matter.

const HEADING_RE = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** The text of some storage markup: tags dropped, entities decoded, whitespace collapsed. */
export function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|[a-z]+);/gi, (m, e: string) => (e.startsWith('#') ? String.fromCodePoint(Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)))
    .replace(/\s+/g, ' ')
    .trim();
}

export interface Heading {
  level: number;
  text: string;
  start: number; // offset of the heading tag
  end: number; // offset just after it
}

export function headings(storage: string): Heading[] {
  const out: Heading[] = [];
  for (const m of storage.matchAll(HEADING_RE)) out.push({ level: Number(m[1]), text: textOf(m[2]), start: m.index, end: m.index + m[0].length });
  return out;
}

const norm = (s: string) => textOf(s).toLowerCase();

/** Where the section under `heading` ends: the next heading of the same or a higher level. */
function sectionEnd(storage: string, all: Heading[], i: number): number {
  const h = all[i];
  const next = all.slice(i + 1).find((n) => n.level <= h.level);
  return next ? next.start : storage.length;
}

/** The page's sections with a short excerpt of each, for the drafter to choose from. */
export function outline(storage: string, excerptChars = 300): { level: number; heading: string; excerpt: string }[] {
  const all = headings(storage);
  return all.map((h, i) => {
    const text = textOf(storage.slice(h.end, sectionEnd(storage, all, i)));
    return { level: h.level, heading: h.text, excerpt: text.length > excerptChars ? `${text.slice(0, excerptChars - 1)}…` : text };
  });
}

/** Inserts `content` at the end of the section under `heading`. Undefined if there's no such heading. */
export function insertIntoSection(storage: string, heading: string, content: string): string | undefined {
  const all = headings(storage);
  const i = all.findIndex((h) => h.text.toLowerCase() === norm(heading));
  if (i < 0) return undefined;
  const at = sectionEnd(storage, all, i);
  return `${storage.slice(0, at)}${content}${storage.slice(at)}`;
}
