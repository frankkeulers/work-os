import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { Link, NavLink, Navigate, useLocation, useNavigate, useParams } from 'react-router';
import { HealthBanner } from '../components/HealthBanner';
import { Icon } from '../components/icons';
import { Kbd, cx } from '../components/ui';
import { GROUPS, PAGES, pageBySlug, search, type GuidePage, type SearchHit } from '../guide/pages';
import { renderGuide } from '../guide/render';
import { toast } from '../store/toasts';

// The user guide (FR-1.8). Laid out like Settings: the pages in groups on the left, the page as
// prose in the middle, and its sections on the right on wide screens. Content comes from
// app/docs/guide/*.md; see guide/pages.ts.

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement | null)?.closest?.('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], [data-no-shortcuts]');

const fmtUpdated = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** The matched words of a snippet, marked. */
function Highlight({ text, terms }: { text: string; terms: string[] }) {
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return (
    <>
      {text.split(re).map((part, i) =>
        i % 2 ? (
          <mark key={i} className="rounded-sm bg-accent-wash text-ink">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

const hitHref = (h: SearchHit) => `/guide/${h.page.slug}${h.heading ? `#${h.heading.id}` : ''}`;

function GuideSearch() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const hits = useMemo(() => search(query), [query]);
  const open = query.trim().length > 0;

  // / focuses search, as in most docs sites.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      input.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const go = (h: SearchHit | undefined) => {
    if (!h) return;
    setQuery('');
    input.current?.blur();
    navigate(hitHref(h));
  };
  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (hits.length) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(hits[active] ?? hits[0]);
    } else if (e.key === 'Escape') {
      setQuery('');
    }
  };

  return (
    <div className="relative w-full max-w-[320px]">
      <Icon name="search" size={15} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-label="Search the guide"
        aria-expanded={open}
        aria-controls="guide-search-results"
        aria-activedescendant={open && hits[active] ? `guide-hit-${active}` : undefined}
        placeholder="Search the guide"
        value={query}
        onChange={(e) => (setQuery(e.target.value), setActive(0))}
        onKeyDown={onKeyDown}
        className="min-h-9 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-8 text-sm text-ink outline-none focus:border-accent [&::-webkit-search-cancel-button]:hidden"
      />
      {!open && (
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">
          <Kbd>/</Kbd>
        </span>
      )}
      {open && (
        <div id="guide-search-results" role="listbox" aria-label="Search results" className="absolute right-0 top-[calc(100%+6px)] z-30 w-[440px] max-w-[calc(100vw-32px)] overflow-hidden rounded-xl border border-line bg-surface shadow-lg">
          {hits.length === 0 ? (
            <div className="px-4 py-3 text-[13px] text-muted">Nothing in the guide matches “{query.trim()}”.</div>
          ) : (
            hits.map((h, i) => (
              <Link
                key={hitHref(h) + i}
                id={`guide-hit-${i}`}
                role="option"
                aria-selected={i === active}
                to={hitHref(h)}
                onMouseEnter={() => setActive(i)}
                onClick={() => setQuery('')}
                className={cx('flex flex-col gap-0.5 border-b border-line-soft px-4 py-2.5 no-underline last:border-b-0', i === active ? 'bg-surface-2' : '')}
              >
                <span className="text-[13px] font-medium !text-ink">
                  {h.page.title}
                  {h.heading && <span className="font-normal text-muted"> › {h.heading.text}</span>}
                </span>
                {h.snippet && (
                  <span className="line-clamp-2 text-xs leading-normal text-ink-2">
                    <Highlight text={h.snippet} terms={h.terms} />
                  </span>
                )}
              </Link>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** The h2 nearest above the top of the page body (under the 64px top bar), for "On this page". */
function useCurrentSection(page: GuidePage, root: RefObject<HTMLElement | null>) {
  const [current, setCurrent] = useState<string | undefined>();
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      const hs = Array.from(root.current?.querySelectorAll<HTMLElement>('h2[id]') ?? []);
      let id = hs[0]?.id;
      for (const h of hs) if (h.getBoundingClientRect().top <= 64 + 120) id = h.id;
      setCurrent(id);
    };
    const onScroll = () => (frame ||= requestAnimationFrame(update));
    update();
    // The page body scrolls, not the window.
    const scroller = root.current?.closest('[data-page-scroll]');
    scroller?.addEventListener('scroll', onScroll, { passive: true });
    return () => (scroller?.removeEventListener('scroll', onScroll), cancelAnimationFrame(frame));
  }, [page, root]);
  return current;
}

function GuideBody({ page }: { page: GuidePage }) {
  const navigate = useNavigate();
  const { hash } = useLocation();
  const article = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderGuide(page.body, page.slug), [page]);
  const current = useCurrentSection(page, article);
  const index = PAGES.indexOf(page);
  const prev = PAGES[index - 1];
  const next = PAGES[index + 1];
  const toc = page.headings.filter((h) => h.depth === 2);

  useEffect(() => {
    document.title = `${page.title} · Guide · Work OS`;
  }, [page]);

  // A link to a heading lands on it; a new page starts at the top.
  useEffect(() => {
    const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
    if (target) target.scrollIntoView({ block: 'start' });
    else article.current?.closest('[data-page-scroll]')?.scrollTo(0, 0);
  }, [page, hash]);

  // Links in the Markdown are plain anchors; in-app ones navigate without a reload.
  const onClick = (e: MouseEvent) => {
    const el = e.target as HTMLElement;
    const copy = el.closest<HTMLButtonElement>('[data-copy]');
    if (copy) {
      const text = copy.parentElement?.querySelector('code')?.textContent ?? '';
      void navigator.clipboard?.writeText(text).then(
        () => {
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1500);
        },
        () => toast('Could not copy. Select the text instead.', { tone: 'error' }),
      );
      return;
    }
    const a = el.closest<HTMLAnchorElement>('a[data-internal]');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    navigate(a.getAttribute('href')!);
  };

  return (
    <>
      <div className="flex min-w-0 max-w-[720px] flex-1 flex-col" aria-label={page.title}>
        <div className="flex flex-col gap-1.5 border-b border-line pb-5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">{page.group}</span>
          <h2 className="m-0 text-2xl font-semibold tracking-[-0.015em]">{page.title}</h2>
          {page.summary && <p className="m-0 text-[15px] leading-normal text-ink-2">{page.summary}</p>}
          <span className="text-xs text-muted" data-testid="guide-updated">
            Updated {fmtUpdated(page.updated)}
          </span>
        </div>
        {/* Delegates clicks on the links and copy buttons inside, which have their own keys. */}
        <div ref={article} className="wos-guide pt-6" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
        <nav aria-label="Previous and next" className="mt-12 flex gap-4 border-t border-line pt-6">
          {prev && (
            <Link to={`/guide/${prev.slug}`} className="flex flex-1 flex-col gap-0.5 rounded-lg border border-line px-4 py-3 no-underline hover:border-line-strong">
              <span className="text-xs text-muted">Previous</span>
              <span className="text-sm font-medium !text-ink">← {prev.title}</span>
            </Link>
          )}
          {next ? (
            <Link to={`/guide/${next.slug}`} className="flex flex-1 flex-col items-end gap-0.5 rounded-lg border border-line px-4 py-3 text-right no-underline hover:border-line-strong">
              <span className="text-xs text-muted">Next</span>
              <span className="text-sm font-medium !text-ink">{next.title} →</span>
            </Link>
          ) : (
            <span className="flex-1" />
          )}
        </nav>
      </div>
      {toc.length > 0 && (
        <nav aria-label="On this page" className="sticky top-8 hidden w-[200px] shrink-0 flex-col gap-0.5 xl:flex">
          <span className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">On this page</span>
          {toc.map((h) => (
            <Link
              key={h.id}
              to={`#${h.id}`}
              aria-current={current === h.id ? 'location' : undefined}
              className={cx('border-l-2 py-1 pl-3 text-[13px] leading-snug no-underline', current === h.id ? 'border-accent font-medium !text-ink' : 'border-transparent !text-muted hover:!text-ink')}
            >
              {h.text}
            </Link>
          ))}
        </nav>
      )}
    </>
  );
}

export function GuidePage() {
  const { page: slug } = useParams();
  const page = pageBySlug(slug);
  if (!page) return <Navigate replace to={`/guide/${PAGES[0].slug}`} />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      {/* 64px, like the other top bars, lined up with the sidebar's header. It stays put; the body below scrolls. */}
      <header className="flex h-16 shrink-0 items-center border-b border-line px-8">
        <div className="flex max-w-[1240px] flex-1 items-center gap-x-6">
          <h1 className="m-0 flex-1 text-xl font-semibold tracking-[-0.01em]">Guide</h1>
          <GuideSearch />
        </div>
      </header>
      <div data-page-scroll className="min-h-0 flex-1 overflow-y-auto">
        <div className="max-w-[1304px] px-8 pt-6 empty:hidden">
          <HealthBanner />
        </div>
        <div className="flex max-w-[1304px] items-start gap-12 px-8 pb-24 pt-8">
          <nav aria-label="Guide pages" className="sticky top-8 flex w-[200px] shrink-0 flex-col gap-6">
            {GROUPS.map((g) => (
              <div key={g} className="flex flex-col gap-0.5">
                <span className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.07em] text-muted">{g}</span>
                {PAGES.filter((p) => p.group === g).map((p) => (
                  <NavLink
                    key={p.slug}
                    to={`/guide/${p.slug}`}
                    className={({ isActive }) => cx('flex min-h-9 items-center rounded-md px-3 text-sm no-underline', isActive ? 'bg-track font-medium !text-ink' : '!text-ink-2 hover:bg-surface-2 hover:!text-ink')}
                  >
                    {p.title}
                  </NavLink>
                ))}
              </div>
            ))}
          </nav>
          <GuideBody page={page} />
        </div>
      </div>
    </div>
  );
}
