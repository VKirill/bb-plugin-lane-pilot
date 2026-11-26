import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import plugin from "../server";
import { runCommandOnHost } from "../src/rooms/writer/cli-run";
import { readBoundedFile, snapshotDryRun } from "../src/rooms/host-worker";
import type { TaskV2 } from "../src/rooms/contracts";
import { coreFileWrite, mapStore } from "./helpers/core-files";
import { appendTaskQaHome, recordCheckFiles, writeDispatchHome } from "../src/rooms/writer/server/services/task-home";
import { bbTaskFileIo } from "../src/rooms/storage";
import { DISPATCH_STAGES_PENDING } from "../src/rooms/runs";
import { recordStage } from "../src/rooms/runs/server";
import {
  createAttempt, createRun, createTask, freezeRunBinding, getAttempt, legacyReadCount, listAttemptsForTask, listStageReceipts, loadProjectSettings, openDatabase, renderTaskManifest, saveProjectSetting, savePrototypeConfig, saveTaskPlan, setRunThread,
} from "../src/rooms/plugin-db";

const projectId = "project-live";
const pmThreadId = "pm-live";
const runId = "run-live";
const realHome = process.env.HOME;
const roots: string[] = [];

function temp(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), `lane-pilot-${prefix}-`));
  roots.push(root);
  return root;
}

/** Paths the fake writer edited: its thread shows them as file changes, as a real writer thread does. */
const touched: string[] = [];

function write(root: string, path: string, content: string): void {
  touched.push(path);
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

/**
 * The whole plugin on a plain folder (no git anywhere): dispatch, the writer thread edits real files, Lane Pilot
 * validates and accepts or rolls back. The host answers runCommand for real and fails the test on any other git call.
 */
async function setup(writerEdits: (folder: string) => string, feedback: (folder: string, turn: number) => string = () => "Looked again") {
  const home = temp("home");
  process.env.HOME = home;
  const folder = temp("folder");
  write(folder, "hello.txt", "original\n");
  write(folder, "keep/other.txt", "not owned\n");
  touched.length = 0;
  const config = {
    projectId, hostId: "host-live", pmWorkspacePath: folder, writerWorkspacePath: folder,
    pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test",
  };
  const task: TaskV2 = {
    schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:live-task", id: "live-task", title: "Edit the live files", risk: "low", lane: "writer", project_cwd: folder,
    read_first: [], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["hello.txt"],
    owns_paths: ["hello.txt", "src/**"], never_touch: [], depends_on: [], objective: "greet", acceptance: ["hello.txt says hello"],
    verify: "none", verification: [],
  };
  const hostCalls: string[] = [];
  const commands: string[] = [];
  const commandResults: Array<{ exitCode: number; stdout: string }> = [];
  const writes = new Map<string, string>();
  const threadSpawns: Array<{ role?: unknown }> = [];
  let answer = "";
  const events: unknown[] = [];
  const extraItems: unknown[] = [];
  const feedbackSeen: string[] = [];
  const boundedReads: Array<{ path: string; cwd: string; content: string }> = [];
  let seq = 0;
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    sdk: { projects: { get: async () => ({ sources: [{ hostId: "host-live", path: folder }] }) }, threads: {
      getPluginMetadata: async ({ threadId }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: runId } : { role: "writer" },
      spawn: async (args) => {
        const role = (args as { pluginMetadata?: { role?: unknown } }).pluginMetadata?.role;
        threadSpawns.push({ role });
        // The writer's work: real edits of the live files, made after Lane Pilot snapshotted and backed up the folder.
        if (role === "writer") answer = writerEdits(folder);
        return { id: "writer-live" } as never;
      },
      get: async ({ threadId }) => ({ id: threadId, status: "idle", projectId }) as never,
      output: async () => ({ text: answer }),
      list: async () => [] as never,
      context: async () => ({ usage: null }) as never,
      updatePluginMetadata: async () => ({}) as never,
      // A feedback turn: the same writer thread gets the failure, works on the live files again and finishes its turn.
      send: async ({ threadId, input }) => {
        if (threadId !== "writer-live") return undefined;
        feedbackSeen.push(readFileSync(join(folder, "hello.txt"), "utf8"));
        answer = feedback(folder, feedbackSeen.length);
        events.push({ type: "client/turn/requested", seq: seq += 1, createdAt: Date.now() },
          { type: "turn/started", threadId, seq: seq += 1, data: {} },
          { type: "turn/completed", threadId, seq: seq += 1, data: { status: "completed" } });
        void input;
        return undefined;
      },
      events: { list: async () => [...events, ...extraItems.map((item) => ({ type: "item/completed", data: { item } })),
        { type: "item/completed", data: { item: { type: "fileChange", changes: touched.map((path) => ({ path })) } } }] as never },
    }, providers: {
      list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }] }] as never,
      models: async () => ({ models: [{ id: "codex-test", model: "codex-test",
        supportedReasoningEfforts: ["medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort })) }] as never }),
    }, files: {
      // A file the plugin wrote reads back as written (the task home); real project files stay disk-backed.
      read: async (args) => {
        const path = (args as { path: string }).path;
        return { content: writes.get(path) ?? (existsSync(path) ? readFileSync(path, "utf8") : "fixture\n") };
      },
      listPaths: async () => ({ paths: [] }) as never,
      write: coreFileWrite(mapStore(writes)) as never,
    } },
    experimental_callHostRpc: async (call) => {
      hostCalls.push(call.method);
      if (call.method === "classifyPlan") {
        return { hostId: "host-live", status: "ok", effort: "medium", reason: null, planSha256: "a", sentPlanSha256: "a", sourceLength: 1, sentLength: 1 };
      }
      // The contract lint asks the machine about read_first files; that is the host's own file check, no git.
      if (call.method === "snapshotDryRun") return snapshotDryRun(call.input as never, {} as never);
      // The execution packet reads read_first through the machine's bounded file read: a file read on the real folder, no git.
      if (call.method === "readBoundedFile") {
        const input = call.input as { relativePath?: string; projectCwd?: string };
        const result = await readBoundedFile(call.input as never, {} as never) as { content?: string };
        if (typeof result.content === "string") boundedReads.push({ path: input.relativePath ?? "", cwd: input.projectCwd ?? "", content: result.content });
        return result;
      }
      if (call.method !== "runCommand") throw new Error(`a folder without git must not call ${call.method}`);
      const input = call.input as { requestedHostId: string; command: string; cwd: string; timeoutSec?: number };
      commands.push(input.command);
      if (input.command.includes("gh auth status --hostname github.com")) return { hostId: "host-live", exitCode: 1, stdout: "", stderr: "fixture: gh is not authenticated" };
      const result = await runCommandOnHost(input);
      commandResults.push(result);
      return result;
    },
  });
  const db = openDatabase(bb);
  savePrototypeConfig(db, config);
  saveProjectSetting(db, projectId, "plan_critique.enabled", false);
  saveProjectSetting(db, projectId, "memory.enabled", false);
  createRun(db, runId, projectId, "bb", null);
  freezeRunBinding(db, runId, { environmentId: "env-live", hostId: "host-live", workspacePath: folder });
  setRunThread(db, runId, pmThreadId);
  await plugin(bb);
  const dispatch = async (patch: Partial<TaskV2> = {}) => JSON.parse(String(await harness.behavior.callAgentTool(
    "lane_pilot_dispatch_writer", { confirm: true, objective: "Проверка диспетча", plan: "Make hello.txt say hello", task: { ...task, ...patch } }, { threadId: pmThreadId, projectId },
  ))) as Record<string, unknown>;
  /** A task that was admitted before the private-Git dispatch guard: recovery resumes its durable pipeline. */
  const resumeLegacy = async (patch: Partial<TaskV2> = {}) => {
    const admittedTask = { ...task, ...patch };
    const attemptId = "attempt-live";
    // This continuation is the older live-folder run shape: the run keeps its frozen host/path binding but has no BB
    // managed environment. The public dispatch refusal above still exercises the current binding guard.
    db.prepare("UPDATE lane_pilot_run SET writer_environment_id=NULL WHERE id=?").run(runId);
    createTask(db, { id: "live-task", runId, kind: "bb", contract: admittedTask });
    saveTaskPlan(db, "live-task", "Make hello.txt say hello");
    await writeDispatchHome(db, bbTaskFileIo(bb as never, "host-live", folder), {
      taskId: "live-task", projectId, runId, basePath: folder, hostId: "host-live", task: admittedTask, plan: "Make hello.txt say hello",
    });
    createAttempt(db, { id: attemptId, runId, taskId: "live-task" });
    db.prepare("UPDATE lane_pilot_attempt SET reason=? WHERE id=?").run(DISPATCH_STAGES_PENDING, attemptId);
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId, taskId: "live-task", stageId, state: "pending", input: "Make hello.txt say hello" });
    const now = Date.now();
    db.prepare(`INSERT INTO lane_pilot_wf_run(id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,link_task_id,link_attempt_id,
      status,reason,inputs_json,created_at,updated_at) VALUES(?,?,'lp-task-pipeline',1,'fixture','{}',?,?,?,?,'interrupted','interrupted_by_reload',?,?,?)`)
      .run("pipeline-live", `lp-task:${attemptId}`, projectId, runId, "live-task", attemptId, JSON.stringify({ taskId: "live-task", attemptId }), now, now);
    const resumed = await harness.behavior.callRpc("resume_runs", { projectId }) as { resumed?: string[]; skipped?: string[] };
    expect(resumed.resumed).toContain(attemptId);
    expect(resumed.skipped ?? []).not.toContain(attemptId);
    return attemptId;
  };
  const finished = async () => {
    for (let i = 0; i < 400; i++) {
      const latest = listAttemptsForTask(db, runId, "live-task").at(-1);
      if (latest && !["queued", "spawn_requested", "spawn_unknown", "running", "cancel_requested"].includes(latest.state)
        && !listStageReceipts(db, runId, "live-task").some((row) => row.state === "running" || row.state === "pending")) return getAttempt(db, latest.id)!;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the task never finished");
  };
  return { bb, db, harness, folder, home, task, dispatch, resumeLegacy, finished, hostCalls, commands, commandResults, writes, threadSpawns, feedbackSeen, boundedReads, extraItems };
}

beforeEach(() => { process.env.LANE_PILOT_DISPATCH_ANSWER_MS = "5000"; });
afterEach(() => {
  delete process.env.LANE_PILOT_DISPATCH_ANSWER_MS;
  process.env.HOME = realHome;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("a plain folder without git, end to end", () => {
  it("refuses a new public dispatch before a plain folder can enter the live-folder pipeline", async () => {
    const env = await setup((folder) => {
      throw new Error(`writer must not start in a refused dispatch: ${folder}`);
    });
    const sent = await env.dispatch();
    expect(sent).toMatchObject({ state: "rejected", error: { code: "project_git_required", sideEffects: "none" } });
    expect(sent.projectGit).toMatchObject({ kind: "noProvider" });
    expect(env.threadSpawns).toEqual([]);
    expect(env.hostCalls.filter((method) => /^git/.test(method))).toEqual([]);
    expect(env.commandResults).toContainEqual(expect.objectContaining({ exitCode: 0, stdout: expect.stringContaining('"state": "noGit"') }));
    expect(existsSync(join(env.folder, ".git"))).toBe(false);
    await env.harness.lifecycle.dispose();
  });

  it("resumes an already-admitted live-folder pipeline, edits a pre-existing live file, accepts, and never touches git, a worktree or a merge", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      write(folder, "src/existing.ts", "export {};\n");
      return "Changed hello.txt and src/existing.ts";
    });
    mkdirSync(join(env.folder, "src"), { recursive: true });
    writeFileSync(join(env.folder, "src", "existing.ts"), "original existing\n");
    await env.resumeLegacy();
    const attempt = await env.finished();
    expect(attempt).toMatchObject({ state: "accepted", reason: null });
    const bound = getAttempt(env.db, attempt.id)!;
    // In place: the attempt's workspace is the run's folder, decided as a live folder.
    expect(bound.workspace_path).toBe(env.folder);
    expect(bound.environment_id).toBeNull();
    expect(bound.workspace_decision).toMatchObject({ strategy: "inherit_run", reason: "live_folder" });
    // The files are already in place; nothing was committed, merged or branched.
    expect(readFileSync(join(env.folder, "hello.txt"), "utf8")).toBe("hello\n");
    expect(existsSync(join(env.folder, "src", "existing.ts"))).toBe(true);
    expect(existsSync(join(env.folder, ".git"))).toBe(false);
    noGit(env);
    expect(env.threadSpawns.filter((row) => row.role === "writer")).toHaveLength(1);
    // The receipt names the mode; it is written once into the task's home (docs/task-folder.md), not the run's shared artifacts.
    const receipt = [...env.writes].find(([path]) => path.endsWith("/.agents/tasks/live-task/receipt.json"));
    expect([...env.writes].some(([path]) => path.endsWith("lane-pilot-receipt.json"))).toBe(false);
    expect(receipt && JSON.parse(receipt[1])).toMatchObject({ status: "accepted", workspace: "live-folder", ownsPaths: ["hello.txt", "src/**"] });
    expect(loadProjectSettings(env.db, projectId)["writer.lastResult"]).toMatchObject({ workspace: "live-folder" });
    const writerStage = listStageReceipts(env.db, runId, "live-task").find((row) => row.stageId === "writer-agent")!;
    expect(writerStage.result).toMatchObject({ status: "accepted", workspace: { mode: "live-folder" } });
    expect((writerStage.result as { produced?: string[] }).produced?.slice().sort()).toEqual(["hello.txt", "src/existing.ts"]);
    await env.harness.lifecycle.dispose();
  });

  it("refuses a newly created owned live file without a before-image", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      write(folder, "src/new.ts", "export {};\n");
      return "Changed hello.txt and src/new.ts";
    });
    await env.resumeLegacy();
    const attempt = await env.finished();
    expect(attempt).toMatchObject({ state: "blocked", reason: "live_backup_before_unknown: src/new.ts: not_in_backup" });
    expect(existsSync(join(env.folder, "src", "new.ts"))).toBe(false);
    expect(existsSync(join(env.home, ".lane-pilot", "live-backups", "attempt-live", "created", "src", "new.ts"))).toBe(true);
    await env.harness.lifecycle.dispose();
  });

  // The legacy admitted path from durable recovery to the effect (the 0.1.562 lesson: every function unit-tested, the graph never started):
  // the queued pipeline resume, the real lp-task-pipeline executors, the writer, acceptance and the close. Mutations it fails under: recovery
  // not opening the home or
  // recording PLAN.md under another kind; the plan reader resolving the manifest entry; the receipts written to the run's
  // artifacts; the close not reading the attempt's report and acceptance through the manifest.
  it("[sma:k_pl_quick] resumes the admitted pipeline → accepted, and every main-path reader resolved its input through the task manifest", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      return "Changed hello.txt\nLESSON: a live folder needs no worktree";
    });
    await env.resumeLegacy();
    const attempt = await env.finished();
    expect(attempt).toMatchObject({ state: "accepted", reason: null });
    type Manifest = { schema: string; files: Array<{ kind: string; path: string; read_by: Array<{ node: string }> }>; legacy: unknown[] };
    let manifest = renderTaskManifest(env.db, "live-task") as Manifest | null;
    // OUTCOME.md and lessons.md are written by the attempt-finished reaction, a moment after the attempt row turns accepted.
    for (let i = 0; i < 200 && !manifest?.files.some((row) => row.kind === "lesson"); i++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      manifest = renderTaskManifest(env.db, "live-task") as Manifest | null;
    }
    expect(manifest?.schema).toBe("lp.task-manifest/1");
    const kinds = new Set(manifest!.files.map((row) => row.kind));
    for (const kind of ["contract", "plan", "brief", "writer-report", "acceptance", "receipt", "outcome", "lesson"]) expect([...kinds], kind).toContain(kind);
    const readers = (kind: string) => manifest!.files.filter((row) => row.kind === kind).flatMap((row) => row.read_by.map((read) => read.node));
    expect(readers("plan")).toContain("pm-read");
    expect(readers("writer-report")).toContain("lessons");
    expect(readers("acceptance")).toContain("lessons");
    expect(manifest!.legacy).toEqual([]);
    expect(legacyReadCount(env.db, { taskId: "live-task" })).toBe(0);
    // The files are in the task's home under the run's folder, and PLAN.md holds the plan text the PM sent.
    expect(env.writes.get(join(env.folder, ".agents/tasks/live-task/PLAN.md"))).toBe("Make hello.txt say hello\n");
    expect(env.writes.has(join(env.folder, ".agents/tasks/live-task/manifest.json"))).toBe(true);
    expect([...env.writes.keys()].filter((path) => path.includes("/.agents/plans/items/") || path.includes("/artifacts/live-task/"))).toEqual([]);
    await env.harness.lifecycle.dispose();
  });

  // 0.1.567: the task home wrote with expectedSha256: null, which the bb core answers with `conflict` (nothing written, nothing thrown) for a file that
  // exists, so manifest.json stayed at its first render and a second QA note was lost. The database render and a fake that overwrites hid it; this reads the FILE.
  it("[sma:k_pl_quick] lists every kind in the manifest.json FILE after acceptance, and a QA note appended twice keeps both entries", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      return "Changed hello.txt\nLESSON: a live folder needs no worktree";
    });
    await env.resumeLegacy();
    const done = await env.finished();
    expect(done).toMatchObject({ state: "accepted", reason: null });
    const manifestPath = join(env.folder, ".agents/tasks/live-task/manifest.json");
    const kindsOnDisk = () => new Set(((JSON.parse(env.writes.get(manifestPath) ?? '{"files":[]}') as { files: Array<{ kind: string }> }).files).map((row) => row.kind));
    for (let i = 0; i < 200 && !kindsOnDisk().has("lesson"); i++) await new Promise((resolve) => setTimeout(resolve, 25));
    // The task has no check of its own; one more recorded round (a red check and its log) goes through the same writer and must reach the file too.
    await recordCheckFiles({ bb: env.bb, db: env.db }, { taskId: "live-task", runId, attemptId: done.id, cleanOutput: (text) => text, verifies: [{ command: "npm test", exitCode: 1, stdout: "1 failed" }] });
    for (const kind of ["contract", "plan", "brief", "writer-report", "checks", "check-log", "acceptance", "receipt", "outcome"]) expect([...kindsOnDisk()], kind).toContain(kind);
    expect(await appendTaskQaHome({ bb: env.bb, db: env.db } as never, { taskId: "live-task", question: "first question?" })).toBe(true);
    expect(await appendTaskQaHome({ bb: env.bb, db: env.db } as never, { taskId: "live-task", question: "second question?", answer: "yes" })).toBe(true);
    const qa = [...env.writes].find(([path]) => path.endsWith("/QA.md"));
    expect(qa?.[1]).toContain("first question?");
    expect(qa?.[1]).toContain("second question?");
    expect(kindsOnDisk().has("qa")).toBe(true);
    await env.harness.lifecycle.dispose();
  });

  it("does not blame the writer for a file the PM or the owner changed in the folder meanwhile (live drill 2026-10-07)", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      // Someone else edits the shared folder during the attempt: no write() call, so the writer's thread never shows it.
      writeFileSync(join(folder, "notes-by-pm.md"), "the PM was here\n");
      return "Changed hello.txt";
    });
    await env.resumeLegacy();
    const attempt = await env.finished();
    expect(attempt).toMatchObject({ state: "accepted", reason: null });
    expect(readFileSync(join(env.folder, "notes-by-pm.md"), "utf8")).toBe("the PM was here\n");
    await env.harness.lifecycle.dispose();
  });

  it("leaves a file another task of the run owns to that task, even when this writer's thread names a file of the same name (BB-сервис 2026-10-10)", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      write(folder, "src/README.md", "this task's readme\n");
      // The sibling's writer works on its own files in the shared folder meanwhile; this writer's thread never names them.
      mkdirSync(join(folder, "sibling"), { recursive: true });
      writeFileSync(join(folder, "sibling", "README.md"), "the sibling's readme\n");
      return "Changed hello.txt and src/README.md";
    });
    // The writer overwrites this owned file; seed it before recovery so the live backup has an authentic before image.
    mkdirSync(join(env.folder, "src"), { recursive: true });
    writeFileSync(join(env.folder, "src", "README.md"), "original task readme\n");
    createTask(env.db, { id: "sibling-task", runId, kind: "bb", contract: { ...env.task, id: "sibling-task", owns_paths: ["sibling/**"], expected_outputs: ["sibling/README.md"] } });
    await env.resumeLegacy();
    const attempt = await env.finished();
    expect(getAttempt(env.db, attempt.id)?.reason ?? null).toBeNull();
    expect(attempt).toMatchObject({ state: "accepted", reason: null });
    await env.harness.lifecycle.dispose();
  });

  it("does not count a file that only shows up in a command's output as the writer's (live drill 2026-10-07, 0.1.179)", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      writeFileSync(join(folder, "notes-by-pm.md"), "the PM was here\n");
      return "Changed hello.txt";
    });
    env.extraItems.push({ type: "commandExecution", command: "ls -la", aggregatedOutput: "hello.txt\nnotes-by-pm.md\n" });
    await env.resumeLegacy();
    const attempt = await env.finished();
    expect(attempt).toMatchObject({ state: "accepted", reason: null });
    await env.harness.lifecycle.dispose();
  });

  it("keeps the admitted pipeline's read_first check on the folder's machine after public noGit refusal", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      return "Changed hello.txt";
    });
    const missing = await env.dispatch({ read_first: ["nowhere/missing.txt"] });
    expect(missing).toMatchObject({ state: "rejected", error: { code: "project_git_required" } });
    expect(env.threadSpawns).toEqual([]);
    await env.resumeLegacy({ read_first: ["keep/other.txt"] });
    const present = await env.finished();
    expect(present).toMatchObject({ state: "accepted", reason: null });
    expect(env.boundedReads).toContainEqual({ path: "keep/other.txt", cwd: env.folder, content: "not owned" });
    await env.harness.lifecycle.dispose();
  });

  it("rolls the owned files back when the attempt is rejected, and leaves what is outside owns_paths", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "changed, then rejected\n");
      write(folder, "src/created.ts", "created by the writer\n");
      // Outside owns_paths: the attempt is rejected for it, and it is not rolled back (only owned paths are).
      write(folder, "keep/other.txt", "touched by the writer\n");
      return "Changed things";
    });
    await env.resumeLegacy();
    const attempt = await env.finished();
    expect(attempt.state).not.toBe("accepted");
    expect(String(getAttempt(env.db, attempt.id)?.reason ?? "")).toContain("keep/other.txt");
    expect(readFileSync(join(env.folder, "hello.txt"), "utf8")).toBe("original\n");
    expect(existsSync(join(env.folder, "src", "created.ts"))).toBe(false);
    expect(readFileSync(join(env.folder, "keep", "other.txt"), "utf8")).toBe("touched by the writer\n");
    // Never rm: the created file sits in the backup folder, beside the originals, for seven days.
    const backups = join(env.home, ".lane-pilot", "live-backups");
    const ids = readdirSync(backups);
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.some((id) => existsSync(join(backups, id, "created", "src", "created.ts")))).toBe(true);
    noGit(env);
    await env.harness.lifecycle.dispose();
  });

  it("keeps the live files across a feedback turn, and accepts once the writer fixes what was rejected", async () => {
    const env = await setup((folder) => {
      write(folder, "hello.txt", "hello\n");
      write(folder, "keep/other.txt", "touched by the writer\n");
      return "Changed things";
    }, (folder) => {
      // The writer undoes its stray edit in the same thread, on the same live files.
      write(folder, "keep/other.txt", "not owned\n");
      return "Undid keep/other.txt";
    });
    await env.resumeLegacy();
    const attempt = await env.finished();
    expect(attempt).toMatchObject({ state: "accepted", reason: null });
    // The feedback turn found the first turn's edit still in place: nothing was rolled back between turns.
    expect(env.feedbackSeen).toEqual(["hello\n"]);
    expect(env.threadSpawns.filter((row) => row.role === "writer")).toHaveLength(1);
    expect(readFileSync(join(env.folder, "hello.txt"), "utf8")).toBe("hello\n");
    expect(readFileSync(join(env.folder, "keep", "other.txt"), "utf8")).toBe("not owned\n");
    noGit(env);
    await env.harness.lifecycle.dispose();
  });
});

/** Recovery may probe again; every direct Git command is a read-only repository check. */
function noGit(env: Awaited<ReturnType<typeof setup>>): void {
  expect(env.hostCalls.filter((method) => /^git/.test(method))).toEqual([]);
  const gitCommands = env.commands.filter((command) => /^git\b/.test(command));
  expect(gitCommands.length).toBeGreaterThan(0);
  expect(gitCommands).toContain("git rev-parse --is-inside-work-tree");
  expect(gitCommands.every((command) => /^git rev-parse\b/.test(command))).toBe(true);
}

