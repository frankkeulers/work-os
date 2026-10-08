import { CONFLUENCE_SCOPE_DEFAULTS, type Rule, type Settings } from '@work-os/shared';

// First-run settings (FR-1.1). Safe by default: dry-run on, so nothing is written to Confluence or
// the real vault until Frank turns it off. Confluence points at the PSG context tree in PRD.

export function defaultSettings(dataDir: string): Settings {
  return {
    dataDir,
    slack: { fetchMode: 'search', includeChannels: [], excludeChannels: [], customerChannels: [], vips: [] },
    schedule: { workHours: 'Mon–Fri 08:00–18:30', intervalWorkMinutes: 10, intervalOffMinutes: 60 },
    triage: { quietMinutes: 10, maxThreadsPerCall: 25, maxInputTokens: 40000, keepLastMessages: 3 },
    models: { triage: 'haiku-5.5', draftVault: 'sonnet-5.5', draftConfluence: 'sonnet-5.5' },
    claudeBackend: 'subscription',
    budgets: { triageCallsPerDay: 60, draftsPerDay: 10, costEquivalentPerDay: 2.5 },
    baselineCostPerDay: null,
    retentionDays: 30,
    vaultPath: '~/Obsidian',
    confluence: { siteUrl: 'https://pole-star.atlassian.net', spaceKey: 'PRD', ...CONFLUENCE_SCOPE_DEFAULTS, pages: [] },
    notifications: { enabled: true, quietHours: '19:00–08:00' },
    dryRun: true,
    schemaVersion: 1,
  };
}

export const DEFAULT_RULES: Rule[] = [
  { id: 'vip-dm', enabled: true, conditions: [{ type: 'is_dm' }, { type: 'sender_in', list: 'vips', values: [] }], outcome: { type: 'now' } },
  { id: 'mention-me', enabled: true, conditions: [{ type: 'mentions_me' }], outcome: { type: 'model', min: 'today' } },
  { id: 'exclude-channels', enabled: true, conditions: [{ type: 'channel_in', list: 'excludeChannels', values: [] }], outcome: { type: 'drop' } },
  { id: 'blockers', enabled: true, conditions: [{ type: 'keyword', pattern: '/blocked|go\\/no-go|urgent/i' }], outcome: { type: 'model', min: 'today' } },
  { id: 'customer-channels', enabled: false, conditions: [{ type: 'channel_in', list: 'customerChannels', values: [] }], outcome: { type: 'model', min: 'today' } },
];
