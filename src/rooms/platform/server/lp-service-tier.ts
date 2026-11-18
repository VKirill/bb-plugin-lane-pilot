import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { nativeSelectionSchema, nativeThreadKey } from "../../contracts";

export const LANE_PILOT_PLUGIN_ID = "lane-pilot";

/**
 * The provider a native Lane Pilot binding drives; a stored `native-thread:` selection counts as active only while the
 * thread runs on it. native-dispatch treats a message on another provider as the profile being off for that message
 * while the binding stays stored, so the binding alone never makes a chat Lane Pilot's.
 */
const NATIVE_PROVIDER_ID = "claude-code";

const hasNativeBinding = async (bb: BbPluginApi, threadId: string): Promise<boolean> => {
  try {
    const raw = await bb.storage.kv.get(nativeThreadKey(threadId));
    return raw != null && nativeSelectionSchema.safeParse(raw).success;
  } catch {
    return false;
  }
};

/**
 * Whether a message target is positively Lane Pilot's for service-tier policy. A thread the plugin spawned is owned
 * on any provider; an open-run PM thread or a stored native binding counts only while the thread provably still runs
 * on the provider the binding drives — the intended provider when the request names one, else the recipient's. A
 * target whose provider cannot be read is not guessed owned, and an ordinary owner chat keeps whatever tier its
 * message carried.
 */
export async function lanePilotOwnedTarget(
  bb: BbPluginApi,
  openRunOnThread: (threadId: string) => unknown,
  request: { threadId: string; providerId?: unknown },
): Promise<boolean> {
  let thread: { providerId?: unknown; originPluginId?: unknown } | null = null;
  try {
    thread = await bb.sdk.threads.get({ threadId: request.threadId });
  } catch {
    thread = null;
  }
  if (thread?.originPluginId === LANE_PILOT_PLUGIN_ID) return true;
  if (!(await hasNativeBinding(bb, request.threadId)) && !openRunOnThread(request.threadId)) return false;
  const provider =
    typeof request.providerId === "string"
      ? request.providerId
      : typeof thread?.providerId === "string"
        ? thread.providerId
        : undefined;
  return provider === NATIVE_PROVIDER_ID;
}

/**
 * The standard-tier check the `message.dispatch` hook runs only after the native dispatch decided to proceed: a turn
 * that would still run on a nondefault tier while belonging to Lane Pilot — a retry or a queued row saved while Fast
 * was on — is refused rather than rewritten, because the queued row is immutable. A dispatch on the default tier and
 * an ordinary chat's Fast turn proceed untouched; a `wait` or `reject` the native dispatch already made never reaches
 * here.
 */
export async function lpStandardTierAdmission(
  bb: BbPluginApi,
  ctx: {
    thread: { id: string; originPluginId?: string | null };
    originPluginId?: string | "mixed" | null;
    queuedMessages?: ReadonlyArray<{ originPluginId?: string | null }>;
    requestedExecution: { providerId?: string | null; serviceTier?: string | null };
  },
): Promise<{ action: "reject"; message: string } | { action: "proceed" }> {
  const tier = ctx.requestedExecution.serviceTier;
  if (tier == null || tier === "default") return { action: "proceed" };
  const owned =
    ctx.thread.originPluginId === LANE_PILOT_PLUGIN_ID ||
    ctx.originPluginId === LANE_PILOT_PLUGIN_ID ||
    Boolean(ctx.queuedMessages?.some((row) => row?.originPluginId === LANE_PILOT_PLUGIN_ID)) ||
    (ctx.requestedExecution.providerId === NATIVE_PROVIDER_ID && (await hasNativeBinding(bb, ctx.thread.id)));
  return owned
    ? { action: "reject", message: "Lane Pilot: this chat runs on the standard service tier, so the turn saved for another tier cannot run. Send it again." }
    : { action: "proceed" };
}

/**
 * The one plugin-local view of bb that keeps Lane Pilot's own sends on the standard service tier while the rest of bb
 * keeps Fast: `threads.send` is normalized only when `owned` calls the target positively Lane Pilot's — an ordinary
 * owner chat keeps whatever tier its message carried, including Fast. Spawn normalization happens once in
 * `fullAccessSpawn`, so nothing here touches it. Every other member, namespace and value delegates to the original
 * api: getters read with the original receiver, methods are invoked with it, and the lazy callable namespace nodes
 * stay callable and traversable. The real api object the plugin was given is never read eagerly, spread or mutated.
 */
export function withStandardServiceTier(
  bb: BbPluginApi,
  owned: (request: { threadId: string; providerId?: unknown }) => Promise<boolean>,
): BbPluginApi {
  const wrappers = new WeakMap<object, WeakMap<object, unknown>>();
  const callable = (owner: object, fn: object): unknown => {
    let per = wrappers.get(owner);
    if (!per) wrappers.set(owner, (per = new WeakMap()));
    let wrapped = per.get(fn);
    if (!wrapped) {
      wrapped = new Proxy(fn, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? callable(target, value) : value;
        },
        apply(target, _thisArg, args) {
          return Reflect.apply(target as (...a: unknown[]) => unknown, owner, args);
        },
      });
      per.set(fn, wrapped);
    }
    return wrapped;
  };
  const sends = new WeakMap<object, unknown>();
  const facades = new WeakMap<object, object>();
  const passThrough = <T extends object>(original: T, intercept?: (target: T, prop: PropertyKey) => unknown): T => {
    let cached = facades.get(original) as T | undefined;
    if (!cached) {
      cached = new Proxy(original, {
        get(target, prop) {
          const hit = intercept?.(target, prop);
          if (hit !== undefined) return hit;
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? callable(target, value) : value;
        },
      });
      facades.set(original, cached);
    }
    return cached;
  };
  return passThrough(bb, (target, prop) => {
    if (prop !== "sdk") return undefined;
    return passThrough(Reflect.get(target, "sdk", target) as Record<PropertyKey, unknown>, (sdk, sdkProp) => {
      if (sdkProp !== "threads") return undefined;
      return passThrough(Reflect.get(sdk, "threads", sdk) as Record<PropertyKey, unknown>, (threads, threadsProp) => {
        if (threadsProp !== "send") return undefined;
        let send = sends.get(threads);
        if (!send) {
          send = async (request: { threadId?: unknown; providerId?: unknown }) =>
            Reflect.apply(Reflect.get(threads, "send", threads) as (args: unknown) => unknown, threads, [
              typeof request?.threadId === "string" && (await owned(request as { threadId: string; providerId?: unknown }))
                ? { ...(request as object), serviceTier: "default" }
                : request,
            ]);
          sends.set(threads, send);
        }
        return send;
      });
    });
  });
}
