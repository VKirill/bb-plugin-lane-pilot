import { runOnHost } from "@lane-pilot/host-calls";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { taskV2Schema } from "../../contracts";
import { fullAccessSpawn, stringAt, type ServerCore, type Services } from "../../core/server";
import { cancelAttemptById, finishRunSafely } from "../../runs/server";
import { createRun, createTask, getActivation, getRun, getTask, listOpenAttempts, loadProjectSettings, loadPrototypeConfig, saveProjectSetting, savePrototypeConfig } from "../../storage";
import { isSandboxProjectName } from "../../stability/server";
import { attemptMetrics, syncTokenUsage } from "../../usage/server";
import { DEFAULT_BENCH_WRITER } from "../runner";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { setBenchProject } from "../store";
import type { BenchProjectRef, HostPort, PipelinePort } from "../ports";
import { createBench, type BenchApi } from "../service";
import { pageReviewByAgent } from "../../critique/server";
import { judgeTrace } from "../jevals";
import { ensureSealedSets } from "../critique-set";
import { jev } from "@lane-pilot/jev";

/** The bench inside the plugin: the machines through `runCommand`, the pipeline through the plugin's own services. */
const listProjects = async (bb: ServerCore["bb"]): Promise<Array<{ id: string; name: string }>> => {
  const rows = await bb.sdk.projects.list({ includePersonal: true } as never).catch(() => []) as Array<{ id?: unknown; name?: unknown }>;
  return rows.flatMap((row) => typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : []);
};

/** The pipeline the bench drives: projects through the SDK, run lifecycle through the plugin's own services. */
export function benchPipeline(ctx: Pick<ServerCore, "bb" | "db" | "host" | "cancelQueuedAttempt">, services: Services): PipelinePort {
  const { bb, db } = ctx;

  const keysKey = (projectId: string) => `bench:keys:${projectId}`;

  // Every attempt of a bench run is the bench's, also the ones its PM queued on its own: they go before the run closes.
  const closeRun = async (projectId: string, runId: string) => {
    for (const row of listOpenAttempts(db).filter((attempt) => attempt.run_id === runId)) await cancelAttemptById(ctx, row.id, undefined, "canceled: the bench closed the run", "run_closed").catch(() => undefined);
    await finishRunSafely(bb, db, projectId, runId, "cli");
  };

  const pipeline: PipelinePort = {
    async findProject(name) {
      const found = (await listProjects(bb)).find((row) => row.name === name);
      if (!found) return null;
      const project = await bb.sdk.projects.get({ projectId: found.id }).catch(() => null) as { sources?: Array<{ hostId?: string; path?: string }> } | null;
      const source = project?.sources?.[0];
      return source?.hostId && source.path ? { projectId: found.id, name, hostId: source.hostId, path: source.path } : null;
    },

    async configure(project, input) {
      // The PM pair is rewritten on every arm: a stored config from before the compiled main agent's
      // claude-code-only rule kept spawning the PM on codex and the night died on
      // vk_compiled_main_agent_unsupported_provider (2026-10-29/30). The PM of a bench series only has to start;
      // the arm's writer pair is the safe one.
      const writerProviderId = typeof input.settings["writer.provider"] === "string" && input.settings["writer.provider"] ? input.settings["writer.provider"] : DEFAULT_BENCH_WRITER.providerId;
      const writerModel = typeof input.settings["writer.model"] === "string" && input.settings["writer.model"] ? input.settings["writer.model"] : DEFAULT_BENCH_WRITER.model;
      const stored = loadPrototypeConfig(db, project.projectId);
      savePrototypeConfig(db, {
        projectId: project.projectId, hostId: stored?.hostId ?? project.hostId,
        pmWorkspacePath: stored?.pmWorkspacePath ?? project.path, writerWorkspacePath: stored?.writerWorkspacePath ?? project.path,
        pmProviderId: writerProviderId, pmModel: writerModel, writerProviderId: stored?.writerProviderId ?? writerProviderId, writerModel: stored?.writerModel ?? writerModel });
      // A key an earlier arm set and this one does not is dropped: an arm is what it names, not what the last arm left behind.
      const before = await bb.storage.kv.get(keysKey(project.projectId)).catch(() => null) as string[] | null;
      for (const key of before ?? []) if (!(key in input.settings)) db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?").run(project.projectId, key);
      for (const [key, value] of Object.entries(input.settings)) saveProjectSetting(db, project.projectId, key, value);
      await bb.storage.kv.set(keysKey(project.projectId), Object.keys(input.settings) as never);
      setBenchProject(db, { projectId: project.projectId, harness: input.harness, sourceProjectId: input.sourceProjectId });
    },

    async startRun(project) {
      // The runner reconfigures writer.provider / writer.model before a retry. Spawn that pair, not the default the previous arm left behind.
      const settings = loadProjectSettings(db, project.projectId);
      const providerId = typeof settings["writer.provider"] === "string" && settings["writer.provider"] ? settings["writer.provider"] : DEFAULT_BENCH_WRITER.providerId;
      const model = typeof settings["writer.model"] === "string" && settings["writer.model"] ? settings["writer.model"] : DEFAULT_BENCH_WRITER.model;
      const spawned = await fullAccessSpawn(bb, {
        projectId: project.projectId, providerId, model, prompt: "Reply with OK only.",
        environment: { type: "host", hostId: project.hostId, workspace: { type: "unmanaged", path: project.path } },
        visibility: "visible", pluginMetadata: { role: "bench-source" },
      } as never);
      const sourceId = stringAt(spawned, "id");
      if (!sourceId) throw new Error("the bench source thread did not start");
      await waitThreadIdle(bb, sourceId, "bench_source_timeout", 180_000);
      // A run an earlier series could not close holds the project's activation and would refuse this one.
      const left = getActivation(db, project.projectId);
      const leftRun = left ? getRun(db, left.run_id) : undefined;
      if (left && (leftRun?.state === "pending" || leftRun?.state === "running")) {
        const meta = await bb.sdk.threads.getPluginMetadata({ threadId: left.pm_thread_id }).catch(() => null) as Record<string, unknown> | null;
        const ours = stringAt(meta, "role") === "bench-pm" || left.pm_thread_id.startsWith("pending:");
        // A live non-bench PM keeps the project: the series defers instead of crashing on the activation
        // lock (hive W28-3). bench.live_pm=close restores the old takeover.
        const livePolicy = String(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID)["bench.live_pm"] ?? "defer");
        if (!ours && livePolicy !== "close") throw new Error(`deferred: the bench project holds a live Lane Pilot PM (thread ${left.pm_thread_id}, run ${left.run_id})`);
        await closeRun(project.projectId, left.run_id);
      }
      const activated = await services.activate(project.projectId, sourceId, "bb");
      // The PM prompt tells the PM to delegate a fixture task of its own; a bench run takes its tasks only from the bench, so the PM is stopped at once.
      await bb.sdk.threads.updatePluginMetadata({ threadId: activated.threadId, set: { role: "bench-pm" } } as never).catch(() => undefined);
      await bb.sdk.threads.stop({ threadId: activated.threadId }).catch(() => undefined);
      return { pmThreadId: activated.threadId, runId: activated.runId };
    },

    async dispatch(project, pmThreadId, task) {
      try {
        const sent = await services.dispatchWriter({ projectId: project.projectId, threadId: pmThreadId, task: taskV2Schema.parse(task), birth: "bench" });
        const state = String(sent.state ?? "");
        return { ok: state !== "rejected" && state !== "failed" && state !== "validation_failed", detail: JSON.stringify(sent).slice(0, 400), ...(typeof sent.taskId === "string" ? { taskId: sent.taskId } : {}) };
      } catch (cause) {
        return { ok: false, detail: cause instanceof Error ? cause.message : String(cause) };
      }
    },

    async outcome(runId, taskId) {
      const latest = db.prepare("SELECT state FROM lane_pilot_attempt WHERE run_id=? AND task_id=? ORDER BY created_at DESC, attempt_no DESC LIMIT 1").get(runId, taskId) as { state: string } | undefined;
      const count = db.prepare("SELECT count(*) AS n FROM lane_pilot_attempt WHERE run_id=? AND task_id=?").get(runId, taskId) as { n: number };
      return { latestState: latest?.state ?? null, attempts: count.n };
    },

    async metrics(project, _runId, taskId) {
      const read = () => attemptMetrics(db, { projectId: project.projectId, days: 7 }).attempts.filter((row) => row.taskId === taskId).sort((a, b) => a.attemptNo - b.attemptNo);
      // The usage sync writes a writer thread's token row minutes after the attempt: sync now before calling the cost not measured.
      if (read().some((row) => row.writer.threadId && row.costNote?.startsWith("no usage row"))) await syncTokenUsage({ bb, db }, { sinceDays: 2 }).catch(() => undefined);
      return read();
    },

    async cancel(runId, taskId) {
      const open = db.prepare("SELECT id FROM lane_pilot_attempt WHERE run_id=? AND task_id=? AND state IN ('queued','spawn_requested','spawn_unknown','running')").all(runId, taskId) as Array<{ id: string }>;
      for (const row of open) await cancelAttemptById(ctx, row.id, undefined, "canceled: the bench canceled the task", "superseded").catch(() => undefined);
    },

    async finishRun(project, runId) {
      await closeRun(project.projectId, runId);
    },
  };
  return pipeline;
}

export function createPluginBench(ctx: ServerCore, services: Services): BenchApi {
  const { bb, db, host } = ctx;
  const hostPort: HostPort = {
    run: async (hostId, cwd, command, timeoutSec = 120) => {
      const result = await runOnHost(host, { hostId, cwd, command, timeoutSec });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };
  return createBench({
    db: db as never, kv: bb.storage.kv as never, host: hostPort, pipeline: benchPipeline(ctx, services),
    projectNames: async () => new Map((await listProjects(bb)).map((row) => [row.id, row.name])),
    isSandboxName: isSandboxProjectName, log: ctx.log,
    jevals: async (input) => {
      const settings = input.task.projectId ? await ctx.effectiveProjectSettings(input.task.projectId).then((r) => r.values as Record<string, unknown>).catch(() => ({})) : {};
      return await judgeTrace({ jev, settings, projectId: input.task.projectId, runId: null }, input);
    },
    jevCtx: async (task) => ({
      projectId: task.projectId ?? null,
      runId: null,
      settings: task.projectId ? await ctx.effectiveProjectSettings(task.projectId).then((r) => r.values as Record<string, unknown>).catch(() => ({} as Record<string, unknown>)) : {},
    }),
    pageReview: async (task, req) => pageReviewByAgent(ctx, services, {
      pmThreadId: "", projectId: task.projectId ?? "", parentRunId: "",
      design: Boolean((task as { brief?: { design?: unknown } }).brief?.design), request: req,
    }),
    // The critic-eval stratum: one real code-critique call on the task's patch — no writer, no repo. The receipt lands
    // on a real lane_pilot_run/lane_pilot_task pair of project critic-eval, so criticStats (R9, lp.critic-edit) counts it.
    criticRun: async (task: import("../types").ManifestTask, runId: string) => {
      const { runCodeCritique } = await import("../../critique/server");
      const { buildCandidateEvidence } = await import("../../critique");
      const { expectedFindings, judgeCriticFindings } = await import("../critique-set");
      const contract = task.contract as { title?: string; diff?: string; expected_findings?: unknown };
      const expected = expectedFindings(task.contract);
      const diff = String(contract.diff ?? "");
      if (!getRun(db, runId)) createRun(db, runId, "critic-eval", "cli");
      if (!getTask(db, task.taskId)) createTask(db, { id: task.taskId, runId, kind: "cli", contract: { title: contract.title ?? task.taskId, risk: task.risk } });
      const evidence = buildCandidateEvidence({
        produced: ["patch.diff"], hashes: { "patch.diff": null }, verification: [],
        files: [{ path: "patch.diff", content: diff }], patches: { "patch.diff": diff },
        output: "", ownsPaths: ["patch.diff"], neverTouch: [], dirtOk: true,
      });
      const verdict = await runCodeCritique({
        bb, db, projectId: "critic-eval", runId, taskId: task.taskId,
        config: (loadPrototypeConfig(db, "critic-eval") ?? { projectId:"critic-eval", hostId:"", pmWorkspacePath:"", writerWorkspacePath:"", pmProviderId:"", pmModel:"", writerProviderId:"", writerModel:"" }) as never,
        task: { id: task.taskId, title: contract.title ?? task.taskId, risk: task.risk, kind: "code",
                objective: `Review this patch for the bug it introduces:\n\n${diff}` } as never,
        evidence,
      });
      const findings = ((verdict.critique ?? verdict.parsed) as { findings?: unknown[] } | undefined)?.findings ?? [];
      const judge = judgeCriticFindings(findings as never, expected);
      return { ok: judge.found === judge.total, reason: `critic found ${judge.found}/${judge.total} known bugs` };
    },
  });
}

export type { BenchProjectRef };
