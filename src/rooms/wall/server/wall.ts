import { join } from "node:path";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
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
import { wallLogLines } from "../logs";
import { createWall, type RepairView, type Scope, type ThreadRun, type WallApi, type WallPorts } from "../service";

const LOG_TAIL_BYTES = 1_000_000;
const READER_WAIT_MS = 25 * 60_000;
/** A reader thread that reports no usage still cost something: its prompt and answer, read a few times. */
const estimateTokens = (...texts: string[]): number => Math.ceil(texts.reduce((sum, text) => sum + text.length, 0) / 3) * 3;

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

  const reader: WallPorts["reader"] = async (prompt, who) => {
    const { cfg, hostId, basePath } = await environmentOf();
    const wall = wallRef.current;
    const wcfg = await wall.config();
    const spawned = await fullAccessSpawn(bb, {
      projectId: cfg.projectId,
      environment: { type: "host", hostId, workspace: { type: "unmanaged", path: basePath } },
      title: `Lane Pilot wall ${who}`,
      prompt,
      ...writerExecutionSelection(wcfg.hunterProviderId, wcfg.hunterModel, who === "analysis" ? "high" : wcfg.hunterReasoningLevel, "default"),
      pluginMetadata: { role: `wall-${who}` },
    } as Parameters<typeof fullAccessSpawn>[1]);
    const threadId = stringAt(spawned, "id");
    if (!threadId) return { text: null, tokens: 0 };
    try {
      await waitThreadIdle(bb, threadId, "wall_reader_timeout", READER_WAIT_MS);
      const out = (await bb.sdk.threads.output({ threadId })).output;
      const text = typeof out === "string" && out.trim() ? out : null;
      const usage = await threadUsage(bb, threadId).catch(() => null);
      const used = usage?.known ? usage.tokens : null;
      return { text, tokens: used ?? estimateTokens(prompt, text ?? "") };
    } catch {
      await bb.sdk.threads.stop({ threadId }).catch(() => undefined);
      return { text: null, tokens: estimateTokens(prompt) };
    }
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
    reader,
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
        return state.status === "ready" ? state.changed.map((file) => file.path) : null;
      },
      revert: async (commit) => {
        const { hostId, basePath } = await environmentOf();
        const created = await host.call("gitCreateWorktree", { requestedHostId: hostId, basePath, name: `night-revert-${commit.slice(0, 8)}-${Date.now().toString(36)}` }, { hostId, timeoutMs: 120_000 });
        if (created.status !== "ready" || !created.path) return { ok: false, detail: `worktree not created: ${created.reason ?? "unknown"}` };
        const reverted = await host.call("gitRevertCommits", { requestedHostId: hostId, worktreePath: created.path, commits: [commit] }, { hostId, timeoutMs: 120_000 });
        if (reverted.status !== "reverted") {
          await host.call("gitRemoveWorktree", { requestedHostId: hostId, basePath, worktreePath: created.path }, { hostId, timeoutMs: 120_000 }).catch(() => null);
          return { ok: false, detail: `${reverted.status}: ${reverted.reason ?? reverted.conflicts.join(", ")}` };
        }
        const merged = await host.call("gitIntegrate", { requestedHostId: hostId, basePath, worktreePath: created.path, message: `night loop: revert ${commit.slice(0, 12)} (canary or bench red)`, removeWorktree: true }, { hostId, timeoutMs: 300_000 });
        return { ok: merged.status === "merged", detail: `${merged.status}${merged.commit ? ` ${merged.commit.slice(0, 12)}` : ""}${merged.reason ? `: ${merged.reason}` : ""}` };
      },
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
        if (runs.some((row) => row.state === "running")) return "running";
        if (runs.length) return runs.every((row) => row.state === "done" || row.state === "stopped_budget") ? "done" : "unavailable";
        const cfg = await wallRef.current.config();
        await services.bench.run({ version, arm, limit: cfg.benchSubset, wait: false });
        return "running";
      },
      compare: async (base, arm) => {
        const version = benchSetVersion();
        if (!version) return "unavailable";
        try {
          const result = services.bench.compare({ version, armA: base, armB: arm });
          return result.comparison.verdict === "pass" ? "pass" : "fail";
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
