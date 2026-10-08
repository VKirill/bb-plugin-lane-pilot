import type { ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { stringAt } from "./values";
import type { ServerCore } from "./core";

/**
 * Lane Pilot's OpenCode helpers run with a minimal config (see src/opencode-min-config.ts for why and how). The OpenCode provider
 * of BB starts `opencode acp` with the thread's environment, and a plugin may add variables to it (`contributeEnv`): for a thread
 * Lane Pilot started we add `XDG_CONFIG_HOME`, pointing at the config home the machine builds for it. Any failure leaves the
 * thread with the machine's own config, as before; nothing here may stop a turn.
 */
export const OPENCODE_PROVIDER_ID = "acp-opencode";
const CACHE_MS = 60_000;
const CALL_MS = 4_000;

type Prepared = { configHome: string; kept: string[]; left: string[] } | null;

export function createOpencodeMinimalEnv(ctx: Pick<ServerCore, "bb" | "host">, now: () => number = Date.now) {
  const { bb, host } = ctx;
  const cache = new Map<string, { at: number; value: Prepared }>();

  async function prepare(hostId: string, model: string | null): Promise<Prepared> {
    const key = `${hostId}\0${model?.split("/")[0] ?? ""}`;
    const hit = cache.get(key);
    if (hit && now() - hit.at < CACHE_MS) return hit.value;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const value = await Promise.race([
      host.call("prepareOpencodeMinimal", { requestedHostId: hostId, model } as never, { hostId, timeoutMs: CALL_MS } as never).then((answer) => (answer as { result: Prepared }).result, () => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), CALL_MS); }),
    ]).finally(() => clearTimeout(timer));
    cache.set(key, { at: now(), value });
    return value;
  }

  return async (context: { threadId: string; hostId: string }): Promise<ExperimentalPluginProviderEnvEntry[]> => {
    try {
      const metadata = await bb.sdk.threads.getPluginMetadata({ threadId: context.threadId }).catch(() => null);
      // Only threads Lane Pilot started carry its role; the owner's own OpenCode chats keep their full config.
      if (!stringAt(metadata, "role")) return [];
      const options = await bb.sdk.threads.defaultExecutionOptions({ threadId: context.threadId }).catch(() => null);
      const prepared = await prepare(context.hostId, stringAt(options, "model"));
      if (!prepared) return [];
      return [{
        name: "XDG_CONFIG_HOME", value: prepared.configHome,
        reason: `Lane Pilot: OpenCode helper with a minimal config (kept ${prepared.kept.join(", ") || "nothing"}; left out ${prepared.left.join(", ")})`.slice(0, 500),
      }];
    } catch {
      return [];
    }
  };
}

export function mountOpencodeMinimal(ctx: ServerCore) {
  ctx.bb.providers.experimental_contributeEnv(OPENCODE_PROVIDER_ID, createOpencodeMinimalEnv(ctx));
}
