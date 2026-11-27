import { sendServiceMessage } from "../../../relay/server";
import { isWriterWaitActive } from "../../../platform/server";
import { providerDisplayName } from "./writer-hold";
import type { ServerCore } from "../../../contracts/server";
import { bestEffort } from "@lane-pilot/kit";

const unsupportedKey = (providerId: string) => `writer-unsupported:${providerId}`;

/**
 * Tells the owner once per provider that this core cannot run it and which setting to change — one item per provider,
 * not one per task that tripped over it. Returns true when the note was sent now.
 */
export async function noteUnsupportedProvider(ctx: ServerCore, input: {
  providerId: string; pmThreadId: string | null | undefined; taskId: string;
}): Promise<boolean> {
  const key = unsupportedKey(input.providerId);
  const told = await ctx.bb.storage.kv.get(key);
  if (told) return false;
  await bestEffort(ctx.log, "writer unsupported note", ctx.bb.storage.kv.set(key, String(Date.now())), undefined);
  ctx.log(`writer ${input.taskId}: provider ${input.providerId} is not supported by this core; the task is blocked`);
  if (!input.pmThreadId || isWriterWaitActive(input.pmThreadId)) return true;
  await bestEffort(ctx.log, "writer unsupported notice", sendServiceMessage(ctx.bb, {
    threadId: input.pmThreadId,
    text: `Lane Pilot: задача ${input.taskId} остановлена — писатель ${providerDisplayName(input.providerId)} не поддерживается этим ядром (core_unsupported). ` +
      `Смените writer.provider (или включите поддержку провайдера в настройках ядра) и отправьте задачу ещё раз. Это сообщение приходит один раз на провайдера, не на каждую задачу.`,
  }), undefined);
  return true;
}

