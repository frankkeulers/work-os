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
  { id: 'J11', group: 'Confluence', title: 'People mentioned: anonymised draft', start: (c) => (fresh(c), item(c, 't4')) },
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
    title: 'Teams (P2)',
    start: (c) => (fresh(c), usePrefs.getState().setScope('full'), `/?item=${encodeURIComponent(c.itemIdForKey('m1') ?? '')}`),
  },
  { id: 'J44', group: 'Settings', title: 'Connect Outlook', start: (c) => (fresh(c), '/settings/outlook') },
  { id: 'J45', group: 'Settings', title: 'Outlook Calendar', start: (c) => (fresh(c), '/settings/outlook') },
  {
    id: 'J50',
    group: 'Cockpit',
    title: 'Still list',
    start: (c) => (fresh(c), later(() => c.simulatePoll('vip_dm'), 2500), `/?item=${encodeURIComponent(c.itemIdForKey('t2') ?? '')}`),
  },
  { id: 'J51', group: 'Cockpit', title: 'Health from across the desk', start: (c) => (fresh(c), c.setFlag('health_stale'), '/') },
  { id: 'J52', group: 'Cockpit', title: 'Your reply closes it', start: (c) => (c.cockpitAfternoon(), '/') },
  { id: 'J53', group: 'Cockpit', title: 'Your reply holds it', start: (c) => (c.cockpitAfternoon(), '/') },
  { id: 'J54', group: 'Cockpit', title: 'Undo a close', start: (c) => (c.cockpitAfternoon(), '/') },
  { id: 'J56', group: 'Cockpit', title: 'Three zones at a glance', start: (c) => (c.cockpitAfternoon(), '/') },
  { id: 'J57', group: 'Cockpit', title: 'Clear what’s due before the meeting', start: (c) => (c.cockpitAfternoon(), '/') },
  { id: 'J58', group: 'Cockpit', title: 'A deadline passes', start: (c) => (c.cockpitAfternoon(), '/') },
  { id: 'J59', group: 'Cockpit', title: 'A narrower window', start: (c) => (fresh(c), '/') },
  { id: 'J60', group: 'Cockpit', title: 'File in a batch', start: (c) => (c.cockpitAfternoon(), '/') },
  { id: 'J61', group: 'Cockpit', title: 'Stop a batch', start: (c) => (c.cockpitAfternoon(), '/') },
  { id: 'J66', group: 'Vault', title: 'Already filed', start: (c) => (fresh(c), c.setNextDraftOutcome('already_filed'), item(c, 'f4')) },
  { id: 'J67', group: 'Vault', title: 'Possible duplicate', start: (c) => (fresh(c), c.setNextDraftOutcome('possible_duplicate'), item(c, 'f4')) },
  { id: 'J68', group: 'Confluence', title: 'Already filed', start: (c) => (fresh(c), c.setNextDraftOutcome('already_filed'), item(c, 't2')) },
  // The bell (FR-11.3–11.6).
  { id: 'J69', group: 'Follow-ups', title: 'Draft, move on, hear back', start: (c) => (fresh(c), item(c, 'f4', '?tab=vault')) },
  { id: 'J70', group: 'Follow-ups', title: 'A draft fails while away', start: (c) => (fresh(c), c.setNextDraftOutcome('model_error'), item(c, 'f4', '?tab=vault')) },
  { id: 'J71', group: 'Follow-ups', title: 'Something to fix', start: (c) => (fresh(c), c.setFlag('health_ms365'), '/') },
  { id: 'J72', group: 'Follow-ups', title: 'Nudges and housekeeping', start: (c) => (c.cockpitAfternoon(), later(() => c.frankReplies('open'), 800), '/') },
  // Waiting on others (FR-8.1, amended).
  { id: 'J75', group: 'Inbox basics', title: 'Waiting on others', start: (c) => (fresh(c), item(c, 'wo1')) },
  { id: 'J76', group: 'Cockpit', title: 'You hand it on', start: (c) => (c.cockpitAfternoon(), later(() => c.frankReplies('handed'), 800), '/') },
  // To-dos (FR-9.8–9.11).
  { id: 'J77', group: 'Vault', title: 'Add a to-do', start: (c) => (fresh(c), `/?item=${encodeURIComponent(c.itemIdForKey('n3') ?? '')}`) },
  {
    id: 'J78',
    group: 'Vault',
    title: 'Action items to Tasks',
    start: (c) => (fresh(c), usePrefs.getState().setScope('full'), `/?item=${encodeURIComponent(c.itemIdForKey('m1') ?? '')}`),
  },
  { id: 'J79', group: 'Settings', title: 'Tasks note', start: (c) => (fresh(c), '/settings/writing') },
  // Filing from the keyboard (UX-1, UX-2, UX-4).
  { id: 'J80', group: 'Vault', title: 'File from the keyboard', start: (c) => (fresh(c), `/?item=${encodeURIComponent(c.itemIdForKey('f4') ?? '')}`) },
  { id: 'J82', group: 'Vault', title: 'Drafts ahead', start: (c) => (fresh(c), '/') },
  { id: 'J81', group: 'Confluence', title: 'Discard and snooze by key', start: (c) => (fresh(c), `/?item=${encodeURIComponent(c.itemIdForKey('f1') ?? '')}&file=confluence`) },
  // Notifications, toasts and the bell open the inbox panel (UX-6).
  { id: 'J83', group: 'Follow-ups', title: 'Open from a notification', start: (c) => (fresh(c), later(() => c.simulatePoll('vip_dm'), 2500), '/') },
  { id: 'J84', group: 'Follow-ups', title: 'Open what the inbox doesn’t show', start: (c) => (fresh(c), usePrefs.getState().setScope('mvp'), item(c, 'm1', '?tab=vault')) },
  // Done today shows filings (UX-12).
  { id: 'J85', group: 'Vault', title: 'What was filed today', start: (c) => (fresh(c), '/settings/writing') },
  // The ? overlay (UX-11).
  { id: 'J86', group: 'Inbox basics', title: 'Keys for where you are', start: (c) => (fresh(c), `/?item=${encodeURIComponent(c.itemIdForKey('f4') ?? '')}`) },
  // The end-of-day sweep (UX-10).
  { id: 'J87', group: 'Cockpit', title: 'Sweep Needs you', start: (c) => (fresh(c), '/') },
  // The filing policy (E14): Ready to approve, and what isn't drafted ahead.
  { id: 'J88', group: 'Cockpit', title: 'Ready to approve', start: (c) => (c.applyFilingPolicy(), '/') },
  // Write failures (FR-14.5).
  { id: 'J73', group: 'Vault', title: 'Not written: Retry write', start: (c) => (fresh(c), c.setNextDraftOutcome('write_unreachable'), item(c, 'f4', '?tab=vault')) },
  { id: 'J74', group: 'Confluence', title: 'Conflict, drafts budget used up', start: (c) => (fresh(c), c.setNextDraftOutcome('confluence_conflict'), c.setFlag('drafts_budget'), item(c, 'f1')) },
];
