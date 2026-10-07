import { marked, type Token } from 'marked';
import { describe, expect, it } from 'vitest';
import appSource from '../App.tsx?raw';
import sectionsSource from '../pages/settings/sections.tsx?raw';
import { HELP } from './links';
import { GROUPS, PAGES, pageBySlug, parsePage, search } from './pages';
import { classifyHref, renderGuide } from './render';

// The guide is kept up to date by hand, so this checks what a renamed heading, page or route would
// silently break: every link in the guide, and every contextual link into it, still lands.

/** The app's routes, from App.tsx: '/settings/:section' and so on. */
const ROUTES = ['/', ...[...appSource.matchAll(/path: '([^']+)'/g)].map((m) => `/${m[1]}`)];
const SETTINGS_SECTIONS = [...sectionsSource.matchAll(/\{ id: '([\w-]+)', label:/g)].map((m) => m[1]);

function routeExists(path: string) {
  const segs = path.split('/').filter(Boolean);
  return ROUTES.some((r) => {
    const rs = r.split('/').filter(Boolean);
    if (rs.length !== segs.length) return false;
    return rs.every((s, i) => {
      if (s === ':section') return SETTINGS_SECTIONS.includes(segs[i]);
      if (s === ':page') return !!pageBySlug(segs[i]);
      return s.startsWith(':') || s === segs[i];
    });
  });
}

const anchorExists = (slug: string, id: string) => !!pageBySlug(slug)?.headings.some((h) => h.id === id);

function linksOf(body: string): string[] {
  const out: string[] = [];
  marked.walkTokens(marked.lexer(body), (t: Token) => {
    if (t.type === 'link') out.push(t.href);
  });
  return out;
}

describe('guide pages', () => {
  it('loads every file in docs/guide, in group order', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(9);
    const groups = PAGES.map((p) => GROUPS.indexOf(p.group));
    expect(groups).toEqual([...groups].sort((a, b) => a - b));
    for (const g of GROUPS) expect(PAGES.some((p) => p.group === g), g).toBe(true);
  });

  it('has unique slugs and orders, and a summary for each page', () => {
    expect(new Set(PAGES.map((p) => p.slug)).size).toBe(PAGES.length);
    expect(new Set(PAGES.map((p) => p.order)).size).toBe(PAGES.length);
    for (const p of PAGES) expect(p.summary, p.slug).not.toBe('');
  });

  it('leaves the title to the front matter: no page starts with its own h1', () => {
    for (const p of PAGES) expect(p.headings.filter((h) => h.depth === 1), p.slug).toEqual([]);
  });

  it('refuses a page with missing or wrong front matter', () => {
    expect(() => parsePage('x', '# No front matter')).toThrow(/needs title, group, order, updated/);
    expect(() => parsePage('x', '---\ntitle: X\ngroup: Elsewhere\norder: 1\nupdated: 2026-10-07\n---\n')).toThrow(/group "Elsewhere"/);
    expect(() => parsePage('x', '---\ntitle: X\ngroup: Help\norder: 1\nupdated: 7 Oct\n---\n')).toThrow(/YYYY-MM-DD/);
  });

  it('links only to guide pages and anchors that exist, app routes that exist, or https', () => {
    const broken: string[] = [];
    for (const p of PAGES) {
      for (const href of linksOf(p.body)) {
        const t = classifyHref(href, p.slug);
        const ok =
          t.kind === 'guide' ? !!pageBySlug(t.slug) && (!t.hash || anchorExists(t.slug, t.hash.slice(1))) : t.kind === 'app' ? routeExists(t.path.replace(/#.*$/, '')) : t.kind === 'external';
        if (!ok) broken.push(`${p.slug}.md → ${href}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('points every contextual link in the app at a page and heading that exist', () => {
    for (const [topic, target] of Object.entries(HELP)) {
      const [slug, id] = target.split('#');
      expect(pageBySlug(slug), topic).toBeDefined();
      if (id) expect(anchorExists(slug, id), target).toBe(true);
    }
  });
});

describe('renderGuide', () => {
  it('escapes raw HTML instead of running it', () => {
    const html = renderGuide('Hi <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n<div>block</div>', 'x');
    expect(html).not.toMatch(/<script|<img|<div>/);
    expect(html).toContain('&lt;script&gt;');
  });

  it('makes guide, app and https links live, and nothing else', () => {
    const html = renderGuide('[a](rules.md#tips) [b](/settings/writing) [c](https://example.com) [d](javascript:alert(1)) [e](#scope)', 'confluence');
    expect(html).toContain('<a href="/guide/rules#tips" data-internal>a</a>');
    expect(html).toContain('<a href="/settings/writing" data-internal>b</a>');
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer noopener">c</a>');
    expect(html).toContain('<span>d</span>');
    expect(html).toContain('<a href="/guide/confluence#scope" data-internal>e</a>');
  });

  it('gives headings the same ids as the page index, and code blocks a copy button', () => {
    const page = pageBySlug('troubleshooting')!;
    const html = renderGuide(page.body, page.slug);
    for (const h of page.headings) expect(html).toContain(`id="${h.id}"`);
    expect(html).toContain('<button type="button" class="wos-guide-copy" data-copy>Copy</button>');
    expect(html).toContain('-w &quot;$(pbpaste)&quot;');
  });
});

describe('search', () => {
  it('finds the section that mentions every word, heading matches first', () => {
    const [first] = search('keychain token');
    expect(first.page.slug).toBe('troubleshooting');
    expect(first.heading?.id).toBe('keychain-tokens');
    expect(first.snippet.toLowerCase()).toContain('keychain');
  });

  it('finds nothing for an empty query or a word no page has', () => {
    expect(search('  ')).toEqual([]);
    expect(search('xylophone')).toEqual([]);
  });
});
