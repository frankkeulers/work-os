// Channel search for the rule editor (ChannelPicker).

const SHOWN = 8;

/** A channel name compared without its "#" or case. */
export const bareChannel = (s: string) => s.trim().replace(/^#/, '').toLowerCase();

/** The channels matching what was typed: names starting with it first, then names containing it. */
export function matchChannels(all: string[], query: string, exclude: string[]): string[] {
  const q = bareChannel(query);
  const taken = new Set(exclude.map(bareChannel));
  const open = all.filter((c) => !taken.has(bareChannel(c)));
  if (!q) return open.slice(0, SHOWN);
  const starts = open.filter((c) => bareChannel(c).startsWith(q));
  const contains = open.filter((c) => !bareChannel(c).startsWith(q) && bareChannel(c).includes(q));
  return [...starts, ...contains].slice(0, SHOWN);
}
