export const PRICES_CHECKED_AT = "2026-10-06";

export type ModelPrice = { input: number; cacheRead: number; cacheWrite: number; output: number };

/** USD per 1M tokens, standard (non-batch, non-fast, global) list prices. cacheWrite is the 5-minute write. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, cacheWrite: 5, output: 20 },
  "claude-opus-5": { input: 5, cacheRead: 0.5, cacheWrite: 6.25, output: 25 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "claude-fable-5-1": { input: 10, cacheRead: 0.25, cacheWrite: 12.5, output: 50 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 },
  "gpt-6-astra": { input: 10, cacheRead: 1, cacheWrite: 12.5, output: 50 },
  "gpt-6.1-sol": { input: 2, cacheRead: 0.1, cacheWrite: 2.5, output: 10 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, cacheWrite: 0.125, output: 0.5 },
  "gpt-6-sol": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 10 },
  "gpt-5.6-sol": { input: 4, cacheRead: 0.4, cacheWrite: 5, output: 20 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, cacheWrite: 2.5, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, cacheWrite: 0.25, output: 1.2 },
};

export function priceFor(model: string): ModelPrice | null {
  const key = model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  return MODEL_PRICES[key] ?? null;
}

export function costUsd(model: string, usage: {
  uncached: number; cacheRead: number; cacheWrite: number; output: number;
}): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const usd = (
    usage.uncached * price.input
    + usage.cacheRead * price.cacheRead
    + usage.cacheWrite * price.cacheWrite
    + usage.output * price.output
  ) / 1_000_000;
  return Math.max(0, usd);
}
