import { runOnHost } from "@lane-pilot/host-calls";
import { waitThreadIdle } from "@lane-pilot/thread-observe";
import { taskV2Schema } from "../../contracts";
import { fullAccessSpawn, stringAt, type ServerCore, type Services } from "../../core/server";
import { cancelAttemptById, finishRunSafely } from "../../runs/server";
import { getActivation, getRun, listOpenAttempts, loadPrototypeConfig, saveProjectSetting, savePrototypeConfig } from "../../storage";
import { isSandboxProjectName } from "../../stability/server";
import { attemptMetrics, syncTokenUsage } from "../../usage/server";
import { DEFAULT_BENCH_WRITER } from "../runner";
import { setBenchProject } from "../store";
import type { BenchProjectRef, HostPort, PipelinePort } from "../ports";
import { createBench, type BenchApi } from "../service";

/** The bench inside the plugin: the machines through `runCommand`, the pipeline through the plugin's own services. */
export function createPluginBench(ctx: ServerCore, services: Services): BenchApi {
  const { bb, db, host } = ctx;

  const hostPort: HostPort = {
    run: async (hostId, cwd, command, timeoutSec = 120) => {
      const result = await runOnHost(host, { hostId, cwd, command, timeoutSec });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };

  const listProjects = async (): Promise<Array<{ id: string; name: string }>> => {
    const rows = await bb.sdk.projects.list({ includePersonal: true } as never).catch(() => []) as Array<{ id?: unknown; name?: unknown }>;
    return rows.flatMap((row) => typeof row.id === "string" && typeof row.name === "string" ? [{ id: row.id, name: row.name }] : []);
  };

  const keysKey = (projectId: string) => `bench:keys:${projectId}`;

  // Every attempt of a bench run is the bench's, also the ones its PM queued on its own: they go before the run closes.
  const closeRun = async (projectId: string, runId: string) => {
    for (const row of listOpenAttempts(db).filter((attempt) => attempt.run_id === runId)) await cancelAttemptById(ctx, row.id).catch(() => undefined);
    await finishRunSafely(bb, db, projectId, runId, "cli");
  };

  const pipeline: PipelinePort = {
    async findProject(name) {
      const found = (await listProjects()).find((row) => row.name === name);
      if (!found) return null;
      const project = await bb.sdk.projects.get({ projectId: found.id }).catch(() => null) as { sources?: Array<{ hostId?: string; path?: string }> } | null;
      const source = project?.sources?.[0];
      return source?.hostId && source.path ? { projectId: found.id, name, hostId: source.hostId, path: source.path } : null;
    },

    async configure(project, input) {
      if (!loadPrototypeConfig(db, project.projectId)) {
        // The PM of a bench series only has to start; the writer is the arm's setting.
        savePrototypeConfig(db, { projectId: project.projectId, hostId: project.hostId, pmWorkspacePath: project.path, writerWorkspacePath: project.path,
          pmProviderId: DEFAULT_BENCH_WRITER.providerId, pmModel: DEFAULT_BENCH_WRITER.model, writerProviderId: DEFAULT_BENCH_WRITER.providerId, writerModel: DEFAULT_BENCH_WRITER.model });
      }
      // A key an earlier arm set and this one does not is dropped: an arm is what it names, not what the last arm left behind.
      const before = await bb.storage.kv.get(keysKey(project.projectId)).catch(() => null) as string[] | null;
      for (const key of before ?? []) if (!(key in input.settings)) db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id=? AND binding_id='' AND key=?").run(project.projectId, key);
      for (const [key, value] of Object.entries(input.settings)) saveProjectSetting(db, project.projectId, key, value);
      await bb.storage.kv.set(keysKey(project.projectId), Object.keys(input.settings) as never);
      setBenchProject(db, { projectId: project.projectId, harness: input.harness, sourceProjectId: input.sourceProjectId });
    },

    async startRun(project) {
      const spawned = await fullAccessSpawn(bb, {
        projectId: project.projectId, providerId: DEFAULT_BENCH_WRITER.providerId, model: DEFAULT_BENCH_WRITER.model, prompt: "Reply with OK only.",
        environment: { type: "host", hostId: project.hostId, workspace: { type: "unmanaged", path: project.path } },
        visibility: "visible", pluginMetadata: { role: "bench-source" },
      } as never);
      const sourceId = stringAt(spawned, "id");
      if (!sourceId) throw new Error("the bench source thread did not start");
      await waitThreadIdle(bb, sourceId, "bench_source_timeout", 180_000);
      // A run an earlier series could not close holds the project's activation and would refuse this one.
      const left = getActivation(db, project.projectId);
      const leftRun = left ? getRun(db, left.run_id) : undefined;
      if (left && (leftRun?.state === "pending" || leftRun?.state === "running")) await closeRun(project.projectId, left.run_id);
      const activated = await services.activate(project.projectId, sourceId, "bb");
      // The PM prompt tells the PM to delegate a fixture task of its own; a bench run takes its tasks only from the bench, so the PM is stopped at once.
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
      for (const row of open) await cancelAttemptById(ctx, row.id).catch(() => undefined);
    },

    async finishRun(project, runId) {
      await closeRun(project.projectId, runId);
    },
  };

  return createBench({
    db: db as never, kv: bb.storage.kv as never, host: hostPort, pipeline,
    projectNames: async () => new Map((await listProjects()).map((row) => [row.id, row.name])),
    isSandboxName: isSandboxProjectName, log: ctx.log,
  });
}

export type { BenchProjectRef };
