import { channelKey, matchLookup } from './lookup';

// Channel search (ChannelPicker), over plain channel names.

export const bareChannel = channelKey;

/** The channels matching what was typed: names starting with it first, then names containing it. */
export function matchChannels(all: string[], query: string, exclude: string[]): string[] {
  return matchLookup(
    all.map((value) => ({ value })),
    query,
    exclude,
    channelKey,
  ).map((o) => o.value);
}
