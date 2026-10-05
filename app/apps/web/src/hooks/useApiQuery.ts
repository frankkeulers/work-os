import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Notice } from '../api';

export interface QueryState<T> {
  data?: T;
  error?: unknown;
  loading: boolean;
  reload: () => void;
}

/**
 * Fetches through the API and refetches whenever a matching change notice arrives
 * (the SSE stand-in). Keeps the last data while refetching, so the UI never flashes.
 */
export function useApiQuery<T>(fetcher: () => Promise<T>, matches: (n: Notice) => boolean, deps: unknown[]): QueryState<T> {
  // Data is tagged with the deps it was fetched for, so a deps change (another item id) never shows stale data.
  const key = JSON.stringify(deps);
  const [state, setState] = useState<{ key?: string; data?: T; error?: unknown }>({});
  const seq = useRef(0);
  const fetcherRef = useRef(fetcher);
  const matchesRef = useRef(matches);
  useEffect(() => {
    fetcherRef.current = fetcher;
    matchesRef.current = matches;
  });

  const load = useCallback(() => {
    const mine = ++seq.current;
    fetcherRef
      .current()
      .then((data) => {
        if (mine === seq.current) setState({ key, data });
      })
      .catch((error: unknown) => {
        if (mine === seq.current) setState((s) => ({ key, data: s.key === key ? s.data : undefined, error }));
      });
  }, [key]);

  useEffect(() => {
    load();
    let pending: ReturnType<typeof setTimeout> | undefined;
    const off = api.subscribe((n) => {
      if (!matchesRef.current(n)) return;
      // Coalesce bursts of notices into one refetch.
      clearTimeout(pending);
      pending = setTimeout(load, 40);
    });
    return () => {
      off();
      clearTimeout(pending);
    };
  }, [load]);

  const current = state.key === key;
  return { data: current ? state.data : undefined, error: current ? state.error : undefined, loading: !current, reload: load };
}

export const onTopics =
  (...topics: Notice['topic'][]) =>
  (n: Notice) =>
    topics.includes(n.topic);
