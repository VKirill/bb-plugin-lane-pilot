import type { ServerCore } from "../../../contracts/server";
import { HOOK_TIMEOUTS_KEY, type HookTimeoutRecord } from "../../models/hook-timeouts";

const KEEP = 50;

/** Appends a hook timeout record to KV under `HOOK_TIMEOUTS_KEY`, keeping the latest `KEEP` entries. */
export async function appendHookTimeoutRecord(ctx: Pick<ServerCore, "bb" | "serializedKv">, record: HookTimeoutRecord): Promise<void> {
  await ctx.serializedKv(async () => {
    const rows = (await ctx.bb.storage.kv.get<HookTimeoutRecord[]>(HOOK_TIMEOUTS_KEY)) ?? [];
    await ctx.bb.storage.kv.set(HOOK_TIMEOUTS_KEY, [...(Array.isArray(rows) ? rows : []), record].slice(-KEEP) as never);
  });
}
