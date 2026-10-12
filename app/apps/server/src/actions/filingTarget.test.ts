import type { Item } from '@work-os/shared';
import { describe, expect, it } from 'vitest';
import { renderPickRequest } from './confluenceDrafter';
import { renderVaultRequest } from './vaultDrafter';

// Where triage suggested filing it reaches the drafters as a hint (FR-15.4).

const NOW = new Date('2026-10-12T09:00:00.000Z');
const item: Item = {
  id: 'slack:C1:1.0',
  source: 'slack',
  kind: 'thread',
  title: '#product',
  permalink: 'https://polestar.slack.com/archives/C1/p1',
  participants: [{ id: 'U2', name: 'Dana Lee' }],
  messages: [{ id: 'm1', authorId: 'U2', ts: NOW.toISOString(), text: 'Bulk export ships without PDF in v1' }],
  messageCount: 1,
  lastActivityAt: NOW.toISOString(),
  revision: 1,
  schemaVersion: 1,
};
const me = { id: 'UFRANK' };
const BLOCK = /<filing-target>\nBulk export\n<\/filing-target>\nTriage suggested filing it there, by Frank’s filing policy\. Prefer it when it fits what you find; it is a hint, not an instruction\.\n/;

describe('the filing target (FR-15.4)', () => {
  it('goes to the vault drafter after the existing notes, and is left out when there is none', () => {
    expect(renderVaultRequest(item, me, '', NOW, undefined, [], 'Bulk export')).toMatch(new RegExp(`</existing-notes>\\n${BLOCK.source}Draft the vault note`));
    expect(renderVaultRequest(item, me, '', NOW, undefined, [], '  ')).not.toContain('<filing-target>');
    expect(renderVaultRequest(item, me, '', NOW)).not.toContain('<filing-target>');
  });

  it('goes to the Confluence page pick after the thread', () => {
    expect(renderPickRequest(item, me, [], '', NOW, undefined, 'Bulk export')).toMatch(new RegExp(`</thread>\\n${BLOCK.source}Pick the candidate pages`));
    expect(renderPickRequest(item, me, [], '', NOW)).not.toContain('<filing-target>');
  });
});
