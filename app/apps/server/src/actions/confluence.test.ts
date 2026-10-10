import type { ConfluenceDraft } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { memoryKeychain, CONFLUENCE_TOKEN_ACCOUNT } from '../config/keychain';
import { ConfluenceApi, ConfluenceError } from './confluenceApi';
import { marker, planConfluenceWrite } from './confluenceExecutor';
import { buildCatalogue, inScope, scopeCql, type ConfluenceScope } from './confluenceCatalogue';
import { FAKE_CONFLUENCE_CREDS, FakeConfluence, parseCql } from './fakeConfluence';
import { entryStorage, inline, markdownToStorage } from './markdown';
import { findOnPages } from './alreadyFiled';
import { findHeading, headings, insertIntoSection, outline, sectionsLinking, textOf } from './storage';

// Confluence filing against a fake Confluence (FR-10.3, FR-10.5, FR-10.6, FR-14.5). Never the real site.

const PAGE = '<h1>MVI V2</h1><p>Requirements.</p><h2>Decisions</h2><ul><li>Bulk export first.</li></ul><h3>Detail</h3><p>x</p><h2>Open questions</h2><p>Pricing &amp; tiers.</p>';
const SCOPE: ConfluenceScope = { siteUrl: 'https://fake.atlassian.net', spaceKey: 'MVI', roots: [{ id: '1100000', title: 'MVI Context' }], labels: [], exclude: [], pages: [] };
const tree = (fc = new FakeConfluence()) => fc.page('1100000', 'MVI Context', '<p>Index</p>').page('1234567', 'MVI V2 PRD', PAGE, 7, { parent: '1100000' });
const api = (fc: FakeConfluence, creds = FAKE_CONFLUENCE_CREDS) => new ConfluenceApi(memoryKeychain({ [CONFLUENCE_TOKEN_ACCOUNT]: creds }), () => 'https://fake.atlassian.net/', fc.fetch);
const draft = (over: Partial<ConfluenceDraft> = {}): ConfluenceDraft => ({
  kind: 'confluence',
  pageId: '1234567',
  pageTitle: 'MVI V2 PRD',
  section: 'Decisions',
  baseVersion: 7,
  title: 'Licence wording',
  content: 'Agreed with **legal**.\n\n- Use the 2026 wording',
  model: 'sonnet-5.5',
  promptVersion: 'draft-confluence v1#0',
  durationMs: 1,
  tokens: 1,
  edited: false,
  ...over,
});

describe('storage format', () => {
  it('outlines a page and inserts at the end of a section, after its subsections', () => {
    expect(headings(PAGE).map((h) => `${h.level}:${h.text}`)).toEqual(['1:MVI V2', '2:Decisions', '3:Detail', '2:Open questions']);
    expect(outline(PAGE)[3]).toEqual({ level: 2, heading: 'Open questions', excerpt: 'Pricing & tiers.' });
    const out = insertIntoSection(PAGE, 'decisions', '<p>NEW</p>')!;
    expect(out).toContain('<p>x</p><p>NEW</p><h2>Open questions</h2>');
    expect(insertIntoSection(PAGE, 'Nope', 'x')).toBeUndefined();
    expect(textOf('<p>a&nbsp;&lt;b&gt; &#65;</p>')).toBe('a <b> A');
  });
});

describe('what a page already holds (FR-10.7)', () => {
  const THREAD = 'https://psg.slack.com/archives/C01PROD/p1728031234000100?thread_ts=1728031234.000100&cid=C01PROD';
  const LONG = `<h2>Decisions</h2><p>${'Older entry. '.repeat(60)}</p><p>Latest: bulk export ships first.</p><h2>Log</h2>`;

  it('shows the start and the end of a long section, where the latest entries are', () => {
    const ex = outline(LONG)[0].excerpt;
    expect(ex.startsWith('Older entry. Older entry.')).toBe(true);
    expect(ex).toContain('… ');
    expect(ex.endsWith('Latest: bulk export ships first.')).toBe(true);
    expect(ex.length).toBeLessThanOrEqual(600);
  });

  it('finds the section holding the thread’s link, with & escaped as storage writes it', () => {
    const page = `<h1>MVI V2</h1><h2>Decisions</h2><p>Bulk export first. (Tier B, 2026-10-07, <a href="${THREAD.replaceAll('&', '&amp;')}">#product thread</a>)</p><h3>Detail</h3><p>x</p><h2>Open questions</h2><p>Pricing?</p>`;
    expect(sectionsLinking(page, [THREAD])).toEqual([{ heading: 'Decisions', text: 'Bulk export first. (Tier B, 2026-10-07, #product thread ) Detail x' }]);
    expect(sectionsLinking(page, ['https://psg.slack.com/archives/C01PROD/p999'])).toEqual([]);
    // The nearest heading above the link: a link under a subsection belongs to it.
    expect(sectionsLinking(`<h2>Decisions</h2><h3>Export</h3><p><a href="${THREAD}">t</a></p>`, [THREAD]).map((x) => x.heading)).toEqual(['Export']);
  });

  it('lists every picked page’s sections that link to any piece of the topic', () => {
    const pages = [
      { id: '1', title: 'MVI V2 PRD', version: 3, versionMessage: '', storage: `<h2>Decisions</h2><p><a href="https://x/a">a</a></p><h2>Log</h2><p><a href="https://x/b">b</a></p>` },
      { id: '2', title: 'Insights', version: 9, versionMessage: '', storage: '<h2>Decisions</h2><p>Nothing linked.</p>' },
    ];
    expect(findOnPages(pages, ['https://x/a', 'https://x/b']).map((f) => [f.pageId, f.section])).toEqual([['1', 'Decisions'], ['1', 'Log']]);
    expect(findOnPages(pages, [])).toEqual([]);
  });
});

describe('headings with entities, as Confluence writes them', () => {
  // From DP - Customer & Prospect Signals: the model copied the heading with a real dash.
  const SIGNALS =
    '<h2>Per-account signals</h2><h3>Qatar Ministry of Transport and Communications &mdash; Customer (June 2026)</h3><p>Uses MVI.</p>' +
    '<h3>Valpara&iacute;so Port Authority (Chile) &mdash; Prospect</h3><p>RFP.</p><h3>Seward &amp; Kissel&rsquo;s view</h3><p>x</p><h2>Page log</h2>';

  it('decodes named, accented and numeric entities', () => {
    expect(textOf('a&mdash;b &ndash; &iacute;&Uuml;&ccedil;&scaron; &rsquo;&hellip; &#8212;&#x2014; &bogus;')).toBe('a—b – íÜçš ’… —— &bogus;');
    expect(outline(SIGNALS)[1].heading).toBe('Qatar Ministry of Transport and Communications — Customer (June 2026)');
  });

  it('finds a section whatever dash, quote, space or case the model wrote', () => {
    expect(findHeading(SIGNALS, 'Qatar Ministry of Transport and Communications — Customer (June 2026)')?.level).toBe(3);
    expect(findHeading(SIGNALS, 'qatar ministry of transport and communications - customer (june 2026)')).toBeDefined();
    expect(findHeading(SIGNALS, 'Valparaíso Port Authority (Chile) – Prospect')).toBeDefined();
    expect(findHeading(SIGNALS, "Seward & Kissel's view")).toBeDefined();
    expect(findHeading(SIGNALS, 'Qatar Ministry — Prospect')).toBeUndefined();
    const out = insertIntoSection(SIGNALS, 'Qatar Ministry of Transport and Communications - Customer (June 2026)', '<h4>New</h4>')!;
    expect(out).toContain('<p>Uses MVI.</p><h4>New</h4><h3>Valpara');
  });
});

describe('markdown to storage', () => {
  it('converts the safe subset and escapes everything else', () => {
    expect(markdownToStorage('Hello **bold** and *it* `c`\nsame para\n\n- one\n- [two](https://x.test/a?b=1&c=2)\n\n1. first')).toBe(
      '<p>Hello <strong>bold</strong> and <em>it</em> <code>c</code> same para</p><ul><li>one</li><li><a href="https://x.test/a?b=1&amp;c=2">two</a></li></ul><ol><li>first</li></ol>',
    );
    expect(inline('<ac:structured-macro ac:name="x"/> [bad](javascript:alert(1))')).toBe('&lt;ac:structured-macro ac:name=&quot;x&quot;/&gt; [bad](javascript:alert(1))');
  });

  it('puts the entry title one level below the section and keeps its headings below that', () => {
    expect(entryStorage('T <1>', '# Big\ntext', 2)).toBe('<h3>T &lt;1&gt;</h3><h4>Big</h4><p>text</p>');
  });
});

describe('executor reconciliation (FR-10.5, FR-14.5)', () => {
  it('writes version + 1 when the page is as drafted, then recognises its own write by the marker', async () => {
    const fc = tree();
    const plan = await planConfluenceWrite(api(fc), SCOPE, 'act-1', draft());
    if (plan.kind !== 'write') throw new Error(plan.kind);
    expect(plan.version).toBe(8);
    expect(plan.storage).toContain('<h3>Licence wording</h3><p>Agreed with <strong>legal</strong>.</p><ul><li>Use the 2026 wording</li></ul><h2>Open questions</h2>');
    await api(fc).updatePage({ id: '1234567', title: plan.page.title, storage: plan.storage, version: plan.version, message: marker('act-1') });
    // A crash after the save and before action.executed: the retry sees its own marker.
    expect(await planConfluenceWrite(api(fc), SCOPE, 'act-1', draft())).toMatchObject({ kind: 'already', version: 8 });
    // Another action drafted from v7 now conflicts.
    expect(await planConfluenceWrite(api(fc), SCOPE, 'act-2', draft())).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/v7 → v8/) });
  });

  it('re-drafts when someone else edited the page, refuses pages out of scope, and handles a deleted page', async () => {
    const fc = tree();
    fc.edit('1234567', PAGE.replace('Requirements', 'Updated requirements'));
    expect(await planConfluenceWrite(api(fc), SCOPE, 'act-1', draft())).toMatchObject({ kind: 'conflict' });
    const excluded = { ...SCOPE, exclude: [{ id: '1234567', title: 'MVI V2 PRD' }] };
    expect(await planConfluenceWrite(api(fc), excluded, 'act-1', draft())).toMatchObject({ kind: 'refused', message: expect.stringMatching(/not in the Confluence scope/) });
    expect(fc.calls).toHaveLength(1); // refused before reading anything
    // In scope when the search ran, gone by the time the page is read.
    fc.page('1300000', 'Gone soon', PAGE, 3, { parent: '1100000' });
    const real = fc.fetch;
    fc.fetch = async (url, init) => {
      if (url.includes('/api/v2/pages/1300000')) fc.pages.delete('1300000');
      return real(url, init);
    };
    expect(await planConfluenceWrite(api(fc), SCOPE, 'act-1', draft({ pageId: '1300000' }))).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/no longer exists/) });
  });

  it('never treats a failed scope check as in scope', async () => {
    const fc = tree();
    fc.failNext.push(503);
    await expect(planConfluenceWrite(api(fc), SCOPE, 'act-1', draft())).rejects.toMatchObject({ failure: { state: 'degraded' } });
    expect(fc.calls).toHaveLength(0);
  });

  it('classifies failures: a 409 race, bad credentials, a dropped connection', async () => {
    const fc = tree();
    const err = (p: Promise<unknown>) =>
      p.then(
        () => undefined,
        (e: ConfluenceError) => e,
      );
    const race = await err(api(fc).updatePage({ id: '1234567', title: 't', storage: 's', version: 9, message: 'm' }));
    expect(race).toMatchObject({ conflict: true });
    expect((await err(api(fc, 'frank@example.com:wrong').getPage('1234567')))?.failure).toMatchObject({ state: 'auth_failed' });
    expect((await err(api(fc, 'no-colon').getPage('1234567')))?.failure).toMatchObject({ state: 'auth_failed', reason: 'token_missing' });
    fc.dropNext = true;
    expect((await err(api(fc).getPage('1234567')))?.failure).toMatchObject({ needsProbe: true });
  });
});

describe('the live catalogue (FR-10.2)', () => {
  // A small PSG-like tree: two BU roots with pages, an index with children, a labelled shared page
  // elsewhere in the space, an archive and a page nobody asked for.
  const psg = () =>
    new FakeConfluence('PRD')
      .page('10', 'Data Products', '<p>i</p>')
      .page('11', 'DP - Pricing', PAGE, 1, { parent: '10', labels: ['psg-context', 'psg-bu-dp'] })
      .page('12', 'Meridia Context', '<p>router</p>', 1, { parent: '10' })
      .page('13', 'Meridia — Fleets', PAGE, 1, { parent: '12' })
      .page('14', 'Archive', '<p>a</p>', 1, { parent: '10' })
      .page('15', 'Old pricing', PAGE, 1, { parent: '14' })
      .page('20', 'Defence', '<p>i</p>')
      .page('21', 'DEF - Pricing', PAGE, 1, { parent: '20' })
      .page('30', 'Shared', '<p>s</p>')
      .page('31', 'Data Assets & Licensing', PAGE, 1, { parent: '30', labels: ['psg-shared-data-assets'] })
      .page('40', 'Team offsite notes', PAGE);
  const scope: ConfluenceScope = {
    siteUrl: 'https://fake.atlassian.net',
    spaceKey: 'PRD',
    roots: [
      { id: '10', title: 'DP' },
      { id: '20', title: 'DEF' },
    ],
    labels: ['psg-shared-data-assets'],
    exclude: [{ id: '14', title: 'Archive' }],
    pages: [],
  };

  it('writes the CQL the skill uses, and nothing when nothing is configured', () => {
    expect(scopeCql(scope)).toBe(
      'space = "PRD" AND type = page AND (id in (10,20) OR ancestor in (10,20) OR label in ("psg-shared-data-assets")) AND id not in (14) AND ancestor not in (14)',
    );
    expect(scopeCql({ ...scope, roots: [], labels: [], pages: [{ id: '99', title: 'x' }], exclude: [] })).toBe('space = "PRD" AND type = page AND (id in (99))');
    expect(scopeCql({ ...scope, roots: [], labels: [] })).toBeNull();
    expect(scopeCql({ ...scope, spaceKey: 'A"B' })).toMatch(/^space = "A\\"B"/);
  });

  it('lists every root, page below a root and labelled page, minus the excluded subtree, with paths and hubs', async () => {
    const cat = await buildCatalogue(api(psg()), scope);
    expect(cat.map((c) => [c.id, c.path, c.hub, c.rootId ?? '-'])).toEqual([
      ['10', 'Data Products', true, '10'],
      ['11', 'Data Products › DP - Pricing', false, '10'],
      ['12', 'Data Products › Meridia Context', true, '10'],
      ['13', 'Data Products › Meridia Context › Meridia — Fleets', false, '10'],
      ['20', 'Defence', true, '20'],
      ['21', 'Defence › DEF - Pricing', false, '20'],
      ['31', 'Shared › Data Assets & Licensing', false, '-'],
    ]);
    expect(cat.find((c) => c.id === '11')).toMatchObject({ labels: ['psg-bu-dp', 'psg-context'], ancestorIds: ['10'] });
  });

  it('follows the search’s result pages', async () => {
    const fc = psg();
    fc.pageSize = 2;
    expect(await buildCatalogue(api(fc), scope)).toHaveLength(7);
  });

  it('checks one page against the scope as it is now', async () => {
    const fc = psg();
    expect(await inScope(api(fc), scope, '13')).toBe(true);
    expect(await inScope(api(fc), scope, '15')).toBe(false); // under the archive
    expect(await inScope(api(fc), scope, '40')).toBe(false); // not under a root, no label
    expect(await inScope(api(fc), scope, '1 OR 1=1')).toBe(false); // never reaches CQL
    expect(await inScope(api(fc), { ...scope, exclude: [{ id: '12', title: 'Meridia Context' }] }, '13')).toBe(false);
  });

  it('says so when Confluence answers as an anonymous user, instead of reporting an empty catalogue', async () => {
    const fc = psg();
    fc.anonymous = true;
    await expect(buildCatalogue(api(fc), scope)).rejects.toMatchObject({ failure: { state: 'auth_failed', reason: 'token_rejected' } });
  });

  it('parses the CQL it needs, and rejects what it does not know', () => {
    const ctx = { id: '5', page: { title: '', version: 1, message: '', storage: '', labels: ['a'] }, space: 'PRD', ancestors: [{ id: '1' }] };
    expect(parseCql('space = "PRD" AND (label = a OR id = 9) AND NOT ancestor in (2,3)')(ctx)).toBe(true);
    expect(parseCql('id != 5 OR label not in ("a")')(ctx)).toBe(false);
    expect(() => parseCql('title ~ "x"')).toThrow(/unknown/);
  });
});
