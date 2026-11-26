import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { beginRunAdmission, createRun, createTask, createAttempt, freezeRunBinding, getRun, openDatabase, setRunThread, directoryMove } from "../src/rooms/plugin-db";
import { handleDirectoryMove, recoverDirectoryMove, type DirectoryMoveInput } from "../src/rooms/native-agent/server/services/directory-move";
import { claimNativeLaneRun } from "../src/rooms/native-agent/server/services/native-run";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function fixture() {
  const fake = createFakePluginHost({ pluginId: "lane-pilot" });
  cleanups.push(() => fake.harness.lifecycle.dispose());
  const db = openDatabase(fake.bb);
  createRun(db, "old", "project", "cli");
  freezeRunBinding(db, "old", { environmentId: "source", hostId: "host", workspacePath: "/source" });
  setRunThread(db, "old", "thread");
  let environmentId = "source";
  const metadata = vi.fn(async () => ({}));
  const bb = { ...fake.bb, sdk: { ...fake.bb.sdk,
    threads: { ...fake.bb.sdk.threads, get: async () => ({ id: "thread", projectId: "project", environmentId }), getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "old" }), updatePluginMetadata: metadata },
    environments: { ...fake.bb.sdk.environments, get: async () => ({ id: "target", hostId: "host", path: "/target", projectId: "project" }) },
  } } as unknown as BbPluginApi;
  const input: DirectoryMoveInput = { phase: "prepare", operationId: "move", threadId: "thread", projectId: "project", source: { environmentId: "source", hostId: "host", path: "/source" }, target: { environmentId: "target", hostId: "host", path: "/target" } };
  const deps = { bb, db, loadParked: async () => [] as Array<{ runId: string; pmThreadId: string }> };
  return { db, bb, input, deps, metadata, attach: () => { environmentId = "target"; } };
}

it("rolls an idle chat once, retaining old history and immutable placement", async () => {
  const f = fixture();
  createTask(f.db, { id: "done", runId: "old", kind: "bb", contract: {} });
  createAttempt(f.db, { id: "attempt", runId: "old", taskId: "done" });
  f.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='attempt'").run();
  await handleDirectoryMove(f.deps, f.input);
  f.attach();
  await handleDirectoryMove(f.deps, { ...f.input, phase: "commit" });
  await handleDirectoryMove(f.deps, { ...f.input, phase: "commit" });
  const next = claimNativeLaneRun({ db: f.db, threadId: "thread", projectId: "project" });
  expect(next.created).toBe(false);
  expect(getRun(f.db, next.runId)).toMatchObject({ writer_environment_id: "target", writer_workspace_path: "/target" });
  expect(getRun(f.db, "old")).toMatchObject({ state: "closed", writer_environment_id: "source", writer_workspace_path: "/source" });
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_run").get()).toEqual({ n: 2 });
  expect(f.db.prepare("SELECT task_id FROM lane_pilot_attempt WHERE id='attempt'").get()).toEqual({ task_id: "done" });
});

it("vetoes existing queued work before the caller may attach", async () => {
  const f = fixture();
  createTask(f.db, { id: "pending", runId: "old", kind: "bb", contract: {} });
  createAttempt(f.db, { id: "attempt", runId: "old", taskId: "pending" });
  await expect(handleDirectoryMove(f.deps, f.input)).rejects.toThrow(/active or queued/);
  expect(directoryMove(f.db, "thread")).toBeNull();
  expect(f.metadata).not.toHaveBeenCalled();
});

it("vetoes work preparing before it has a task, and blocks new admission until a failed attach aborts", async () => {
  const f = fixture();
  const release = beginRunAdmission(f.db, "old");
  await expect(handleDirectoryMove(f.deps, f.input)).rejects.toThrow(/preparing work/);
  release();
  await handleDirectoryMove(f.deps, f.input);
  expect(() => beginRunAdmission(f.db, "old")).toThrow(/move is pending/);
  expect(() => createTask(f.db, { id: "late", runId: "old", kind: "bb", contract: {} })).toThrow(/move is pending/);
  await handleDirectoryMove(f.deps, { ...f.input, phase: "abort" });
  const releaseAgain = beginRunAdmission(f.db, "old");
  releaseAgain();
  expect(getRun(f.db, "old")?.closed_at).toBeNull();
});

it("keeps a failed metadata attach fenced and recovers one new run on the next dispatch", async () => {
  const f = fixture();
  await handleDirectoryMove(f.deps, f.input);
  f.attach();
  f.metadata.mockRejectedValueOnce(new Error("metadata unavailable"));
  await expect(handleDirectoryMove(f.deps, { ...f.input, phase: "commit" })).rejects.toThrow(/metadata unavailable/);
  expect(directoryMove(f.db, "thread")?.newRunId).toBeTruthy();
  await expect(handleDirectoryMove(f.deps, { ...f.input, phase: "abort" })).rejects.toThrow(/cannot abort/);
  await recoverDirectoryMove(f.bb, f.db, "thread");
  expect(directoryMove(f.db, "thread")).toBeNull();
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_run").get()).toEqual({ n: 2 });
  expect(() => beginRunAdmission(f.db, "old")).toThrow(/closed/);
});

it("releases the fence on parked-work veto", async () => {
  const f = fixture();
  await expect(handleDirectoryMove({ ...f.deps, loadParked: async () => [{ runId: "old", pmThreadId: "thread" }] }, f.input)).rejects.toThrow(/parked work/);
  expect(directoryMove(f.db, "thread")).toBeNull();
});

it("the real writer handler holds admission across async checkout setup", async () => {
  const f = fixture();
  const { createWriterDispatch } = await import("../src/rooms/writer/server/services/dispatch");
  let entered!: () => void, rejectSetup!: (cause: Error) => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const setup = new Promise<void>((_, reject) => { rejectSetup = reject; });
  const bb = { ...f.bb, sdk: { ...f.bb.sdk, threads: { ...f.bb.sdk.threads, getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "old" }) } } };
  const writer = createWriterDispatch({ bb, db: f.db, ensureRunScopes: () => { entered(); return setup; } } as never, {} as never);
  const dispatched = writer.dispatchWriter({ threadId: "thread", projectId: "project" });
  const failed = expect(dispatched).rejects.toThrow("setup failed");
  await ready;
  await expect(handleDirectoryMove(f.deps, f.input)).rejects.toThrow(/preparing work/);
  rejectSetup(new Error("setup failed"));
  await failed;
  await handleDirectoryMove(f.deps, f.input);
  await expect(writer.dispatchWriter({ threadId: "thread", projectId: "project" })).rejects.toThrow(/move is pending/);
});

it("the real workflow handler holds admission while loading its workflow", async () => {
  const f = fixture();
  const { runWorkflowTool } = await import("../src/rooms/workflow/server/handlers/workflow-tools");
  let entered!: () => void, rejectStore!: (cause: Error) => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const store = new Promise<never>((_, reject) => { rejectStore = reject; });
  const deps = { db: f.db, store: () => { entered(); return store; } };
  const started = runWorkflowTool(deps as never, { workflowId: "test", inputs: {} }, { threadId: "thread", projectId: "project" });
  const failed = expect(started).rejects.toThrow("store failed");
  await ready;
  await expect(handleDirectoryMove(f.deps, f.input)).rejects.toThrow(/preparing work/);
  rejectStore(new Error("store failed"));
  await failed;
  await handleDirectoryMove(f.deps, f.input);
  await expect(runWorkflowTool(deps as never, { workflowId: "test", inputs: {} }, { threadId: "thread", projectId: "project" })).rejects.toThrow(/move is pending/);
});

it.each(["running", "waiting", "blocked", "interrupted"])("vetoes %s workflow work even on an older run of the chat", async (status) => {
  const f = fixture();
  f.db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,created_at,updated_at) VALUES ('wf','workflow',1,'hash','{}','project','old',?,1,1)").run(status);
  await expect(handleDirectoryMove(f.deps, f.input)).rejects.toThrow(/resumable workflow/);
  expect(directoryMove(f.db, "thread")).toBeNull();
});

it("vetoes a source path that differs from the immutable run binding", async () => {
  const f = fixture();
  await expect(handleDirectoryMove(f.deps, { ...f.input, source: { ...f.input.source, path: "/stale" } })).rejects.toThrow(/binding does not match/);
});

it("holds admission before the writer's first metadata await", async () => {
  const f = fixture();
  const { createWriterDispatch } = await import("../src/rooms/writer/server/services/dispatch");
  let rejectMetadata!: (cause: Error) => void;
  const metadata = new Promise<never>((_, reject) => { rejectMetadata = reject; });
  const bb = { ...f.bb, sdk: { ...f.bb.sdk, threads: { ...f.bb.sdk.threads, getPluginMetadata: () => metadata } } };
  const writer = createWriterDispatch({ bb, db: f.db } as never, {} as never);
  const dispatched = writer.dispatchWriter({ threadId: "thread", projectId: "project" });
  const failed = expect(dispatched).rejects.toThrow("metadata failed");
  await expect(handleDirectoryMove(f.deps, f.input)).rejects.toThrow(/preparing work/);
  rejectMetadata(new Error("metadata failed"));
  await failed;
});

it("shares admissions across connections and releases them after a process crash", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");
  const { default: Database } = await import("better-sqlite3");
  const f = fixture(), dir = await mkdtemp(join(tmpdir(), "lp-directory-admission-"));
  const file = join(dir, "test.sqlite");
  await f.db.backup(file);
  const first = new Database(file), second = new Database(file);
  try {
    const release = beginRunAdmission(first, "old");
    first.close();
    await expect(handleDirectoryMove({ ...f.deps, db: second }, f.input)).rejects.toThrow(/preparing work/);
    release();
    const moduleUrl = new URL("../src/rooms/storage/native-directory-guard.ts", import.meta.url).href;
    const script = `import Database from 'better-sqlite3'; import {beginRunAdmission} from ${JSON.stringify(moduleUrl)}; beginRunAdmission(new Database(${JSON.stringify(file)}),'old'); process.exit(17);`;
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(), stdio: "pipe" });
    let error = "";
    child.stderr.on("data", (chunk) => { error += String(chunk); });
    const code = await new Promise<number | null>((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
    expect(code, error).toBe(17);
    await expect(handleDirectoryMove({ ...f.deps, db: second }, f.input)).resolves.toEqual({ ok: true });
  } finally {
    if (first.open) first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("parking reserves admission before async state reads and cannot appear behind the move fence", async () => {
  const f = fixture();
  const { createStability } = await import("../src/rooms/stability/server");
  let rejectRead!: (cause: Error) => void;
  const read = new Promise<never>((_, reject) => { rejectRead = reject; });
  const bb = { ...f.bb, storage: { ...f.bb.storage, kv: { ...f.bb.storage.kv, get: () => read } } };
  const { stability } = createStability({ bb, db: f.db } as never, {} as never);
  const input = { projectId: "project", runId: "old", taskId: "task", pmThreadId: "thread", state: "blocked", reason: "ENOSPC: no space left on device" };
  const parked = stability.onTaskFailed(input);
  const failed = expect(parked).rejects.toThrow("read failed");
  await expect(handleDirectoryMove(f.deps, f.input)).rejects.toThrow(/preparing work/);
  rejectRead(new Error("read failed"));
  await failed;
  await handleDirectoryMove(f.deps, f.input);
  await expect(stability.onTaskFailed(input)).rejects.toThrow(/move is pending/);
});

it("waits for a canceled workflow's actual executor to settle before moving", async () => {
  const f = fixture();
  const { engineOn, wf, ok } = await import("./workflow/engine-helpers");
  const { installWorkflowAdmission } = await import("../src/rooms/workflow/server/services/workflow-admission");
  const engine = engineOn(f.db);
  const stopTracking = installWorkflowAdmission(f.db, engine);
  let entered!: () => void, finish!: () => void;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  engine.register("search", ok(async () => { entered(); await pending; return { items: [], count: 0, kind: "fresh" }; }));
  engine.register("write", ok(() => ({ text: "done" })));
  try {
    const run = engine.start({ workflow: wf(), inputs: { query: "q" }, link: { runId: "old", projectId: "project" } });
    await ready;
    expect(engine.cancel(run.runId)).toBe(true);
    expect(engine.get(run.runId)?.status).toBe("canceled");
    await expect(handleDirectoryMove(f.deps, f.input)).rejects.toThrow(/preparing work/);
    finish();
    await run.done;
    await expect(handleDirectoryMove(f.deps, f.input)).resolves.toEqual({ ok: true });
  } finally { finish(); await engine.idle(); engine.dispose(); stopTracking(); }
});

it("keeps a timed-out executor fenced even after the workflow drive has ended", async () => {
  const f = fixture();
  const { engineOn, wf, ok } = await import("./workflow/engine-helpers");
  const { installWorkflowAdmission } = await import("../src/rooms/workflow/server/services/workflow-admission");
  const engine = engineOn(f.db), stopTracking = installWorkflowAdmission(f.db, engine);
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => { finish = resolve; });
  engine.register("search", ok(async () => { await pending; return { items: [], count: 0, kind: "fresh" }; }));
  engine.register("write", ok(() => ({ text: "done" })));
  const workflow = wf();
  const search = workflow.nodes.find((node) => node.id === "search");
  if (search?.type !== "action") throw new Error("search action is missing");
  search.timeoutSec = 1;
  try {
    const run = engine.start({ workflow, inputs: { query: "q" }, link: { runId: "old", projectId: "project" } });
    expect((await run.done).status).toBe("failed");
    expect(engine.inFlight()).toEqual([]);
    await expect(handleDirectoryMove(f.deps, f.input)).rejects.toThrow(/preparing work/);
    finish();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(handleDirectoryMove(f.deps, f.input)).resolves.toEqual({ ok: true });
  } finally { finish(); await engine.idle(); engine.dispose(); stopTracking(); }
});
