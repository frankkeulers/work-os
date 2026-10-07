import { useEffect, useState } from 'react';
import type { Item } from '@work-os/shared';
import { api, type EarlierView } from '../api';

export type EarlierState = { state: 'loading' } | { state: 'ready'; view: EarlierView } | { state: 'failed' };

/** The week before a DM item, read from the source once `wanted` turns on, then kept for the item. */
export function useEarlier(item: Item, wanted: boolean): EarlierState | undefined {
  const [s, setS] = useState<{ id: string; v: EarlierState }>();
  const have = s?.id === item.id;
  useEffect(() => {
    if (!wanted || have) return;
    let live = true;
    api.getEarlier(item.id).then(
      (view) => live && setS({ id: item.id, v: { state: 'ready', view } }),
      () => live && setS({ id: item.id, v: { state: 'failed' } }),
    );
    return () => {
      live = false;
    };
  }, [item.id, wanted, have]);
  if (have) return s.v;
  return wanted ? { state: 'loading' } : undefined;
}
