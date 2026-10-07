import type { ActionType, Draft, Settings } from '@work-os/shared';
import type { ItemRec } from './types';
import { ancestorIdsOf, mockCatalogue } from './seed/catalogue';
import { PEOPLE } from './seed/people';

// Simulated Sonnet drafts (FR-9.1, FR-10.2). Scripted templates where the seed has them,
// otherwise a plausible draft built from the thread.

// Under the excluded Product org pages, so the executor refuses it (FR-10.6).
const OFF_LIST_PAGE = { pageId: '48213377', pageTitle: 'Product org › Roadmap process' };

const slug = (s: string) =>
  s
    .replace(/[^\p{L}\p{N} ]/gu, '')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join(' ');

const londonDate = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
const longDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Europe/London', day: 'numeric', month: 'short', year: 'numeric' });

function stableNumber(seed: string, min: number, max: number) {
  let h = 0;
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return min + (h % (max - min));
}

const SOURCE_LABEL = { slack: 'Slack', outlook: 'Outlook', teams: 'Teams', plaud: 'Plaud', wispr: 'Wispr Flow' } as const;

export function buildDraft(
  rec: ItemRec,
  type: ActionType,
  settings: Settings,
  clock: string,
  opts: { forceOffList?: boolean; attempt: number },
): Draft {
  const summary = rec.decision?.summary ?? rec.script.summary;
  const src = SOURCE_LABEL[rec.item.source];
  const what = rec.item.kind === 'email' ? 'email' : rec.item.kind === 'meeting' ? 'meeting transcript' : rec.item.kind === 'chat' || rec.item.kind === 'dm' ? 'chat' : 'thread';
  const tokens = stableNumber(rec.item.id + type + opts.attempt, type === 'vault_note' ? 26000 : 15000, type === 'vault_note' ? 36000 : 21000);
  const meta = {
    model: type === 'vault_note' ? settings.models.draftVault : settings.models.draftConfluence,
    promptVersion: type === 'vault_note' ? 'draft-vault v2' : 'draft-confluence v3',
    durationMs: stableNumber(rec.item.id + opts.attempt, 31000, 52000),
    tokens,
    edited: false,
  };

  if (type === 'vault_note') {
    const t = rec.drafts?.vault;
    if (t) return { ...meta, ...t };
    const hint = rec.decision?.vault.targetHint ?? rec.script.vault;
    const bullets = rec.item.messages.map((m) => `- ${PEOPLE[m.authorId] ?? m.authorId}: ${m.text}`).join('\n');
    if (hint?.includes(' › ')) {
      const [path, heading] = hint.split(' › ');
      return {
        ...meta,
        kind: 'vault_append',
        path,
        heading: `## ${heading}`,
        context: [`## ${heading}`, '- (earlier entries)'],
        content: `- ${londonDate(clock)} · ${summary}\n  Source: [${src} ${rec.item.title}](permalink)`,
      };
    }
    const path = hint ?? `Inbox/${src}/${londonDate(clock)} ${slug(summary)}.md`;
    return {
      ...meta,
      kind: 'vault_new',
      path,
      content: `---\ntype: note\nsource: ${rec.item.source}\n${rec.item.source === 'slack' ? 'channel' : 'from'}: "${rec.item.title}"\ncreated: ${londonDate(clock)}\ntags: [${rec.item.source}]\n---\n# ${summary.replace(/\.$/, '')}\n\n${bullets}\n\nSource: [${src} ${what}](permalink)`,
    };
  }

  const t = rec.drafts?.confluence;
  const hint = rec.decision?.confluence.targetHint ?? rec.script.confluence;
  // The picker: the page the triage hint names if it is in the catalogue, else the first page
  // that isn't a hub.
  let page = t ? { pageId: t.pageId, pageTitle: t.pageTitle } : undefined;
  if (!page) {
    const catalogue = mockCatalogue(settings.confluence);
    const picked = catalogue.find((p) => p.title === hint) ?? catalogue.find((p) => !p.hub);
    page = picked ? { pageId: picked.id, pageTitle: picked.title } : { pageId: '39004512', pageTitle: 'Insights APIs › Decisions' };
  }
  if (opts.forceOffList) page = OFF_LIST_PAGE;
  return {
    ...meta,
    kind: 'confluence',
    ...page,
    ancestorIds: ancestorIdsOf(page.pageId),
    section: t?.section ?? 'Decisions',
    baseVersion: (t?.baseVersion ?? stableNumber(page.pageId, 6, 40)) + (opts.attempt > 1 ? 2 : 0),
    title: t?.title ?? `${longDate(clock)} · ${slug(summary)}`,
    content: t?.content ?? `${summary}\n\nContext: ${rec.item.messages[0]?.text ?? ''}\n\nSource: ${src} ${rec.item.title} ${what}`,
  };
}
