import type { PluginCliResult } from "@get-bb/plugin-sdk";
import type { CliRunDeps } from "./cli-deps";
import { CODE_CRITIC_DEFAULTS, THREAD_WATCH_EVENT_TYPES, decideThreadCompletion, eventsListQueryLabel, isCodeCriticDefault, isNotFound, listThreadEventsRaw, orMiss, stringAt, taskV2Schema, waitThreadIdle } from "./cli-imports";
import type { CodeCriticDefault } from "./cli-imports";
import { DISPATCH_BB_USAGE } from "./cli-commands";
function requireCriticCodeDefault(value: string): CodeCriticDefault {
  if (!isCodeCriticDefault(value)) throw new Error(`critic.code.default_for_risk must be one of ${CODE_CRITIC_DEFAULTS.join(", ")}`);
  return value;
}

/** Host and thread-probe commands of `bb lane-pilot`. Returns undefined when `command` is not one of theirs. */
export async function cliHost(d: CliRunDeps): Promise<PluginCliResult | undefined> {
  const { bb, host } = d.ctx;
  const { services, command, args } = d;

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
  if (command === "dispatch-bb") {
    // --plan <text>: the plan apart from the contract, as lane_pilot_dispatch_writer takes it; without it the objective is the plan (as before).
    const planAt = args.indexOf("--plan");
    if (planAt >= 0 && !args[planAt + 1]?.trim()) return { exitCode:1, stderr:`usage: ${DISPATCH_BB_USAGE}` };
    const positional = args.filter((_, index) => planAt < 0 || (index !== planAt && index !== planAt + 1));
    if (positional.length >= 2) {
      const task = positional[2] ? taskV2Schema.parse(JSON.parse(positional[2])) : undefined;
      return { exitCode:0, stdout:JSON.stringify(await services.dispatchWriter({
        projectId:positional[0]!,
        threadId:positional[1]!,
        task,
        ...(planAt >= 0 ? { plan:args[planAt + 1]! } : {}),
        baseRef:positional[3]||undefined,
        ...(positional[4] ? { criticCodeDefault:requireCriticCodeDefault(positional[4]) } : {}),
      }), null, 2) };
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
  return undefined;
}
