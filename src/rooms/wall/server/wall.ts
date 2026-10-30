import { join } from "node:path";
import { writerExecutionSelection } from "@lane-pilot/models";
import { fullAccessSpawn, scheduleIsolated, stringAt } from "../../core/server";
import { conveyorState } from "../../conveyor";
import type { ServerCore, Services } from "../../core/server";
import { createAttempt, getAttempt } from "../../storage";
import { reopenWriterStages } from "../../runs/server";
import { sendServiceMessage } from "../../relay/server";
import { CONFIG_KEY as SELF_REPAIR_CONFIG_KEY, SELF_REPAIR_DEFAULTS, VERSION, readRepairRecord, readTail, setRepairHooks } from "../../self-repair/server";
import type { SelfRepairConfig } from "../../self-repair/server";
import { DRILL_KEY, SANDBOX_PROJECT_ID, isDrillTask, isSandboxProjectName } from "../../stability/server";
import type { DrillOutcome } from "../../stability/server";
import { threadUsage } from "../../usage/server";
import { id as newId } from "../../core/server";
import { saveVerdict } from "../../bench";
import { benchArmStatus } from "../../bench/server";
import { wallLogLines } from "../logs";
import { revertMerge, type RevertHost } from "../revert";
import { builtinWorkflow } from "../../workflow";
import type { ChainRuntime } from "../../workflow/server";
import type { HuntOutcome } from "../pack";
import { WALL_HUNT_WORKFLOW, createWall, type RepairView, type Scope, type ThreadRun, type WallApi, type WallPorts } from "../service";

const LOG_TAIL_BYTES = 1_000_000;

/** The night loop inside the plugin: the real ports, the self-repair hooks, the two schedules. */
export function createPluginWall(ctx: ServerCore, services: Services): WallApi {
  const { bb, db, host } = ctx;

  const repairConfig = async (): Promise<SelfRepairConfig> => {
    const raw = await bb.storage.kv.get(SELF_REPAIR_CONFIG_KEY).catch(() => null);
    return { ...SELF_REPAIR_DEFAULTS, ...(raw && typeof raw === "object" ? raw as Partial<SelfRepairConfig> : {}) };
  };
  const environmentOf = async () => {
    const cfg = await repairConfig();
    const environment = await bb.sdk.environments.get({ environmentId: cfg.environmentId });
    const hostId = stringAt(environment, "hostId"), basePath = stringAt(environment, "path");
    if (!hostId || !basePath) throw new Error(`environment ${cfg.environmentId} has no host path`);
    return { cfg, hostId, basePath };
  };

  let sandbox: { at: number; ids: ReadonlySet<string> } | null = null;
  let benchIds: ReadonlySet<string> = new Set();
  const loadScope = async (): Promise<Scope> => {
    const now = Date.now();
    if (!sandbox || now - sandbox.at > 60_000) {
      let ids = new Set<string>(sandbox?.ids);
      try {
        const rows = [...await bb.sdk.projects.list({ includePersonal: true } as never), ...await bb.sdk.projects.list({ includePersonal: true, archived: true } as never).catch(() => [])] as Array<{ id: string; name?: string }>;
        ids = new Set(rows.filter((row) => isSandboxProjectName(row.name)).map((row) => row.id));
        const bench = new Set(rows.filter((row) => typeof row.name === "string" && row.name.startsWith("LP bench")).map((row) => row.id));
        sandbox = { at: now, ids };
        benchIds = bench;
      } catch { /* keep the last answer */ }
    }
    const ids = sandbox?.ids ?? new Set<string>();
    return {
      isReal: (projectId, taskId) => projectId !== SANDBOX_PROJECT_ID && !ids.has(projectId) && !isDrillTask(taskId),
      scopeOf: (projectId) => (benchIds.has(projectId) ? "bench" : projectId === SANDBOX_PROJECT_ID || ids.has(projectId) ? "sandbox" : "real"),
    };
  };

  /** The hidden thread of one reader (a hunter or the analysis), tied to the graph step that asked for it; the step waits for it, reads it and archives it. */
  const spawnReader: NonNullable<WallPorts["spawnReader"]> = async ({ who, prompt, graph }) => {
    const { cfg, hostId, basePath } = await environmentOf();
    const wcfg = await wallRef.current.config();
    const spawned = await fullAccessSpawn(bb, {
      projectId: cfg.projectId,
      environment: { type: "host", hostId, workspace: { type: "unmanaged", path: basePath } },
      title: `Lane Pilot wall ${who}`,
      // A reader only reads and answers once: hidden, and archived once its answer is read (the first night's six hunters sat unread in the project's list, 2026-10-26).
      visibility: "hidden",
      prompt,
      ...writerExecutionSelection(wcfg.hunterProviderId, wcfg.hunterModel, who === "analysis" ? "high" : wcfg.hunterReasoningLevel, "default"),
      pluginMetadata: { role: `wall-${who}`, ...graph.metadata, spawnId: graph.spawnId },
    } as Parameters<typeof fullAccessSpawn>[1]);
    const threadId = stringAt(spawned, "id");
    if (!threadId) throw new Error("wall_reader_thread_id_missing");
    return threadId;
  };

  /** A run of `lp.wall-hunt` named by the night, the wall and what it does: asking again the same night finds the run and its result. */
  const runGraph = async (wallKey: string, kind: "hunt" | "analysis", inputs: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const { cfg } = await environmentOf();
    const workflow = builtinWorkflow(WALL_HUNT_WORKFLOW);
    if (!workflow) throw new Error(`built-in workflow ${WALL_HUNT_WORKFLOW} is not loaded`);
    const night = new Date(ports.now()).toISOString().slice(0, 10);
    const started = services.workflowEngine.start({
      workflow, key: `wall-hunt:${night}:${wallKey}:${kind}`, link: { projectId: cfg.projectId },
      runtime: { ctx, services, pmThreadId: null, projectId: cfg.projectId, runId: null } satisfies ChainRuntime,
      inputs: { wall_key: wallKey, pack: {}, angles: [], analysis_prompt: "", ...inputs },
    });
    const summary = await started.done;
    if (summary.status !== "succeeded") throw new Error(summary.error ?? summary.reason ?? `wall ${kind} run ${summary.status}`);
    return summary.output ?? {};
  };

  const busy = async (threadId: string): Promise<boolean> => {
    const thread = await bb.sdk.threads.get({ threadId }).catch(() => null);
    const status = stringAt(thread, "status");
    return status !== null && status !== "idle" && status !== "error" && status !== "stopped";
  };

  const benchSetVersion = (): string | null => {
    const sets = services.bench.status();
    return sets.find((set) => set.tasks > 0)?.version ?? null;
  };

  const ports: WallPorts = {
    // Held repairs and backlog walls go to the screen «Ждут владельца» (and its Telegram push), never as a blocking question.
    now: () => Date.now(),
    version: VERSION,
    loadScope,
    logLines: (since, until) => {
      let text = "";
      try { text = readTail(join(bb.server.experimental_dataDir, "plugins", "lane-pilot", "logs", "plugin.log"), LOG_TAIL_BYTES); } catch { return []; }
      return wallLogLines(text, since, until).map((row) => ({ message: row.message, at: row.at, projectId: row.projectId }));
    },
    codeFiles: async (fragments) => {
      if (!fragments.length) return [];
      try {
        const { hostId, basePath } = await environmentOf();
        const files: Array<{ path: string; lines: number; text: string }> = [];
        for (const fragment of fragments) {
          const grep = await host.call("runCommand", { requestedHostId: hostId, cwd: basePath, timeoutSec: 30,
            command: `git grep -l -F -e ${JSON.stringify(fragment.slice(0, 80))} -- 'src/**/*.ts' 'packages/**/*.ts' | head -3` }, { hostId, timeoutMs: 40_000 });
          for (const path of grep.stdout.split("\n").map((line) => line.trim()).filter(Boolean)) {
            if (files.some((row) => row.path === path)) continue;
            const read = await host.call("runCommand", { requestedHostId: hostId, cwd: basePath, timeoutSec: 20, command: `head -c 30000 ${JSON.stringify(path)}` }, { hostId, timeoutMs: 30_000 });
            files.push({ path, lines: read.stdout.split("\n").length, text: read.stdout });
          }
        }
        return files.slice(0, 6);
      } catch { return []; }
    },
    spawnReader,
    graph: {
      hunt: async ({ wallKey, pack, angles }) => {
        const out = await runGraph(wallKey, "hunt", { pack, angles: [...angles] });
        return out.outcome ? { outcome: out.outcome as HuntOutcome, tokens: Number(out.tokens) || 0 } : null;
      },
      analysis: async ({ wallKey, prompt }) => {
        const out = await runGraph(wallKey, "analysis", { analysis_prompt: prompt });
        return { text: typeof out.analysis_text === "string" && out.analysis_text ? out.analysis_text : null, tokens: Number(out.analysis_tokens) || 0 };
      },
    },
    tellPm: async (threadId, text) => {
      try { await sendServiceMessage(bb as never, { threadId, text }); return true; } catch { return false; }
    },
    repair: {
      view: async (signature): Promise<RepairView | null> => readRepairRecord(bb, signature),
      report: async (threadId) => {
        const out = (await bb.sdk.threads.output({ threadId })).output;
        return typeof out === "string" ? out.slice(-8000) : "";
      },
      tokens: async (threadId) => { const usage = await threadUsage(bb, threadId); return usage.known ? usage.tokens : null; },
      busy,
      changedFiles: async (view) => {
        if (!view.worktreePath) return null;
        const { hostId, basePath } = await environmentOf();
        const state = await host.call("gitWorktreeState", { requestedHostId: hostId, basePath, worktreePath: view.worktreePath }, { hostId, timeoutMs: 60_000 });
        return state.status === "ready" ? state.changed.map((file) => ({ path: file.path, status: file.status })) : null;
      },
      revert: async (commit) => revertMerge(host as unknown as RevertHost, await environmentOf(), commit),
    },
    release: {
      drill: async () => {
        const raw = await bb.storage.kv.get(DRILL_KEY).catch(() => null) as Record<string, DrillOutcome> | null;
        const outcomes = Object.values(raw ?? {});
        if (!outcomes.length) return null;
        const newest = outcomes.reduce((a, b) => (b.at > a.at ? b : a));
        return { version: newest.version, at: newest.at, ok: outcomes.every((row) => row.checks.every((check) => check.ok)) };
      },
      canary: async () => {
        const report = await services.canary.status();
        return { version: report.version, tripped: report.tripped, windowOpen: report.window.open };
      },
      changedBetween: async (from, to) => {
        if (![from, to].every((version) => /^\d+\.\d+\.\d+$/.test(version))) return null;
        try {
          const { hostId, basePath } = await environmentOf();
          const diff = await host.call("runCommand", { requestedHostId: hostId, cwd: basePath, timeoutSec: 30, command: `git diff --name-only v${from} v${to}` }, { hostId, timeoutMs: 40_000 });
          return diff.exitCode === 0 ? diff.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : null;
        } catch { return null; }
      },
    },
    bench: {
      available: async () => {
        const version = benchSetVersion();
        if (!version) return false;
        const needed = await services.bench.prepare(version).catch(() => []);
        return needed.length > 0 && needed.every((row) => row.exists);
      },
      ensureArm: async (arm) => {
        const version = benchSetVersion();
        if (!version) return "unavailable";
        const set = services.bench.status(version)[0];
        const runs = set?.runs.filter((row) => row.arm === arm) ?? [];
        const status = benchArmStatus(runs);
        if (status === "running" || status === "done" || status === "unavailable") return status;
        const cfg = await wallRef.current.config();
        await services.bench.run({ version, arm, limit: cfg.benchSubset, wait: false });
        return "running";
      },
      compare: async (base, arm) => {
        const version = benchSetVersion();
        if (!version) return "unavailable";
        try {
          const result = services.bench.compare({ version, armA: base, armB: arm });
          // The night's comparison is a verdict on record like the harness's (the table stayed empty while the night compared).
          // An inconclusive comparison is no verdict: it is neither recorded as a pass nor as a fail.
          if (result.comparison.verdict !== "inconclusive") try { saveVerdict(db, { setId: `benchset_${version}`, armA: base, armB: arm, harnessId: null, passed: result.comparison.verdict === "pass", report: result.comparison }); } catch { /* the verdict stands without its record */ }
          return result.comparison.verdict;
        } catch { return "unavailable"; }
      },
      score: async (arm) => {
        const version = benchSetVersion();
        const runs = version ? services.bench.status(version)[0]?.runs.filter((row) => row.arm === arm) ?? [] : [];
        const tasks = runs.reduce((sum, row) => sum + row.tasks, 0);
        return tasks ? runs.reduce((sum, row) => sum + row.accepted, 0) / tasks : null;
      },
    },
    restart: async (plan) => {
      const run = db.prepare("SELECT closed_at FROM lane_pilot_run WHERE id=?").get(plan.runId) as { closed_at: number | null } | undefined;
      if (!run || run.closed_at) return { ok: false, note: "the run is closed" };
      if (services.activeWriterTasks.has(`${plan.runId}:${plan.taskId}`)) return { ok: false, note: "the task has a writer at work" };
      reopenWriterStages(db, plan.runId, plan.taskId, `re-run from ${plan.affected.from} on the new head (${plan.head.join(", ") || "the repaired class"})`);
      const attemptId = newId("lpattempt");
      createAttempt(db, { id: attemptId, runId: plan.runId, taskId: plan.taskId });
      const attempt = getAttempt(db, attemptId);
      const ok = attempt ? await services.enqueueResumedWriter(plan.projectId, attempt).catch(() => false) : false;
      return { ok, note: ok ? `restarted from ${plan.affected.from}; reused ${plan.affected.reused.join(", ") || "nothing"}` : "the writer could not be queued" };
    },
    deferrals: {
      open: (input) => { services.deferrals.open({ id: input.id, kind: "wall", what: input.what, area: input.area, projectId: input.projectId }); },
      close: (deferralId, evidence) => { services.deferrals.close({ id: deferralId, evidence }); },
    },
  };

  const wallRef = { current: null as unknown as WallApi };
  const wall = createWall({ db, kv: bb.storage.kv as never, ports, log: (line) => ctx.log(line), hubDb: SELF_REPAIR_DEFAULTS.hubDb });
  wallRef.current = wall;
  setRepairHooks(ctx, {
    nextAssignment: () => wall.nextAssignment(),
    started: (assignmentId, info) => wall.started(assignmentId, info),
    startFailed: (assignmentId, reason) => wall.startFailed(assignmentId, reason),
    mergeGate: (signature, info) => wall.mergeGate(signature, info),
    settled: (signature, info) => wall.settled(signature, info),
  });

  scheduleIsolated(bb, "wall-night", "0 3 * * *", async () => {
    if (ctx.isDisposed()) return;
    // The conveyor is off (src/rooms/runs/server/conveyor.ts): the night queues no repair.
    if (!(await conveyorState(bb.storage.kv as never)).on) { ctx.log("wall-night: skipped, the conveyor is off"); return; }
    await wall.runNight().then((summary) => ctx.log(`wall-night: ${summary.picked.length} repair(s) queued, ${summary.hunts.length} hunt(s), ${summary.backlog.length} to the backlog`))
      .catch((cause) => { if (!ctx.isDisposed()) ctx.log(`wall-night failed: ${cause instanceof Error ? cause.message : String(cause)}`); });
  }, { timeoutMs: 2 * 3_600_000 });
  scheduleIsolated(bb, "wall-advance", "5,20,35,50 * * * *", async () => {
    if (ctx.isDisposed()) return;
    await wall.advance().catch((cause) => { if (!ctx.isDisposed()) ctx.log(`wall-advance failed: ${cause instanceof Error ? cause.message : String(cause)}`); });
  }, { timeoutMs: 30 * 60_000 });
  return wall;
}
