import { useEffect } from 'react';

// The browser tab's icon follows the mark's light: attention while something is in Now. Filed never shows here (§5.2).

export const FAVICON = { quiet: '/favicon.svg', attention: '/favicon-attention.svg' } as const;

export function useBrandFavicon(state: 'quiet' | 'attention') {
  useEffect(() => {
    document.getElementById('brand-favicon')?.setAttribute('href', FAVICON[state]);
  }, [state]);
}
