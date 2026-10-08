import type { ModelId } from './schemas';

// Cost-equivalent in USD per million tokens: Anthropic's list prices, with cache at the cache-read
// rate. Used when the SDK reports no cost, or prices a model it doesn't know at a guess.
// Haiku 5.5 is priced in tiers by prompt size; these are its rates up to 100k tokens, which every
// call here stays under (triage.maxInputTokens).
const RATES: Record<ModelId, { input: number; output: number; cache: number }> = {
  'haiku-4.5': { input: 1, output: 5, cache: 0.1 },
  'haiku-5.5': { input: 0.1, output: 0.5, cache: 0.01 },
  'sonnet-5.5': { input: 2, output: 10, cache: 0.1 },
  'opus-5.5': { input: 4, output: 20, cache: 0.2 },
};

export const costOf = (model: ModelId, input: number, output: number, cache = 0): number => {
  const r = RATES[model];
  return Math.round(((input * r.input + output * r.output + cache * r.cache) / 1_000_000) * 10000) / 10000;
};
