import type { ModelId } from './schemas';

// Cost-equivalent in USD per million tokens. Placeholder rates for the prototype.
const RATES: Record<ModelId, { input: number; output: number; cache: number }> = {
  'haiku-4.5': { input: 1, output: 5, cache: 0.1 },
  'sonnet-5.5': { input: 3, output: 15, cache: 0.3 },
  'opus-5.5': { input: 5, output: 25, cache: 0.5 },
};

export const costOf = (model: ModelId, input: number, output: number, cache = 0): number => {
  const r = RATES[model];
  return Math.round(((input * r.input + output * r.output + cache * r.cache) / 1_000_000) * 10000) / 10000;
};
