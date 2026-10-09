import { z } from 'zod';

// Outlook categories on calendar events (R2.8). Search gives each event's category names; the
// mailbox's list of which colour each category has can't be read through the connector (P0-12
// addendum), so Frank picks the colours in Settings › Outlook. Until he does, a category has a
// steady colour of its own, from its name. The colours are Outlook's 25, by the names its tools use.

export const OUTLOOK_COLORS = {
  red: '#d13438',
  orange: '#ca5010',
  brown: '#8e562e',
  yellow: '#c19c00',
  green: '#498205',
  teal: '#038387',
  olive: '#5c7e10',
  blue: '#0078d4',
  purple: '#8764b8',
  cranberry: '#c50f1f',
  steel: '#69797e',
  darkSteel: '#394146',
  gray: '#7a7574',
  darkGray: '#525252',
  black: '#1b1b1b',
  darkRed: '#750b1c',
  darkOrange: '#8a3707',
  darkBrown: '#4d291c',
  darkYellow: '#817400',
  darkGreen: '#0b6a0b',
  darkTeal: '#005b70',
  darkOlive: '#3b5b1f',
  darkBlue: '#004e8c',
  darkPurple: '#5c2e91',
  darkCranberry: '#6e0811',
} as const;

export type OutlookColor = keyof typeof OUTLOOK_COLORS;
export const OutlookColor = z.enum(Object.keys(OUTLOOK_COLORS) as [OutlookColor, ...OutlookColor[]]);

/** "darkSteel" as "Dark steel". */
export const colorLabel = (c: OutlookColor) => c.replace(/[A-Z]/g, (l) => ` ${l.toLowerCase()}`).replace(/^./, (l) => l.toUpperCase());

/** The colours a category gets before Frank picks one: clear ones, no two alike. */
const DEFAULTS: OutlookColor[] = ['blue', 'green', 'orange', 'purple', 'teal', 'red', 'yellow'];

/** The colour Frank chose for a category (names match whatever their case), or its own default. */
export function categoryColor(name: string, chosen: Record<string, OutlookColor> | undefined): OutlookColor {
  const key = name.trim().toLowerCase();
  const picked = Object.entries(chosen ?? {}).find(([k]) => k.trim().toLowerCase() === key)?.[1];
  if (picked) return picked;
  let h = 0x811c9dc5; // FNV-1a: names alike in length and letters still spread
  for (const ch of key) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return DEFAULTS[h % DEFAULTS.length];
}

/** A category as views send it: its name and colour. */
export interface CategoryTag {
  name: string;
  color: OutlookColor;
}
export const categoryTags = (names: readonly string[] | undefined, chosen: Record<string, OutlookColor> | undefined): CategoryTag[] => (names ?? []).map((name) => ({ name, color: categoryColor(name, chosen) }));
