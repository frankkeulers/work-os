import type { Rule, Settings } from '@work-os/shared';

// Matches the Settings & rules artboard. Dry-run is on by default in development (FR-1.6).
export const SEED_SETTINGS: Settings = {
  dataDir: '~/WorkOS-data',
  slack: {
    fetchMode: 'search',
    includeChannels: [],
    excludeChannels: ['#random', '#alerts-prod', '#social'],
    customerChannels: ['#ext-pilot-alpha', '#ext-pilot-bravo'],
    vips: ['Matt M.', 'VP Engineering'],
  },
  schedule: { workHours: 'Mon–Fri 08:00–18:30', intervalWorkMinutes: 10, intervalOffMinutes: 60 },
  triage: { quietMinutes: 10, maxThreadsPerCall: 25, maxInputTokens: 40000, keepLastMessages: 3 },
  models: { triage: 'haiku-4.5', draftVault: 'sonnet-5.5', draftConfluence: 'sonnet-5.5' },
  claudeBackend: 'subscription',
  budgets: { triageCallsPerDay: 60, draftsPerDay: 10, costEquivalentPerDay: 2.5 },
  baselineCostPerDay: 1.9,
  retentionDays: 30,
  vaultPath: '~/Obsidian/PSG Vault',
  confluence: {
    siteUrl: 'https://pole-star.atlassian.net',
    spaceKey: 'PRD',
    pages: [
      { title: 'Insights APIs › Decisions', id: '39004512' },
      { title: 'Meridia › Context: Decisions', id: '40217733' },
      { title: 'Pole Star Labs › Graduation gate', id: '41120987' },
    ],
  },
  notifications: { enabled: true, quietHours: '19:00–08:00' },
  dryRun: true,
  schemaVersion: 1,
};

export const SEED_RULES: Rule[] = [
  { id: 'vip-dm', enabled: true, conditions: [{ type: 'is_dm' }, { type: 'sender_in', list: 'vips', values: [] }], outcome: { type: 'now' } },
  { id: 'mention-me', enabled: true, conditions: [{ type: 'mentions_me' }], outcome: { type: 'model', min: 'today' } },
  { id: 'exclude-channels', enabled: true, conditions: [{ type: 'channel_in', list: 'excludeChannels', values: [] }], outcome: { type: 'drop' } },
  { id: 'blockers', enabled: true, conditions: [{ type: 'keyword', pattern: '/blocked|go\\/no-go|urgent/i' }], outcome: { type: 'model', min: 'today' } },
  { id: 'customer-channels', enabled: false, conditions: [{ type: 'channel_in', list: 'customerChannels', values: [] }], outcome: { type: 'model', min: 'today' } },
];

export const SEED_RULE_HITS: Record<string, number> = {
  'vip-dm': 3,
  'mention-me': 9,
  'exclude-channels': 41,
  blockers: 1,
  'customer-channels': 0,
};
