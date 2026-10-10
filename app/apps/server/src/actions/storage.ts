// Confluence storage format (XHTML) as far as filing needs it (FR-10.3, FR-10.5): a page's
// outline for the drafter, and inserting an entry at the end of a section. Headings are matched by
// their text, so markup inside a heading doesn't matter.

const HEADING_RE = /<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/gi;

// The named entities Confluence writes in storage format: markup, spaces, punctuation and symbols.
// Accented letters (&eacute;, &Uuml;, &ccedil; …) are composed from their name below.
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', shy: '\u00ad', zwj: '\u200d', zwnj: '\u200c',
  ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·', prime: '′', Prime: '″',
  lsquo: '‘', rsquo: '’', sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', laquo: '«', raquo: '»', lsaquo: '‹', rsaquo: '›',
  iexcl: '¡', iquest: '¿', sect: '§', para: '¶', dagger: '†', Dagger: '‡', permil: '‰',
  copy: '©', reg: '®', trade: '™', deg: '°', plusmn: '±', times: '×', divide: '÷', minus: '−', micro: 'µ',
  frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', ordf: 'ª', ordm: 'º', not: '¬',
  le: '≤', ge: '≥', ne: '≠', asymp: '≈', infin: '∞', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', rArr: '⇒', lArr: '⇐',
  euro: '€', pound: '£', yen: '¥', cent: '¢', curren: '¤',
  szlig: 'ß', aelig: 'æ', AElig: 'Æ', oelig: 'œ', OElig: 'Œ', oslash: 'ø', Oslash: 'Ø', eth: 'ð', ETH: 'Ð', thorn: 'þ', THORN: 'Þ',
};
const ACCENTS: Record<string, string> = { acute: '\u0301', grave: '\u0300', circ: '\u0302', tilde: '\u0303', uml: '\u0308', ring: '\u030a', cedil: '\u0327', caron: '\u030c' };

function entity(name: string): string | undefined {
  if (name.startsWith('#')) {
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : undefined;
  }
  if (ENTITIES[name]) return ENTITIES[name];
  const m = /^([A-Za-z])(acute|grave|circ|tilde|uml|ring|cedil|caron)$/.exec(name);
  return m ? `${m[1]}${ACCENTS[m[2]]}`.normalize('NFC') : undefined;
}

/** The text of some storage markup: tags dropped, entities decoded, whitespace collapsed. */
export function textOf(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => entity(e) ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * How headings are compared: decoded, case-folded, with every kind of dash, quote and space made
 * the same, so a model writing "—" for "&mdash;" or "'" for "’" still finds the section.
 */
export function headingKey(s: string): string {
  return textOf(s)
    .normalize('NFC')
    .replace(/[\u00ad\u200b-\u200d]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/[\u2018\u2019\u201a\u2032`]/g, "'")
    .replace(/[\u201c\u201d\u201e\u2033]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/** The heading in `storage` whose text is `text`, as headingKey compares them. */
export function findHeading(storage: string, text: string): Heading | undefined {
  const key = headingKey(text);
  return headings(storage).find((h) => headingKey(h.text) === key);
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

/** Where the section under `heading` ends: the next heading of the same or a higher level. */
function sectionEnd(storage: string, all: Heading[], i: number): number {
  const h = all[i];
  const next = all.slice(i + 1).find((n) => n.level <= h.level);
  return next ? next.start : storage.length;
}

/**
 * The page's sections with an excerpt of each, for the drafter to choose from: the start of the
 * section and its end, where the latest entries are, so the draft can see what was filed lately
 * (FR-10.7).
 */
export function outline(storage: string, o: { head?: number; tail?: number } = {}): { level: number; heading: string; excerpt: string }[] {
  const head = o.head ?? 150;
  const tail = o.tail ?? 450;
  const all = headings(storage);
  return all.map((h, i) => {
    const text = textOf(storage.slice(h.end, sectionEnd(storage, all, i)));
    return { level: h.level, heading: h.text, excerpt: text.length > head + tail ? `${text.slice(0, head - 1)}… ${text.slice(-(tail - 1))}` : text };
  });
}

/**
 * The sections that hold one of `links` (FR-10.7): for each, the nearest heading above the link and
 * that section's text. Hrefs in storage escape "&" as "&amp;", so both spellings are looked for.
 */
export function sectionsLinking(storage: string, links: string[]): { heading: string; text: string }[] {
  const all = headings(storage);
  const found = new Map<number, { heading: string; text: string }>();
  for (const link of links) {
    for (const spelling of new Set([link, link.replaceAll('&', '&amp;')])) {
      for (let at = storage.indexOf(spelling); at >= 0; at = storage.indexOf(spelling, at + spelling.length)) {
        const i = all.findLastIndex((h) => h.start < at);
        if (i < 0 || found.has(i)) continue;
        found.set(i, { heading: all[i].text, text: textOf(storage.slice(all[i].end, sectionEnd(storage, all, i))) });
      }
    }
  }
  return [...found.entries()].sort(([a], [b]) => a - b).map(([, v]) => v);
}

/** Inserts `content` at the end of the section under `heading`. Undefined if there's no such heading. */
export function insertIntoSection(storage: string, heading: string, content: string): string | undefined {
  const all = headings(storage);
  const key = headingKey(heading);
  const i = all.findIndex((h) => headingKey(h.text) === key);
  if (i < 0) return undefined;
  const at = sectionEnd(storage, all, i);
  return `${storage.slice(0, at)}${content}${storage.slice(at)}`;
}
