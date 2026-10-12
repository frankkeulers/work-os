import { Marked } from 'marked';
import { plain, slugger } from './pages';

// Renders a guide page's Markdown to HTML. The files are ours, but the renderer still treats them
// as text: raw HTML is shown escaped, not run, and only three kinds of link are made live.
//   - another guide page (rules.md, confluence.md#scope) → /guide/<slug>#anchor, in the app;
//   - an app route (/settings/writing) → in the app;
//   - an https: link → a new tab.
// Anything else (a relative file, javascript:, mailto:) renders as plain text. In-app links carry
// data-internal; the Guide page turns their clicks into router navigation.

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export type GuideHref = { kind: 'guide'; slug: string; hash: string } | { kind: 'app'; path: string } | { kind: 'external'; url: string } | { kind: 'unsafe' };

/** What a link in a guide page points at. */
export function classifyHref(href: string, currentSlug: string): GuideHref {
  const guide = href.match(/^(?:\.\/)?([a-z0-9-]+)\.md(#[\w-]*)?$/i);
  if (guide) return { kind: 'guide', slug: guide[1], hash: guide[2] ?? '' };
  if (/^#[\w-]+$/.test(href)) return { kind: 'guide', slug: currentSlug, hash: href };
  if (/^\/(?!\/)[\w\-/]*(#[\w-]*)?$/.test(href)) return { kind: 'app', path: href };
  if (/^https:\/\/[^\s]+$/i.test(href)) return { kind: 'external', url: href };
  return { kind: 'unsafe' };
}

export function renderGuide(body: string, currentSlug: string): string {
  const slug = slugger();
  const md = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth }) {
        const id = slug(plain(tokens));
        const anchor = depth > 1 ? `<a class="wos-guide-anchor" href="/guide/${currentSlug}#${id}" data-internal aria-label="Link to this section">#</a>` : '';
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}${anchor}</h${depth}>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        const t = classifyHref(href, currentSlug);
        const titleAttr = title ? ` title="${esc(title)}"` : '';
        if (t.kind === 'guide') return `<a href="/guide/${t.slug}${t.hash}" data-internal${titleAttr}>${text}</a>`;
        if (t.kind === 'app') return `<a href="${esc(t.path)}" data-internal${titleAttr}>${text}</a>`;
        if (t.kind === 'external') return `<a href="${esc(t.url)}" target="_blank" rel="noreferrer noopener"${titleAttr}>${text}</a>`;
        return `<span>${text}</span>`;
      },
      image({ text }) {
        return esc(text);
      },
      html({ text }) {
        return esc(text);
      },
      codespan({ text }) {
        return `<code>${esc(text)}</code>`;
      },
      code({ text }) {
        return `<div class="wos-guide-code"><pre><code>${esc(text.replace(/\n$/, ''))}</code></pre><button type="button" class="wos-guide-copy" data-copy>Copy</button></div>\n`;
      },
    },
  });
  // Tables sit in a wrapper that scrolls sideways, so the table itself can take the article's width.
  // Raw HTML in a page is escaped, so every <table> here is one Marked made.
  return md
    .parse(body, { async: false })
    .replace(/<table>/g, '<div class="wos-guide-table"><table>')
    .replace(/<\/table>/g, '</table></div>');
}
