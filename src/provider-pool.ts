/**
 * G9: a cap on simultaneous writers per provider (bulkhead), across runs. The setting `ops.provider_pool` is a map from
 * provider id to a limit, written `codex=2, claude-code=3` (comma- or line-separated) or as a JSON object. A provider that
 * is not listed has no cap beyond the run's own pool, which is the behaviour without the setting.
 */
export const PROVIDER_POOL_KEY = "ops.provider_pool";
export const PROVIDER_POOL_MAX = 15;

export type ProviderPools = Record<string, number>;

function limitOf(value: unknown): number | null {
  const parsed = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === "number" && Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= PROVIDER_POOL_MAX ? parsed : null;
}

/** The entries of a setting value; `invalid` lists what could not be read. Empty or missing means no caps. */
export function parseProviderPools(value: unknown): { pools: ProviderPools; invalid: string[] } {
  const pools: ProviderPools = {};
  const invalid: string[] = [];
  if (value === undefined || value === null || (typeof value === "string" && !value.trim())) return { pools, invalid };
  let pairs: Array<[string, unknown]>;
  if (typeof value === "object" && !Array.isArray(value)) pairs = Object.entries(value as Record<string, unknown>);
  else if (typeof value === "string" && value.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { pools, invalid: [value] };
      pairs = Object.entries(parsed as Record<string, unknown>);
    } catch { return { pools, invalid: [value] }; }
  } else if (typeof value === "string") {
    pairs = value.split(/[,\n]/).map((part) => part.trim()).filter(Boolean).map((part) => {
      const at = part.search(/[=:]/);
      return at < 0 ? [part, ""] : [part.slice(0, at).trim(), part.slice(at + 1).trim()];
    });
  } else return { pools, invalid: [String(value)] };
  for (const [provider, raw] of pairs) {
    const limit = limitOf(raw);
    if (!provider || limit === null) invalid.push(`${provider}=${String(raw)}`);
    else pools[provider] = limit;
  }
  return { pools, invalid };
}

/** The cap on simultaneous writers of one provider, or null when none is set. A malformed entry is ignored, never a block. */
export function providerPoolCap(settings: Record<string, unknown>, providerId: string): number | null {
  return parseProviderPools(settings[PROVIDER_POOL_KEY]).pools[providerId] ?? null;
}

/** Why a value cannot be saved, or null. */
export function providerPoolProblem(value: unknown): string | null {
  const { invalid } = parseProviderPools(value);
  return invalid.length ? `provider=limit pairs with a limit of 1-${PROVIDER_POOL_MAX}; cannot read: ${invalid.join(", ")}` : null;
}
