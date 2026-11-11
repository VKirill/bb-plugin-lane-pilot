import type { PluginCliResult } from "@get-bb/plugin-sdk";
import type { CliRunDeps } from "./cli-deps";
import { isCodeCriticDefault } from "../../contracts/task-enums"
import { CODE_CRITIC_DEFAULTS } from "../../contracts/task-enums";
import type { CodeCriticDefault } from "../../contracts/task-enums";
import { prototypeConfigSchema, resolvePlanningHome, taskV2Schema } from "../../contracts";
import { failureFieldsOf, getActivation, getAttempt, getRun, getRunWriterHost, getTask, importSettingsOnce, inspectAttempt, inspectState, listAttemptReasonsSince, listRunsWithAttempts, loadProjectSettings, PROTECTIONS, loadPrototypeConfig, saveProjectSetting, savePrototypeConfig, transitionAttempt, failedTasksAllProjects, listNearMissReceipts, projectIdForWorkspacePath, projectLiveAttempts, attemptStateCounts, settingsScopesForWorkspacePath } from "../../storage";
import {bestEffort, isNotFound, maskCredentials, orMiss, outputText, pluginRootFromModule, spawnAsync, stringAt, valueAt} from "@lane-pilot/kit";
import { THREAD_WATCH_EVENT_TYPES, decideThreadCompletion, eventsListQueryLabel, listThreadEventsRaw, waitThreadIdle } from "@lane-pilot/thread-observe";
import { attemptRecord, manifest, passport, preship, prPassport, receiptChain, subagentReceipts, verifyChain } from "./receipts";

function requireCriticCodeDefault(value: string): CodeCriticDefault {
  if (!isCodeCriticDefault(value)) throw new Error(`critic.code.default_for_risk must be one of ${CODE_CRITIC_DEFAULTS.join(", ")}`);
  return value;
}


/** Host and thread-probe commands of `bb lane-pilot`. Returns undefined when `command` is not one of theirs. */
export async function cliHost(d: CliRunDeps): Promise<PluginCliResult | undefined> {
  const { bb, db, effectiveProjectSettings, host } = d.ctx;
  const { ctx, services, command, args, invocation, commands, migrations } = d;

  if (command === "host-detect" && args.length === 2) {
    return { exitCode:0, stdout:JSON.stringify(await host.call("detect", { requestedHostId:args[0]!, workspacePath:args[1]! }, { hostId:args[0]! }), null, 2) };
  }
  if (command === "host-snapshot" && args.length >= 2) {
    return { exitCode:0, stdout:JSON.stringify(await host.call("snapshotDryRun", { requestedHostId:args[0]!, paths:args.slice(1) }, { hostId:args[0]! }), null, 2) };
  }
  if (command === "host-snapshot-manifest" && args.length >= 1) {
    return { exitCode:0, stdout:JSON.stringify(await host.call("snapshot", {
      requestedHostId:args[0]!,
      threadStoragePath:args[1],
    }, { hostId:args[0]!, timeoutMs:120_000 }), null, 2) };
  }
  if (command === "remove-claude-lane-leftovers" && args.length >= 1) {
    const hostId = args.find((arg) => !arg.startsWith("--"));
    if (!hostId) return { exitCode: 1, stderr: "bb lane-pilot remove-claude-lane-leftovers <host-id> [--apply]" };
    return { exitCode: 0, stdout: JSON.stringify(await host.call("removeClaudeLaneLeftovers", {
      requestedHostId: hostId,
      apply: args.includes("--apply"),
    }, { hostId, timeoutMs: 120_000 }), null, 2) };
  }
  if (command === "host-install" && args.length >= 1) {
    return { exitCode:0, stdout:JSON.stringify(await host.call("install", {
      requestedHostId:args[0]!,
      threadStoragePath:args[1],
      pmWorkspacePath:args[2],
      confirmExternalOps:false,
    }, { hostId:args[0]!, timeoutMs:600_000 }), null, 2) };
  }
  if (command === "host-rollback" && args.length === 2) {
    return { exitCode:0, stdout:JSON.stringify(await host.call("rollback", {
      requestedHostId:args[0]!,
      snapshotPath:args[1]!,
    }, { hostId:args[0]!, timeoutMs:180_000 }), null, 2) };
  }
  if (command === "host-connect-opencode" && args.length === 1) {
    return { exitCode:0, stdout:JSON.stringify(await host.call("connectOpencode", {
      requestedHostId:args[0]!,
    }, { hostId:args[0]!, timeoutMs:30_000 }), null, 2) };
  }
  if (command === "resume") {
    return { exitCode:0, stdout:JSON.stringify(await services.resumeOrphans(args[0]), null, 2) };
  }
  if (command === "dispatch-bb" && args.length >= 2) {
    const task = args[2] ? taskV2Schema.parse(JSON.parse(args[2])) : undefined;
    return { exitCode:0, stdout:JSON.stringify(await services.dispatchWriter({
      projectId:args[0]!,
      threadId:args[1]!,
      task,
      baseRef:args[3]||undefined,
      ...(args[4] ? { criticCodeDefault:requireCriticCodeDefault(args[4]) } : {}),
    }), null, 2) };
  }
  if (command === "docs-nightly") {
    // The owner's assignment (SMA k_ag_docwriter): masked and bounded, it enters the docs prompt as data, never as instructions.
    const assignAt = args.indexOf("--assignment");
    if (assignAt >= 0 && !args[assignAt + 1]) return { exitCode:1, stderr:'usage: bb lane-pilot docs-nightly <project-id> [folder-path] [since-commit] [--assignment "<text>"]' };
    const positional = args.filter((_, index) => assignAt < 0 || (index !== assignAt && index !== assignAt + 1));
    if (positional.length >= 1 && positional.length <= 3) {
      // A thread is an agent: it may run the nightly docs pass only for its own project and only as that project's PM; the owner at a terminal and automation (no thread) are unrestricted.
      if (invocation?.threadId) {
        const caller = await orMiss(bb.sdk.threads.get({ threadId: invocation.threadId }), null, isNotFound) as { projectId?: unknown } | null;
        if (!caller || typeof caller.projectId !== "string" || caller.projectId !== positional[0]) return { exitCode:1, stderr:`refused: docs-nightly from a thread reaches only that thread's own project (${typeof caller?.projectId === "string" ? caller.projectId : "unknown"}), not ${positional[0]}` };
        const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: invocation.threadId }), null, isNotFound) as { role?: unknown } | null;
        if (metadata?.role !== "pm") return { exitCode:1, stderr:`refused: docs-nightly is not for a ${typeof metadata?.role === "string" ? `${metadata.role} thread` : "thread whose role is unknown"}; ask the PM or the owner` };
      }
      const assignment = assignAt >= 0 ? maskCredentials(args[assignAt + 1]!).text.slice(0, 2000) : undefined;
      return { exitCode:0, stdout:JSON.stringify(await services.runNightlyDocs({force:true,projectId:positional[0]!,path:positional[1],base:positional[2],...(assignment?.trim() ? {assignment} : {})}), null, 2) };
    }
  }
  if (command === "wait-thread" && args.length === 1) {
    const threadId = args[0]!;
    const startedAt = Date.now();
    try {
      await waitThreadIdle(bb,threadId,"wait_thread_probe_timeout", 15_000);
      const thread = await orMiss(bb.sdk.threads.get({ threadId }), null, isNotFound);
      const listed = await listThreadEventsRaw(bb, {
        threadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc", limit:"50",
      });
      const decision = listed.ok
        ? decideThreadCompletion({
          threadId,
          status:stringAt(thread, "status"),
          queuedWork:stringAt(thread, "queuedWork"),
          events:listed.events,
        })
        : { ok:false as const, via:"incomplete" as const, detail:listed.detail };
      return { exitCode: decision.ok ? 0 : 1, stdout:JSON.stringify({
        threadId,
        helper:"waitThreadIdle",
        elapsedMs:Date.now() - startedAt,
        status:stringAt(thread, "status"),
        decision,
      }) };
    } catch (cause) {
      return { exitCode:1, stdout:JSON.stringify({
        threadId,
        helper:"waitThreadIdle",
        elapsedMs:Date.now() - startedAt,
        ok:false,
        error:cause instanceof Error ? cause.message : String(cause),
      }) };
    }
  }
  if (command === "events-list" && args.length === 1) {
    const threadId = args[0]!;
    const filteredQuery = { threadId, types:THREAD_WATCH_EVENT_TYPES, order:"desc" as const, limit:"50" as const };
    const unfilteredQuery = { threadId, order:"desc" as const, limit:"50" as const };
    const summarize = (listed: unknown[]) => listed.map((row) => ({
      seq: row && typeof row === "object" ? Reflect.get(row, "seq") : null,
      type: row && typeof row === "object" ? Reflect.get(row, "type") : null,
      threadId: row && typeof row === "object" ? Reflect.get(row, "threadId") : null,
      status: row && typeof row === "object" && Reflect.get(row, "data") && typeof Reflect.get(row, "data") === "object"
        ? Reflect.get(Reflect.get(row, "data") as object, "status") : null,
    }));
    const filtered = await listThreadEventsRaw(bb, filteredQuery);
    const unfiltered = await listThreadEventsRaw(bb, unfilteredQuery);
    return { exitCode:0, stdout:JSON.stringify({
      threadId,
      filtered: filtered.ok
        ? { ok:true, query:eventsListQueryLabel(filteredQuery), n:filtered.events.length, rows:summarize(filtered.events) }
        : { ok:false, kind:filtered.kind, detail:filtered.detail },
      unfiltered: unfiltered.ok
        ? { ok:true, query:eventsListQueryLabel(unfilteredQuery), n:unfiltered.events.length, rows:summarize(unfiltered.events) }
        : { ok:false, kind:unfiltered.kind, detail:unfiltered.detail },
    }, null, 2) };
  }
  if (command === "host-import-config" && args.length >= 2) {
    const imported = await host.call("importConfig", {
      requestedHostId:args[0]!,
      projectId:args[1]!,
      workspacePath:args[2],
    }, { hostId:args[0]!, timeoutMs:30_000 });
    const persisted = importSettingsOnce(db, args[1]!, imported.imported);
    return { exitCode:0, stdout:JSON.stringify({ ...imported, persisted }, null, 2) };
  }
  return undefined;
}
