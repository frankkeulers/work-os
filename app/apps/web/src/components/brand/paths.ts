// The status tile's geometry on a 64 grid, copied from specs/WORKOS-IDENTITY.md §3 (and specs/brand-workos/marks/).
// One evenodd path: the tile, then the socket and the two text lines as holes.

export const TILE =
  'M22 8 H42 C50 8 56 14 56 22 V42 C56 50 50 56 42 56 H22 C14 56 8 50 8 42 V22 C8 14 14 8 22 8 Z ' +
  'M50.5 20 A6.5 6.5 0 1 0 37.5 20 A6.5 6.5 0 1 0 50.5 20 Z ' +
  'M18 34 H36 A2 2 0 0 1 36 38 H18 A2 2 0 0 1 18 34 Z ' +
  'M18 43 H29 A2 2 0 0 1 29 47 H18 A2 2 0 0 1 18 43 Z';

/** The status light. At 16px or less a coloured light fills the socket (r 6.5) so the colour reads. */
export const LIGHT = { cx: 44, cy: 20, r: 4, rFull: 6.5 };

/** The tight crop for 32px and below, and the box with room for the hop and the tilt above that. */
export const VIEWBOX_TIGHT = '6 6 52 52';
export const VIEWBOX_ROOMY = '-4 -8 72 72';
