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

/**
 * A Teams join link that opens the meeting in the browser, not the Teams app. Teams sends its join
 * links to a launcher page that tries the app and then offers "Continue on this browser"; this is
 * where that button goes (checked 12 Oct 2026): the web client, with the meeting's path and query
 * after the hash. Anything but a teams.microsoft.com join link is left as it is.
 */
export function teamsWebUrl(joinUrl: string): string {
  try {
    const u = new URL(joinUrl);
    if (u.protocol !== 'https:' || u.hostname !== 'teams.microsoft.com' || !/^\/(?:l\/meetup-join|meet)\//.test(u.pathname)) return joinUrl;
    return `https://teams.microsoft.com/v2/?meetingjoin=true#${decodeURIComponent(u.pathname)}${u.search ? `${u.search}&` : '?'}anon=true&launchAgent=join_launcher_web`;
  } catch {
    return joinUrl;
  }
}

/** Outlook on the web's calendar, for a meeting without a link of its own. */
export const OUTLOOK_CALENDAR = 'https://outlook.office.com/calendar/';

/**
 * Where choosing a meeting goes: a Teams meeting not yet over joins in the browser; anything else
 * opens in Outlook, the event itself or else the calendar.
 */
export function meetingLink(e: { joinUrl?: string; link?: string; end: string }, now: Date): { href: string; teams: boolean } {
  if (e.joinUrl && Date.parse(e.end) > now.getTime()) return { href: teamsWebUrl(e.joinUrl), teams: true };
  return { href: e.link ?? OUTLOOK_CALENDAR, teams: false };
}
