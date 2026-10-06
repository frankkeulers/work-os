import type { ConfluenceDraft } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { memoryKeychain, CONFLUENCE_TOKEN_ACCOUNT } from '../config/keychain';
import { ConfluenceApi, ConfluenceError } from './confluenceApi';
import { marker, planConfluenceWrite } from './confluenceExecutor';
import { FAKE_CONFLUENCE_CREDS, FakeConfluence } from './fakeConfluence';
import { entryStorage, inline, markdownToStorage } from './markdown';
import { headings, insertIntoSection, outline, textOf } from './storage';

// Confluence filing against a fake Confluence (FR-10.3, FR-10.5, FR-10.6, FR-14.5). Never the real site.

const PAGE = '<h1>MVI V2</h1><p>Requirements.</p><h2>Decisions</h2><ul><li>Bulk export first.</li></ul><h3>Detail</h3><p>x</p><h2>Open questions</h2><p>Pricing &amp; tiers.</p>';
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
    const fc = new FakeConfluence().page('1234567', 'MVI V2 PRD', PAGE, 7);
    const plan = await planConfluenceWrite(api(fc), ['1234567'], 'act-1', draft());
    if (plan.kind !== 'write') throw new Error(plan.kind);
    expect(plan.version).toBe(8);
    expect(plan.storage).toContain('<h3>Licence wording</h3><p>Agreed with <strong>legal</strong>.</p><ul><li>Use the 2026 wording</li></ul><h2>Open questions</h2>');
    await api(fc).updatePage({ id: '1234567', title: plan.page.title, storage: plan.storage, version: plan.version, message: marker('act-1') });
    // A crash after the save and before action.executed: the retry sees its own marker.
    expect(await planConfluenceWrite(api(fc), ['1234567'], 'act-1', draft())).toMatchObject({ kind: 'already', version: 8 });
    // Another action drafted from v7 now conflicts.
    expect(await planConfluenceWrite(api(fc), ['1234567'], 'act-2', draft())).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/v7 → v8/) });
  });

  it('re-drafts when someone else edited the page, refuses pages off the allow-list, and handles a deleted page', async () => {
    const fc = new FakeConfluence().page('1234567', 'MVI V2 PRD', PAGE, 7);
    fc.edit('1234567', PAGE.replace('Requirements', 'Updated requirements'));
    expect(await planConfluenceWrite(api(fc), ['1234567'], 'act-1', draft())).toMatchObject({ kind: 'conflict' });
    expect(await planConfluenceWrite(api(fc), ['7654321'], 'act-1', draft())).toMatchObject({ kind: 'refused', message: expect.stringMatching(/not on the Confluence allow-list/) });
    expect(fc.calls).toHaveLength(1); // refused before reading anything
    expect(await planConfluenceWrite(api(fc), ['9999999'], 'act-1', draft({ pageId: '9999999' }))).toMatchObject({ kind: 'conflict', message: expect.stringMatching(/no longer exists/) });
  });

  it('classifies failures: a 409 race, bad credentials, a dropped connection', async () => {
    const fc = new FakeConfluence().page('1234567', 'MVI V2 PRD', PAGE, 7);
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
