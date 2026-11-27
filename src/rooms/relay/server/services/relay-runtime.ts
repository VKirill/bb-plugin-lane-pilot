import { parseIntegrationGateSettings } from "../../../contracts";
import { pmDeferralLines } from "../../../deferral/server";
import { calibrate, calibrationLine } from "../../../forecast";
import { forecastReport } from "../../../forecast/server";
import { sendServiceMessage, type ServerContext } from "../../../platform/server";
import type { LanePilotDatabase } from "../../../storage";
import { gateRunVerdict } from "../../../verification/server";
import {
  findLatestFamilyMember,
  hasPendingTaskOutcomes,
  loadRelayItems,
  loadTaskOutcomesSince,
  markRelayOutcomesReported,
  readPmTasksAtWork,
  readRelayGateContext,
  readRelayPrototypeConfig,
  readRelayTaskStates,
  saveRelayItems,
  wasOutcomeToldDirectly,
} from "../repositories/relay-repository";
import { createRelay, type Relay } from "./relay";

const relays = new WeakMap<object, Relay>();
/** Background commands per thread, from the last thread:changed event; threads.get does not report them. */
const backgroundCommands = new Map<string, number>();

export function setBackgroundCommandCount(threadId: string, count: number): void {
  backgroundCommands.set(threadId, count);
}

export function hasPendingRelayOutcomes(db: LanePilotDatabase): boolean {
  return hasPendingTaskOutcomes(db);
}

/** The plugin's one relay over BB storage and threads; every caller shares it, so writes stay in one queue. */
export function relayFor(ctx: ServerContext): Relay {
  const { bb } = ctx;
  const existing = relays.get(bb);
  if (existing) return existing;
  const relay = createRelay({
    manualMode: ctx.manualMode,
    load: () => loadRelayItems(bb.storage.kv),
    save: (items) => saveRelayItems(bb.storage.kv, items),
    send: async (threadId, text, senderThreadId) => { await sendServiceMessage(bb, { threadId, text, senderThreadId }); },
    nativelyNotifiesParent: async (childThreadId, parentThreadId) => {
      const loudChild = async (childId: string, parentId: string) => {
        const [thread, meta] = await Promise.all([
          bb.sdk.threads.get({ threadId: childId }).catch(() => null) as Promise<{ parentThreadId?: unknown; parentNotifications?: unknown } | null>,
          (bb.sdk.threads as unknown as { getPluginMetadata?: (args: { threadId: string }) => Promise<Record<string, unknown> | null> }).getPluginMetadata?.({ threadId: childId }).catch(() => null) ?? Promise.resolve(null),
        ]);
        return thread?.parentThreadId === parentId && thread?.parentNotifications !== "none" && meta?.experimental_vkQuietChild !== true;
      };
      return (await loudChild(childThreadId, parentIdOr(parentThreadId))) || (await loudChild(parentThreadId, childThreadId));
    },
    settled: async (threadId) => {
      const thread = await bb.sdk.threads.get({ threadId }) as { status?: string; queuedMessageCount?: number; activeBackgroundAgentCount?: number; environmentId?: string | null };
      // threads.get has no background command count; the thread list of its environment does.
      type Listed = { id: string; activity?: { activeBackgroundCommandCount?: number } };
      const listed = thread.environmentId
        ? await (bb.sdk.threads.list({ environmentId: thread.environmentId, includeHidden: true } as never) as Promise<unknown>).catch((cause: unknown) => { ctx.log(`relay: thread list unreadable: ${cause instanceof Error ? cause.message : String(cause)}`); return null; })
        : null;
      const row = Array.isArray(listed) ? (listed as Listed[]).find((item) => item.id === threadId) : undefined;
      const commands = row?.activity?.activeBackgroundCommandCount ?? backgroundCommands.get(threadId) ?? 0;
      return ["idle", "error", "stopped"].includes(thread.status ?? "") && !thread.queuedMessageCount && !thread.activeBackgroundAgentCount && commands === 0;
    },
    busy: async (threadId) => !["idle", "error", "stopped"].includes(((await bb.sdk.threads.get({ threadId })) as { status?: string }).status ?? ""),
    taskStates: async (projectId, taskIds) => readRelayTaskStates(ctx.db, projectId, taskIds),
    latestFamilyMember: async (projectId, taskId) => findLatestFamilyMember(ctx.db, projectId, taskId),
    output: async (threadId) => {
      const result = await bb.sdk.threads.output({ threadId }) as { output?: unknown; text?: unknown };
      const value = result.output ?? result.text;
      return typeof value === "string" ? value : JSON.stringify(value ?? "");
    },
    // The time of a reminder is kept by BB's own queue (threads.send with sendAt, threads.queuedMessages): a card in the chat that
    // survives a reload. LANE_PILOT_NATIVE_REMINDERS=0 goes back to the sweep sending it when due.
    ...(process.env.LANE_PILOT_NATIVE_REMINDERS === "0" ? {} : {
      scheduleQueued: async (threadId: string, text: string, sendAt: number) => {
        // «Ручной режим»: do not queue native reminders with sendAt into BB while manual.
        if (ctx.manualMode?.on()) {
          ctx.log("relay: native reminder queue skipped (manual mode)");
          return null;
        }
        const sent = await bb.sdk.threads.send({ threadId, mode: "queue-if-active", sendAt, input: [{ type: "text", text, mentions: [] }] } as never);
        // Anything but a queued row means BB took no `sendAt`: it cannot be undone, so say so loudly and let the sweep carry on.
        if (sent.delivery !== "queued") { ctx.log(`relay: BB sent a reminder at once instead of queueing it for ${new Date(sendAt).toISOString()}`); return null; }
        return sent.queuedMessage.id;
      },
      dropQueued: async (threadId: string, queuedMessageId: string) => {
        try { await bb.sdk.threads.queuedMessages.delete({ threadId, queuedMessageId }); return "deleted" as const; }
        // 404: not there (sent or deleted). 409: BB has taken it for dispatch this moment. Neither is a row to wait for.
        catch (cause) { return /\b(404|409)\b|not found/i.test(cause instanceof Error ? cause.message : String(cause)) ? "gone" as const : "failed" as const; }
      },
      queuedState: async (threadId: string, queuedMessageId: string) => {
        try {
          const rows = await bb.sdk.threads.queuedMessages.list({ threadId });
          return rows.some((row) => row.id === queuedMessageId) ? "waiting" as const : "gone" as const;
        } catch (cause) { return /\b404\b|not found/i.test(cause instanceof Error ? cause.message : String(cause)) ? "gone" as const : "unknown" as const; }
      },
    }),
    // Results that ended before this version ran were reported by the PM's own reminders: start from the first sweep.
    taskOutcomes: () => loadTaskOutcomesSince(bb.storage.kv, ctx.db, () => Date.now()),
    tasksAtWork: async (pmThreadId) => readPmTasksAtWork(ctx.db, pmThreadId),
    toldDirectly: (row) => wasOutcomeToldDirectly(ctx.db, row),
    markReported: async (rows) => markRelayOutcomesReported(ctx.db, rows, Date.now()),
    // What a PM reads before it promises a date (SMA rule 6): the register of deferrals and how its forecasts held (src/rooms/forecast).
    deferralLines: (projectId) => {
      const lines: string[] = [];
      try { lines.push(...pmDeferralLines(ctx.db, projectId, Date.now())); } catch { /* the register is informational here */ }
      try {
        const report = forecastReport(ctx.db, { projectId, days: 60 });
        // SMA k_lib_modelver: the PM reads how the model it runs on now forecast, never another model's priors.
        const config = readRelayPrototypeConfig(ctx.db, projectId);
        const model = config?.pmProviderId && config?.pmModel ? `${config.pmProviderId}/${config.pmModel}` : null;
        const overall = model ? calibrate(report.scored, model).overall : report.calibration.overall;
        const line = calibrationLine(overall ?? undefined);
        if (line) lines.push(line);
      } catch { /* idem */ }
      return lines;
    },
    // «accepted» is the merge, not main's check: the results message carries the integration gate's verdict of the
    // task's merge commit (running / red / not run / none configured), so «all tasks accepted» is never read as «ship» (Astra F1).
    gateLine: async (row) => {
      const { found, settings: rawSettings, hasPriorGateRun } = readRelayGateContext(ctx.db, row);
      if (found) return gateRunVerdict(found).line;
      // No run for this merge yet. The gate exists when the project set it or one ran before; otherwise the merge
      // itself never called the runner (finish.ts only notes a merge when the gate resolved) — «none configured».
      const settings = parseIntegrationGateSettings(rawSettings ?? {});
      if (settings.gateOff) return "none configured";
      return settings.gateCommand || hasPriorGateRun ? "running" : "none configured";
    },
    now: () => Date.now(),
    log: ctx.log,
  });
  relays.set(bb, relay);
  return relay;
}

const parentIdOr = (id: string) => id;
