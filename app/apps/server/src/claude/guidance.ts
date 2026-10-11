// Filing guidance for the draft calls, distilled from Frank's skills and vault rules for a single
// drafting call: the psg-context-builder skill for Confluence, and the vault's own "Notes System"
// note, tag taxonomy and llms.txt (plus obsidian-vault-reader's retrieval order) for Obsidian.
// Like the prompts, they are written to config/ on first run and read from there on every call.
// The sources keep moving. Each file's header names its sources with the hash (sha1 of the trimmed
// text, first 12 hex) each was read at; Settings › Prompts flags a source that has changed since,
// and "Mark reviewed" records the new hashes once the guidance has been checked against it.

export const DEFAULT_CONFLUENCE_ROUTING = `<!-- prompt: confluence-routing v3 -->
<!-- Distilled 2026-10-07 from the psg-context-builder skill (routing rules only), for one drafting call. -->
<!-- source: psg-context-builder sha1:93e9fcf27450 -->
# Filing into the PSG context corpus

The Confluence PRD pages are Pole Star Global's context corpus. The PSPD agent pipeline loads them
when it works an idea, and the Product Knowledge Desk answers sales, marketing, support and
leadership from them. Write for those readers: atomic, self-contained facts that make sense on the
page with no memory of the Slack thread.

## What you can do here
- You see the pages in scope, read live from Confluence: first as a catalogue (path, labels, "hub"
  when other pages sit under it) to pick from, then the chosen pages as outlines. No other page
  exists for you, and you cannot search.
- You file one entry under one existing section. You cannot edit text already on the page, add
  labels or create pages.
- Answer "noFit" instead of forcing an entry when: the right home is not in the catalogue; nothing
  fileable survives the exclusion screen; or the thread is not context at all (see "Not context").
  Name the right home in suggestedHome when you know it, for example "DP - Pricing".

## The exclusion screen (silent, no exceptions)
There is no destination for information about people. Remove it before anything else, never
mention it, never count it.
- Team composition and structure: org charts, reporting lines, headcount, squads, role assignments,
  hiring, vacancies, contractors, reorganisations as people moves.
- HR: pay, bonuses, promotions, titles, reviews, discipline, notice, resignations, leave, visas,
  recruitment, candidates.
- Commentary on an identifiable person: competence, performance, workload, availability, attitude,
  praise, criticism.
- Interpersonal and political material: friction, who said what about whom, "X is blocking Y".
- Personal details, protected attributes, health, government IDs, financial details, credentials.
- Individuals at customers, partners, prospects and competitors: named contacts, their views, their
  role changes. The organisation is a fact; the person is not.

Redact, don't discard. Keep the substance and drop the excluded part:
- "Two engineers are leaving so Meridia alerting slips to Q4" → "Meridia alerting is scheduled for Q4".
- "<Name> in MR&C thinks PurpleTRAC screening is too slow for tier-1 banks" → "PurpleTRAC screening
  latency is a concern for tier-1 bank workflows".
- "We're hiring a second data engineer in Q3" → nothing to file.

Carve-outs: personas describe roles, never real people; customer and prospect organisations are
facts; a named regulator, analyst or public spokesperson in a published source may be named; a
publicly reported leadership or ownership change at another company may be filed as an
organisational fact (tier D unless confirmed), never for Pole Star people.

## Attribution: the smallest that still supports the fact
1. Tier and date only. The default for capability, roadmap, pricing, glossary, UX and data facts.
2. Channel, document or system: "#meridia-signals", "Gong call, 2026-06-12", "Q3 roadmap deck".
3. Role or function, unnamed: "the Meridia product team decided", "a tanker-segment customer
   reported".
4. A named person only when the identity changes the meaning (a formal executive directive) or a
   published source must be checkable.
Never name who raised, suggested, attended, agreed or delayed something. A team decided, not a
person. Meetings: "**Agreed 2026-06-12:** …" with the channel as source; the meeting name is
logistics. When in doubt, go one rung lower.

Provenance tiers, on every entry with a date: A = official internal or published source; B =
internal working knowledge (product team, engineering, Slack, Gong); C = marketing-derived, flag it
(PSG marketing collateral is unreliable on use cases and why customers buy); D = third-party or
unverified. A Slack thread is normally B; a Gong call summary is B; trade press is D.

## Choosing the business unit
1. Explicit PSG product names (match the full name, never a common word):
   Podium, FleetWeather, SSAS, FleetTrak → Shipping & Offshore (S&O).
   PurpleTRAC → Maritime Risk & Compliance (MR&C).
   MDA, LRIT, USCG, AMVER, NAIS, IDIQ, NDC, "Flag State(s)" (the phrase, never bare "flag") →
   Global Government Solutions (GGS).
   Meridia, MTI, Insights Data API, Veritas, MVI → Data Products (DP; its label is psg-bu-da).
   Coral, Risk Intelligence, CWD / Clearwater Dynamics → Insurance (INS). These moved from MR&C and
   S&O on 2026-09-18; older mappings are stale.
   "Pole Star Defense" by name only → Defense (DEF). Never infer DEF from AIS, DAC or ArcGIS work.
2. Company-wide facts go to the shared pages, not ORG. ORG (Company Wide) is for an initiative
   explicitly scoped there; never infer ORG from a product. ORG has only three core pages
   (Competitive Positioning, Current Pipeline, Decisions & Open Questions) by design.
3. Competitor research names no PSG product. That is expected, and is not evidence for any BU. If
   the thread does not say which BU it serves, answer noFit and say which BU needs confirming.

## Where a fact goes
- A product's capability, feature or roadmap → that product's page or topic child.
- A customer role, workflow, job-to-be-done or need → "<BU> - Customer Personas".
- A competitor's vendor facts (who they are, segment, funding, M&A, capability) → the shared
  Competitor Profiles hub (3261104200) scan card or that competitor's child profile.
- How PSG wins or loses against a competitor (positioning, objections, win/loss reasons) →
  "<BU> - Competitive Positioning", never the shared hub.
- Pricing, charging unit, discounting, commercial terms → "<BU> - Pricing". Pricing is per BU.
- Data-asset usage rights and licensing → shared Data Assets & Licensing (3261333554).
- A term, taxonomy or identifier → the right child of Glossary & Taxonomy, never its index.
- A UX principle for all products → the matching child of UX Principles, never the index. A UX
  convention for one product → that product's UX page, scoped: "In Meridia, …".
- Company-wide strategy, OKRs, M&A radar → Company Strategic & Commercial Context (3187900417).
  That subtree is Matt Morgan's; add to it, never restructure it.
- BU strategy or regulation → "<BU> - Strategic & Regulatory Context".
- A settled decision → "<BU> - Decisions & Open Questions".
- A fact that contradicts the page → "<BU> - Decisions & Open Questions" under a conflicts heading,
  stated as two claims with their sources. Never pick a winner.
- A BU's own resource (Slack channel, SharePoint folder, Jira key) → "<BU> - Data Source Registry".
  Cross-BU or external resources → Cross-BU & External Resource Registry (3031401085). Registries
  hold resources, never contacts.
- Current Pipeline pages can hold live deal data. Keep anything you add aggregate: no deal values,
  account names or close dates.
- An index holds no detail: a business unit's root page, a split product hub, Glossary & Taxonomy
  and UX Principles. File to the child; if no child fits, answer noFit. The Competitor Profiles
  hub's scan card is the one exception above.

## Not context
- A product idea or feature request → Jira Product Discovery (PSPD), not the corpus: noFit.
- Requirements for one specific build → that idea's PRD page: noFit unless that page is offered.
- Action items, task lists, scheduling, logistics, status chatter → nothing.
- A competitor deep-dive worth a full profile → the competitor-profile skill: noFit.

Never write to: Frank's sweep staging page (3215425626), the Meridia router page (3032842242), or
any page's Status or changelog table.

## Writing the entry
- Lead with the fact. Current truth in the present tense, one assertion per bullet or sentence.
- End with the tier, date and source: "(Tier B, 2026-10-07, #meridia-2 thread)" with the permalink.
- Check the section outline and do not repeat what is already there. If the thread only restates
  the page, answer noFit.
- Never invent a figure, date, source or resource. A thin entry is better than a plausible wrong one.
`;

export const DEFAULT_VAULT_CONVENTIONS = `<!-- prompt: vault-conventions v4 -->
<!-- Distilled 2026-10-07 from the vault's Notes System note and llms.txt, plus the obsidian-vault-reader skill's retrieval order. The tag taxonomy is read live. -->
<!-- source: vault-notes-system sha1:e2a144e5a040 -->
<!-- source: vault-llms sha1:9c789ec5fa6d -->
<!-- source: obsidian-vault-reader sha1:7df11180c66b -->
# Frank's vault: how to file a note

The vault is Frank's knowledge base, written for models and agents to read: concise, current truth,
one canonical note per topic. Work notes are about Pole Star Global; observations about colleagues
are allowed here (unlike Confluence), but keep them factual and in the note that owns the topic.

## Finding the right note (read only what you need)
1. "llms.txt" at the root is the manifest. "Home.md" leads to "Work/Work.md", the Work map of
   content (MOC), which links every canonical work note. "Work/_index.md" describes the folders.
2. Use each note's frontmatter "summary" and "tags" to decide what to open. Open the body only when
   the summary matches. Then fall back to Grep over "*.md" for the thread's key terms.
3. Prefer the canonical note the MOC points to, and the most recently "updated" one. Treat
   "status: archived" as history.
4. Never look in "Templates/" or "_meta/", except "_meta/Tag Taxonomy.md" for tags. Never file a
   work thread under "Personal/".

## Where things go
- One canonical note per topic. Add to the note that owns the topic; create a note only when
  nothing covers it.
- Split hubs: file into the child that owns the topic.
  Meridia: fleets → "Work/Meridia Fleet Analytics.md"; customer and competitor signals →
  "Work/Meridia Customer Signals.md"; access, trials and support → "Work/Meridia Support & Access
  Process.md"; roadmap items, UX decisions and bugs → "Work/Meridia Backlog & Roadmap.md";
  everything else → "Work/Meridia.md".
  PSG Labs → detail in "Work/PSG Labs Prototype Catalog.md". AI Orchestration Pipeline
  ("Work/AI Pipeline/AI Orchestration Pipeline.md") → context material in
  "Work/AI Pipeline/AI Pipeline Context Architecture.md". Insights APIs → customer demand in
  "Work/Insights API Demand & Customers.md".
- Cross-product material: "Work/Decision Log.md" (decisions spanning products), "Work/Customer
  Signals — Cross-Product.md", "Work/Recent Deals.md", "Work/Competitors/Competitor News & Market Signals.md".
- Single-product decisions live in the product note, not the Decision Log.
- A meeting is filed by topic, like a thread: each decision, fact or finding goes under the
  heading of the note that owns it. One meeting often feeds several notes.
- A meeting note in "Work/Meetings/", named "Topic — Subtitle YYYY-MM-DD.md", holds only what no
  existing note covers. When everything has a home, there is no meeting note.
- Never append to "Work/Work.md" or any other MOC: they are links only.
- People profiles live in "Work/People/".

## Appending to an existing note
- Pick the "##" heading that owns the topic and copy it exactly.
- Notes are structured by theme, not by date. Never add a dated heading or a changelog entry.
- Write the block as current fact. If it supersedes something in the note, say so in one clause
  ("replaces the 2026-08 plan to …"); Frank will tidy the old line.
- Keep an inline date on each fact: "(2026-10-07)".
- Decision Log bullets: "- **Decision** (YYYY-MM-DD, owner): what was decided; why in one line;
  scope or impact; [[link to the owning note]]".
- End each block with its source link, so a later check can tell this thread or meeting is filed.
- Size budget: hub notes ≤25 KB, sections ≤6 KB, meeting notes ≤8 KB. Keep additions to a few lines.

## New notes
Frontmatter, in this order:
---
type: note        # note | meeting | reference | idea | project | person
tags: [kebab-case, from the taxonomy only]
created: YYYY-MM-DD
updated: YYYY-MM-DD
status: active
summary: "One line saying what the note holds, for retrieval."
---
Then "# Title" matching the filename. Filenames are descriptive Title Case ("Insights API Rate
Limits.md"). Meeting notes use "type: meeting", a "source:" line, and sections Decisions, Action
items, Notes. "source:" holds the recording's link (the Wispr Flow share link or the Slack
permalink), so the meeting can be recognised if it comes in again.

## Tags
Topical tags come only from "_meta/Tag Taxonomy.md". Read it; do not guess or invent a tag.
Content type goes in "type:", never in tags. If unsure about the home, add "review/location"; if it
may be ephemera, "review/relevance"; if it may duplicate a note, "review/duplicate". Pair any
review tag with a one-line "review_note:".

## What to capture
Capture decisions and their reasons, facts and findings that stay true beyond this week, patterns,
and context a future reader would need. Do not capture action items, to-dos, next steps, "waiting
on X", or transient status. The one exception: a meeting note records the action items agreed in
that meeting. Never create a meeting note only to hold action items; without one, they stay out of
the vault.

## Links
Use [[wikilinks]] to related notes that exist (check with Glob). Link the source by its link: the
Slack permalink, or for a meeting the Wispr Flow share link.

## Style
Lead with the fact. Short sentences, active voice, British English. No preamble, no restating the
thread, no filler ("it's worth noting", "in order to"), no em dashes as decoration, no "not X but Y"
framing, no vague claims. Every sentence carries a fact.
`;
