import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

// Read-only access to one folder for draft calls (FR-9.1): the model may use Read, Grep and Glob,
// and only inside `root`. Checked twice, in a PreToolUse hook (which runs before any permission
// rule) and in canUseTool, so neither a default allow nor a symlink widens it.

export const READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

export type ReadVerdict = { ok: true } | { ok: false; reason: string };

async function real(p: string): Promise<string> {
  for (let dir = p; ; dir = dirname(dir)) {
    try {
      return join(await realpath(dir), relative(dir, p));
    } catch {
      if (dirname(dir) === dir) return p;
    }
  }
}

const within = (root: string, p: string) => {
  const rel = relative(root, p);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

const escapes = (pattern: unknown) => typeof pattern === 'string' && (isAbsolute(pattern) || pattern.split(/[\\/]/).includes('..') || pattern.startsWith('~'));

/** Whether this tool call stays inside `root`. */
export async function readVerdict(root: string, tool: string, input: unknown): Promise<ReadVerdict> {
  if (!(READ_TOOLS as readonly string[]).includes(tool)) return { ok: false, reason: `${tool} is not allowed here.` };
  const i = (input ?? {}) as Record<string, unknown>;
  const path = tool === 'Read' ? i.file_path : i.path;
  if (tool === 'Read' && typeof path !== 'string') return { ok: false, reason: 'Read needs a file_path.' };
  if (path !== undefined && typeof path !== 'string') return { ok: false, reason: 'The path must be a string.' };
  if (escapes(tool === 'Glob' ? i.pattern : i.glob)) return { ok: false, reason: 'Patterns must stay inside the vault.' };
  const realRoot = await real(resolve(root));
  const target = await real(resolve(root, path ?? '.'));
  return within(realRoot, target) ? { ok: true } : { ok: false, reason: 'Only files inside the vault can be read.' };
}
