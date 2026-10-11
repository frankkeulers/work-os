import type { Filing, FiledView } from '@work-os/shared';
import { api } from '../../api';
import { BrandIcon } from '../../components/BrandIcon';
import { Icon } from '../../components/icons';
import { Button, cx } from '../../components/ui';
import { useApiQuery } from '../../hooks/useApiQuery';
import { fmtTime } from '../../lib/format';
import { TYPE_LABEL } from '../../lib/lanes';
import { confluencePageUrl, obsidianNoteUrl } from '../../lib/links';
import { errorToast, toast } from '../../store/toasts';

/** A link styled as a small secondary button, as the action panel's Open page. */
const linkButton = 'inline-flex h-7 items-center gap-1.5 whitespace-nowrap rounded-lg border border-line-strong bg-surface px-2.5 text-xs font-medium !text-ink no-underline hover:bg-surface-2';

/** The note's name, for a filing that went into several. */
const noteName = (path: string) => path.split('/').pop()!.replace(/\.md$/i, '');

/**
 * Done today shows filings (BACKLOG UX-12): what was written where today, newest first, with a way
 * to open each note or page, and Reopen for an item that closed. At the top of the Done list.
 */
export function FiledToday({ onOpen }: { onOpen: (itemId: string) => void }) {
  const q = useApiQuery(() => api.getFiled(), (n) => n.topic === 'inbox' || n.topic === 'item' || n.topic === 'settings', []);
  const filings = q.data?.filings ?? [];
  if (!filings.length) return null;
  return (
    <section aria-label="Filed today" className="flex flex-col border-t border-line-soft">
      <h3 className="m-0 flex items-baseline gap-2 px-6 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-muted">
        Filed today <span className="font-mono tabular-nums">{filings.length}</span>
      </h3>
      <ul className="m-0 list-none p-0">
        {filings.map((f) => (
          <FilingRow key={f.actionId} f={f} view={q.data!} onOpen={onOpen} />
        ))}
      </ul>
    </section>
  );
}

function FilingRow({ f, view, onOpen }: { f: Filing; view: FiledView; onOpen: (itemId: string) => void }) {
  const { targets, dryRun } = view;
  // Where the sandbox stands in for the vault, there is no note in Obsidian to open.
  const notes = f.type !== 'confluence_entry' && !dryRun ? (f.paths ?? []) : [];
  const reopen = () =>
    void api.reopen(f.itemId).then(
      () => toast(`Reopened · ${f.title}`),
      (e) => errorToast(e),
    );
  return (
    <li data-filing={f.type} className="flex gap-3 border-t border-line-soft px-6 py-2.5 first:border-t-0">
      <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center">
        {f.type === 'todo' ? <Icon name="commitments" size={16} className="text-ink-2" /> : <BrandIcon brand={f.type === 'vault_note' ? 'obsidian' : 'confluence'} size={16} decorative />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button type="button" onClick={() => onOpen(f.itemId)} className="truncate text-left text-[13px] font-medium text-ink cursor-pointer hover:underline">
          {f.summary || f.title}
        </button>
        <span className="truncate text-xs text-muted">
          {TYPE_LABEL[f.type].short} · {f.title} · {fmtTime(f.at)}
          {!f.itemDone && ' · still open'}
        </span>
        {f.result && <span className="text-xs leading-snug text-ink-2">{f.result.replace(/\s*Logged action\.executed\.$/, '')}</span>}
        <span className={cx('flex flex-wrap items-center gap-2', !(f.pageId || notes.length || f.itemDone) && 'hidden')}>
          {f.pageId && (
            <a href={confluencePageUrl(targets.confluenceSite, targets.spaceKey, f.pageId)} target="_blank" rel="noreferrer" className={linkButton}>
              <BrandIcon brand="confluence" size={12} decorative /> Open page
            </a>
          )}
          {notes.map((p) => (
            <a key={p} href={obsidianNoteUrl(targets.vaultPath, p)} className={linkButton}>
              <BrandIcon brand="obsidian" size={12} decorative /> {notes.length > 1 ? noteName(p) : 'Open note'}
            </a>
          ))}
          {f.itemDone && (
            <Button size="sm" variant="ghost" icon="undo" onClick={reopen} title="Reopen the item. What was written stays.">
              Reopen
            </Button>
          )}
        </span>
      </div>
    </li>
  );
}
