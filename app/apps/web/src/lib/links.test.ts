import { describe, expect, it } from 'vitest';
import { confluencePageUrl, meetingLink, obsidianNoteUrl, teamsWebUrl, vaultName } from './links';
import { frontMatterFields, joinFrontMatter, splitFrontMatter, tidySerialised } from './markdown';

describe('Teams in the browser', () => {
  it('sends a join link to the web client, as the launcher’s “Continue on this browser” does', () => {
    expect(teamsWebUrl('https://teams.microsoft.com/meet/21335181223291?p=LIHecMmaadB7jNURcd')).toBe('https://teams.microsoft.com/v2/?meetingjoin=true#/meet/21335181223291?p=LIHecMmaadB7jNURcd&anon=true&launchAgent=join_launcher_web');
    // The path decoded, the query as it was: what Teams' own launcher hands the web client.
    expect(teamsWebUrl('https://teams.microsoft.com/l/meetup-join/19%3ameeting_ABC%40thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d')).toBe(
      'https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_ABC@thread.v2/0?context=%7b%22Tid%22%3a%22x%22%7d&anon=true&launchAgent=join_launcher_web',
    );
  });

  it('joins a Teams meeting until it ends, and opens anything else in Outlook', () => {
    const now = new Date('2026-10-12T09:00:00Z');
    const e = { joinUrl: 'https://teams.microsoft.com/meet/1?p=a', link: 'https://outlook.office365.com/owa/?itemid=X', end: '2026-10-12T09:30:00Z' };
    expect(meetingLink(e, now)).toEqual({ href: 'https://teams.microsoft.com/v2/?meetingjoin=true#/meet/1?p=a&anon=true&launchAgent=join_launcher_web', teams: true });
    expect(meetingLink({ ...e, end: '2026-10-12T09:00:00Z' }, now)).toEqual({ href: e.link, teams: false }); // over
    expect(meetingLink({ ...e, joinUrl: undefined }, now)).toEqual({ href: e.link, teams: false });
    expect(meetingLink({ end: e.end }, now)).toEqual({ href: 'https://outlook.office.com/calendar/', teams: false });
  });

  it('leaves anything else alone', () => {
    for (const u of ['https://teams.live.com/meet/123?p=a', 'https://teams.microsoft.com/meetingOptions/?organizerId=1', 'https://zoom.us/j/123', 'not a url', 'https://teams.microsoft.com/l/meetup-join/%E0%A4%A']) expect(teamsWebUrl(u)).toBe(u);
  });
});

describe('target links', () => {
  it('builds the canonical Confluence Cloud page address', () => {
    expect(confluencePageUrl('https://pole-star.atlassian.net/', 'PRD', '39004512')).toBe('https://pole-star.atlassian.net/wiki/spaces/PRD/pages/39004512');
  });

  it('opens an Obsidian note by vault name and path, without the .md extension', () => {
    expect(vaultName('~/Obsidian/PSG Vault/')).toBe('PSG Vault');
    expect(obsidianNoteUrl('~/Obsidian/PSG Vault', 'Inbox/Slack/2026-10-05 Asks for.md')).toBe('obsidian://open?vault=PSG%20Vault&file=Inbox%2FSlack%2F2026-10-05%20Asks%20for');
  });
});

describe('draft markdown helpers', () => {
  const note = '---\ntype: note\nchannel: "#mvi-launch"\n---\n# Title\n\nBody';

  it('splits and rejoins front matter without changing the text', () => {
    const { frontMatter, body } = splitFrontMatter(note);
    expect(frontMatter).toBe('---\ntype: note\nchannel: "#mvi-launch"\n---');
    expect(body).toBe('# Title\n\nBody');
    expect(joinFrontMatter(frontMatter, body)).toBe(note);
    expect(splitFrontMatter('No front matter')).toEqual({ frontMatter: '', body: 'No front matter' });
  });

  it('lists front-matter fields for display', () => {
    expect(frontMatterFields(splitFrontMatter(note).frontMatter)).toEqual([
      ['type', 'note'],
      ['channel', '#mvi-launch'],
    ]);
  });

  it('keeps Obsidian wiki links unescaped after the editor serialises', () => {
    expect(tidySerialised('See \\[\\[Roadmap process\\]\\] and \\[x\\]\n')).toBe('See [[Roadmap process]] and \\[x\\]');
  });
});
