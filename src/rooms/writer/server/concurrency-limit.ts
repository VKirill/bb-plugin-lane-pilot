import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * BB's `concurrency-limit` plugin (I4) holds a new turn in a queue while a host (or all hosts) runs its limit of threads:
 * `message.dispatch` answers `wait`, and the queued row says `waitingOn: { kind:"plugin", pluginId:"concurrency-limit" }`.
 * Two things follow for Lane Pilot, both inert when the plugin is absent, disabled or unlimited:
 * - the writer pool does not start more writers on a host than the limit lets run (`hostCap`, from the plugin's RPC
 *   `getConfiguration`: `hosts[].effectiveLimit`, `globalLimit`), so they wait in Lane Pilot's own line instead of BB's;
 * - a writer whose turn waits in that queue is not «a provider that never started»: the 180 s start limit of
 *   `threadFailure` does not apply while the thread has a turn held by a plugin (`turnHeldByPlugin` in thread-observe).
 */
export const CONCURRENCY_PLUGIN_ID = "concurrency-limit";
const CONFIG_TTL_MS = 60_000;
const ABSENT_TTL_MS = 5 * 60_000;

const configurationSchema = z.object({
  globalLimit: z.number().nullable(),
  hosts: z.array(z.object({ id: z.string(), effectiveLimit: z.number() }).passthrough()),
}).passthrough();
type Configuration = z.infer<typeof configurationSchema>;

type CallRpc = (args: { pluginId: string; method: string; input?: unknown; outputSchema: z.ZodType<unknown>; signal?: AbortSignal }) => Promise<unknown>;

/** The most writers the limit lets start on a host: its effective limit, or the overall one when that is lower; at least 1. */
export function hostWriterCap(configuration: Configuration | null, hostId: string): number | null {
  if (!configuration) return null;
  const limits = [configuration.hosts.find((row) => row.id === hostId)?.effectiveLimit, configuration.globalLimit ?? undefined]
    .filter((limit): limit is number => typeof limit === "number");
  return limits.length ? Math.max(1, Math.min(...limits)) : null;
}

export function createConcurrencyLimit(bb: Pick<BbPluginApi, "sdk">, now: () => number = Date.now) {
  const callRpc = (bb.sdk as { plugins?: { callRpc?: CallRpc } }).plugins?.callRpc;
  let cached: { at: number; configuration: Configuration | null } | null = null;

  async function configuration(): Promise<Configuration | null> {
    if (!callRpc) return null;
    if (cached && now() - cached.at < (cached.configuration ? CONFIG_TTL_MS : ABSENT_TTL_MS)) return cached.configuration;
    const configuration = await Promise.resolve().then(() => callRpc({ pluginId: CONCURRENCY_PLUGIN_ID, method: "getConfiguration", input: null,
      outputSchema: configurationSchema as z.ZodType<unknown>, signal: AbortSignal.timeout(5_000) })).then((value) => value as Configuration, () => null);
    cached = { at: now(), configuration };
    return configuration;
  }

  return {
    /** The limit on writers for a host, or null when the plugin gives none (absent, disabled, nothing configured). Never throws. */
    async hostCap(hostId: string): Promise<number | null> {
      try { return hostWriterCap(await configuration(), hostId); } catch { return null; }
    },
  };
}

export type ConcurrencyLimit = ReturnType<typeof createConcurrencyLimit>;
