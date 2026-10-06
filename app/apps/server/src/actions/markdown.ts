// Markdown to Confluence storage format, for the subset a filed entry uses: paragraphs, headings,
// bullet and numbered lists, bold, italic, inline code and links. Everything else is text, escaped,
// so a draft can never inject markup or macros into the page (FR-10.3, FR-10.5).

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const SAFE_URL = /^(https?:\/\/|mailto:)/i;

/** Inline markup: `code`, **bold**, *italic* or _italic_, [text](url). */
export function inline(text: string): string {
  const parts: string[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*|\*([^*]+)\*|_([^_]+)_|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    parts.push(escape(text.slice(last, m.index)));
    if (m[1] !== undefined) parts.push(`<code>${escape(m[1])}</code>`);
    else if (m[2] !== undefined) parts.push(`<strong>${inline(m[2])}</strong>`);
    else if (m[3] !== undefined || m[4] !== undefined) parts.push(`<em>${inline(m[3] ?? m[4])}</em>`);
    else if (SAFE_URL.test(m[6])) parts.push(`<a href="${escape(m[6])}">${inline(m[5])}</a>`);
    else parts.push(escape(m[0]));
    last = m.index + m[0].length;
  }
  parts.push(escape(text.slice(last)));
  return parts.join('');
}

/** Headings below `minHeading` are pushed down to it, so an entry can't end its own section. */
export function markdownToStorage(md: string, minHeading = 1): string {
  const out: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | undefined;
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`);
    list = undefined;
  };
  for (const raw of md.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.*)$/.exec(line);
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!line) {
      flushPara();
      flushList();
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? 'ul' : 'ol';
      if (list?.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]);
    } else if (heading) {
      flushPara();
      flushList();
      const level = Math.min(6, Math.max(heading[1].length, minHeading));
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join('');
}

/** The entry as it lands in the page: its title one level below the section, then the body. */
export function entryStorage(title: string, content: string, sectionLevel: number): string {
  const level = Math.min(6, sectionLevel + 1);
  return `<h${level}>${escape(title)}</h${level}>${markdownToStorage(content, Math.min(6, level + 1))}`;
}
