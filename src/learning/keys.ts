import { z } from "zod";

/**
 * A key by name from BB's Env Catalog (the same record call `core.ts` makes for TYPESAFE_API_KEY). The value is kept in memory for ten
 * minutes, never logged, never stored; a failed read gives `undefined` and is not cached for long, so a record added later is found.
 */
type CallRpc = (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown> }) => Promise<unknown>;

const TTL_MS = 10 * 60_000, MISSING_TTL_MS = 60_000;

export function envCatalogKey(bb: { sdk: unknown }, name: string, now: () => number = Date.now): () => Promise<string | undefined> {
  let cached: { value: string | undefined; at: number } | null = null;
  return async () => {
    if (cached && now() - cached.at < (cached.value ? TTL_MS : MISSING_TTL_MS)) return cached.value;
    const callRpc = (bb.sdk as { plugins?: { callRpc?: CallRpc } }).plugins?.callRpc;
    let value: string | undefined;
    try {
      const record = await callRpc?.({ pluginId: "env-catalog", method: "env_get_value", input: { name }, outputSchema: z.object({ value: z.string().nullable() }).passthrough() }) as { value: string | null } | undefined;
      value = record?.value?.trim() || undefined;
    } catch { value = undefined; }
    cached = { value, at: now() };
    return value;
  };
}
