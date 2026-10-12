import type { QueryFn } from './adapter';

// A stand-in for the Agent SDK in tests and `--fakes` runs: never a live call. It answers triage
// batches by keyword, the way a model might, so lanes fill predictably:
//   now    go/no-go, "before Thursday", urgent, asap
//   today  a question, or check / review / decision
//   follow someone else has picked it up: "looking into it", "on it", "will get back to you"
//   none   anything else
// Confluence for launch, licensing and pricing talk; the vault for release notes and ideas.
// Routing joins pieces that name the same PR or ticket, and Frank's own piece to the topic of the
// person he @-mentions (topicsFor).
// A vault draft request gets a new note under Inbox/, named after the thread. The Confluence page
// picker takes the first page in the catalogue that isn't a hub, and the draft goes to that page's
// first section; the people check flags words about how someone works. A to-do with Frank's
// information keeps the open steps and adds one from the information (todoFor).
// A settle check settles every ask unless Frank's reply only holds it ("later", "on it", a question)
// or hands it on ("over to you", "can you take this"), which leaves it open and handed on; a finish
// check (CK-2.10) likewise, judged on the latest message since. The policy tuner (FR-15.9) adds a
// ready rule [R9] for settled decisions and raises the policy's version.
// A To Do plan (FR-16.6) sizes each step by its first word and wants "today" steps by 17:00.

export interface FakeClaude {
  query: QueryFn;
  calls: { system: string; prompt: string; options: Parameters<QueryFn>[0]['options'] }[];
  /** Replaces the next answers' text (for bad-output tests), in order. */
  nextTexts: string[];
  /** Throws this on the next call instead of answering. */
  failNext?: unknown;
  /** An API error (the SDK's assistant `error`, e.g. invalid_request) for calls whose prompt it picks. */
  apiErrorFor?: (prompt: string) => string | undefined;
}

type Thread = { id: string; messages: { author: string; text: string }[] };

const pick = (text: string) => {
  if (/go\/no-go|before thursday|urgent|asap/i.test(text)) return 'now';
  if (/\?|\b(check|review|decision)\b/i.test(text)) return 'today';
  if (/\b(looking into it|on it|will get back to you)\b/i.test(text)) return 'follow';
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

type Conversation = { topics: { id: string; summary: string; recent: { author: string; text: string }[] }[]; pieces: Thread[] };

// A PR number or a ticket key: the fake's idea of a subject.
const SUBJECT = /\b(PR[ -]?\d+|[A-Z][A-Z0-9]+-\d+)\b/gi;
const subjects = (text: string) => new Set([...text.matchAll(SUBJECT)].map((m) => m[1].toUpperCase().replace(/[ -]/, '')));

/**
 * Routing: a piece joins the open topic or earlier piece that names the same PR or ticket; a piece
 * of Frank's own joins the one written by the person he @-mentions; else "new".
 */
export function topicsFor(convs: Conversation[]) {
  return {
    assignments: convs.flatMap((c) => {
      const seen: { id: string; subjects: Set<string>; authors: Set<string> }[] = c.topics.map((t) => ({
        id: t.id,
        subjects: subjects([t.summary, ...t.recent.map((m) => m.text)].join(' ')),
        authors: new Set(t.recent.map((m) => m.author)),
      }));
      return c.pieces.map((p) => {
        const text = p.messages.map((m) => m.text).join(' ');
        const mine = subjects(text);
        const fromMe = p.messages.every((m) => m.author === 'me');
        const named = (x: { authors: Set<string> }) => fromMe && [...x.authors].some((a) => a !== 'me' && text.includes(`@${a}`));
        const match = seen.find((x) => [...mine].some((k) => x.subjects.has(k))) ?? seen.find(named);
        seen.push({ id: p.id, subjects: mine, authors: new Set(p.messages.map((m) => m.author)) });
        return { id: p.id, topic: match?.id ?? 'new' };
      });
    }),
  };
}

/** A vault draft: "filed" when the check found a strong match (FR-9.6), otherwise a new note for the thread. */
export function vaultNoteFor(prompt: string) {
  const existing = (/<existing-notes>\n([\s\S]*?)\n<\/existing-notes>/.exec(prompt)?.[1] ?? '')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { path: string; strength: string; why: string[] });
  const strong = existing.find((n) => n.strength === 'strong');
  if (strong) return { kind: 'filed', path: strong.path, why: `${strong.path} already holds it (${strong.why.join(', ')}).` };
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

/** A Confluence draft: alreadyFiled when a section already links to the thread (FR-10.7), otherwise an entry for the first page offered. */
export function confluenceEntryFor(prompt: string) {
  const filed = (/<already-filed>\n([\s\S]*?)\n<\/already-filed>/.exec(prompt)?.[1] ?? '')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { pageId: string; section: string });
  if (filed[0]) return { alreadyFiled: true, pageId: filed[0].pageId, section: filed[0].section, why: 'The section already has the entry for this thread.' };
  const pages = JSON.parse(/<confluence-pages>\n([\s\S]*?)\n<\/confluence-pages>/.exec(prompt)?.[1] ?? '[]') as { pageId: string; sections: { level: number; heading: string }[] }[];
  const t = JSON.parse(/<thread>\n([\s\S]*?)\n<\/thread>/.exec(prompt)?.[1] ?? '{}') as { title?: string; permalink?: string; messages?: { text: string }[] };
  const page = pages[0];
  const section = page?.sections.find((x) => x.level >= 2) ?? page?.sections[0];
  return { pageId: page?.pageId ?? 'none', section: section?.heading ?? 'none', title: `${t.title ?? 'Thread'} update`, content: `${t.messages?.[0]?.text ?? ''}\n\n[Slack thread](${t.permalink ?? ''})` };
}

/**
 * A to-do with Frank's information (FR-9.12): the open steps as they are, and one more step taken
 * from the information's first line, due on the date in it when there is one.
 */
export function todoFor(prompt: string) {
  const steps = (/<open-steps>\n([\s\S]*?)\n<\/open-steps>/.exec(prompt)?.[1] ?? '')
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l) as { step: string; due?: string });
  const info = /<additional-information>\n([^\n]*)/.exec(prompt)?.[1];
  const due = info && /\b(\d{4}-\d{2}-\d{2})\b/.exec(info)?.[1];
  return { steps: [...steps, ...(info ? [{ step: `From Frank: ${info}`, ...(due && { due }) }] : [])] };
}

type Check = { itemId: string; itemRevision: number; asks: { index: number }[]; reply?: { text: string }[]; since?: { text: string }[] };

const HANDED_ON = /\b(over to you|handing (it|this) (on|over)|can you (take|pick up|handle) (this|it))\b/i;
const HOLDING = /\b(later|on it|let me|will|tomorrow)\b|\?\s*$|^\W*$/i;

/** Settle and finish checks: a holding reply (or latest message) settles nothing; any other settles every ask. */
export function settleFor(checks: Check[]) {
  return {
    decisions: checks.map((c) => {
      const text = c.reply ? c.reply.map((m) => m.text).join(' ') : (c.since?.at(-1)?.text ?? '');
      const handedOn = !!c.reply && HANDED_ON.test(text);
      const settled = !handedOn && !HOLDING.test(text);
      const why = handedOn ? 'They have the next move; you still own the outcome.' : c.reply ? (settled ? 'Your reply answers it.' : 'You said you would come back to it.') : settled ? 'The latest messages settle it.' : 'It still waits on you.';
      return { itemId: c.itemId, itemRevision: c.itemRevision, asks: c.asks.map((a) => ({ index: a.index, settled, why })), allSettled: settled, ...(handedOn && { handedOn: true }) };
    }),
  };
}

type PlanTodo = { id: string; step: string; deadline?: string };

/**
 * To Do plans (FR-16.6): a send or share is 15 minutes and sure; booking 15; a review an hour; a
 * write two hours; anything else 30, unsure. "today" in the step wants it by 17:00 London today,
 * if that is before its deadline; the clamp drops it otherwise.
 */
export function scheduleFor(todos: PlanTodo[], now: Date) {
  const size = (s: string): [number, 'low' | 'medium' | 'high'] =>
    /^(send|share|reply)\b/i.test(s) ? [15, 'high'] : /^book\b/i.test(s) ? [15, 'high'] : /\breview\b/i.test(s) ? [60, 'medium'] : /^(write|draft)\b/i.test(s) ? [120, 'medium'] : [30, 'low'];
  const today = new Date(now);
  today.setUTCHours(16, 0, 0, 0); // 17:00 BST
  return {
    todos: todos.map((t) => {
      const [effortMinutes, confidence] = size(t.step);
      const soon = /\btoday\b/i.test(t.step);
      return { id: t.id, effortMinutes, confidence, estimateWhy: `A ${effortMinutes}-minute step, by the fake.`, ...(soon && { deadline: today.toISOString(), deadlineWhy: 'The step says today.' }) };
    }),
  };
}

type DoneTodo = { id: string; step: string; canReply?: boolean; itemOpen?: boolean; otherTodos?: string[] };

/**
 * Follow-ups (FR-16.11): a reply where Frank can answer and the step sent, shared or confirmed
 * something; closing the item when it was the last thing on it; a review leads to sending the
 * comments; a decision or a written piece is worth filing.
 */
export function followupFor(todos: DoneTodo[]) {
  return {
    todos: todos.map((t) => ({
      id: t.id,
      suggestions: [
        ...(t.canReply && /^(send|share|reply|confirm)\b/i.test(t.step) ? [{ kind: 'reply', why: 'They asked for it, by the fake.', reply: { text: `Done: ${t.step.replace(/^\w+\s/, '').replace(/\.$/, '')}.` } }] : []),
        ...(t.itemOpen && !t.otherTodos?.length ? [{ kind: 'mark_source_done', why: 'Nothing else is open on it, by the fake.' }] : []),
        ...(/^review\b/i.test(t.step) ? [{ kind: 'add_todo', why: 'A review leads to comments, by the fake.', todo: { step: `Send comments on ${t.step.replace(/^review\s+/i, '')}` } }] : []),
        ...(/\b(decide|decision|spec|write)\b/i.test(t.step) ? [{ kind: 'file_note', why: 'Worth keeping, by the fake.' }] : []),
      ],
    })),
  };
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
        const apiError = fake.apiErrorFor?.(prompt);
        if (apiError) yield { type: 'assistant', error: apiError, message: { content: [] } };
        const m = /<threads>\n([\s\S]*)\n<\/threads>/.exec(prompt);
        const convs = /<conversations>\n([\s\S]*)\n<\/conversations>/.exec(prompt);
        const checks = /<checks>\n([\s\S]*)\n<\/checks>/.exec(prompt);
        const todos = /<todos>\n([\s\S]*)\n<\/todos>/.exec(prompt);
        const done = /<done>\n([\s\S]*)\n<\/done>/.exec(prompt);
        const now = /^Now: (\S+)/.exec(prompt)?.[1];
        // A tuner request quotes a whole prompt, so it is recognised first.
        const answer = prompt.startsWith('<policy>')
          ? tuneFor(prompt)
          : convs
          ? topicsFor(JSON.parse(convs[1]) as Conversation[])
          : checks
          ? settleFor(JSON.parse(checks[1]) as Check[])
          : done
          ? followupFor(JSON.parse(done[1]) as DoneTodo[])
          : todos
          ? scheduleFor(JSON.parse(todos[1]) as PlanTodo[], new Date(now ?? Date.now()))
          : prompt.includes('<open-steps>')
          ? todoFor(prompt)
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
          modelUsage: { 'claude-haiku-5-5': { inputTokens: 1200, outputTokens: 180, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0012 } },
        };
      })();
    },
  };
  return fake;
}

/** A revised prompt, the version raised: the filing policy gains a Ready rule; another loop's prompt a closing line. */
export function tuneFor(prompt: string) {
  const policy = /^<policy>\n([\s\S]*?)\n<\/policy>/.exec(prompt)?.[1] ?? '';
  const loop = /<loop>(\w+)<\/loop>/.exec(prompt)?.[1] ?? 'filing';
  const raised = policy.replace(/(<!-- prompt: [\w-]+ v)(\d+)/, (_m, a: string, v: string) => `${a}${Number(v) + 1}`);
  if (loop === 'filing') {
    const rule = '- [R9] A decision on a named product, stated as settled by its owner: its Confluence entry.';
    return { policy: raised.replace('## To-dos', `${rule}\n\n## To-dos`), changes: [{ rule: 'R9', kind: 'added', what: 'Settled product decisions from their owner are ready to approve.' }] };
  }
  const line = 'When in doubt between two answers, take the stricter one.';
  return { policy: `${raised}\n\n${line}`, changes: [{ kind: 'added', what: 'Prefers the stricter answer when the thread leaves it open.' }] };
}

/** For runs that must never reach Claude: any call fails loudly. */
export const noClaude: QueryFn = () => {
  throw new Error('This run may not call Claude.');
};
