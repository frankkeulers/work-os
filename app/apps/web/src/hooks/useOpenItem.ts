import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import type { ActionType } from '@work-os/shared';
import { typeParam } from '../components/ActionPanel';
import { itemPath } from '../components/item';

/** The inbox with its panel open on the item, on a filing when one is named. */
export function inboxPath(id: string, type?: ActionType) {
  return `/?${new URLSearchParams({ item: id, ...(type && { file: typeParam(type) }) })}`;
}

/** Carried with the link: where to go instead when the item isn't on the inbox (done long ago, or out of scope). */
export interface OpenItemState {
  orPage: string;
}

/**
 * Opens an item from a notification, a toast or the bell in the inbox panel (UX-6), so Frank keeps
 * his place in the list and the panel's keys. The inbox falls back to the full page.
 */
export function useOpenItem() {
  const navigate = useNavigate();
  return useCallback(
    (id: string, type?: ActionType) => {
      const state: OpenItemState = { orPage: itemPath(id, type ? `?tab=${typeParam(type)}` : '') };
      navigate(inboxPath(id, type), { state });
    },
    [navigate],
  );
}
