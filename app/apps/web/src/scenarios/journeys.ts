import type { MockControls } from '../mock/controls';
import { usePrefs } from '../store/prefs';

// Start points for JOURNEYS.md. Each start resets the demo data, sets up the scenario and returns a path.
export interface Journey {
  id: string;
  title: string;
  group: string;
  start: (c: MockControls) => string;
}

const item = (c: MockControls, key: string, query = '') => `/item/${encodeURIComponent(c.itemIdForKey(key) ?? '')}${query}`;
const fresh = (c: MockControls, preset?: Parameters<MockControls['reset']>[0]) => c.reset(preset);
const later = (fn: () => void, ms = 1500) => setTimeout(fn, ms);

export const JOURNEYS: Journey[] = [
  { id: 'J01', group: 'Inbox basics', title: 'Morning scan', start: (c) => (fresh(c), '/') },
  { id: 'J02', group: 'Inbox basics', title: 'Done and Undo', start: (c) => (fresh(c), '/') },
  { id: 'J03', group: 'Inbox basics', title: 'Snooze and return', start: (c) => (fresh(c), '/') },
  { id: 'J04', group: 'Inbox basics', title: 'Correct triage in the panel', start: (c) => (fresh(c), '/') },
  { id: 'J05', group: 'Inbox basics', title: 'Correct triage in detail', start: (c) => (fresh(c), item(c, 't2')) },
  { id: 'J06', group: 'Inbox basics', title: 'Keyboard triage', start: (c) => (fresh(c), '/') },
  { id: 'J07', group: 'Vault', title: 'New vault note', start: (c) => (fresh(c), item(c, 'f4')) },
  { id: 'J08', group: 'Vault', title: 'Append with edit', start: (c) => (fresh(c), item(c, 't1')) },
  { id: 'J09', group: 'Vault', title: 'Vault conflict', start: (c) => (fresh(c), c.setNextDraftOutcome('vault_conflict'), item(c, 'f1', '?tab=vault')) },
  { id: 'J10', group: 'Confluence', title: 'Happy path', start: (c) => (fresh(c), item(c, 'f1')) },
  { id: 'J11', group: 'Confluence', title: 'Blocked: people observations', start: (c) => (fresh(c), item(c, 't4')) },
  { id: 'J12', group: 'Confluence', title: 'Blocked: people check', start: (c) => (fresh(c), c.setNextDraftOutcome('people_check'), item(c, 't2')) },
  { id: 'J13', group: 'Confluence', title: 'Version conflict', start: (c) => (fresh(c), c.setNextDraftOutcome('confluence_conflict'), item(c, 't2')) },
  { id: 'J14', group: 'Confluence', title: 'Allow-list refusal', start: (c) => (fresh(c), item(c, 'f2')) },
  { id: 'J15', group: 'Confluence', title: 'Discard and re-draft', start: (c) => (fresh(c), item(c, 'f1')) },
  { id: 'J16', group: 'Confluence', title: 'Draft ready while away', start: (c) => (fresh(c), '/') },
  { id: 'J17', group: 'Polling', title: 'New Now item → notification', start: (c) => (fresh(c), later(() => c.simulatePoll('vip_dm')), '/') },
  { id: 'J18', group: 'Polling', title: 'Quiet hours', start: (c) => (fresh(c), c.setClockLondon('19:30'), later(() => c.simulatePoll('vip_dm')), '/') },
  { id: 'J19', group: 'Polling', title: 'Quiet window and batch', start: (c) => (fresh(c), '/') },
  { id: 'J20', group: 'Polling', title: 'Nothing eligible', start: (c) => (fresh(c), later(() => c.simulatePoll('nothing'), 800), '/') },
  { id: 'J21', group: 'Polling', title: 'Revision collisions', start: (c) => (fresh(c), '/') },
  { id: 'J22', group: 'Polling', title: 'Wake from sleep', start: (c) => (fresh(c), later(() => c.wakeFromSleep(), 1200), '/') },
  { id: 'J23', group: 'Polling', title: 'Failed triage → retry', start: (c) => (fresh(c), '/') },
  { id: 'J24', group: 'Budgets & health', title: 'Triage budget hit', start: (c) => (fresh(c), c.setFlag('triage_budget'), '/') },
  { id: 'J25', group: 'Budgets & health', title: 'Drafts budget hit', start: (c) => (fresh(c), c.setFlag('drafts_budget'), '/') },
  { id: 'J26', group: 'Budgets & health', title: 'Slack failing', start: (c) => (fresh(c), c.setFlag('slack_429'), '/') },
  { id: 'J27', group: 'Budgets & health', title: 'Usage check', start: (c) => (fresh(c), '/') },
  { id: 'J28', group: 'Budgets & health', title: 'No baseline', start: (c) => (fresh(c, 'noBaseline'), '/usage') },
  { id: 'J29', group: 'Budgets & health', title: 'Run eval', start: (c) => (fresh(c), '/usage') },
  { id: 'J30', group: 'Settings', title: 'Edit rules', start: (c) => (fresh(c), '/settings/rules') },
  { id: 'J31', group: 'Settings', title: 'Edit settings', start: (c) => (fresh(c), '/settings/slack') },
  { id: 'J32', group: 'Settings', title: 'Dry-run', start: (c) => (fresh(c), '/settings/writing#dry-run') },
  { id: 'J33', group: 'Settings', title: 'Rebuild state', start: (c) => (fresh(c), '/settings/storage') },
  { id: 'J34', group: 'Settings', title: 'Theme and scope', start: (c) => (fresh(c), '/settings/rules') },
  { id: 'J35', group: 'Failure & empty', title: 'Unreachable', start: (c) => (fresh(c), c.setFlag('server_down'), '/') },
  { id: 'J36', group: 'Failure & empty', title: 'Startup failures', start: (c) => (fresh(c), c.setFlag('api_key'), '/') },
  { id: 'J37', group: 'Failure & empty', title: 'First run', start: (c) => (fresh(c, 'firstRun'), '/') },
  { id: 'J38', group: 'Failure & empty', title: 'Inbox zero', start: (c) => (fresh(c, 'inboxZero'), '/') },
  { id: 'J39', group: 'Failure & empty', title: 'Retention-expired item', start: (c) => (fresh(c), item(c, 'd2')) },
  {
    id: 'J40',
    group: 'Inbox basics',
    title: 'Outlook and Teams (P2)',
    start: (c) => (fresh(c), usePrefs.getState().setScope('full'), `/?item=${encodeURIComponent(c.itemIdForKey('o1') ?? '')}`),
  },
];
