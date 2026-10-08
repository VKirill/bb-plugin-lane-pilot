import type { ExperimentalPluginProviderEnvEntry } from "@get-bb/plugin-sdk";
import { stringAt } from "./values";
import type { ServerCore } from "./core";
import { scheduleIsolated } from "./schedules";
import { createBbShimEnv } from "./helper-bb-shim";

/**
 * Lane Pilot's OpenCode helpers run with a minimal config (see src/opencode-min-config.ts for why and how). The OpenCode provider
 * of BB starts `opencode acp` with the thread's environment, and a plugin may add variables to it (`contributeEnv`): for a thread
 * Lane Pilot started we add `XDG_CONFIG_HOME`, pointing at the config home the machine builds for it.
 *
 * BB gives a `contributeEnv` hook 5 seconds, and the preparation on the machine (reading the global config, linking its
 * entries, three tries of 4 seconds) took up to ~25 s (audit 2026-10-08 round 3, item 15). So it is done ahead: at start-up and
 * every few minutes for every connected machine, per machine and model provider (the set of auth plugins to keep). The hook
 * only reads that cache, waits at most ~2.5 s for a preparation already running, and otherwise refuses the helper's start at once
 * with the reason (`opencode_minimal_config_pending:…` while one runs in the background, `…_failed:…` when it failed): the helper
 * never starts with the machine's full config because a preparation was late or failed (audit round 2, B8). A machine answering
 * «nothing to leave out» or an owner who switched it off (`~/.lane-pilot/opencode-min.json`) is not a failure and the thread keeps
 * the machine's config.
 */
export const OPENCODE_PROVIDER_ID = "acp-opencode";
/** A prepared answer is refreshed in the background once it is this old, and not used at all once it is older than KEEP_MS. */
const FRESH_MS = 5 * 60_000;
const KEEP_MS = 60 * 60_000;
const CALL_MS = 4_000;
/** What the hook itself may spend (BB's limit is 5 s): reading the thread, then waiting for a preparation already running. */
const THREAD_CALL_MS = 1_500;
const WAIT_MS = 2_500;
const PREFIXES_KEY = "opencode-min:prefixes";
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


export type OpencodeMinimalEnv = ((context: { threadId: string; hostId: string }) => Promise<ExperimentalPluginProviderEnvEntry[]>) & {
  /** Prepares ahead (in the background, never throws) for a machine and a model; null model = no provider named. */
  warm(hostId: string, model: string | null): void;
  /** Prepares ahead for every connected machine and every model provider seen so far. */
  warmConnected(): Promise<void>;
};

export function createOpencodeMinimalEnv(ctx: Pick<ServerCore, "bb" | "host">, now: () => number = Date.now, pause: (ms: number) => Promise<void> = (ms) => new Promise((done) => setTimeout(done, ms))): OpencodeMinimalEnv {
  const { bb, host } = ctx;
  const cache = new Map<string, { at: number; value: Prepared }>();
  const inflight = new Map<string, Promise<Prepared>>();
  const prefixes = new Set<string>([""]);
  const kv = (bb as unknown as { storage?: { kv?: { get<T>(key: string): Promise<T | null | undefined>; set(key: string, value: unknown): Promise<unknown> } } }).storage?.kv;
  let prefixesLoaded: Promise<void> | null = null;

  const prefixOf = (model: string | null) => (model?.includes("/") ? model.split("/")[0]! : "");
  const keyOf = (hostId: string, model: string | null) => `${hostId}\0${prefixOf(model)}`;

  /** One host call; throws on a failure or a timeout, answers null only when the machine said there is nothing to do. */
  async function ask(hostId: string, model: string | null): Promise<Prepared> {
    const answer = await within(CALL_MS, "prepareOpencodeMinimal", Promise.resolve(host.call("prepareOpencodeMinimal", { requestedHostId: hostId, model }, { hostId, timeoutMs: CALL_MS })));
    return (answer as { result: Prepared }).result;
  }

  /** The one preparation in flight for a key: tries up to ATTEMPTS times and stores a success. */
  function start(key: string, hostId: string, model: string | null): Promise<Prepared> {
    const running = inflight.get(key);
    if (running) return running;
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
      // A failure is not cached as an answer: the next helper asks again.
      throw new Error(`opencode_minimal_config_failed:${hostId}: ${reasonOf(last)} (after ${ATTEMPTS} tries)`);
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, work);
    return work;
  }

  function loadPrefixes(): Promise<void> {
    prefixesLoaded ??= (async () => {
      const stored = await kv?.get<string[]>(PREFIXES_KEY).catch(() => null);
      if (Array.isArray(stored)) for (const item of stored) if (typeof item === "string") prefixes.add(item);
    })();
    return prefixesLoaded;
  }
  function remember(model: string | null): void {
    const prefix = prefixOf(model);
    if (prefixes.has(prefix)) return;
    prefixes.add(prefix);
    void kv?.set(PREFIXES_KEY, [...prefixes].filter(Boolean)).catch(() => undefined);
  }

  function warm(hostId: string, model: string | null): void {
    const hit = cache.get(keyOf(hostId, model));
    if (hit && now() - hit.at < FRESH_MS) return;
    start(keyOf(hostId, model), hostId, model).catch((cause) => bb.log.info(`Lane Pilot: OpenCode minimal config not prepared ahead for ${hostId}: ${reasonOf(cause)}`));
  }

  async function warmConnected(): Promise<void> {
    await loadPrefixes();
    const listed = await Promise.resolve((bb.sdk as unknown as { hosts?: { list?: () => Promise<unknown> } }).hosts?.list?.()).catch(() => []);
    for (const entry of Array.isArray(listed) ? listed : []) {
      const hostId = stringAt(entry, "id");
      if (!hostId || (entry as { connected?: unknown }).connected === false) continue;
      for (const prefix of prefixes) warm(hostId, prefix ? `${prefix}/` : null);
    }
  }

  const hook = async (context: { threadId: string; hostId: string }): Promise<ExperimentalPluginProviderEnvEntry[]> => {
    // Only threads Lane Pilot started carry its role; the owner's own OpenCode chats keep their full config.
    let metadata: unknown = null;
    try { metadata = await within(THREAD_CALL_MS, "getPluginMetadata", Promise.resolve(bb.sdk.threads.getPluginMetadata({ threadId: context.threadId }))); } catch (cause) {
      bb.log.warn(`Lane Pilot: could not tell whether OpenCode thread ${context.threadId} is a helper (${reasonOf(cause)}); it starts with the machine's config`);
      return [];
    }
    if (!stringAt(metadata, "role")) return [];
    // The model only picks which provider's plugin is kept (all auth plugins are): without it the helper still starts.
    const options = await within(THREAD_CALL_MS, "defaultExecutionOptions", Promise.resolve(bb.sdk.threads.defaultExecutionOptions({ threadId: context.threadId }))).catch(() => null);
    const model = stringAt(options, "model") ?? null;
    remember(model);
    const key = keyOf(context.hostId, model);
    const hit = cache.get(key);
    let prepared: Prepared;
    if (hit && now() - hit.at < KEEP_MS) {
      prepared = hit.value;
      if (now() - hit.at >= FRESH_MS) warm(context.hostId, model);
    } else {
      // Nothing usable cached: start (or join) the preparation, give it what is left of BB's 5 seconds, then refuse with the reason.
      const running = start(key, context.hostId, model);
      running.catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        prepared = await Promise.race([running, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("pending")), WAIT_MS); })]);
      } catch (cause) {
        const reason = cause instanceof Error && cause.message === "pending"
          ? `opencode_minimal_config_pending:${context.hostId}: the minimal config for this machine is being prepared in the background; start the helper again in a moment`
          : reasonOf(cause);
        bb.log.warn(`Lane Pilot: ${reason}; the OpenCode helper ${context.threadId} is not started with the machine's full config`);
        throw new Error(reason);
      } finally { clearTimeout(timer); }
    }
    if (!prepared) return [];
    return [{
      name: "XDG_CONFIG_HOME", value: prepared.configHome,
      reason: `Lane Pilot: OpenCode helper with a minimal config (kept ${prepared.kept.join(", ") || "nothing"}; left out ${prepared.left.join(", ")})`.slice(0, 500),
    }];
  };

  return Object.assign(hook, { warm, warmConnected });
}

export function mountOpencodeMinimal(ctx: ServerCore) {
  // One resolver per provider: the minimal config's variable and the guard wrappers' PATH (src/bb-shim.ts) go out together.
  const env = createOpencodeMinimalEnv(ctx);
  const shim = createBbShimEnv(ctx);
  ctx.bb.providers.experimental_contributeEnv(OPENCODE_PROVIDER_ID, async (context) => (await Promise.all([env(context), shim(context)])).flat());
  // Ahead of the first helper, and again every few minutes: a machine that connects later is prepared at the next tick.
  const warm = () => { void env.warmConnected().catch(() => undefined); };
  const first = setTimeout(warm, 2_000);
  first.unref?.();
  ctx.bb.onDispose?.(() => clearTimeout(first));
  scheduleIsolated(ctx.bb, "opencode-minimal-warm", "1-58/3 * * * *", async () => { warm(); }, { timeoutMs: 60_000 });
}
