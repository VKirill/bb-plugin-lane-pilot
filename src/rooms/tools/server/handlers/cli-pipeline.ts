import { OWNER_ITEM_SWEEPS } from "./cli-deps";
import type { PluginCliResult } from "@get-bb/plugin-sdk";
import { type CliRunDeps } from "./cli-deps";
import { TASK_RECORD_USAGE, blindRecord, readsBlind, renderTaskRecord, taskRecord } from "../services/task-record";
import { runWorktreeCleanupCli } from "../../../stability/server";
import { cleanupFinishedAttemptEnvironments, cleanupStickyLaneWorktrees } from "../../../runs/server";
import { agentRegistry, answerWorkflowQuestion, budgetSpentSweep, conveyorState, failedTasksAllProjects, renderTimeline, runAgentsCli, runDeferralCli, runForecastCli, runOutageCli, runReturnCli, runScheduleCli, runWaitingCli, setConveyor, taskBaselineEntries, taskTimeline, tierReport } from "./cli-imports";
/** `timeline <task-id> [--run <run-id>] [--json]`: without --run the first bare word is the task (it was skipped until 2026-11-02). */
export function timelineArgs(args: string[]): { taskId: string | undefined; runId: string | undefined } {
  const runAt = args.indexOf("--run");
  return { taskId: args.find((arg, index) => !arg.startsWith("--") && (runAt < 0 || index !== runAt + 1)), runId: runAt >= 0 ? args[runAt + 1] : undefined };
}

/** Pipeline, phase and room-delegate commands of `bb lane-pilot`. Returns undefined when `command` is not one of theirs. */
export async function cliPipeline(d: CliRunDeps): Promise<PluginCliResult | undefined> {
  const { bb, db } = d.ctx;
  const { ctx, services, command, args, invocation } = d;

  if (command === "gates" && args[0] === "ack" && /^\d+$/.test(args[1] ?? "")) {
    // A firing a person marks as a false alarm stops counting against the gate (SMA k_v_gates).
    const whyAt = args.indexOf("--why");
    const why = whyAt >= 0 ? args.slice(whyAt + 1).join(" ").trim() : "";
    if (!why) return { exitCode:1, stderr:"bb lane-pilot gates ack <event-id> --why \"<reason>\"" };
    const kv = bb.storage.kv as { get(key: string): Promise<unknown>; set(key: string, value: unknown): Promise<unknown> };
    const all = ((await kv.get("gates:acks").catch(() => null)) ?? {}) as Record<string, unknown>;
    all[args[1]!] = { eventId: Number(args[1]), why: why.slice(0, 300), by: "owner", at: Date.now() };
    await kv.set("gates:acks", all);
    return { exitCode:0, stdout:JSON.stringify({ acked: Number(args[1]), why }) };
  }
  if (command === "waiting") {
    return runWaitingCli(db, args, Date.now(), [...OWNER_ITEM_SWEEPS, budgetSpentSweep(services)]);
  }
  if (command === "workflow-trigger" && args.length >= 2 && args.length <= 4) {
    const parsed: unknown = args[2] ? JSON.parse(args[2]) : {};
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("inputs must be a JSON object");
    // The tick's id is the key: a retried tick is the same run, not a second one.
    const result = await services.workflowTriggers.start({ projectId:args[0]!, workflowId:args[1]!, inputs:parsed as Record<string, unknown>, source:"schedule", key:args[3] || undefined });
    return { exitCode:result.ok ? 0 : 1, stdout:JSON.stringify(result, null, 2) };
  }
  if (command === "workflow-answer" && args.length >= 3) {
    const words = args.slice(2).join(" ");
    const result = await answerWorkflowQuestion(ctx, services, { runId:args[0]!, stepKey:args[1]!, choice:words });
    return { exitCode:result.ok ? 0 : 1, stdout:JSON.stringify(result, null, 2) };
  }
  if (command === "defer" || command === "defer-close" || command === "deferrals") {
    return await runDeferralCli(services.deferrals, command, args);
  }
  if (command === "forecast") return runForecastCli(db, args);
  if (command === "outages") return runOutageCli(ctx, args);
  if (command === "failures") {
    const days = args[0] === "--since" ? Number(args[1]) : undefined;
    if (args.length && (args[0] !== "--since" || !Number.isFinite(days))) return { exitCode:1, stderr:"usage: bb lane-pilot failures [--since <days>]" };
    return { exitCode:0, stdout:JSON.stringify(failedTasksAllProjects(db, days === undefined ? 0 : Date.now() - days * 86_400_000), null, 2) };
  }
  if (command === "owner-presence") {
    const now = Date.now(), presence = await services.ownerPresence.sweep();
    // Without --journal the output is main's: the bare array of marks.
    if (args.includes("--journal")) return { exitCode:0, stdout:JSON.stringify(services.ownerPresence.journal(), null, 2) };
    return { exitCode:0, stdout:JSON.stringify(presence.map((row) => ({ ...row, minutesAgo:Math.round((now - row.at) / 60_000), holdsWriters:services.ownerPresence.holds(row.providerId, now) !== null })), null, 2) };
  }
  if (command === "task") {
    const { taskId, runId } = timelineArgs(args.filter((arg) => arg !== "--plan"));
    const found = taskId ? taskRecord(db, taskId, runId) : null;
    if (!found) return { exitCode:1, stderr:taskId ? `no task ${taskId} on record` : `usage: ${TASK_RECORD_USAGE}` };
    const record = readsBlind(found, invocation?.threadId) ? blindRecord(found) : found;
    return { exitCode:0, stdout:args.includes("--json") ? JSON.stringify(record, null, 2) : renderTaskRecord(record, { fullPlan: args.includes("--plan") }) };
  }
  if (command === "timeline") {
    const { taskId, runId } = timelineArgs(args);
    if (!taskId) return { exitCode:1, stderr:"usage: bb lane-pilot timeline <task-id> [--run <run-id>] [--json]" };
    const timeline = taskTimeline(db, taskId, runId, taskBaselineEntries);
    if (!timeline.runId) return { exitCode:1, stderr:renderTimeline(timeline) };
    return { exitCode:0, stdout:args.includes("--json") ? JSON.stringify(timeline, null, 2) : renderTimeline(timeline) };
  }
  if (command === "memory-tiers") {
    if (args.length && !(args.length === 2 && args[0] === "--project")) return { exitCode:1, stderr:"usage: bb lane-pilot memory-tiers [--project P]" };
    return { exitCode:0, stdout:JSON.stringify(tierReport(db, args[1]), null, 2) };
  }
  if (command === "conveyor" && ["on", "off", "status"].includes(args[0] ?? "")) {
    const kv = bb.storage.kv as never;
    const state = args[0] === "status" ? await conveyorState(kv) : await setConveyor(kv, args[0] === "on", args.slice(1).join(" "));
    return { exitCode:0, stdout:JSON.stringify(state, null, 2) };
  }
  if (command === "return" || command === "returns") {
    return await runReturnCli(services.stageReturn, command, args);
  }
  if (command === "schedule") {
    return await runScheduleCli(services, args);
  }
  if (command === "worktree-cleanup") {
    // The pass the two worktree-cleanup system schedules run, by hand; --dry-run decides only (docs/worktrees.md).
    return await runWorktreeCleanupCli(ctx, { cleanupStickyLaneWorktrees, cleanupFinishedAttemptEnvironments }, args);
  }
  if (command === "agents") {
    return await runAgentsCli({ list: () => services.listedAgentProfiles(), registry: agentRegistry(ctx, services.scheduleAgents) }, args);
  }
  return undefined;
}
