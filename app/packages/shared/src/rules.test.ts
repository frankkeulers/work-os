import { describe, expect, it } from 'vitest';
import { firstMatchingRule, type Me } from './rules';
import type { Item, Rule, Settings } from './schemas';

const ME: Me = { id: 'U01FRANK', mentionRe: /@frank\b/i };

// Rules only read the Slack lists from settings.
const settings = {
  slack: { fetchMode: 'search', includeChannels: [], excludeChannels: ['#random'], customerChannels: [], vips: ['Dana Lee'] },
} as unknown as Settings;

const item = (over: Partial<Item> = {}): Item => ({
  id: 'slack:C1:1',
  source: 'slack',
  kind: 'thread',
  title: '#product',
  permalink: 'https://example.slack.com/archives/C1/p1',
  participants: [
    { id: 'U01FRANK', name: 'Frank Keulers' },
    { id: 'U02DANA', name: 'Dana Lee' },
  ],
  messages: [{ id: 'm1', authorId: 'U02DANA', ts: '2026-10-05T08:00:00.000Z', text: 'Morning all' }],
  messageCount: 1,
  lastActivityAt: '2026-10-05T08:00:00.000Z',
  revision: 1,
  schemaVersion: 1,
  ...over,
});

const rule = (id: string, conditions: Rule['conditions'], outcome: Rule['outcome'] = { type: 'now' }, enabled = true): Rule => ({
  id,
  enabled,
  conditions,
  outcome,
});

const say = (authorId: string, text: string) => [{ id: 'm', authorId, ts: '2026-10-05T08:00:00.000Z', text }];

describe('firstMatchingRule (FR-4.1, FR-4.2)', () => {
  it('returns the first enabled rule whose conditions all match', () => {
    const rules = [
      rule('off', [{ type: 'is_dm' }], { type: 'now' }, false),
      rule('dm', [{ type: 'is_dm' }]),
      rule('dm-too', [{ type: 'is_dm' }], { type: 'today' }),
    ];
    expect(firstMatchingRule(item({ kind: 'dm' }), rules, settings, ME)?.id).toBe('dm');
  });

  it('needs every condition to match', () => {
    const rules = [rule('dm-in-product', [{ type: 'is_dm' }, { type: 'channel_in', values: ['#product'] }])];
    expect(firstMatchingRule(item({ kind: 'thread' }), rules, settings, ME)).toBeUndefined();
  });

  it('matches mentions as Slack <@id> markup or as plain text', () => {
    const rules = [rule('mention', [{ type: 'mentions_me' }])];
    expect(firstMatchingRule(item({ messages: say('U02DANA', 'cc <@U01FRANK>') }), rules, settings, ME)?.id).toBe('mention');
    expect(firstMatchingRule(item({ messages: say('U02DANA', 'over to @Frank') }), rules, settings, ME)?.id).toBe('mention');
    expect(firstMatchingRule(item({ messages: say('U02DANA', 'over to @frankie') }), rules, settings, ME)).toBeUndefined();
    expect(firstMatchingRule(item({ messages: say('U02DANA', 'cc @frank') }), rules, settings, { id: 'U01FRANK' })).toBeUndefined();
  });

  it('matches senders from a named list but never counts the user as a sender', () => {
    const rules = [rule('vip', [{ type: 'sender_in', list: 'vips', values: [] }])];
    expect(firstMatchingRule(item(), rules, settings, ME)?.id).toBe('vip');
    const meOnly = item({ participants: [{ id: 'U01FRANK', name: 'Dana Lee' }], messages: say('U01FRANK', 'note to self') });
    expect(firstMatchingRule(meOnly, rules, settings, ME)).toBeUndefined();
  });

  it('matches channels case-insensitively from a named list', () => {
    const rules = [rule('drop-random', [{ type: 'channel_in', list: 'excludeChannels', values: [] }], { type: 'drop' })];
    expect(firstMatchingRule(item({ title: '#Random' }), rules, settings, ME)?.id).toBe('drop-random');
  });

  it('matches keywords, with /pattern/flags or a case-insensitive plain pattern', () => {
    const rules = [rule('outage', [{ type: 'keyword', pattern: '/OUTAGE/' }]), rule('renewal', [{ type: 'keyword', pattern: 'renewal' }])];
    expect(firstMatchingRule(item({ messages: say('U02DANA', 'possible outage') }), rules, settings, ME)).toBeUndefined();
    expect(firstMatchingRule(item({ messages: say('U02DANA', 'OUTAGE in EU') }), rules, settings, ME)?.id).toBe('outage');
    expect(firstMatchingRule(item({ messages: say('U02DANA', 'Renewal due') }), rules, settings, ME)?.id).toBe('renewal');
  });

  it('leaves non-Slack items to the model', () => {
    const rules = [rule('any-dm', [{ type: 'is_dm' }])];
    expect(firstMatchingRule(item({ source: 'outlook', kind: 'dm' }), rules, settings, ME)).toBeUndefined();
  });
});
