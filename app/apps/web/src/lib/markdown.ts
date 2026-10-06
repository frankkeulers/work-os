// Draft text is stored as markdown. The rich-text editor edits the body; these helpers keep the
// parts it doesn't understand (YAML front matter, Obsidian wiki links) intact.

const FRONT_MATTER = /^---\n[\s\S]*?\n---(?:\n|$)/;

/** Splits a leading YAML front-matter block (fences included) from the body. */
export function splitFrontMatter(md: string): { frontMatter: string; body: string } {
  const m = md.match(FRONT_MATTER);
  if (!m) return { frontMatter: '', body: md };
  return { frontMatter: m[0].replace(/\n$/, ''), body: md.slice(m[0].length) };
}

export const joinFrontMatter = (frontMatter: string, body: string) => (frontMatter ? `${frontMatter}\n${body}` : body);

/** The key: value lines of a front-matter block, for display. */
export function frontMatterFields(frontMatter: string): [string, string][] {
  return frontMatter
    .split('\n')
    .slice(1, -1)
    .map((l): [string, string] => {
      const i = l.indexOf(':');
      return i < 0 ? [l.trim(), ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"(.*)"$/, '$1')];
    })
    .filter(([k]) => k);
}

/**
 * Undoes the escaping a CommonMark serialiser applies to Obsidian syntax: `\[\[Note\]\]` back to
 * `[[Note]]`. Without this, every edit would break the vault's wiki links.
 */
export const tidySerialised = (md: string) => md.replace(/\\\[\\\[(.+?)\\\]\\\]/g, '[[$1]]').replace(/\n+$/, '');
