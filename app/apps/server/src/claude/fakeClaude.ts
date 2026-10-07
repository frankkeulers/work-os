import type { QueryFn } from './adapter';

// A stand-in for the Agent SDK in tests and `--fakes` runs: never a live call. It answers triage
// batches by keyword, the way a model might, so lanes fill predictably:
//   now    go/no-go, "before Thursday", urgent, asap
//   today  a question, or check / review / decision
//   none   anything else
// Confluence for launch, licensing and pricing talk; the vault for release notes and ideas.
// Routing joins pieces that name the same PR or ticket (topicsFor).
// A vault draft request gets a new note under Inbox/, named after the thread. The Confluence page
// picker takes the first page in the catalogue that isn't a hub, and the draft goes to that page's
// first section; the people check flags words about how someone works.

export interface FakeClaude {
  query: QueryFn;
  calls: { system: string; prompt: string; options: Parameters<QueryFn>[0]['options'] }[];
  /** Replaces the next answers' text (for bad-output tests), in order. */
  nextTexts: string[];
  /** Throws this on the next call instead of answering. */
  failNext?: unknown;
}

type Thread = { id: string; messages: { author: string; text: string }[] };

const pick = (text: string) => {
  if (/go\/no-go|before thursday|urgent|asap/i.test(text)) return 'now';
  if (/\?|\b(check|review|decision)\b/i.test(text)) return 'today';
  return 'none';
};

export function answerFor(threads: Thread[]) {
  return {
    decisions: threads.map((t) => {
      const text = t.messages
        .filter((m) => m.author !== 'me')
        .map((m) => m.text)
        .join(' ');
      const first = t.messages[0]?.text ?? '';
      return {
        id: t.id,
        attention: pick(text),
        confluence: /launch|licen[cs]|pricing/i.test(text) ? { suggested: true, targetHint: 'Launch' } : { suggested: false },
        vault: /release notes|idea/i.test(text) ? { suggested: true, targetHint: 'Product notes' } : { suggested: false },
        containsPeopleObservations: false,
        summary: first.length > 100 ? `${first.slice(0, 99)}…` : first || 'Thread',
        reason: 'Fake triage for tests.',
      };
    }),
  };
}

type Conversation = { topics: { id: string; summary: string; recent: { text: string }[] }[]; pieces: Thread[] };

// A PR number or a ticket key: the fake's idea of a subject.
const SUBJECT = /\b(PR[ -]?\d+|[A-Z][A-Z0-9]+-\d+)\b/gi;
const subjects = (text: string) => new Set([...text.matchAll(SUBJECT)].map((m) => m[1].toUpperCase().replace(/[ -]/, '')));

/** Routing: a piece joins the open topic or earlier piece that names the same PR or ticket, else "new". */
export function topicsFor(convs: Conversation[]) {
  return {
    assignments: convs.flatMap((c) => {
      const seen: { id: string; subjects: Set<string> }[] = c.topics.map((t) => ({ id: t.id, subjects: subjects([t.summary, ...t.recent.map((m) => m.text)].join(' ')) }));
      return c.pieces.map((p) => {
        const mine = subjects(p.messages.map((m) => m.text).join(' '));
        const match = seen.find((x) => [...mine].some((k) => x.subjects.has(k)));
        seen.push({ id: p.id, subjects: mine });
        return { id: p.id, topic: match?.id ?? 'new' };
      });
    }),
  };
}

/** A new note for the thread in a vault draft request. */
export function vaultNoteFor(prompt: string) {
  const m = /<thread>\n([\s\S]*?)\n<\/thread>/.exec(prompt);
  const t = m ? (JSON.parse(m[1]) as Thread & { title: string; permalink?: string }) : { id: 'x', title: 'Thread', messages: [] };
  const name = t.title.replace(/[^A-Za-z0-9 -]/g, '').trim() || 'Thread';
  const first = t.messages[0]?.text ?? '';
  return { kind: 'new', path: `Inbox/${name}.md`, content: `---\ntags: [slack]\n---\n# ${name}\n\n${first}\n\n[Slack thread](${t.permalink ?? ''})\n` };
}

/** The first page that isn't a hub, in a Confluence page-picker request. */
export function confluencePickFor(prompt: string) {
  const lines = /<confluence-catalogue>\n([\s\S]*?)\n?<\/confluence-catalogue>/.exec(prompt)?.[1] ?? '';
  const pages = lines
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { id: string; hub?: boolean });
  const page = pages.find((p) => !p.hub) ?? pages[0];
  return page ? { candidates: [{ pageId: page.id, why: 'The first page that is not an index.' }] } : { noFit: true, reason: 'The catalogue is empty.' };
}

/** An entry for the first page offered in a Confluence draft request. */
export function confluenceEntryFor(prompt: string) {
  const pages = JSON.parse(/<confluence-pages>\n([\s\S]*?)\n<\/confluence-pages>/.exec(prompt)?.[1] ?? '[]') as { pageId: string; sections: { level: number; heading: string }[] }[];
  const t = JSON.parse(/<thread>\n([\s\S]*?)\n<\/thread>/.exec(prompt)?.[1] ?? '{}') as { title?: string; permalink?: string; messages?: { text: string }[] };
  const page = pages[0];
  const section = page?.sections.find((x) => x.level >= 2) ?? page?.sections[0];
  return { pageId: page?.pageId ?? 'none', section: section?.heading ?? 'none', title: `${t.title ?? 'Thread'} update`, content: `${t.messages?.[0]?.text ?? ''}\n\n[Slack thread](${t.permalink ?? ''})` };
}

const PEOPLE_RE = /\b(lazy|unreliable|performance issue|attitude|behaviour)\b/i;

export function fakeClaude(): FakeClaude {
  const fake: FakeClaude = {
    calls: [],
    nextTexts: [],
    query: ({ prompt, options }) => {
      const system = typeof options.systemPrompt === 'string' ? options.systemPrompt : '';
      fake.calls.push({ system, prompt, options });
      const fail = fake.failNext;
      fake.failNext = undefined;
      const scripted = fake.nextTexts.shift();
      return (async function* () {
        if (fail) throw fail;
        yield { type: 'system', subtype: 'init', mcp_servers: [] };
        const m = /<threads>\n([\s\S]*)\n<\/threads>/.exec(prompt);
        const convs = /<conversations>\n([\s\S]*)\n<\/conversations>/.exec(prompt);
        const answer = convs
          ? topicsFor(JSON.parse(convs[1]) as Conversation[])
          : prompt.includes('<vault-conventions>')
          ? vaultNoteFor(prompt)
          : prompt.includes('<confluence-catalogue>')
            ? confluencePickFor(prompt)
            : prompt.includes('<confluence-pages>')
            ? confluenceEntryFor(prompt)
            : prompt.startsWith('<entry>')
              ? { containsPeopleObservations: PEOPLE_RE.test(prompt), reason: PEOPLE_RE.test(prompt) ? 'Describes how a named person works.' : 'Facts only.' }
              : answerFor(m ? (JSON.parse(m[1]) as Thread[]) : []);
        const text = scripted ?? JSON.stringify(answer);
        yield {
          type: 'result',
          subtype: 'success',
          result: text,
          num_turns: 1,
          total_cost_usd: 0.0012,
          modelUsage: { 'claude-haiku-4-5': { inputTokens: 1200, outputTokens: 180, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0012 } },
        };
      })();
    },
  };
  return fake;
}

/** For runs that must never reach Claude: any call fails loudly. */
export const noClaude: QueryFn = () => {
  throw new Error('This run may not call Claude.');
};
