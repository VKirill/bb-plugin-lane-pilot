import { getRun, getRunWriterHost, listOpenAttempts } from "../../storage";
import { threadSignalHub } from "@lane-pilot/thread-observe";
import { loadBlockedBy, saveBlockedBy, type BlockedBy } from "../../runs/server";
import { closeAbandonedRuns, pluginStopped } from "../../runs/server";
import type { ServerCore } from "./core";
import { loadFollowUp, markFollowUpCancelled } from "../../writer/server";
import { valueAt } from "./values";

/**
 * What BB announces about threads, queued messages and machines, handled when it happens instead of at the next sweep
 * (`bb.events.on`). Every handler is an announcement's listener: it cannot veto anything, and a failure is only logged. The
 * sweeps stay as the safety net for an event lost to a reload.
 */

const idOf = (value: unknown, key: string): string | null => {
  const found = valueAt(valueAt(value, key), "id");
  return typeof found === "string" && found ? found : null;
};

type Listen = (name: string, handler: (payload: unknown) => Promise<void> | void) => void;

export function mountLifecycleEvents(ctx: ServerCore, extra?: { onQueued?: (name: "message.dispatched" | "message.cancelled", entry: unknown) => Promise<void> | void }) {
  const { bb, db } = ctx;
  const events = (bb as unknown as { events?: { on?: (name: string, handler: (payload: unknown) => unknown) => void } }).events;
  if (!events || typeof events.on !== "function" || process.env.LANE_PILOT_THREAD_SIGNALS === "0") return;
  const listen: Listen = (name, handler) => {
    try {
      events.on!(name, async (payload) => {
        if (ctx.isDisposed()) return;
        try { await handler(payload); }
        catch (cause) { if (!pluginStopped(cause)) bb.log.warn(`Lane Pilot ${name} handler failed: ${cause instanceof Error ? cause.message : String(cause)}`); }
      });
    } catch (cause) {
      // An older BB does not know every event (experimental_host.deleted came late): the sweeps cover it.
      bb.log.info(`Lane Pilot does not listen to ${name}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };

  // The PM chat of a run was archived or deleted: the run is closed now, not at the next quarter-hour sweep. A run with an
  // open attempt is left to the sweep, the same rule as there.
  const closeRunOf = async (payload: unknown) => {
    const threadId = idOf(payload, "thread");
    if (!threadId) return;
    const closed = await closeAbandonedRuns(bb, db, Date.now(), undefined, threadId);
    if (closed.length) bb.log.info(`Lane Pilot closed ${closed.length} run(s) whose PM chat ${threadId} is gone: ${closed.join(", ")}`);
  };
  listen("thread.archived", closeRunOf);
  listen("thread.deleted", closeRunOf);

  // A writer stopped on a question or an approval nobody sees: the PM is told once, and if the attempt later ends blocked
  // the reason is on its blockedBy.
  listen("interaction.pending", async (payload) => {
    const threadId = idOf(payload, "thread");
    const interaction = valueAt(payload, "interaction");
    const interactionId = valueAt(interaction, "id");
    if (!threadId || typeof interactionId !== "string") return;
    const attempt = listOpenAttempts(db).find((row) => row.thread_id === threadId && row.state === "running");
    if (!attempt) return;
    const known = await loadBlockedBy(bb.storage.kv, attempt.id);
    if (known?.kind === "human" && known.detail?.includes(interactionId)) return;
    const payloadKind = valueAt(valueAt(interaction, "payload"), "kind");
    const reason = valueAt(valueAt(interaction, "payload"), "reason");
    const what = `${typeof payloadKind === "string" ? payloadKind : "interaction"}${typeof reason === "string" && reason ? `: ${reason.slice(0, 300)}` : ""}`;
    const blockedBy: BlockedBy = { kind: "human", holderTaskId: attempt.task_id, holderThreadId: threadId, holderAttemptId: attempt.id,
      since: new Date().toISOString(), retryAfterSec: 300, detail: `writer waits for the owner (${what}; ${interactionId})` };
    await saveBlockedBy(bb.storage.kv, attempt.id, blockedBy);
    const pmThreadId = getRun(db, attempt.run_id)?.pm_thread_id;
    bb.log.info(`Lane Pilot: the writer of ${attempt.task_id} (${threadId}) waits for the owner: ${what}`);
    if (pmThreadId) {
      await bb.sdk.threads.send({ threadId: pmThreadId, mode: "queue-if-active", input: [{ type: "text", mentions: [],
        text: `Lane Pilot: the writer of task ${attempt.task_id} (@thread:${threadId}) is stopped on a question that needs the owner (${what}). The task stays running and will not go on by itself: tell the owner to open that thread and answer, or cancel the task.` }] } as never);
    }
  });

  // A queued row was deleted before it dispatched. A follow-up turn for a writer never reaches it, so its attempt stops
  // waiting and frees the writer slot; a reminder the relay queued is closed (extra.onQueued).
  listen("message.cancelled", async (payload) => {
    const entry = valueAt(payload, "entry");
    const threadId = valueAt(entry, "threadId");
    if (typeof threadId !== "string") return;
    await extra?.onQueued?.("message.cancelled", entry);
    const ours = valueAt(entry, "originPluginId") === (bb as unknown as { pluginId?: string }).pluginId;
    if (!ours) return;
    const attempt = listOpenAttempts(db).find((row) => row.thread_id === threadId && row.state === "running");
    const since = attempt ? await loadFollowUp(bb.storage.kv, attempt.id) : null;
    const createdAt = valueAt(entry, "createdAt");
    if (!attempt || since === null || (typeof createdAt === "number" && createdAt < since - 5_000)) return;
    markFollowUpCancelled(bb, attempt.id);
    bb.log.info(`Lane Pilot: the follow-up for ${attempt.task_id} (${threadId}) was deleted from the queue; its attempt stops waiting`);
    threadSignalHub(bb)?.notify(threadId, "message.cancelled");
  });

  if (extra?.onQueued) listen("message.dispatched", (payload) => extra.onQueued!("message.dispatched", valueAt(payload, "entry")));

  // A machine was removed: what Lane Pilot kept for it goes too, or every enable/disable/remove keeps trying it.
  listen("experimental_host.deleted", async (payload) => {
    const hostId = idOf(payload, "host");
    if (!hostId) return;
    await ctx.nativeInstaller.forget(hostId);
    let jobs = 0;
    for (const key of await bb.storage.kv.list("host-job:")) {
      if (key.split(":")[2] !== hostId) continue;
      await bb.storage.kv.delete(key);
      jobs++;
    }
    const orphaned = new Set(listOpenAttempts(db).filter((row) => getRunWriterHost(db, row.run_id) === hostId).map((row) => row.run_id));
    bb.log.info(`Lane Pilot forgot machine ${hostId}: install record, ${jobs} host job(s)${orphaned.size ? `; ${orphaned.size} run(s) with open attempts still name it` : ""}`);
  });
}
