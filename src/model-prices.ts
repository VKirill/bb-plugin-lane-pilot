export const PRICES_CHECKED_AT = "2026-10-06";

export type ModelPrice = { input: number; cacheRead: number; output: number };

/** USD per 1M tokens, standard (non-batch, non-fast, global) list prices. */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  "claude-opus-5-5": { input: 4, cacheRead: 0.2, output: 20 },
  "claude-opus-5": { input: 5, cacheRead: 0.5, output: 25 },
  "claude-sonnet-5": { input: 2, cacheRead: 0.2, output: 10 },
  "claude-sonnet-5-5": { input: 2, cacheRead: 0.2, output: 10 },
  "claude-fable-5-1": { input: 10, cacheRead: 0.25, output: 50 },
  "claude-haiku-4-5": { input: 1, cacheRead: 0.1, output: 5 },
  "gpt-6-astra": { input: 10, cacheRead: 1, output: 50 },
  "gpt-6.1-sol": { input: 2, cacheRead: 0.1, output: 10 },
  "gpt-6-luna": { input: 0.1, cacheRead: 0.01, output: 0.5 },
  "gpt-6-sol": { input: 2, cacheRead: 0.2, output: 10 },
  "gpt-5.6-sol": { input: 4, cacheRead: 0.4, output: 20 },
  "gpt-5.6-terra": { input: 2, cacheRead: 0.2, output: 12 },
  "gpt-5.6-luna": { input: 0.2, cacheRead: 0.02, output: 1.2 },
};

export function priceFor(model: string): ModelPrice | null {
  const key = model.replace(/\[[^\]]*\]$/, "").replace(/-\d{8}$/, "");
  return MODEL_PRICES[key] ?? null;
}

export function costUsd(model: string, usage: { input: number; cached: number; output: number }): number | null {
  const price = priceFor(model);
  if (!price) return null;
  const billedInput = Math.max(0, usage.input - usage.cached);
  return (billedInput * price.input + usage.cached * price.cacheRead + usage.output * price.output) / 1_000_000;
}
