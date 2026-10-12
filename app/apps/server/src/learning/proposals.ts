import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PolicyProposal } from '@work-os/shared';
import { writeJsonAtomic } from '../store/atomic';

// proposals/<id>.json (FR-15.9): each proposed policy with its diff, changes and scores, and what
// became of it. Files are small and few: one per run Frank asks for.

const FILE_RE = /^proposal-.+\.json$/;

export class ProposalStore {
  constructor(readonly dir: string) {}

  private file(id: string) {
    if (!/^proposal-[\w-]+$/.test(id)) throw new Error(`Not a proposal ID: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  async save(p: PolicyProposal): Promise<void> {
    await writeJsonAtomic(this.file(p.id), PolicyProposal.parse(p));
  }

  async get(id: string): Promise<PolicyProposal | undefined> {
    try {
      const r = PolicyProposal.safeParse(JSON.parse(await readFile(this.file(id), 'utf8')));
      return r.success ? r.data : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every readable proposal, newest first. */
  async list(): Promise<PolicyProposal[]> {
    const names = (await readdir(this.dir).catch(() => [] as string[])).filter((n) => FILE_RE.test(n));
    const out: PolicyProposal[] = [];
    for (const n of names) {
      const p = await this.get(n.slice(0, -'.json'.length)).catch(() => undefined);
      if (p) out.push(p);
    }
    return out.sort((a, b) => b.at.localeCompare(a.at));
  }

  async update(id: string, fn: (p: PolicyProposal) => PolicyProposal): Promise<PolicyProposal | undefined> {
    const p = await this.get(id);
    if (!p) return undefined;
    const next = fn(p);
    await this.save(next);
    return next;
  }
}
