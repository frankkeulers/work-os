import { describe, expect, it } from 'vitest';
import { firstMatchingRule, type Me } from './rules';
import { ruleSources, type Item, type Rule, type Settings } from './schemas';

const ME: Me = { id: 'U01FRANK', mentionRe: /@frank\b/i };

// Rules only read the named lists from settings: VIPs from People, channels from Slack.
const settings = {
  slack: { fetchMode: 'search', includeChannels: [], excludeChannels: ['#random'], customerChannels: [] },
  people: { vips: ['Dana Lee'] },
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

  it('leaves items from sources without rules to the model', () => {
    const rules = [rule('any', [{ type: 'keyword', pattern: 'renewal' }])];
    expect(firstMatchingRule(item({ source: 'wispr', kind: 'meeting', messages: say('U02DANA', 'Renewal due') }), rules, settings, ME)).toBeUndefined();
  });

  it('checks Outlook emails against the conditions that work on email', () => {
    const ME_MAIL: Me = { id: 'frank.keulers@polestarglobal.com' };
    const email = (from: string, name: string, text: string) =>
      item({
        id: 'outlook:AAQk1',
        source: 'outlook',
        kind: 'email',
        title: 'Renewal terms',
        participants: [
          { id: ME_MAIL.id, name: 'Frank Keulers' },
          { id: from, name },
        ],
        messages: say(from, text),
      });
    const vip = rule('vip', [{ type: 'sender_in', list: 'vips', values: [] }]);
    const kw = rule('renewal', [{ type: 'keyword', pattern: 'renewal' }], { type: 'today' });
    const dm = rule('any-dm', [{ type: 'is_dm' }]);
    expect(firstMatchingRule(email('dana.lee@example.com', 'Dana Lee', 'Hello'), [dm, vip], settings, ME_MAIL)?.id).toBe('vip');
    expect(firstMatchingRule(email('sam@example.com', 'Sam Ray', 'Renewal is due'), [dm, vip, kw], settings, ME_MAIL)?.id).toBe('renewal');
    expect(firstMatchingRule(email('sam@example.com', 'Sam Ray', 'Hello'), [dm, vip, kw], settings, ME_MAIL)).toBeUndefined();
    // Frank's own email never makes him a VIP sender.
    expect(firstMatchingRule(email(ME_MAIL.id, 'Dana Lee', 'Hello'), [vip], settings, ME_MAIL)).toBeUndefined();
  });

  it('skips a rule scoped to other sources', () => {
    const rules = [{ ...rule('teams-dm', [{ type: 'is_dm' }]), sources: ['teams' as const] }, rule('any-dm', [{ type: 'is_dm' }], { type: 'today' })];
    expect(firstMatchingRule(item({ kind: 'dm' }), rules, settings, ME)?.id).toBe('any-dm');
    expect(firstMatchingRule(item({ kind: 'dm' }), [{ ...rules[0], sources: ['teams', 'slack'] }], settings, ME)?.id).toBe('teams-dm');
  });
});

describe('ruleSources (sources)', () => {
  it('is every source for a rule without a scope whose conditions work everywhere', () => {
    expect(ruleSources(rule('k', [{ type: 'keyword', pattern: 'renewal' }]))).toEqual(['slack', 'outlook', 'teams', 'plaud', 'wispr']);
  });

  it('narrows to the sources every condition works on', () => {
    expect(ruleSources(rule('c', [{ type: 'keyword', pattern: 'x' }, { type: 'channel_in', values: ['#a'] }]))).toEqual(['slack', 'teams']);
    expect(ruleSources({ ...rule('c', [{ type: 'channel_in', values: ['#a'] }]), sources: ['outlook', 'slack'] })).toEqual(['slack']);
  });

  it('is empty when no chosen source supports every condition', () => {
    expect(ruleSources({ ...rule('c', [{ type: 'is_dm' }]), sources: ['outlook'] })).toEqual([]);
  });
});
