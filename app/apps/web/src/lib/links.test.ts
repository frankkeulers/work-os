import { describe, expect, it } from 'vitest';
import { confluencePageUrl, obsidianNoteUrl, vaultName } from './links';
import { frontMatterFields, joinFrontMatter, splitFrontMatter, tidySerialised } from './markdown';

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
