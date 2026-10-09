import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useBlocker, useSearchParams, type BlockerFunction } from 'react-router';
import type { ActionType } from '@work-os/shared';
import { api, type ItemSummary, type ItemView } from '../../api';
import { parseType } from '../../components/ActionPanel';
import { markDoneWithUndo } from '../../components/item';
import { useApiQuery } from '../../hooks/useApiQuery';

// The item panel's host, for any page that lists items and opens one beside the list: the Inbox,
// and each source's history (cockpit CK-5). The URL holds the open item (?item=) and its filing
// target (?file=), so a link or a reload opens the same panel.

export const rowEl = (id: string) => document.querySelector<HTMLElement>(`[data-row="${CSS.escape(id)}"]`);
const keyOf = (q: URLSearchParams) => `${q.get('item')}:${parseType(q.get('file'))}`;

export interface PanelHostOptions {
  /** The rows the page shows, to find the open item among. */
  items: ItemSummary[];
  /** The rows j/k walk, as they show. */
  order: string[];
  /** Clicks on these aren't "outside" the panel, so they leave it open. */
  notOutside: string;
  /** Runs before the panel opens on an item, picked or stepped to. */
  onPick?: (id: string) => void;
  /** Runs as the panel closes. */
  onClose?: () => void;
}

export function usePanelHost({ items, order, notOutside, onPick, onClose }: PanelHostOptions) {
  const [search, setSearch] = useSearchParams();
  const sel = search.get('item');
  const filing = parseType(search.get('file'));
  const selItem = sel ? items.find((i) => i.id === sel) : undefined;
  const idx = sel ? order.indexOf(sel) : -1;
  // Where the cursor was, so j/k carry on from there after the item leaves the list.
  const [anchor, setAnchor] = useState(0);
  if (idx >= 0 && idx !== anchor) setAnchor(idx);
  // The panel's last content, kept on screen while it slides out.
  const [shown, setShown] = useState<{ item: ItemSummary; view?: ItemView; pos: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  // The page's own steps, read when they run, so a new closure each render doesn't re-run effects.
  const hooks = useRef({ onPick, onClose });
  useLayoutEffect(() => {
    hooks.current = { onPick, onClose };
  });

  const detail = useApiQuery(() => (sel ? api.getItem(sel) : Promise.resolve(undefined)), (n) => (n.topic === 'item' && n.id === sel) || n.topic === 'settings' || n.topic === 'usage', [sel]);

  // Unsaved draft edits belong to one item and filing target. The blocker reads them from a ref,
  // so a keypress straight after typing can't slip past it before the next render.
  const editKey = keyOf(search);
  const [dirtyState, setDirtyState] = useState({ key: '', dirty: false });
  const dirtyRef = useRef(dirtyState);
  const dirty = dirtyState.key === editKey && dirtyState.dirty;
  const onDirty = useCallback(
    (d: boolean) => {
      dirtyRef.current = { key: editKey, dirty: d };
      setDirtyState(dirtyRef.current);
    },
    [editKey],
  );
  const shouldBlock = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current.dirty && dirtyRef.current.key === keyOf(new URLSearchParams(currentLocation.search)) && (currentLocation.pathname !== nextLocation.pathname || currentLocation.search !== nextLocation.search),
    [],
  );
  const blocker = useBlocker(shouldBlock);
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const pick = useCallback(
    (id: string | undefined) => {
      if (!id) return;
      hooks.current.onPick?.(id);
      // At once, not in a transition: a key pressed straight after (j again, or e) acts on this row.
      setSearch({ item: id }, { replace: true, flushSync: true });
      const el = rowEl(id);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest' });
    },
    [setSearch],
  );
  const step = useCallback(
    (d: 1 | -1) => {
      if (!order.length) return;
      if (idx < 0) return pick(sel ? order[Math.max(0, Math.min(order.length - 1, d > 0 ? anchor : anchor - 1))] : order[0]);
      pick(order[Math.max(0, Math.min(order.length - 1, idx + d))]);
    },
    [order, idx, sel, anchor, pick],
  );
  const close = useCallback(() => {
    hooks.current.onClose?.();
    setSearch({}, { replace: true });
  }, [setSearch]);
  const doneAndNext = useCallback(() => {
    if (!selItem) return;
    const next = idx >= 0 ? (order[idx + 1] ?? order[idx - 1]) : order[Math.min(anchor, order.length - 1)];
    if (selItem.status === 'open') void markDoneWithUndo(selItem);
    if (next && next !== selItem.id) pick(next);
    else close();
  }, [selItem, idx, order, anchor, pick, close]);
  const setFiling = useCallback(
    (t: ActionType | undefined) => {
      if (!sel) return;
      setSearch(t ? { item: sel, file: t === 'vault_note' ? 'vault' : 'confluence' } : { item: sel }, { replace: true });
    },
    [sel, setSearch],
  );

  // A click outside the panel closes it. On click rather than mousedown, so the control you
  // clicked still gets the click before the list widens.
  useEffect(() => {
    if (!sel) return;
    const onClick = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.isConnected || panelRef.current?.contains(t) || t.closest(notOutside)) return;
      if (!(window.getSelection()?.isCollapsed ?? true)) return; // the end of a text selection
      close();
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, [sel, close, notOutside]);

  const view = detail.data && detail.data.summary.id === sel ? detail.data : undefined;
  if (selItem && (shown?.item !== selItem || shown.view !== view || shown.pos !== idx + 1)) setShown({ item: selItem, view, pos: idx + 1 });
  const closing = !selItem && !!shown;
  const panel = selItem ? { item: selItem, view, pos: idx + 1 } : shown;

  return {
    sel,
    selItem,
    filing,
    idx,
    anchor,
    setSearch,
    pick,
    step,
    close,
    doneAndNext,
    setFiling,
    onDirty,
    blocker,
    panelRef,
    /** What the panel shows: the open item, or the last one while it slides out. */
    panel,
    closing,
    /** Forgets the last item once the slide-out ends. */
    onSlidOut: () => setShown(null),
  };
}

export type PanelHost = ReturnType<typeof usePanelHost>;
