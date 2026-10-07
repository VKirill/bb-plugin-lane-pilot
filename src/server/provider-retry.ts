import type { BbPluginApi } from "@get-bb/plugin-sdk";

/**
 * BB's `provider-retry` plugin queues a retry of a failed turn in the thread that failed (a subscription limit, an
 * overload): an ordinary durable queued row with `payload.kind === "retry"` and a `sendAt`. When Lane Pilot hands the
 * task to the next writer of its chain, that row would later wake the abandoned thread and redo the same work twice.
 *
 * The plugin has no flag to respect and no RPC; what it leaves is the row, which `bb provider-retry cancel` deletes
 * through `threads.queuedMessages.delete`. Lane Pilot does the same for a thread it has given up on, at once and for any
 * row queued afterwards (`message.queued`, because the plugin may queue its retry after Lane Pilot has seen the failure).
 * Without the plugin there is no such row and nothing happens.
 */
const REMEMBERED = 500;

export function createProviderRetryGuard(bb: Pick<BbPluginApi, "sdk" | "events" | "log">) {
  const abandoned = new Set<string>();

  /** Deletes every queued retry row of the thread; returns how many. Never throws. */
  async function cancelQueuedRetries(threadId: string): Promise<number> {
    try {
      const rows = await bb.sdk.threads.queue.list({ threadId });
      const retries = (Array.isArray(rows) ? rows : []).filter((row) => row.threadId === threadId && row.payload.kind === "retry");
      let deleted = 0;
      for (const row of retries) {
        await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId: row.id }).then(() => { deleted += 1; }, () => undefined);
      }
      if (deleted) bb.log.info(`Lane Pilot cancelled ${deleted} queued provider retry of ${threadId}: its task moved on`);
      return deleted;
    } catch {
      return 0;
    }
  }

  /** The thread's work moves to another writer: its queued retries go now, and so does any queued from here on. */
  async function abandon(threadId: string | null | undefined): Promise<number> {
    if (!threadId) return 0;
    abandoned.add(threadId);
    if (abandoned.size > REMEMBERED) abandoned.delete(abandoned.values().next().value as string);
    return await cancelQueuedRetries(threadId);
  }

  bb.events.on("message.queued", async ({ entry }) => {
    if (entry.payload.kind === "retry" && abandoned.has(entry.threadId)) {
      await bb.sdk.threads.queuedMessages.delete({ threadId: entry.threadId, queuedMessageId: entry.id }).then(
        () => bb.log.info(`Lane Pilot cancelled a provider retry queued in ${entry.threadId}: its task moved on`),
        () => undefined,
      );
    }
  });

  return { abandon, cancelQueuedRetries };
}

export type ProviderRetryGuard = ReturnType<typeof createProviderRetryGuard>;
