import type { ServerCore } from "./core";

/**
 * VK core hook policy (`vk.hookPolicy` in package.json, `bb.vk.experimental_vkOnHookTimeout`). BB drops the env of a
 * plugin whose resolver is late and starts the turn without it, with no trace; with the policy the core writes a line
 * into the thread and calls this subscription, which keeps the event where the self-repair watcher reads it. Without
 * the core function nothing is subscribed and the 0.1.150 cached launcher stays the only guard.
 */
export const HOOK_TIMEOUTS_KEY = "vk:hook-timeouts";
const KEEP = 50;
/** A hook that was held for a reload (drain) or came right after one is the reload's, not a fault. */
const QUIET_AFTER_START_MS = 120_000;

export type HookTimeoutRecord = { hook: string; timeoutMs: number; threadId: string | null; projectId: string | null; required: boolean; at: number; quiet: boolean };
type TimeoutEvent = { hook?: unknown; timeoutMs?: unknown; threadId?: unknown; projectId?: unknown; required?: unknown };
type VkNamespace = { experimental_vkOnHookTimeout?: (callback: (event: TimeoutEvent) => void | Promise<void>) => { dispose(): void } };

export function mountHookTimeoutWatch(ctx: ServerCore, now = () => Date.now()): boolean {
  const vk = (ctx.bb as unknown as { vk?: VkNamespace }).vk;
  if (typeof vk?.experimental_vkOnHookTimeout !== "function") return false;
  const startedAt = now();
  vk.experimental_vkOnHookTimeout(async (event) => {
    const record: HookTimeoutRecord = {
      hook: typeof event.hook === "string" ? event.hook : "unknown",
      timeoutMs: typeof event.timeoutMs === "number" ? event.timeoutMs : 0,
      threadId: typeof event.threadId === "string" ? event.threadId : null,
      projectId: typeof event.projectId === "string" ? event.projectId : null,
      required: event.required === true,
      at: now(),
      quiet: ctx.deployDrain.status().draining || now() - startedAt < QUIET_AFTER_START_MS,
    };
    ctx.bb.log.info(`Lane Pilot hook ${record.hook} did not answer in ${record.timeoutMs} ms${record.threadId ? ` (thread ${record.threadId})` : ""}${record.quiet ? " (reload window)" : ""}`);
    await ctx.serializedKv(async () => {
      const rows = (await ctx.bb.storage.kv.get<HookTimeoutRecord[]>(HOOK_TIMEOUTS_KEY).catch(() => null)) ?? [];
      await ctx.bb.storage.kv.set(HOOK_TIMEOUTS_KEY, [...(Array.isArray(rows) ? rows : []), record].slice(-KEEP) as never);
    });
  });
  return true;
}
