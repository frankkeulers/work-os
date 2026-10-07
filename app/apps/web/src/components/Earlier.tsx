import { useEffect, useState } from 'react';
import type { Item } from '@work-os/shared';
import { api, type EarlierView } from '../api';

export type EarlierState = { state: 'loading' } | { state: 'ready'; view: EarlierView } | { state: 'failed' };

/** The messages before a DM item, read from the source when the item is opened. */
export function useEarlier(item: Item): EarlierState | undefined {
  const wanted = item.kind === 'dm' && !item.contentExpired;
  const [s, setS] = useState<{ id: string; v: EarlierState }>();
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    api.getEarlier(item.id).then(
      (view) => live && setS({ id: item.id, v: { state: 'ready', view } }),
      () => live && setS({ id: item.id, v: { state: 'failed' } }),
    );
    return () => {
      live = false;
    };
  }, [item.id, wanted]);
  if (!wanted) return undefined;
  return s?.id === item.id ? s.v : { state: 'loading' };
}
