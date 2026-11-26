import type { ServerCore } from "../../../contracts/server";
import type { HookTimeoutRecord } from "../../models/hook-timeouts";
import { appendHookTimeoutRecord } from "../repositories/hook-timeouts-repository";

/** Logs and stores a VK hook timeout event via the repository. */
export async function recordHookTimeout(ctx: Pick<ServerCore, "bb" | "serializedKv">, record: HookTimeoutRecord): Promise<void> {
  ctx.bb.log.info(`Lane Pilot hook ${record.hook} did not answer in ${record.timeoutMs} ms${record.threadId ? ` (thread ${record.threadId})` : ""}${record.quiet ? " (reload window)" : ""}`);
  await appendHookTimeoutRecord(ctx, record);
}
