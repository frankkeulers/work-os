// Links to where an approved action writes: the Confluence page and the Obsidian note.

/** https://site/wiki/spaces/KEY/pages/ID, Confluence Cloud's canonical page address. */
export function confluencePageUrl(site: string, spaceKey: string, pageId: string) {
  return `${site.replace(/\/+$/, '')}/wiki/spaces/${encodeURIComponent(spaceKey)}/pages/${encodeURIComponent(pageId)}`;
}

/** The vault's name in Obsidian is its folder name. */
export const vaultName = (vaultPath: string) => vaultPath.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? vaultPath;

/** obsidian://open?vault=…&file=… opens the note in the Obsidian app. The .md extension is optional, so it is dropped. */
export function obsidianNoteUrl(vaultPath: string, notePath: string) {
  const file = notePath.replace(/^\/+/, '').replace(/\.md$/i, '');
  return `obsidian://open?vault=${encodeURIComponent(vaultName(vaultPath))}&file=${encodeURIComponent(file)}`;
}
