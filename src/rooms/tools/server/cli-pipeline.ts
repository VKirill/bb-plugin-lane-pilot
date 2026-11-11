import type { PluginCliResult } from "@get-bb/plugin-sdk";
import { OWNER_ITEM_SWEEPS, type CliRunDeps } from "./cli-deps";
import { TASK_RECORD_USAGE, blindRecord, readsBlind, renderTaskRecord, taskRecord } from "./task-record";
import { attemptRecord, manifest, passport, preship, prPassport, receiptChain, subagentReceipts, verifyChain } from "./receipts";
import { agentRegistry, answerWorkflowQuestion, breakerRowId, budgetSpentSweep, closeOwnerItem, conveyorState, designJournalLines, dirname, failedTasksAllProjects, getPhase, isNotFound, jev, join, listNearMissReceipts, listTripped, orMiss, pluginRootFromModule, postOwnerItem, readinessWords, rearmBreaker, renderTimeline, retireAdoptedRule, runAgentsCli, runBacklogCli, runBaselineCli, runBenchCli, runCapabilityCli, runCheckersCli, runDeferralCli, runDesignPairCli, runErrandsCli, runForecastCli, runHypothesisCli, runJevCli, runLeadCli, runOutageCli, runPhaseCli, runReturnCli, runRulesCli, runRunGoalCli, runScheduleCli, runSmaLiveCli, runSmaMapCli, runWaitingCli, runWallCli, saveProjectSetting, setConveyor, spawnAsync, taskBaselineEntries, taskTimeline, tierReport, trainedConditions, trainingRatios, workerSecretReach } from "./cli-imports";
/** `timeline <task-id> [--run <run-id>] [--json]`: without --run the first bare word is the task (it was skipped until 2026-11-02). */
export function timelineArgs(args: string[]): { taskId: string | undefined; runId: string | undefined } {
  const runAt = args.indexOf("--run");
  return { taskId: args.find((arg, index) => !arg.startsWith("--") && (runAt < 0 || index !== runAt + 1)), runId: runAt >= 0 ? args[runAt + 1] : undefined };
}

/** Pipeline, phase and room-delegate commands of `bb lane-pilot`. Returns undefined when `command` is not one of theirs. */
export async function cliPipeline(d: CliRunDeps): Promise<PluginCliResult | undefined> {
  const { bb, db, effectiveProjectSettings, host } = d.ctx;
  const { ctx, services, command, args, invocation, commands, migrations } = d;

  if (command === "phase") {
    return await runPhaseCli(services.phases, args, invocation?.threadId);
  }
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
  if (command === "design-metrics") {
    const all = await designJournalLines(ctx.bb.storage.kv);
    const project = args.includes("--project") ? args[args.indexOf("--project") + 1] : null;
    const lines = project ? all.filter((line) => line.projectId === project) : all;
    // Series assignment: which role-lines state each drawing was made under; the baseline is the first series, shown beside the latest.
    const seriesOrder = [...new Set(lines.map((line) => line.series ?? "base"))];
    const series = Object.fromEntries(seriesOrder.map((id) => [id, trainingRatios(lines.filter((line) => (line.series ?? "base") === id))]));
    const report = { ratios:trainingRatios(lines), series, baseline:seriesOrder[0] ?? null, latest:seriesOrder.at(-1) ?? null, conditions:trainedConditions(lines), readiness:readinessWords(lines) };
    return { exitCode:0, stdout:args.includes("--json") ? JSON.stringify(report, null, 2) : `${report.readiness}\n\n${JSON.stringify(report.ratios)}\n${report.conditions.map((row) => `${row.ok ? "✓" : "✗"} ${row.id}: ${row.detail}`).join("\n")}` };
  }
  if (command === "design-pair" || command === "design-pair-answer") {
    // Paired design judgement (SMA k_lib_djudgement): the model and the person see one basis and one order; the pair lands in the journal.
    // The plugin's own scripts/ folder, not the shell's cwd; the caller rules and the URL table live in design-eval/server.
    const script = join(pluginRootFromModule(import.meta.url), "scripts", "lp-design-eval.ts");
    const portOf = (value: string | undefined): number[] => { try { const url = new URL(value ?? ""); return [Number(url.port || (url.protocol === "https:" ? 443 : 80))]; } catch { return []; } };
    const hubPorts = [...portOf(process.env.BB_SERVER_URL), Number(process.env.BB_HOST_DAEMON_PORT), Number(process.env.PORT)].filter((n) => Number.isInteger(n) && n > 0);
    return await runDesignPairCli({
      kv: ctx.bb.storage.kv, threadId: invocation?.threadId ?? null, script, hubPorts,
      thread: async (threadId) => {
        const thread = await orMiss(bb.sdk.threads.get({ threadId }), null, isNotFound) as { projectId?: unknown } | null;
        if (!thread) return null;
        const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId }), null, isNotFound) as { role?: unknown } | null;
        return { projectId: typeof thread.projectId === "string" ? thread.projectId : null, role: typeof metadata?.role === "string" ? metadata.role : null };
      },
      phaseProject: (phaseId) => getPhase(db as never, phaseId)?.projectId ?? null,
      jev: () => jev(),
      // The judge is a paid call: it waits on a money cap that is set and spent (no cap set = no hold; only a paid writer lane is closed by an unset cap).
      moneyHold: async () => services.money.judgeHolds(),
      measure: async (file, scriptArgs) => {
        const ran = await spawnAsync("npx", ["tsx", file, ...scriptArgs], { cwd: dirname(dirname(file)), timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
        if (ran.error || ran.status !== 0) throw ran.error ?? new Error(`${file} ended with ${ran.status ?? ran.signal}: ${(ran.stderr ?? "").trim().slice(-400)}`);
        return ran.stdout ?? "";
      },
      ownerItem: {
        post: (item) => { postOwnerItem(db, { key: item.key, source: "design-eval", kind: "design-pair", wake: false, ...(item.projectId ? { projectId: item.projectId } : {}), what: item.what, why: item.why, evidence: [{ kind: "text", ref: item.basis }] }); },
        close: (key, by) => { closeOwnerItem(db, key, by); },
      },
    }, command, args);
  }
  if (command === "sma-map") {
    return args.includes("--live") ? runSmaLiveCli(db as never, args) : runSmaMapCli(args);
  }
  if (command === "waiting") {
    return runWaitingCli(db, args, Date.now(), [...OWNER_ITEM_SWEEPS, budgetSpentSweep(services)], services.ownerLearningItems);
  }
  if (command === "lead") return await runLeadCli({ db, kv: bb.storage.kv as never, lead: services.lead }, args);
  if (command === "jev") return runJevCli({ db, saveProjectSetting: (p, k, v) => saveProjectSetting(db, p, k, v), settings: async (p) => (await effectiveProjectSettings(p)).values as Record<string, unknown> }, args);
  if (command === "errands" && args[0] === "process-key-eval") return runErrandsCli(args);
  if (command === "rules") {
    const hostAt = args.indexOf("--host");
    const hostId = hostAt >= 0 ? args[hostAt + 1] : undefined;
    const ask = hostId ? async (state:string, questions:Record<string, { instructions:string; criteria:Record<string, string> }>) => {
      const judged = await host.call("councilJudge", { requestedHostId:hostId, state, questions }, { hostId, timeoutMs:20_000 });
      return judged.status === "ok" ? judged.probabilities ?? null : null;
    } : null;
    return await runRulesCli({ db, ask, repoPath:process.cwd(), retire:(projectId, ruleId, reason) => retireAdoptedRule(db, projectId, ruleId, reason) }, args.filter((arg, index, all) => arg !== "--host" && all[index - 1] !== "--host"));
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
  // Before 0.1.430 nothing outside the engine could stop a workflow run: the magicseo replays were stopped by hand in the database.
  if (command === "workflow-cancel" && args.length >= 1) {
    const reason = args.slice(1).join(" ") || "canceled_by_owner";
    const ok = services.workflowEngine?.cancel(args[0]!, reason) ?? false;
    return { exitCode:ok ? 0 : 1, stdout:JSON.stringify(ok ? { ok, runId:args[0], reason } : { ok, runId:args[0], why:"no running or waiting run with this id" }, null, 2) };
  }
  if (command === "defer" || command === "defer-close" || command === "deferrals") {
    return await runDeferralCli(services.deferrals, command, args);
  }
  if (command === "regress" || command === "regressions" || command === "regress-close" || command === "baseline") {
    return await runBaselineCli(services, command, args);
  }
  if (command === "forecast") return runForecastCli(db, args);
  // sma breaker (SMA k_v_breaker): the tripped rules of the loop breaker, re-armed only by a person with a reason.
  if (command === "breaker") {
    const kv = bb.storage.kv as never;
    if (args[0] === "rearm") {
      const whyAt = args.indexOf("--why");
      const why = whyAt >= 0 ? args[whyAt + 1] : undefined;
      if (!args[1] || !why?.trim()) return { exitCode:1, stderr:"bb lane-pilot breaker rearm <id> --why <text>: a reason is required" };
      const row = await rearmBreaker(kv, args[1], { why });
      return row ? { exitCode:0, stdout:JSON.stringify({ rearmed:args[1], by:row.by, why:row.reason }, null, 2) }
                 : { exitCode:1, stderr:`breaker: no tripped row ${args[1]}` };
    }
    const rows = await listTripped(kv, args[0] && !args[0].startsWith("--") ? args[0] : undefined);
    return { exitCode:0, stdout:JSON.stringify(rows.map((row) => ({ id: breakerRowId(row.project, row.ruleHash, row.target), rule: row.ruleHash, target: row.target, count: row.count, firstAt: row.firstAt, lastAt: row.lastAt })), null, 2) };
  }
  // The near-miss channel (SMA k_v_skeptic): reports agents flagged, listed under «not scored» — never counted.
  if (command === "nearmiss") {
    const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : 30;
    const projectId = args.includes("--project") ? args[args.indexOf("--project") + 1] : undefined;
    const since = Date.now() - (Number.isInteger(days) && days > 0 ? days : 30) * 86_400_000;
    const rows = listNearMissReceipts(db, since, projectId);
    const out = rows.flatMap((row) => { try { const misses = (JSON.parse(row.result_json) as { near_misses?: unknown }).near_misses; return (Array.isArray(misses) ? misses : []).filter((m): m is string => typeof m === "string").map((miss) => ({ taskId: row.task_id, miss, at: row.updated_at, scored: "not scored" })); } catch { return []; } });
    return { exitCode:0, stdout:JSON.stringify({ notScored: true, nearMisses: out }, null, 2) };
  }
  if (command === "subagent-receipts") {
    const days = args.includes("--days") ? Number(args[args.indexOf("--days") + 1]) : undefined;
    const projectId = args.includes("--project") ? args[args.indexOf("--project") + 1] : undefined;
    return { exitCode:0, stdout:JSON.stringify(subagentReceipts(db, { projectId, days }), null, 2) };
  }
  if (command === "run-goal") return await runRunGoalCli(services.runGoal, args);
  if (command === "capabilities") return await runCapabilityCli(services.capabilities, args, (user) => workerSecretReach(user), Boolean(invocation?.threadId));
  if (command === "outages") return runOutageCli(ctx, args);
  if (command === "failures") {
    const days = args[0] === "--since" ? Number(args[1]) : undefined;
    if (args.length && (args[0] !== "--since" || !Number.isFinite(days))) return { exitCode:1, stderr:"usage: bb lane-pilot failures [--since <days>]" };
    return { exitCode:0, stdout:JSON.stringify(failedTasksAllProjects(db, days === undefined ? 0 : Date.now() - days * 86_400_000), null, 2) };
  }
  if (command === "backlog") return await runBacklogCli(services.backlog, args);
  if (command === "hypothesis") return await runHypothesisCli(services.hypotheses, args);
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
  if (command === "bench") {
    // The arena is up to four series of real model runs: from a thread only the PM chat starts it. `bench run` keeps main's rule.
    if (args[0] === "arena" && invocation?.threadId) {
      const metadata = await orMiss(bb.sdk.threads.getPluginMetadata({ threadId: invocation.threadId }), null, isNotFound) as { role?: unknown } | null;
      if (metadata?.role !== "pm") return { exitCode:1, stderr:"refused: bench arena starts up to four series of real model runs; from a thread only the PM chat starts it. Ask the PM or the owner" };
    }
    return await runBenchCli(services.bench, args);
  }
  if (command === "wall") {
    return await runWallCli(services.wall, args);
  }
  if (command === "checkers") {
    return await runCheckersCli(services.checkers, args);
  }
  if (command === "schedule") {
    return await runScheduleCli(services, args);
  }
  if (command === "agents") {
    return await runAgentsCli({ list: () => services.listedAgentProfiles(), registry: agentRegistry(ctx, services.scheduleAgents) }, args);
  }
  return undefined;
}
