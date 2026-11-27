import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { LanePilotDatabase } from "../../../storage";
import { PROVIDER_RETRY_CONSENT_METHOD, type RetryEligibility } from "../../models/provider-retry";
import { retryEligibility } from "../services/provider-retry";

/**
 * BB's `provider-retry` plugin queues a retry of a failed turn in the thread that failed (a subscription limit, an
 * overload): an ordinary durable queued row with `payload.kind === "retry"` and a `sendAt`. When Lane Pilot hands the
 * task to the next writer of its chain, that row would later wake the abandoned thread and redo the same work twice.
 *
 * The plugin has no flag to respect; what it leaves is the row, which `bb provider-retry cancel` deletes
 * through `threads.queuedMessages.delete`. Lane Pilot does the same for a thread it has given up on, at once and for any
 * row queued afterwards (`message.queued`, because the plugin may queue its retry after Lane Pilot has seen the failure).
 * Without the plugin there is no such row and nothing happens.
 *
 * BB 0.49 adds a consent call: before queueing, provider-retry asks the plugin that sent the failed turn
 * (`provider-retry.v1.consent`, discoverable) whether the retry may run; a missing, failing or slow answer counts as
 * allow. Lane Pilot answers from its durable store, not the RAM `abandoned` set that a reload empties: the newest
 * attempt on the thread must still be live (open, not superseded by a newer attempt of its task, run not closed).
 * Positively ended work — accepted, canceled, failed, blocked, superseded or under a closed run — is declined;
 * anything the store does not know stays allowed, so helper, PM and native threads keep their retries.
 */
const REMEMBERED = 500;

/** Wire contract of the official provider-retry consent endpoint (bb plugins/provider-retry/src/retry-contract.ts, tag desktop-v0.49.0). */
export const providerRetryConsentContract = defineRpcContract({
  [PROVIDER_RETRY_CONSENT_METHOD]: {
    input: z.object({
      threadId: z.string().min(1),
      requestId: z.string().min(1),
      reason: z.enum(["Rate limited", "Provider overloaded", "Provider unavailable"]),
      sendAt: z.number().int().nonnegative(),
    }),
    output: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("allow") }),
      z.object({ kind: z.literal("decline"), reason: z.string().min(1) }),
    ]),
    experimental_description:
      "Asked of the plugin that sent a failed turn before provider retry re-runs it. Decline when the sender already ended or replaced the work; allow leaves the retry scheduled. A missing, failing, or slow answer counts as allow.",
  },
});

export function createProviderRetryGuard(bb: Pick<BbPluginApi, "sdk" | "events" | "log" | "rpc">, db?: LanePilotDatabase) {
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

  /** The durable verdict for the queued check: a store failure answers `unknown`, keeping the historical RAM handling. */
  function durableKind(threadId: string): RetryEligibility["kind"] {
    if (!db) return "unknown";
    try {
      return retryEligibility(db, threadId).kind;
    } catch (cause) {
      bb.log.warn(`Lane Pilot could not check retry eligibility of ${threadId}: ${cause instanceof Error ? cause.message : String(cause)}`);
      return "unknown";
    }
  }

  bb.events.on("message.queued", async ({ entry }) => {
    if (entry.payload.kind !== "retry") return;
    // One decision, same as consent and the stream gate: durable `allow` supersedes a stale `abandoned` mark (the
    // thread was legitimately reused by a newer live attempt); `unknown` keeps the RAM behavior for threads the
    // store does not know; only `decline` or an abandoned unknown deletes the row.
    const kind = durableKind(entry.threadId);
    if (kind === "allow" || (kind === "unknown" && !abandoned.has(entry.threadId))) return;
    await bb.sdk.threads.queuedMessages.delete({ threadId: entry.threadId, queuedMessageId: entry.id }).then(
      () => bb.log.info(`Lane Pilot cancelled a provider retry queued in ${entry.threadId}: its task moved on`),
      () => undefined,
    );
  });

  if (db) {
    bb.rpc.register(providerRetryConsentContract, {
      [PROVIDER_RETRY_CONSENT_METHOD]: async (input) => {
        try {
          const eligibility = retryEligibility(db, input.threadId);
          if (eligibility.kind === "decline") return { kind: "decline" as const, reason: eligibility.reason };
          return { kind: "allow" as const };
        } catch (cause) {
          // Core counts a missing, failing or slow answer as allow; a store failure degrades to the same answer,
          // loudly, rather than silently cancelling retries core would have allowed.
          bb.log.warn(`Lane Pilot retry consent check failed for ${input.threadId}: ${cause instanceof Error ? cause.message : String(cause)}; allowing`);
          return { kind: "allow" as const };
        }
      },
    }, { experimental_discoverable: true });
  }

  return { abandon, cancelQueuedRetries };
}
