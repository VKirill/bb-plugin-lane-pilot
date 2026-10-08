import type { ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { stringAt } from "./values";
import type { ServerCore } from "./core";
import { createBbShimEnv } from "./helper-bb-shim";

/**
 * Lane Pilot's OpenCode helpers run with a minimal config (see src/opencode-min-config.ts for why and how). The OpenCode provider
 * of BB starts `opencode acp` with the thread's environment, and a plugin may add variables to it (`contributeEnv`): for a thread
 * Lane Pilot started we add `XDG_CONFIG_HOME`, pointing at the config home the machine builds for it.
 *
 * The preparation is shared and waited for: helpers of a fan-out that ask at the same moment get the one run in flight (and a
 * success is remembered for a minute), a failed or slow run is tried again, and a helper never starts with the machine's full
 * config because a preparation failed (it used to: the failure was cached as «nothing to do» for 60 s and the helper went on
 * silently, audit 2026-10-08 round 2, B8). When the preparation cannot be made, the helper's start is refused with the reason
 * (`opencode_minimal_config_failed:…`); a machine answering «nothing to leave out» or an owner who switched it off
 * (`~/.lane-pilot/opencode-min.json`) is not a failure and the thread keeps the machine's config.
 */
export const OPENCODE_PROVIDER_ID = "acp-opencode";
const CACHE_MS = 60_000;
const CALL_MS = 4_000;
const ATTEMPTS = 3;
const RETRY_PAUSE_MS = 500;

type Prepared = { configHome: string; kept: string[]; left: string[] } | null;
const reasonOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause)).replace(/\s+/g, " ").slice(0, 200);

/** Runs `work` but gives up on it after `ms`. */
async function within<T>(ms: number, label: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}

export function createOpencodeMinimalEnv(ctx: Pick<ServerCore, "bb" | "host">, now: () => number = Date.now, pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))) {
  const { bb, host } = ctx;
  const cache = new Map<string, { at: number; value: Prepared }>();
  const inflight = new Map<string, Promise<Prepared>>();

  /** One host call; throws on a failure or a timeout, answers null only when the machine said there is nothing to do. */
  async function ask(hostId: string, model: string | null): Promise<Prepared> {
    const answer = await within(CALL_MS, "prepareOpencodeMinimal", Promise.resolve(host.call("prepareOpencodeMinimal", { requestedHostId: hostId, model }, { hostId, timeoutMs: CALL_MS })));
    return (answer as { result: Prepared }).result;
  }

  async function prepare(hostId: string, model: string | null): Promise<Prepared> {
    const key = `${hostId}\0${model?.split("/")[0] ?? ""}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    const running = inflight.get(key);
    if (running) return await running;
    const work = (async () => {
      let last: unknown;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        try {
          const value = await ask(hostId, model);
          cache.set(key, { at: now(), value });
          return value;
        } catch (cause) {
          last = cause;
          if (attempt < ATTEMPTS) await pause(RETRY_PAUSE_MS * attempt);
        }
      }
      // A failure is not cached: the next helper asks again.
      throw new Error(`opencode_minimal_config_failed:${hostId}: ${reasonOf(last)} (after ${ATTEMPTS} tries)`);
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, work);
    return await work;
  }

  return async (context: { threadId: string; hostId: string }): Promise<ExperimentalPluginProviderEnvEntry[]> => {
    // Only threads Lane Pilot started carry its role; the owner's own OpenCode chats keep their full config.
    let metadata: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try { metadata = await within(CALL_MS, "getPluginMetadata", Promise.resolve(bb.sdk.threads.getPluginMetadata({ threadId: context.threadId }))); break; } catch (cause) {
        if (attempt === 2) { bb.log.warn(`Lane Pilot: could not tell whether OpenCode thread ${context.threadId} is a helper (${reasonOf(cause)}); it starts with the machine's config`); return []; }
        await pause(RETRY_PAUSE_MS);
      }
    }
    if (!stringAt(metadata, "role")) return [];
    // The model only picks which provider's plugin is kept (all auth plugins are): without it the helper still starts.
    const options = await within(CALL_MS, "defaultExecutionOptions", Promise.resolve(bb.sdk.threads.defaultExecutionOptions({ threadId: context.threadId }))).catch(() => null);
    let prepared: Prepared;
    try { prepared = await prepare(context.hostId, stringAt(options, "model")); } catch (cause) {
      bb.log.warn(`Lane Pilot: ${reasonOf(cause)}; the OpenCode helper ${context.threadId} is not started with the machine's full config`);
      throw cause;
    }
    if (!prepared) return [];
    return [{
      name: "XDG_CONFIG_HOME", value: prepared.configHome,
      reason: `Lane Pilot: OpenCode helper with a minimal config (kept ${prepared.kept.join(", ") || "nothing"}; left out ${prepared.left.join(", ")})`.slice(0, 500),
    }];
  };
}

export function mountOpencodeMinimal(ctx: ServerCore) {
  // One resolver per provider: the minimal config's variable and the guard wrappers' PATH (src/bb-shim.ts) go out together.
  const minimal = createOpencodeMinimalEnv(ctx);
  const shim = createBbShimEnv(ctx);
  ctx.bb.providers.experimental_contributeEnv(OPENCODE_PROVIDER_ID, async (context) => (await Promise.all([minimal(context), shim(context)])).flat());
}
