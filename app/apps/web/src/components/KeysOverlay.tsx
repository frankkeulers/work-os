import { useEffect } from 'react';
import { Link } from 'react-router';
import { Dialog } from './ui';

// The ? overlay (BACKLOG UX-11): the keys for where Frank is, without leaving it. The guide's
// shortcuts page (docs/guide/shortcuts.md) lists them all; keep the two in step.

export type KeyContext = 'batch' | 'sweep' | 'draft' | 'item' | 'list' | 'guide';

/** Keys pressed together; `then` and `/` between them are read, not pressed. */
type Row = [keys: string[], does: string];

const SECTIONS: Record<KeyContext | 'everywhere', { title: string; rows: Row[] }> = {
  batch: {
    title: 'Filing in a batch',
    rows: [
      [['⌘', '↵'], 'Approve and go to the next item'],
      [['→'], 'Skip: the item stays in To file'],
      [['Esc'], 'Stop the batch'],
    ],
  },
  sweep: {
    title: 'Sweep',
    rows: [
      [['e'], 'Done, and on to the next'],
      [['s'], 'Snooze, and on to the next'],
      [['r'], 'Reply in the source, and on to the next'],
      [['f', '/', 'v'], 'File it; approving goes on to the next'],
      [['→'], 'Skip: the item stays in Needs you'],
      [['Esc'], 'Stop, and see the tally'],
    ],
  },
  draft: {
    title: 'Draft',
    rows: [
      [['⌘', '↵'], 'Approve; while editing, save the edit and approve'],
      [['x'], 'Discard the draft'],
    ],
  },
  item: {
    title: 'Item',
    rows: [
      [['e'], 'Done'],
      [['⇧', 'E'], 'Done and open the next item'],
      [['s'], 'Snooze: then a number, or s for the suggested time'],
      [['r'], 'Reply in the source'],
      [['f'], 'File to Confluence'],
      [['v'], 'File to the vault'],
      [['a'], 'Add to-do'],
      [['c'], 'Correct triage'],
      [['y'], 'Triage was right'],
    ],
  },
  list: {
    title: 'Inbox',
    rows: [
      [['j', '/', 'k'], 'Next or previous item'],
      [['g', 'then', 'n'], 'The first item in Needs you'],
      [['g', 'then', 'l'], 'The first item in Later'],
      [['g', 'then', 'd'], 'The first To Do: then e for Done, p to plan it, ↵ to open its item'],
      [['t'], 'Today or tomorrow in the time column'],
      [['o'], 'Open the item as a full page'],
      [['Esc'], 'Close the item panel'],
    ],
  },
  guide: {
    title: 'Guide',
    rows: [
      [['/'], 'Search the guide'],
      [['↵'], 'Open the first search result'],
      [['Esc'], 'Clear the search'],
    ],
  },
  everywhere: {
    title: 'Everywhere',
    rows: [
      [['?'], 'Show these keys'],
      [['['], 'Collapse or expand the sidebar'],
      [['z'], 'Undo the last thing a toast offered to undo'],
    ],
  },
};

/** Where Frank is, read from the page as it stands: the most specific first. */
export function keyContexts(pathname: string): KeyContext[] {
  if (pathname.startsWith('/guide')) return ['guide'];
  const inbox = pathname === '/';
  const item = pathname.startsWith('/item/') || !!document.querySelector('aside[aria-label="Item panel"]');
  const out: KeyContext[] = [];
  const batch = !!document.querySelector('[data-testid="batch-pos"]');
  if (batch) out.push('batch'); // its keys cover the draft's
  if (document.querySelector('[data-testid="sweep-pos"]')) out.push('sweep');
  if (!batch && document.querySelector('[data-action-bar]')) out.push('draft');
  if (item) out.push('item');
  if (inbox) out.push('list');
  return out;
}

const KeyCap = ({ k }: { k: string }) => (
  <kbd className="inline-flex h-6 min-w-6 items-center justify-center rounded-md border border-b-2 border-line-strong bg-surface px-1.5 font-mono text-xs leading-none text-ink-2">{k}</kbd>
);

/** The keys for the contexts given, then those that work everywhere, with the full list a link away. */
export function KeysOverlay({ contexts, onClose }: { contexts: KeyContext[]; onClose: () => void }) {
  // ? again closes it, as Esc does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  const shown = [...contexts, 'everywhere' as const];
  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={onClose}
      footer={
        <Link to="/guide/shortcuts" onClick={onClose} className="text-[13px] font-medium">
          All shortcuts in the guide
        </Link>
      }
    >
      <div className="flex flex-col gap-4">
        {shown.map((c) => (
          <section key={c} aria-label={SECTIONS[c].title} data-keys={c}>
            <h3 className="m-0 mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{SECTIONS[c].title}</h3>
            <dl className="m-0 grid grid-cols-[96px_1fr] items-center gap-x-4 gap-y-1.5">
              {SECTIONS[c].rows.map(([keys, does]) => (
                <div key={does} className="contents">
                  <dt className="flex items-center gap-1">
                    {keys.map((k, i) =>
                      k === 'then' || k === '/' ? (
                        <span key={i} className="text-xs text-muted">
                          {k}
                        </span>
                      ) : (
                        <KeyCap key={i} k={k} />
                      ),
                    )}
                  </dt>
                  <dd className="m-0 text-[13px] text-ink-2">{does}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
