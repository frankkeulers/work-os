import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Item } from '@work-os/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { itemLinks } from './alreadyFiled';
import { findExistingNotes, MAX_EXISTING } from './vaultCandidates';

// FR-9.6 against a synthetic vault in a temp folder: which notes the check offers the draft before
// it files a meeting or thread. Never the real vault.

let dir: string;
let vault: string;
let sandbox: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'workos-candidates-'));
  vault = join(dir, 'vault');
  sandbox = join(dir, 'sandbox/vault');
  await mkdir(vault, { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const put = async (root: string, path: string, text: string) => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), text);
};
const me = { id: 'wispr:me' };
const SHARE = 'https://notes.wisprflow.ai/shared/7mdOM3uv';
// The SkyWatch meeting that was filed twice: Wispr's recording of a meeting already filed from Teams.
const meeting = (over: Partial<Item> = {}): Item => ({
  id: 'wispr:55b33757',
  source: 'wispr',
  kind: 'meeting',
  title: 'SkyWatch satellite data',
  permalink: SHARE,
  participants: [
    { id: 'wispr:me', name: 'Frank Keulers' },
    { id: 'wispr:contact:1', name: 'Lanny Day' },
  ],
  messages: [],
  messageCount: 0,
  lastActivityAt: '2026-10-05T14:00:00.000Z',
  revision: 1,
  meeting: { start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T13:45:00.000Z' },
  schemaVersion: 1,
  ...over,
});
const meetingNote = (o: { created?: string; attendees?: string; source?: string } = {}) =>
  `---\ntype: meeting\ncreated: ${o.created ?? '2026-10-05'}\nsource: ${o.source ?? 'Teams transcript'}\nsummary: "Imagery behind one API."\n---\n\n# Frank × Lanny — Satellite Imagery 2026-10-05\n\n**Attendees:** ${o.attendees ?? 'Frank Keulers, [[Lanny Day]]'}\n\n## Decisions\n`;
const find = (item: Item, roots = [vault]) => findExistingNotes({ roots, item, me, links: itemLinks(item) });

describe('findExistingNotes (FR-9.6)', () => {
  it('skips the Tasks note, which links to sources without filing them (UX-5)', async () => {
    await put(vault, 'Work/Tasks.md', `# Tasks\n\n- [ ] Send the sample [SkyWatch](${SHARE})\n`);
    await put(vault, 'Work/SkyWatch.md', `# SkyWatch\n\nFiled from [the meeting](${SHARE}).\n`);
    const item = meeting({ kind: 'thread', meeting: undefined });
    expect((await findExistingNotes({ roots: [vault], item, me, links: itemLinks(item), skip: ['Work/Tasks.md'] })).map((n) => n.path)).toEqual(['Work/SkyWatch.md']);
  });

  it('finds a meeting filed from another recording: same day, someone who was there, another title and source', async () => {
    await put(vault, 'Work/Meetings/Frank × Lanny — Satellite Imagery Integration Path 2026-10-05.md', meetingNote());
    expect(await find(meeting())).toEqual([
      {
        path: 'Work/Meetings/Frank × Lanny — Satellite Imagery Integration Path 2026-10-05.md',
        title: 'Frank × Lanny — Satellite Imagery 2026-10-05',
        summary: 'Imagery behind one API.',
        date: '2026-10-05',
        strength: 'strong',
        why: ['same date', 'attendee: Lanny Day'],
      },
    ]);
  });

  it('matches the date from the frontmatter alone, and a calendar invitee written "Last, First"', async () => {
    await put(vault, 'Work/Meetings/Imagery sync.md', meetingNote({ attendees: 'Frank Keulers, Peter Fen' }));
    const item = meeting({
      participants: [{ id: 'wispr:me', name: 'Frank Keulers' }],
      meeting: { start: '2026-10-05T13:00:00.000Z', end: '2026-10-05T13:45:00.000Z', calendar: { eventId: 'e1', title: 'Imagery', invitees: [{ id: 'outlook:p', name: 'Fen, Peter' }] } },
    });
    expect((await find(item)).map((n) => [n.path, n.strength, n.why])).toEqual([['Work/Meetings/Imagery sync.md', 'strong', ['same date', 'attendee: Fen, Peter']]]);
  });

  it('offers a meeting note from the same day with no one in common as weak, and ignores Frank himself', async () => {
    await put(vault, 'Work/Meetings/DAP Weekly 2026-10-05.md', meetingNote({ attendees: 'Frank Keulers, Ankush Khapre' }));
    await put(vault, 'Work/Notes 2026-10-05.md', '---\ntype: note\n---\n# Notes\n\nFrank Keulers wrote this.\n'); // same day, not a meeting note
    expect((await find(meeting())).map((n) => [n.path, n.strength, n.why])).toEqual([['Work/Meetings/DAP Weekly 2026-10-05.md', 'weak', ['same date']]]);
  });

  it('skips notes from other days', async () => {
    await put(vault, 'Work/Meetings/Frank × Lanny — Roadmap 2026-09-21.md', meetingNote({ created: '2026-09-21' }));
    expect(await find(meeting())).toEqual([]);
  });

  it('finds a note that links to the source on any day, for a Slack thread too', async () => {
    const thread = meeting({ id: 'slack:C1:1.0', source: 'slack', kind: 'thread', permalink: 'https://psg.slack.com/archives/C1/p10', meeting: undefined });
    await put(vault, 'Work/Decision Log.md', '# Decision Log\n\n- **Bulk export first** ([thread](https://psg.slack.com/archives/C1/p10))\n');
    await put(vault, 'Work/Other.md', '# Other\n\n[thread](https://psg.slack.com/archives/C1/p99)\n');
    expect((await find(thread)).map((n) => [n.path, n.strength, n.why])).toEqual([['Work/Decision Log.md', 'strong', ['same source link']]]);
  });

  it('ignores a placeholder link, hidden folders and other files', async () => {
    const noLink = meeting({ permalink: 'wispr-flow://', meeting: undefined });
    expect(itemLinks(noLink)).toEqual([]);
    await put(vault, '.trash/Frank × Lanny 2026-10-05.md', meetingNote());
    await put(vault, 'Work/Meetings/Frank × Lanny 2026-10-05.txt', meetingNote());
    expect(await find(noLink)).toEqual([]);
    expect(await find(meeting())).toEqual([]);
  });

  it('counts the dry-run sandbox, whose copy stands in for the vault note', async () => {
    await put(vault, 'Work/Meetings/Imagery 2026-10-05.md', meetingNote({ attendees: 'Frank Keulers' }));
    await put(sandbox, 'Work/Meetings/Imagery 2026-10-05.md', meetingNote({ source: SHARE }));
    await put(sandbox, 'Inbox/SkyWatch.md', `# SkyWatch\n\n[recording](${SHARE})\n`);
    const found = await find(meeting(), [sandbox, vault]);
    expect(found.map((n) => [n.path, n.why])).toEqual([
      ['Work/Meetings/Imagery 2026-10-05.md', ['same source link', 'same date', 'attendee: Lanny Day']],
      ['Inbox/SkyWatch.md', ['same source link']],
    ]);
  });

  it(`lists strong matches first, and at most ${MAX_EXISTING}`, async () => {
    for (let i = 0; i < 4; i++) await put(vault, `Work/Meetings/Weekly ${i} 2026-10-05.md`, meetingNote({ attendees: 'Frank Keulers' }));
    for (let i = 0; i < 3; i++) await put(vault, `Work/Meetings/Lanny ${i} 2026-10-05.md`, meetingNote());
    const found = await find(meeting());
    expect(found).toHaveLength(MAX_EXISTING);
    expect(found.map((n) => n.strength)).toEqual(['strong', 'strong', 'strong', 'weak', 'weak']);
  });
});
