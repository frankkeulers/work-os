import type { ReplySeed, ThreadSeed } from '../types';

// Seed threads. minsAgo is relative to the seed clock, Mon 5 Oct 2026 09:45 London.
// Summaries and reasons are what the triage "model" returns for each thread.

const H = 60;
const YESTERDAY = 17 * H + 35; // Sun 4 Oct 16:10 → minutes before Mon 09:45

/** A London wall-clock time in the seed week (BST, UTC+1). Day 5 is Mon 5 Oct. */
const london = (day: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 9, day, h - 1, m)).toISOString();
};

export const SEED_THREADS: ThreadSeed[] = [
  // ---------- Now ----------
  {
    key: 'n1',
    channelId: 'D01MATT',
    kind: 'dm',
    title: 'Matt M.',
    messages: [
      { by: 'U02MATT', minsAgo: 13, text: 'Morning Frank. Before Thursday’s exec sync I need your go/no-go on MVI V2. Are we still on for the 15th?' },
      { by: 'U02MATT', minsAgo: 12, text: 'If it’s a no-go I need the reason in one line for the board pack.' },
    ],
    decision: {
      attention: 'now',
      summary: 'Asks for your MVI V2 go/no-go call before Thursday’s exec sync.',
      reason: 'VIP DM with a direct question and a deadline.',
    },
  },
  {
    key: 'n2',
    channelId: 'C01APIDOG',
    kind: 'thread',
    title: '#apidog-migration',
    messages: [
      { by: 'U06PLATFORM', minsAgo: 58, text: 'Custom domain for the new developer portal is ready on the Apidog side. The DNS change for developers.polestarglobal.com needs approval before IT will apply it.' },
      { by: 'U13OPS', minsAgo: 41, text: 'IT change ticket is raised. They want a product sign-off in the ticket, not just in Slack.' },
      { by: 'U06PLATFORM', minsAgo: 26, text: '@Frank can you approve? The cutover is blocked until then and we lose the Thursday window otherwise.' },
    ],
    decision: {
      attention: 'now',
      summary: 'Custom-domain cutover is blocked until you approve the DNS change.',
      reason: '@-mention with a blocker on committed work.',
      next: { need: 'approve', step: 'Approve the DNS change in the IT ticket', why: 'The cutover can’t start until you approve, and IT wants the sign-off in the ticket. Miss it and the Thursday window goes.', blocks: 'Blocks cutover' },
    },
  },
  {
    key: 'n3',
    channelId: 'C06MVI',
    kind: 'thread',
    title: '#mvi-launch',
    messages: [
      { by: 'U18PMM', minsAgo: 70, text: 'Launch checklist update: everything is green apart from the data-licensing wording in the release notes.' },
      { by: 'U19LEGAL', minsAgo: 52, text: 'I’ve suggested wording in the doc. A product owner needs to confirm it matches what the API actually returns.' },
      { by: 'U18PMM', minsAgo: 34, text: '@Frank we need this by 12:00 to make the comms freeze. Blocked until then.' },
    ],
    decision: {
      attention: 'now',
      summary: 'Release notes are blocked on your sign-off of the data-licensing wording, needed by 12:00.',
      reason: 'Blocker keyword and a same-day deadline.',
      next: { need: 'approve', step: 'Confirm the data-licensing wording in the doc', why: 'Legal has suggested wording. The comms freeze is at 12:00, so marketing needs your sign-off before then.', dueAt: london(5, '12:00'), blocks: 'Marketing waiting' },
    },
  },

  // ---------- Today ----------
  {
    key: 't1',
    channelId: 'C02MERIDIA',
    kind: 'thread',
    title: '#meridia-product',
    messages: [
      { by: 'U07MERIDIAPM', minsAgo: 2 * H, text: 'Beta feedback round-up from the six Meridia IQ pilot customers is in the doc. Top asks: port-call ETA confidence, bulk export, and a Teams alert integration.' },
      { by: 'U16CS', minsAgo: 100, text: 'Two of the pilots said bulk export is a blocker to converting to paid.' },
      { by: 'U07MERIDIAPM', minsAgo: 62, text: '@Frank which three go into FQ3 (Oct–Dec)? I’d like to lock the plan this week.' },
    ],
    decision: {
      attention: 'today',
      vault: 'Areas/Meridia/Meridia IQ.md › Beta feedback',
      summary: 'Meridia IQ beta feedback shared; asks which three items go into FQ3 (Oct–Dec).',
      reason: 'Decision needed from you; worth keeping in the vault.',
      next: { need: 'decide', step: 'Pick the three FQ3 items', why: 'The Meridia PM wants to lock the FQ3 plan this week. Two pilots call bulk export a blocker to paid.', dueAt: london(9, '17:00'), dueLabel: 'plan lock' },
    },
    drafts: {
      vault: {
        kind: 'vault_append',
        path: 'Areas/Meridia/Meridia IQ.md',
        heading: '## Beta feedback',
        context: ['## Beta feedback', '- 2026-09-14 · Pilot kick-off with six customers; weekly check-ins agreed.'],
        content:
          '- 2026-10-05 · Beta round-up from six pilots. Top asks: port-call ETA confidence, bulk export, Teams alerts.\n  Two pilots call bulk export a blocker to paid conversion.\n  Open: pick three for FQ3 (Oct–Dec). Source: [Slack thread](permalink)',
      },
    },
  },
  {
    key: 't2',
    channelId: 'C03LABS',
    kind: 'thread',
    title: '#pole-star-labs',
    messages: [
      { by: 'U08LABS', minsAgo: 3 * H, text: 'We’d like to graduate the berth-availability prototype into a product team. Internal usage is steady at about 40 weekly users.' },
      { by: 'U08LABS', minsAgo: 2 * H + 10, text: '@Frank what’s on the graduation gate checklist? I couldn’t find the current version.' },
      { by: 'U10DELIVERY', minsAgo: 2 * H, text: 'The last version I saw was in a slide deck from June.' },
    ],
    decision: {
      attention: 'today',
      confluence: 'Pole Star Labs › Graduation gate',
      summary: 'Graduation request for a Labs prototype; needs the gate checklist.',
      reason: '@-mention, process question you own.',
      next: { need: 'reply', step: 'Share the graduation gate checklist', why: 'You own the process and the current version can’t be found. The outcome is worth a Confluence entry.', dueLabel: 'today' },
    },
    drafts: {
      confluence: {
        pageId: '41120987',
        pageTitle: 'Pole Star Labs › Graduation gate',
        section: 'Graduation requests',
        baseVersion: 17,
        title: '5 Oct 2026 · Berth-availability prototype requests graduation',
        content:
          'Request: the Labs berth-availability prototype asks to graduate into a product team. Internal usage is steady at about 40 weekly users.\n\nGap: the current gate checklist could not be found. The last known version is in a June slide deck.\n\nNext step: publish the checklist on this page and review the request against it.\n\nSource: Slack #pole-star-labs thread',
      },
      vault: {
        kind: 'vault_new',
        path: 'Projects/Labs/Berth availability graduation.md',
        content:
          '---\ntype: project-note\nsource: slack\nchannel: "#pole-star-labs"\ncreated: 2026-10-05\ntags: [labs, graduation]\n---\n# Berth availability graduation\n\nThe Labs team asks to graduate the berth-availability prototype (about 40 weekly internal users).\n\n- Gate checklist: not findable; last seen in a June deck.\n- To do: publish the checklist on [[Pole Star Labs]] and review the request.\n\nSource: [Slack thread](permalink)',
      },
    },
  },
  {
    key: 't3',
    channelId: 'D03SALES',
    kind: 'dm',
    title: 'Head of Sales',
    messages: [
      { by: 'U09SALES', minsAgo: 2 * H + 55, text: 'Hi Frank, could you do a 15-minute walkthrough of Insights APIs v2 for the sales team this week? Wednesday or Thursday afternoon ideally.' },
    ],
    decision: {
      attention: 'today',
      summary: 'Wants a 15-minute Insights APIs v2 walkthrough for the sales team this week.',
      reason: 'Direct request with a this-week deadline.',
      next: { need: 'reply', step: 'Offer a time for the walkthrough', why: 'Wednesday or Thursday afternoon suits the sales team.', dueLabel: 'this week' },
    },
  },
  {
    key: 't4',
    channelId: 'D04TEAMLEAD',
    kind: 'dm',
    title: 'Data products team lead',
    messages: [
      { by: 'U11TEAMLEAD', minsAgo: 3 * H + 20, text: 'Can I get your view before Thursday? Two of the engineers on the data products team are visibly overloaded ahead of the MVI V2 launch, and one has said they are close to burning out.' },
      { by: 'U11TEAMLEAD', minsAgo: 3 * H + 18, text: 'I’d like to move the export work to after launch. Keeping this between us for now.' },
    ],
    decision: {
      attention: 'today',
      vault: 'People/Data products team lead.md › Notes',
      people: true,
      summary: 'Team lead flags two overloaded engineers before MVI V2 and asks to move the export work.',
      reason: 'Asks for your view this week. Mentions named people, so vault only.',
      next: { need: 'decide', step: 'Give your view on moving the export work', why: 'The team lead wants it before Thursday. Mentions named people, so it can only go to the private vault.', dueAt: london(8, '09:00') },
    },
    drafts: {
      vault: {
        kind: 'vault_append',
        path: 'People/Data products team lead.md',
        heading: '## Notes',
        context: ['## Notes', '- 2026-09-21 · 1:1. Hiring plan for Q4 agreed.'],
        content:
          '- 2026-10-05 · Raised workload risk on the data products team before MVI V2; two engineers overloaded.\n  Proposal: move the export work to after launch. Asked for my view before Thursday. Confidential.',
      },
    },
  },

  // ---------- P2 sources (Outlook, Teams), shown in Full scope ----------
  {
    key: 'o1',
    source: 'outlook',
    channelId: 'INBOX',
    kind: 'email',
    title: '[Customer] account lead',
    messages: [
      {
        by: 'X01ACCOUNT',
        minsAgo: 18,
        text: 'Ahead of this afternoon: 1) Is v2 priced per vessel or per call? 2) Does historical backfill cost extra? 3) Can we keep v1 pricing until we migrate?',
      },
    ],
    decision: {
      attention: 'now',
      summary: 'Three questions on Insights APIs v2 pricing to answer before the renewal call.',
      reason: 'External sender, linked to a meeting at 14:00.',
      next: { need: 'prepare', step: 'Answer the three pricing questions', why: 'They’re on the agenda for the [Customer] renewal call at 14:00.', dueAt: london(5, '14:00') },
    },
  },
  {
    key: 'm1',
    source: 'teams',
    channelId: 'MTG-MVIREADY',
    kind: 'meeting',
    title: 'MVI V2 readiness review',
    messages: [
      { by: 'X02RELEASE', minsAgo: 75, text: 'Rollback plan is written, but we still need a named owner for the rollback call on launch day. Frank, can you confirm who that is?' },
      { by: 'X03SUPPORT', minsAgo: 64, text: 'Support needs the customer comms plan by Wednesday so we can brief the team.' },
    ],
    messageCount: 14,
    decision: {
      attention: 'today',
      summary: 'Two action items assigned to you: confirm the rollback owner and share the comms plan.',
      reason: 'The transcript names you as the owner.',
      next: {
        need: 'actions',
        step: 'Confirm your two action items',
        why: 'Both are assigned to you in the transcript.',
        dueLabel: 'today',
        actionItems: ['Confirm the rollback owner for MVI V2 · due Tue 6 Oct', 'Share the customer comms plan with Support · due Wed 7 Oct'],
      },
    },
  },
  {
    key: 'm2',
    source: 'teams',
    channelId: 'MTG-INSIGHTSROADMAP',
    kind: 'meeting',
    title: 'Insights APIs roadmap review',
    messages: [
      { by: 'X04APILEAD', minsAgo: 3 * H + 10, text: 'Decision: webhooks for vessel-events move to v2.1 in FQ4. v2.0 ships with polling only.' },
      { by: 'X05SALESENG', minsAgo: 3 * H + 5, text: 'Fine for the pilots, as long as we can tell customers a date.' },
    ],
    messageCount: 9,
    decision: {
      attention: 'none',
      confluence: 'Insights APIs › Decisions',
      summary: 'Decision: vessel-events webhooks move to v2.1; v2.0 ships with polling only.',
      reason: 'Product decision recorded in the transcript.',
      next: { need: 'file', step: 'Draft the Confluence entry', why: 'A product decision for Insights APIs › Decisions.' },
    },
  },

  // ---------- File ----------
  {
    key: 'f1',
    channelId: 'C04INSIGHTS',
    kind: 'thread',
    title: '#insights-api',
    messageCount: 7,
    messages: [
      { by: 'U04BACKEND', minsAgo: 4 * H + 54, text: 'Proposal for v2 vessel-events: drop imo_str and keep the integer imo only. It keeps breaking typed SDK clients.' },
      { by: 'U05SE', minsAgo: 4 * H + 41, text: 'Two customers parse imo_str today. We need a deprecation window in v1 and a changelog entry.' },
      { by: 'U01FRANK', minsAgo: 4 * H + 25, text: 'Agreed. Remove in v2, deprecate in v1, and note it on the developer portal.' },
      { by: 'U04BACKEND', minsAgo: 4 * H + 14, text: 'Done in the spec. Closing this out.' },
    ],
    decision: {
      attention: 'none',
      confluence: 'Insights APIs › Decisions',
      vault: 'Areas/Insights APIs/Insights APIs v2.md › Decisions',
      summary: 'Decision: v2 vessel-events endpoint drops the legacy imo_str field.',
      reason: 'Product decision. Target: Insights APIs › Decisions.',
      next: { need: 'file', step: 'Review the Confluence entry', why: 'A product decision for Insights APIs › Decisions. Both drafts are ready to review here.' },
    },
    drafts: {
      confluence: {
        pageId: '39004512',
        pageTitle: 'Insights APIs › Decisions',
        section: '2026 decision log',
        baseVersion: 42,
        title: '5 Oct 2026 · v2 vessel-events drops imo_str',
        content:
          'Decision: the v2 vessel-events response returns the IMO number only as the integer field `imo`. The string duplicate `imo_str` is removed.\n\nWhy: the duplicate field caused type mismatches in client SDKs.\n\nMigration: deprecated in v1 responses from [DATE]; removed in v2. The developer portal changelog will note it.\n\nSource: Slack #insights-api thread',
      },
      vault: {
        kind: 'vault_append',
        path: 'Areas/Insights APIs/Insights APIs v2.md',
        heading: '## Decisions',
        context: ['## Decisions', '- 2026-09-22 · v2 pagination uses cursors, not offsets.'],
        content:
          '- 2026-10-05 · v2 vessel-events drops `imo_str`; integer `imo` only.\n  Deprecate in v1 from [DATE]; changelog on [[Developer portal]].\n  Source: [Slack thread](permalink)',
      },
    },
  },
  {
    key: 'f2',
    channelId: 'C05LEADS',
    kind: 'thread',
    title: '#product-leads',
    messages: [
      { by: 'U03VPENG', minsAgo: 5 * H, text: 'For FQ4 (Jan–Mar) planning, a proposal: each product lead owns their roadmap page end to end, and Product Ops owns the cross-BU view.' },
      { by: 'U07MERIDIAPM', minsAgo: 4 * H + 50, text: '+1, as long as the cross-BU view pulls from our pages rather than a separate spreadsheet.' },
      { by: 'U10DELIVERY', minsAgo: 4 * H + 40, text: 'We should write this down somewhere people will find it.' },
    ],
    decision: {
      attention: 'none',
      confluence: 'Product org › Roadmap process',
      vault: 'Areas/Product org/Roadmap process.md',
      summary: 'Roadmap ownership agreed ahead of FQ4 (Jan–Mar) planning.',
      reason: 'Planning context. Target: Product org › Roadmap process.',
      next: { need: 'file', step: 'Draft the Confluence entry', why: 'Planning context for Product org › Roadmap process.' },
    },
    drafts: {
      // Under the excluded Product org pages: the panel warns, and approving exercises FR-10.6.
      confluence: {
        pageId: '48213377',
        pageTitle: 'Product org › Roadmap process',
        section: 'Ownership',
        baseVersion: 8,
        title: 'Roadmap ownership from FQ4 (Jan–Mar)',
        content:
          'Each product lead owns their roadmap page end to end. Product Ops owns the cross-BU view, which pulls from the product pages rather than a separate spreadsheet.\n\nApplies from FQ4 (Jan–Mar) planning.\n\nSource: Slack #product-leads thread',
      },
    },
  },
  {
    key: 'f3',
    channelId: 'C02MERIDIA',
    kind: 'thread',
    title: '#meridia-product',
    messages: [
      { by: 'U07MERIDIAPM', minsAgo: YESTERDAY, text: 'Pricing decision from today’s call: Meridia IQ beta stays free until GA, then per-vessel tiers. Finance has signed off.' },
      { by: 'U14FINANCE', minsAgo: YESTERDAY - 12, text: 'Confirmed. Tier boundaries will follow in the pricing sheet.' },
    ],
    decision: {
      attention: 'none',
      confluence: 'Meridia › Context: Decisions',
      vault: 'Areas/Meridia/Meridia IQ.md › Pricing',
      summary: 'Pricing decision: Meridia IQ beta stays free until GA, then per-vessel tiers.',
      reason: 'Pricing decision. Target: Meridia › Context: Decisions.',
      next: { need: 'file', step: 'Draft the vault note', why: 'The Confluence entry is filed. The pricing tiers are also worth keeping in the vault.' },
    },
    drafts: {
      confluence: {
        pageId: '40217733',
        pageTitle: 'Meridia › Context: Decisions',
        section: 'Pricing',
        baseVersion: 23,
        title: '4 Oct 2026 · Meridia IQ beta pricing',
        content: 'Decision: Meridia IQ beta stays free until GA, then moves to per-vessel tiers. Finance signed off on 4 Oct.\n\nSource: Slack #meridia-product thread',
      },
    },
  },
  {
    key: 'f4',
    channelId: 'C10AI',
    kind: 'thread',
    title: '#ai-adoption',
    messages: [
      { by: 'U06PLATFORM', minsAgo: 6 * H, text: 'Short how-to for running Claude Code on the subscription without an API key: 1) unset ANTHROPIC_API_KEY, 2) claude login, 3) check /status shows the plan. Pinning this.' },
      { by: 'U17DATAENG', minsAgo: 5 * H + 45, text: 'Worked for me. Worth adding that a key in .zshrc overrides the login.' },
    ],
    decision: {
      attention: 'none',
      vault: 'Resources/Claude Code/Subscription auth.md',
      summary: 'How-to: running Claude Code on the subscription with no API key.',
      reason: 'Reusable how-to. Target: a new note in Resources.',
      next: { need: 'file', step: 'Draft a vault note', why: 'A reusable how-to. It becomes a new note in Resources.' },
    },
    drafts: {
      vault: {
        kind: 'vault_new',
        path: 'Resources/Claude Code/Subscription auth.md',
        content:
          '---\ntype: resource\nsource: slack\nchannel: "#ai-adoption"\ncreated: 2026-10-05\ntags: [claude-code, ai-adoption]\n---\n# Claude Code subscription auth\n\nRun Claude Code on the Claude subscription without an API key.\n\n1. Unset `ANTHROPIC_API_KEY`. A key in `.zshrc` overrides the login.\n2. Run `claude login`.\n3. Check that `/status` shows the plan.\n\nRelated: [[Work OS]] · [[AI adoption]]\nSource: [Slack thread](permalink)',
      },
    },
  },

  // ---------- Everything else ----------
  ...(
    [
      ['e1', 'C08GENERAL', 'U15OFFICE', 3 * H + 5, 'Office Wi-Fi maintenance on Saturday between 08:00 and 12:00. No action needed.', 'Office Wi-Fi maintenance on Saturday.'],
      ['e2', 'C09MERDEV', 'U17DATAENG', 2 * H + 30, 'Deploy to staging completed. Release candidate 2.14.0 is up.', 'Deploy to staging completed, no action requested.'],
      ['e3', 'C10AI', 'U12DESIGN', 4 * H, 'New Claude Code release notes are out, link in thread.', 'Link share: new Claude Code release notes.'],
      ['e4', 'C04INSIGHTS', 'U20QA', 5 * H + 10, 'Typo in the Swagger UI header on the dev portal is fixed.', 'Dev portal typo fixed.'],
      ['e5', 'C06MVI', 'U10DELIVERY', 1 * H + 15, 'Stand-up notes posted. All workstreams green.', 'MVI stand-up notes posted, all green.'],
      ['e6', 'C05LEADS', 'U10DELIVERY', 6 * H + 20, 'Reminder: FQ4 OKR drafts are due on 16 Oct.', 'Reminder: FQ4 OKR drafts due 16 Oct.'],
      ['e7', 'C03LABS', 'U08LABS', 7 * H, 'Photos from demo day are in the shared drive.', 'Demo day photos shared.'],
      ['e8', 'C02MERIDIA', 'U16CS', 2 * H + 40, 'Weekly Meridia IQ usage stats are posted. Up 8% week on week.', 'Weekly Meridia IQ usage stats posted.'],
      ['e9', 'C01APIDOG', 'U13OPS', 1 * H + 50, 'Test build of the doc site passed on the staging domain.', 'Doc site test build passed.'],
      ['e10', 'C09MERDEV', 'U04BACKEND', 3 * H + 40, 'Can someone review PR 482? Small change to the tile cache.', 'Engineers asking each other for a PR review.'],
      ['e11', 'C07DPOPS', 'U13OPS', 8 * H, 'Ingestion lag recovered overnight. Incident closed.', 'Ingestion lag incident closed.'],
      ['e12', 'C08GENERAL', 'U15OFFICE', 5 * H + 30, 'Please welcome our new data engineer, who joins on Monday.', 'New starter announcement.'],
      ['e13', 'D05DESIGN', 'U12DESIGN', 4 * H + 30, 'Thanks for the feedback on the onboarding flow, I’ll share v2 next week.', 'Designer thanks you for onboarding feedback.'],
      ['e14', 'C10AI', 'U18PMM', 6 * H + 50, 'Quick poll: which AI tools do you use daily? Reactions please.', 'Poll on daily AI tools.'],
    ] as const
  ).map(
    ([key, channelId, by, minsAgo, text, summary]): ThreadSeed => ({
      key,
      channelId,
      kind: channelId.startsWith('D') ? 'dm' : 'thread',
      title: channelId.startsWith('D') ? 'Product designer' : '',
      messages: [{ by, minsAgo, text }],
      decision: { attention: 'none', summary, reason: 'Informational. Nothing to answer or file.' },
    }),
  ),

  // ---------- Failed triage ----------
  {
    key: 'x1',
    channelId: 'C07DPOPS',
    kind: 'thread',
    title: '#data-products-ops',
    messages: [
      { by: 'U13OPS', minsAgo: 2 * H, text: 'Nightly AIS ingestion finished 3h late. The root cause looks like the upstream provider throttling us again.' },
      { by: 'U17DATAENG', minsAgo: 90, text: 'Second time this month. Do we escalate with the provider or add a retry budget?' },
    ],
    failTriage: 2,
    decision: {
      attention: 'today',
      vault: 'Areas/Data products/Incidents.md',
      summary: 'AIS ingestion ran 3h late from provider throttling; the team asks whether to escalate.',
      reason: 'Recurring incident with a decision to make.',
    },
  },

  // ---------- Snoozed ----------
  {
    key: 's1',
    channelId: 'C04INSIGHTS',
    kind: 'thread',
    title: '#insights-api',
    messages: [{ by: 'U16CS', minsAgo: 75, text: 'A customer asks how far back historical AIS backfill goes on v2. Is it still 2015?' }],
    decision: {
      attention: 'today',
      summary: 'Customer asks how far back historical AIS backfill goes on v2.',
      reason: 'Customer question you can answer.',
      next: { need: 'reply', step: 'Answer the backfill question', why: 'A customer is waiting on it. The answer is in the v2 docs.' },
    },
  },
  {
    key: 's2',
    channelId: 'D06FINANCE',
    kind: 'dm',
    title: 'Finance partner',
    messages: [{ by: 'U14FINANCE', minsAgo: 2 * H + 20, text: 'Q3 tooling spend breakdown attached. I need your input on the Apidog and Claude lines by Wednesday.' }],
    decision: {
      attention: 'today',
      summary: 'Needs your input on the Apidog and Claude tooling spend by Wednesday.',
      reason: 'Direct request with a deadline this week.',
      next: { need: 'reply', step: 'Send your tooling spend input', why: 'Due Wednesday. Snooze it to Wednesday morning if today is full.', dueAt: london(7, '17:00') },
    },
  },

  // ---------- Waiting for the quiet window ----------
  {
    key: 'q1',
    channelId: 'C02MERIDIA',
    kind: 'thread',
    title: '#meridia-product',
    messages: [
      { by: 'U16CS', minsAgo: 6, text: 'A pilot customer reports map tiles not loading in Meridia IQ since this morning.' },
      { by: 'U07MERIDIAPM', minsAgo: 4, text: 'Looking into it. @Frank FYI in case they escalate to you.' },
    ],
    decision: {
      attention: 'today',
      summary: 'FYI: a pilot customer can’t load map tiles in Meridia IQ and may escalate to you.',
      reason: '@-mention, FYI with escalation risk.',
    },
  },
  {
    key: 'q2',
    channelId: 'C06MVI',
    kind: 'thread',
    title: '#mvi-launch',
    messages: [{ by: 'U18PMM', minsAgo: 2, text: 'Release notes draft v3 is in the doc for anyone who wants to review.' }],
    decision: { attention: 'none', summary: 'Release notes draft v3 posted for optional review.', reason: 'Open invitation, nothing addressed to you.' },
  },

  // ---------- Done ----------
  {
    key: 'd1',
    channelId: 'C01APIDOG',
    kind: 'thread',
    title: '#apidog-migration',
    messages: [
      { by: 'U06PLATFORM', minsAgo: YESTERDAY + 60, text: 'Doc site theme v2 is ready for sign-off. Screenshots in the thread.' },
      { by: 'U01FRANK', minsAgo: YESTERDAY + 40, text: 'Approved, looks good.' },
    ],
    decision: { attention: 'today', summary: 'Doc site theme v2 needed your sign-off.', reason: 'Approval request on committed work.' },
  },
  {
    key: 'd2',
    channelId: 'C05LEADS',
    kind: 'thread',
    title: '#product-leads',
    messageCount: 5,
    messages: [{ by: 'U03VPENG', minsAgo: 33 * 24 * H, text: 'FQ3 planning kick-off: dates and owners in the doc.' }],
    decision: { attention: 'today', vault: 'Areas/Product org/Planning.md', summary: 'FQ3 planning kick-off: dates and owners agreed.', reason: 'Planning dates you need to know.' },
  },
  {
    key: 'd3',
    channelId: 'D07DATAENG',
    kind: 'dm',
    title: 'Data engineer',
    messages: [{ by: 'U17DATAENG', minsAgo: 50, text: 'Shared the port-call notebook you asked for.' }],
    decision: { attention: 'none', summary: 'Data engineer shared the port-call notebook.', reason: 'Reply to your request; nothing to do.' },
  },
];

/** The Topics preset (amendment): a group DM routed into two topics, and two threads Regroup merges. */
export const TOPIC_THREADS: ThreadSeed[] = [
  ...API_GROUP_DM(),

  // ---------- Topics: two threads on one subject, triaged apart; Regroup merges them ----------
  {
    key: 'r1',
    channelId: 'C04INSIGHTS',
    kind: 'thread',
    title: '#insights-api',
    thread: true,
    messages: [
      { by: 'U04BACKEND', minsAgo: 4 * H, text: 'Insights module API key auth: moving the key check from folder level to module level so it matches the spec.' },
      { by: 'U20QA', minsAgo: 3 * H + 40, text: 'Pre-publish diffs look clean with the module-level check.' },
    ],
    decision: { attention: 'none', summary: 'Insights API key auth moved to module level; pre-publish diffs clean.', reason: 'Status update; nothing for you yet.' },
  },
  {
    key: 'r2',
    channelId: 'C04INSIGHTS',
    kind: 'thread',
    title: '#insights-api',
    thread: true,
    regroupWith: 'r1',
    messages: [
      { by: 'U04BACKEND', minsAgo: 2 * H, text: 'Insights API key auth is merged to pre-publish. @Frank can you check the portal shows the module-level scheme before we publish?' },
      { by: 'U20QA', minsAgo: 1 * H + 50, text: 'Tested the three endpoints against it, all good.' },
    ],
    decision: {
      attention: 'today',
      summary: 'Insights API key auth on pre-publish: check the portal before it’s published.',
      reason: 'Direct ask before a publish.',
      next: { need: 'review', step: 'Check the portal shows the module-level key scheme', why: 'Backend lead wants your eye on it before publishing.' },
    },
  },
];

/**
 * A group DM about API governance, as Slack cuts it: chat split at 30 minutes of quiet, plus reply
 * threads. Routing puts the pieces on the pre-publish branch in one topic and the API contract
 * pieces in another, so the inbox shows two entries with a checklist each instead of six.
 */
function API_GROUP_DM(): ThreadSeed[] {
  const base = { channelId: 'G01APIGOV', kind: 'dm' as const, title: 'Backend lead, Platform engineer, QA engineer, Data engineer' };
  const part = { attention: 'today' as const, summary: 'Part of a topic.', reason: 'Triaged with its topic.' };
  const due = london(5, '18:00');
  return [
    {
      ...base,
      key: 'k1',
      messages: [
        { by: 'U06PLATFORM', minsAgo: 5 * H, text: 'Apidog branch workflow is live: the pre-publish branch holds portal changes until Frank merges via MR.' },
        { by: 'U06PLATFORM', minsAgo: 5 * H - 2, text: 'It’s experimental, so it needs an end-to-end run before we rely on it.' },
      ],
      decision: {
        attention: 'now',
        summary: 'Pre-publish branch workflow: main branch protection waits on your go; PR 63 needs a look.',
        reason: 'The team is waiting on your approval today.',
        next: {
          need: 'approve',
          step: 'Give the go to enable main branch protection',
          why: 'The team has tested the pre-publish flow and needs your go to switch protection on.',
          dueAt: due,
          blocks: 'Team waiting',
          asks: [
            { need: 'approve', step: 'Give the go to enable main branch protection', dueAt: due },
            { need: 'review', step: 'Check the PR 63 security scheme lands on the right module' },
            { need: 'reply', step: 'Tell the Backend lead whether the PR 60 cleanup can be reverted' },
          ],
        },
      },
    },
    {
      ...base,
      key: 'k2',
      topic: 'k1',
      thread: true,
      messages: [
        { by: 'U04BACKEND', minsAgo: 2 * H + 10, text: 'PR 63 adds GOVERNANCE-RULES.md for the contract checks.' },
        { by: 'U01FRANK', minsAgo: 2 * H, text: 'The security scheme merge in pre-publish is landing on the wrong module, can you check?' },
        { by: 'U04BACKEND', minsAgo: 1 * H + 50, text: 'Looking. Will push a fix to the same PR.' },
      ],
      decision: part,
    },
    {
      ...base,
      key: 'k3',
      topic: 'k1',
      messages: [
        { by: 'U20QA', minsAgo: 5 * H - 50, text: 'Pre-publish branch workflow is ready for main branch protection. We tested it end to end.' },
        { by: 'U06PLATFORM', minsAgo: 5 * H - 48, text: 'Just needs Frank’s go to enable it. Can we have it by 18:00?' },
      ],
      decision: part,
    },
    {
      ...base,
      key: 'k4',
      topic: 'k1',
      thread: true,
      messages: [
        { by: 'U04BACKEND', minsAgo: 2 * H - 5, text: 'Is the PR 60 cleanup done? Want to revert the temporary rules.' },
        { by: 'U01FRANK', minsAgo: 2 * H - 8, text: 'Running checks before reverting.' },
      ],
      decision: part,
    },
    {
      ...base,
      key: 'k5',
      messages: [
        { by: 'U17DATAENG', minsAgo: 1 * H + 10, text: 'Can you review the API contract change for the timestamp_end default? Future dates would be clamped to now.' },
        { by: 'U17DATAENG', minsAgo: 1 * H + 8, text: 'Need it before 18:00 so it makes the release.' },
      ],
      decision: {
        attention: 'today',
        summary: 'API contract validation: review the timestamp_end default and agree the plan for the gaps.',
        reason: 'Two asks for you, one due today.',
        next: {
          need: 'review',
          step: 'Review the timestamp_end default change (future dates clamped)',
          why: 'It has to make today’s release.',
          dueAt: due,
          asks: [
            { need: 'review', step: 'Review the timestamp_end default change (future dates clamped)', dueAt: due },
            { need: 'decide', step: 'Agree to fix the contract gaps at 2–3 points a sprint', dueAt: due },
          ],
        },
      },
    },
    {
      ...base,
      key: 'k6',
      topic: 'k5',
      thread: true,
      messages: [
        { by: 'U20QA', minsAgo: 1 * H + 5, text: 'Reviewed the API contract validation findings. Proposal: resolve the gaps incrementally, 2–3 story points per sprint, and add validation rules.' },
        { by: 'U17DATAENG', minsAgo: 58, text: 'Fine by me if Frank agrees.' },
      ],
      decision: part,
    },
  ];
}

// Arrivals on the scripted timeline (minutes after the seed clock). Polls pick them up.
export const TIMELINE: { afterMins: number; thread?: ThreadSeed; reply?: ReplySeed }[] = [
  {
    afterMins: 7,
    thread: {
      key: 'i1',
      channelId: 'C04INSIGHTS',
      kind: 'thread',
      title: '#insights-api',
      messages: [{ by: 'U05SE', minsAgo: 0, text: 'A customer asks whether v2 vessel-events supports webhooks or polling only. Do we have a position?' }],
      decision: {
        attention: 'today',
        confluence: 'Insights APIs › Decisions',
        summary: 'Customer asks whether v2 vessel-events will support webhooks.',
        reason: 'Product position needed; may become a recorded decision.',
      },
    },
  },
  {
    afterMins: 18,
    reply: { targetKey: 't1', by: 'U07MERIDIAPM', text: 'Leaning towards bulk export, ETA confidence and Teams alerts. Shout if you disagree.' },
  },
  {
    afterMins: 32,
    thread: {
      key: 'i2',
      channelId: 'C08GENERAL',
      kind: 'thread',
      title: '#general',
      messages: [{ by: 'U15OFFICE', minsAgo: 0, text: 'Fire alarm test on Wednesday at 10:00.' }],
      decision: { attention: 'none', summary: 'Fire alarm test on Wednesday at 10:00.', reason: 'Informational.' },
    },
  },
  {
    afterMins: 50,
    reply: { targetKey: 't2', by: 'U08LABS', text: 'Found the June checklist, attaching it here.' },
  },
];

// Scenario injections (scenarios drawer → Poll outcomes).
export const VIP_DM: ThreadSeed = {
  key: 'v1',
  channelId: 'D01MATT',
  kind: 'dm',
  title: 'Matt M.',
  messages: [{ by: 'U02MATT', minsAgo: 0, text: 'Can you join the exec sync at 11:00 today instead of Thursday? I need 10 minutes on MVI V2.' }],
  decision: {
    attention: 'now',
    summary: 'Asks you to join the exec sync at 11:00 today for 10 minutes on MVI V2.',
    reason: 'VIP DM with a same-day request.',
  },
};

export const REPLIES: Record<'done' | 'snoozed' | 'drafted', ReplySeed> = {
  done: {
    targetKey: 'd1',
    by: 'U06PLATFORM',
    text: 'One more thing: marketing wants the logo swapped before launch. Can you confirm?',
    decision: {
      attention: 'today',
      summary: 'Marketing wants the doc site logo swapped before launch; needs your confirmation.',
      reason: 'New question on an item you closed.',
      next: { need: 'approve', step: 'Confirm the logo swap', why: 'Marketing wants it in before launch. A yes in the thread is enough.' },
    },
  },
  snoozed: {
    targetKey: 's2',
    by: 'U14FINANCE',
    text: 'Sorry, the deadline moved to today 15:00.',
    decision: {
      attention: 'now',
      summary: 'Tooling spend input now needed by 15:00 today.',
      reason: 'Deadline moved to today.',
      next: { need: 'reply', step: 'Send your tooling spend input', why: 'Finance moved the deadline to 15:00 today.', dueAt: london(5, '15:00') },
    },
  },
  drafted: {
    targetKey: 'f1',
    by: 'U04BACKEND',
    text: 'Small change: the v1 deprecation date is 1 Dec.',
  },
};

// Twelve quiet threads that arrive together and are triaged in one batched call (Story 5.1).
export const BATCH_TWELVE: ThreadSeed[] = (
  [
    ['C09MERDEV', 'U04BACKEND', 'Tile cache hit rate is back above 95% after the fix.', 'none', 'Tile cache hit rate recovered.'],
    ['C08GENERAL', 'U15OFFICE', 'The kitchen on floor 3 is closed for cleaning tomorrow.', 'none', 'Kitchen closed tomorrow.'],
    ['C10AI', 'U17DATAENG', 'Sharing a prompt that summarises Jira epics nicely.', 'none', 'Prompt shared for summarising Jira epics.'],
    ['C04INSIGHTS', 'U05SE', '@Frank do we commit to an SLA for the v2 events stream? A prospect asks.', 'today', 'Prospect asks whether v2 events has an SLA.'],
    ['C06MVI', 'U20QA', 'Regression suite passed on the release candidate.', 'none', 'MVI regression suite passed.'],
    ['C05LEADS', 'U03VPENG', 'Decision: product leads present roadmaps at the monthly all-hands from November.', 'file', 'Decision: roadmaps presented at monthly all-hands from November.'],
    ['C02MERIDIA', 'U12DESIGN', 'New empty-state illustrations for Meridia IQ are in Figma.', 'none', 'New Meridia IQ illustrations in Figma.'],
    ['C07DPOPS', 'U13OPS', 'Disk alerts on the ingest box cleared after rotation.', 'none', 'Ingest disk alerts cleared.'],
    ['C03LABS', 'U08LABS', '@Frank can you be a judge at the Labs hack day on the 23rd?', 'today', 'Invites you to judge the Labs hack day on 23 Oct.'],
    ['C01APIDOG', 'U06PLATFORM', 'Apidog CLI is now in the CI image.', 'none', 'Apidog CLI added to the CI image.'],
    ['C09MERDEV', 'U20QA', 'Flaky test in the tile service is quarantined.', 'none', 'Flaky tile-service test quarantined.'],
    ['C08GENERAL', 'U15OFFICE', 'Team lunch on Friday, sign-up sheet in the thread.', 'none', 'Team lunch sign-up for Friday.'],
  ] as const
).map(([channelId, by, text, kind, summary], i): ThreadSeed => ({
  key: `b${i + 1}`,
  channelId,
  kind: 'thread',
  title: '',
  messages: [{ by, minsAgo: 14 + (i % 4), text }],
  decision:
    kind === 'file'
      ? { attention: 'none', confluence: 'Product org › Roadmap process', vault: 'Areas/Product org/Roadmap process.md', summary, reason: 'Process decision worth recording.' }
      : kind === 'today'
        ? { attention: 'today', summary, reason: '@-mention with a question for you.' }
        : { attention: 'none', summary, reason: 'Informational.' },
}));
