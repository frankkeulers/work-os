import { useEffect, useState } from 'react';
import { api } from '../api';

/** The server clock (the mock clock in the prototype). Re-renders every `everyMs` and when the clock jumps. */
export function useNow(everyMs = 15_000): Date {
  const [now, setNow] = useState(() => api.now());
  useEffect(() => {
    const t = setInterval(() => setNow(api.now()), everyMs);
    const off = api.subscribe((n) => {
      if (n.topic === 'clock' || n.topic === 'inbox') setNow(api.now());
    });
    return () => {
      clearInterval(t);
      off();
    };
  }, [everyMs]);
  return now;
}
