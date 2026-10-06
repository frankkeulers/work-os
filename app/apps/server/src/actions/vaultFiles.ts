import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';

// The vault on disk (FR-9.x): where a note may go, what is there now, and how an append changes
// it. Only code writes to the vault, after approval; these helpers never write.

export class VaultPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultPathError';
  }
}

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const inside = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The nearest existing ancestor's real path, so a symlink can't lead out of the vault. */
async function realAncestor(p: string): Promise<string> {
  for (let dir = p; ; dir = dirname(dir)) {
    try {
      return join(await realpath(dir), relative(dir, p));
    } catch {
      if (dirname(dir) === dir) return p;
    }
  }
}

/**
 * A note path the model proposed, checked: relative, Markdown, no hidden folders (.obsidian,
 * .trash), and inside the vault after symlinks are resolved. Returns the normalised relative path.
 */
export async function checkNotePath(root: string, proposed: string): Promise<string> {
  const rel = normalize(proposed.trim()).replace(/^(\.\/)+/, '');
  if (!rel || isAbsolute(rel) || rel.startsWith('..')) throw new VaultPathError(`The note path ${proposed} is outside the vault.`);
  if (!rel.endsWith('.md')) throw new VaultPathError(`The note path ${proposed} is not a Markdown file.`);
  if (rel.split(sep).some((part) => part.startsWith('.'))) throw new VaultPathError(`The note path ${proposed} is in a hidden folder.`);
  const realRoot = await realpath(root).catch(() => root);
  if (!inside(realRoot, await realAncestor(join(root, rel)))) throw new VaultPathError(`The note path ${proposed} leads outside the vault.`);
  return rel;
}

/** The file's text, or null when there is none. */
export const readOrNull = (file: string) => readFile(file, 'utf8').catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));

const headingLevel = (line: string) => /^(#{1,6})\s/.exec(line)?.[1].length;

/**
 * Inserts `block` at the end of the section under `heading` (a full heading line, such as
 * "## Decisions"), before the next heading of the same or a higher level. Returns undefined if
 * the heading isn't there. `context` is the last few lines above the insertion point.
 */
export function insertUnderHeading(content: string, heading: string, block: string): { content: string; context: string[] } | undefined {
  const lines = content.split('\n');
  const want = heading.trim();
  const at = lines.findIndex((l) => l.trim() === want);
  const level = headingLevel(want);
  if (at < 0 || !level) return undefined;
  let end = lines.length;
  for (let i = at + 1; i < lines.length; i++) {
    const l = headingLevel(lines[i]);
    if (l && l <= level) {
      end = i;
      break;
    }
  }
  let last = end;
  while (last > at + 1 && lines[last - 1].trim() === '') last--;
  const before = lines.slice(0, last);
  const tail = lines.slice(end); // the next heading onwards, with the final newline's empty line
  const out = [...before, '', ...block.replace(/\s+$/, '').split('\n'), ...(tail.length ? ['', ...tail] : [])];
  const text = out.join('\n') + (!tail.length && content.endsWith('\n') ? '\n' : '');
  return { content: text, context: before.filter((l) => l.trim() !== '').slice(-3) };
}
