import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import type { Item, Me } from '@work-os/shared';
import { londonParts } from '@work-os/shared';

// Before a vault draft (FR-9.6): code looks for notes that may already hold this thread or meeting,
// so the draft has to weigh them. A note that links to the source is a strong match. For a meeting,
// a note on the same London date that names someone who was there is strong too; one on the same
// date that names no one is weak. Meeting notes come from Plaud, Teams and pasted summaries as well
// as Work OS, so their source lines never match: the date and the people are what they share.
// Reads only.

export const MAX_EXISTING = 5;
const MAX_NOTE_BYTES = 1_000_000;
const HEAD_LINES = 40; // the frontmatter and the Attendees line sit in the head of a note

export interface ExistingNote {
  path: string; // relative to the vault
  title: string;
  summary?: string;
  date?: string;
  strength: 'strong' | 'weak';
  why: string[];
}

async function* notes(root: string, dir = root): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // no sandbox yet, or a folder that went away
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // .obsidian, .trash: the same rule as checkNotePath
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* notes(root, p);
    else if (e.isFile() && e.name.endsWith('.md')) yield p;
  }
}

function frontmatter(text: string): Record<string, string> {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out: Record<string, string> = {};
  for (const line of fm?.[1].split(/\r?\n/) ?? []) {
    const m = /^([A-Za-z_]+):\s*(.*)$/.exec(line);
    if (m) out[m[1].toLowerCase()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** "Day, Lanny" also as "Lanny Day". */
const spellings = (name: string) => {
  const n = name.trim().replace(/\s+/g, ' ');
  const m = /^([^,]+),\s*(.+)$/.exec(n);
  return m ? [n, `${m[2]} ${m[1]}`] : [n];
};

/** Who else was in the meeting: participants and calendar invitees, not Frank. */
function others(item: Item, me: Me): string[] {
  const self = new Set(item.participants.filter((p) => p.id === me.id).map((p) => p.name.trim().toLowerCase()));
  const cal = item.meeting?.calendar;
  const people = [...item.participants, ...(cal?.organizer ? [cal.organizer] : []), ...(cal?.invitees ?? [])];
  return [...new Set(people.filter((p) => p.id !== me.id && !self.has(p.name.trim().toLowerCase())).map((p) => p.name.trim()))].filter((n) => n.length > 2);
}

/**
 * Notes, in the vault or in the dry-run sandbox, that may already hold this item. Strong first, at
 * most MAX_EXISTING. `skip`: notes that link to sources without filing them, such as the Tasks note (UX-5).
 */
export async function findExistingNotes(o: { roots: string[]; item: Item; me: Me; links: string[]; skip?: string[] }): Promise<ExistingNote[]> {
  const skip = new Set((o.skip ?? []).map((p) => p.trim().replace(/^(\.\/)+/, '')));
  const date = o.item.kind === 'meeting' && o.item.meeting ? londonParts(o.item.meeting.start).dateKey : undefined;
  if (!o.links.length && !date) return [];
  const people = date ? others(o.item, o.me).map((n) => ({ name: n, re: new RegExp(`(^|[^\\p{L}])(${spellings(n).map(escape).join('|')})($|[^\\p{L}])`, 'iu') })) : [];
  const seen = new Set<string>();
  const found: ExistingNote[] = [];
  for (const root of o.roots) {
    for await (const file of notes(root)) {
      const rel = relative(root, file).split(sep).join('/');
      if (seen.has(rel) || skip.has(rel)) continue; // the sandbox copy, listed first, stands in for the vault note
      seen.add(rel);
      const size = await stat(file).then((s) => s.size, () => 0);
      if (!size || size > MAX_NOTE_BYTES) continue;
      const nameDates: string[] = basename(file).match(/\d{4}-\d{2}-\d{2}/g) ?? [];
      const text = await readFile(file, 'utf8').catch(() => '');
      const fm = frontmatter(text);
      const why: string[] = [];
      if (o.links.some((l) => text.includes(l))) why.push('same source link');
      let strong = why.length > 0;
      let weak = false;
      if (date && (nameDates.includes(date) || fm.created === date || fm.date === date)) {
        why.push('same date');
        const head = text.split(/\r?\n/).slice(0, HEAD_LINES).join('\n');
        const met = people.filter((p) => p.re.test(head)).map((p) => `attendee: ${p.name}`);
        why.push(...met);
        if (met.length) strong = true;
        else weak = fm.type === 'meeting';
      }
      if (!strong && !weak) continue;
      const title = /^#\s+(.+)$/m.exec(text)?.[1].trim() ?? basename(file, '.md');
      found.push({ path: rel, title, ...(fm.summary && { summary: fm.summary.slice(0, 300) }), ...((fm.date || fm.created) && { date: fm.date || fm.created }), strength: strong ? 'strong' : 'weak', why });
    }
  }
  return found.sort((a, b) => (a.strength === b.strength ? b.why.length - a.why.length || a.path.localeCompare(b.path) : a.strength === 'strong' ? -1 : 1)).slice(0, MAX_EXISTING);
}
