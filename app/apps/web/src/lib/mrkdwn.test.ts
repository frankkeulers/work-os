import { describe, expect, it } from 'vitest';
import { parseInline, parseMrkdwn } from './mrkdwn';

describe('mrkdwn', () => {
  it('parses bold, italic, strike and code, only at word boundaries', () => {
    expect(parseInline('*Merge* it _now_, ~not~ `main`')).toEqual([
      { t: 'b', children: [{ t: 'text', text: 'Merge' }] },
      { t: 'text', text: ' it ' },
      { t: 'i', children: [{ t: 'text', text: 'now' }] },
      { t: 'text', text: ', ' },
      { t: 's', children: [{ t: 'text', text: 'not' }] },
      { t: 'text', text: ' ' },
      { t: 'code', text: 'main' },
    ]);
    expect(parseInline('snake_case_name and 2*3*4')).toEqual([{ t: 'text', text: 'snake_case_name and 2*3*4' }]);
  });

  it('nests formatting', () => {
    expect(parseInline('_What we *tested* first_')).toEqual([
      { t: 'i', children: [{ t: 'text', text: 'What we ' }, { t: 'b', children: [{ t: 'text', text: 'tested' }] }, { t: 'text', text: ' first' }] },
    ]);
  });

  it('reads mentions, channels, specials and links, and decodes entities', () => {
    expect(parseInline('Hi <@U08QM>, <@U02|sam> in <#C1|api-dev> <!here> <!subteam^S1|@product>')).toEqual([
      { t: 'text', text: 'Hi ' },
      { t: 'user', id: 'U08QM', label: undefined },
      { t: 'text', text: ', ' },
      { t: 'user', id: 'U02', label: 'sam' },
      { t: 'text', text: ' in ' },
      { t: 'tag', text: '#api-dev' },
      { t: 'text', text: ' ' },
      { t: 'tag', text: '@here' },
      { t: 'text', text: ' ' },
      { t: 'tag', text: '@product' },
    ]);
    expect(parseInline('PR <https://github.com/x/pull/61|#61> &amp; <https://a.io/p_q_r> &lt;b&gt;')).toEqual([
      { t: 'text', text: 'PR ' },
      { t: 'link', href: 'https://github.com/x/pull/61', text: '#61' },
      { t: 'text', text: ' & ' },
      { t: 'link', href: 'https://a.io/p_q_r', text: 'https://a.io/p_q_r' },
      { t: 'text', text: ' <b>' },
    ]);
    expect(parseInline('<javascript:alert(1)|click>')).toEqual([{ t: 'text', text: 'click' }]);
  });

  it('turns known emoji shortcodes into emoji and leaves others', () => {
    expect(parseInline(':white_check_mark: done :warning::skin-tone-2: :partyparrot:')).toEqual([{ t: 'text', text: '✅ done ⚠️ :partyparrot:' }]);
  });

  it('keeps line breaks and groups quotes and code blocks', () => {
    expect(parseMrkdwn('One\n• two\n&gt; quoted\n&gt; more\n```a *b*\nc```\nend')).toEqual([
      { t: 'p', lines: [[{ t: 'text', text: 'One' }], [{ t: 'text', text: '• two' }]] },
      { t: 'quote', lines: [[{ t: 'text', text: 'quoted' }], [{ t: 'text', text: 'more' }]] },
      { t: 'pre', text: 'a *b*\nc' },
      { t: 'p', lines: [[{ t: 'text', text: 'end' }]] },
    ]);
  });
});
