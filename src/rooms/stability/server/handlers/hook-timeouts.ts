import type { ServerCore } from "../../../contracts/server";
import type { HookTimeoutRecord } from "../../models/hook-timeouts";
import { recordHookTimeout } from "../services/hook-timeouts";

/**
 * VK core hook policy (`vk.hookPolicy` in package.json, `bb.vk.experimental_vkOnHookTimeout`). BB drops the env of a
 * plugin whose resolver is late and starts the turn without it, with no trace; with the policy the core writes a line
 * into the thread and calls this subscription, which keeps the event where the self-repair watcher reads it. Without
 * the core function nothing is subscribed and the 0.1.150 cached launcher stays the only guard.
 */
/** A hook that was held for a reload (drain) or came right after one is the reload's, not a fault. */
const QUIET_AFTER_START_MS = 120_000;

export function mountHookTimeoutWatch(ctx: ServerCore, now = () => Date.now()): boolean {
  const vk = ctx.bb.vk;
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
    await recordHookTimeout(ctx, record);
  });
  return true;
}
