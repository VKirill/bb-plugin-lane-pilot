// Region 1 batch h probe.  Every step below enters production consumers with a
// fake host and an isolated in-memory SQLite database; no hub or live scene is
// contacted.  The final line is deliberately one JSON object for the Python proof.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createWriterSpawn } from "../../../src/rooms/writer/server/spawn";
import { createWriterReassign, takeReassignRequest } from "../../../src/rooms/writer/server/reassign";
import { createAttempt, createRun, createTask, getAttempt, openDatabase, setRunThread, transitionAttempt } from "../../../src/rooms/plugin-db";
import { countChargedAttempts, endSpawnFailure } from "../../../src/rooms/storage";
import { failureClass } from "../../../src/rooms/contracts/failure-class";
import { parkForWriter } from "../../../src/rooms/writer/server/start-writer-holds";
import { walkWriterChain, type WriterHoldDeps } from "../../../src/rooms/writer/server/writer-hold";
import { startWorld, contract, config } from "../../../tests/sma/r01-world-a";
import { observeNeedsDecision, observeTestEditHold } from "../../../tests/sma/r01-world-d";

const out: Record<string, unknown> = {};
const step = async (id: string, run: () => unknown | Promise<unknown>) => {
  try { out[id] = await run(); } catch (error) { out[id] = { error: String((error as Error)?.stack ?? error).slice(0, 600) }; }
};

const task = (id: string) => contract(id, { project_cwd: "/repo", owns_paths: ["src/**"], expected_outputs: ["src/a.ts"], verification: [] });

async function spawnWorld() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "P", "cli", "/repo");
  setRunThread(db, "run1", "pm");
  createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: task("t1") });
  createAttempt(db, { id: "t1-a1", runId: "run1", taskId: "t1" });
  const seen: Array<[string, string | undefined, string | null | undefined]> = [];
  const live = { ...bb, sdk: { ...bb.sdk, projects: { get: async () => ({ sources: [] }) }, providers: {
    list: async () => [{ id: "codex", available: true, serviceTiers: [{ id: "default" }] }],
    models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] }),
  }, files: { read: async () => ({ content: null }) }, threads: {
    get: async () => ({ id: "pm", projectId: "P", parentThreadId: "root", sourceThreadId: "root", lifecycleOwnerThreadId: "root", status: "idle" }), getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "run1" }), stop: async () => ({}),
    spawn: async () => { const row = getAttempt(db, "t1-a1")!; seen.push(["at spawn", row.state, row.reason]); throw new Error("fetch failed"); },
  } } };
  const ctx = {
    bb: live, db,
    host: { call: async (method: string) => method === "runCommand" ? { hostId: "h", exitCode: 0, stdout: "[]", stderr: "" } : method === "gitCreateWorktree" ? { status: "ready", path: "/wt/a1/repo", branch: "lane/a1", reason: null } : {} },
    effectiveProjectSettings: async () => ({ values: { "memory.enabled": false, "adoc.040": "auto" } }),
  };
  const services = {
    providerBreaker: { decide: () => ({ allow: true }), releaseTrial: () => undefined }, ruleScan: { chainForRun: async () => [] },
    reconcileAttemptThread: async () => { const row = getAttempt(db, "t1-a1")!; seen.push(["at reconcile", row.state, row.reason]); return "thr_found"; },
  };
  return { db, harness, seen, writer: createWriterSpawn(ctx as never, services as never) };
}

async function familyWorld(priorReason: string, currentReason: string) {
  const w = startWorld({ finishes: [{ status: "validation_failed", reason: currentReason }] });
  // The prior family failure must reach the fingerprint branch, not the same
  // writer's feedback retry.  The real sticky dead marker is how production
  // represents an unusable writer thread.
  await w.bb.storage.kv.set("sticky-dead:thr_w", true as never);
  w.start("T1.2", {}, (db) => {
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: contract("T1") });
    createAttempt(db, { id: "T1-a1", runId: "run1", taskId: "T1" });
    transitionAttempt(db, "T1-a1", "spawn_requested");
    transitionAttempt(db, "T1-a1", "running", { threadId: "thr_old" });
    transitionAttempt(db, "T1-a1", "validation_failed", { reason: priorReason });
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !["blocked", "accepted"].includes(w.attempts("T1.2").at(-1)?.state ?? "")) await new Promise((resolve) => setTimeout(resolve, 25));
  const family = w.attempts("T1");
  const current = w.attempts("T1.2");
  await w.harness.lifecycle.dispose();
  return { family: family.map((row) => [row.attempt_no, row.state, row.reason]), current: current.slice(-1).map((row) => [row.attempt_no, row.state]), reason: current.at(-1)?.reason ?? null };
}

async function repeatedFamilyWorld() {
  const repeatedReason = "verification failed (npm test): repeated tree failure";
  const repeated = await familyWorld(repeatedReason, repeatedReason);
  const different = await familyWorld("verification failed (npm test): first fault", "verification failed (npm test): second fault");
  return { ...repeated, different };
}

async function repeatedOwnershipWorld() {
  const reason = "owns_paths: src/x.ts is outside the contract";
  return familyWorld(reason, reason);
}

async function main() {
  await step("n160", async () => {
    const w = await spawnWorld();
    const result = await w.writer.spawnWriterAttempt({ projectId: "P", runId: "run1", taskId: "t1", attemptId: "t1-a1", config, task: task("t1"), plan: "write", pmThreadId: "pm" });
    await w.harness.lifecycle.dispose();
    return { result: { ok: result.ok, threadId: result.ok ? result.threadId : null }, seen: w.seen };
  });

  await step("n172", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "P"); createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: task("t1") }); createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested"); transitionAttempt(db, "a1", "running", { threadId: "thr" });
    transitionAttempt(db, "a1", "validation_failed", { reason: "verification failed (npm test): boom", failureCode: "verification_failed", checkName: "npm test" } as never);
    const row = db.prepare("SELECT state, reason, failure_code AS failureCode, check_name AS checkName FROM lane_pilot_attempt WHERE id='a1'").get();
    await harness.lifecycle.dispose(); return row;
  });

  await step("n175", repeatedOwnershipWorld);

  await step("n185", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); const db = openDatabase(bb);
    createRun(db, "run1", "P"); createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: task("t1") }); createAttempt(db, { id: "t1-a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "t1-a1", "spawn_requested"); transitionAttempt(db, "t1-a1", "running", { threadId: "thr_old" });
    const stops: string[] = []; const store = new Map<string, unknown>();
    const reassign = createWriterReassign({ bb: { storage: { kv: { get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } } }, sdk: { threads: { stop: async ({ threadId }: { threadId: string }) => { stops.push(threadId); } } } }, db } as never);
    const done = await reassign.requestReassign({ projectId: "P", runId: "run1", taskId: "t1", providerId: "codex", model: "codex-test", reason: "use the narrower reading" });
    const request = await takeReassignRequest({ get: async (key: string) => store.get(key) ?? null, set: async (key: string, value: unknown) => { store.set(key, value); } } as never, "t1-a1");
    const row = db.prepare("SELECT state, cancel_code FROM lane_pilot_attempt WHERE id='t1-a1'").get(); await harness.lifecycle.dispose();
    return { done, row, request, stops };
  });

  await step("n201", async () => {
    // This is the real finish consumer and the real writer verifier.  The fake
    // host returns an environment-shaped check failure; no classification helper
    // is called directly by the probe.
    const { createWriterFinish } = await import("../../../src/rooms/writer/server/finish");
    const { createWriterVerify } = await import("../../../src/rooms/writer/server/verify");
    const { createCore } = await import("../../../src/rooms/core/server/core");
    const { stageHelperSettings } = await import("../../../src/rooms/settings/server/stage-settings");
    const { gateEventsForTask } = await import("../../../src/rooms/storage");
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); const db = openDatabase(bb);
    harness.sdk.stub("threads.get", async () => ({ id: "writer", status: "idle" }));
    harness.sdk.stub("threads.output", async () => ({ text: "done" }));
    harness.sdk.stub("threads.events.list", async () => []);
    harness.sdk.stub("files.read", async () => ({ content: "export const a = 1;\n" }));
    const envTask = { ...task("t1"), verification: [{ command: "check", cwd: "/repo" }] };
    createRun(db, "run", "P", "cli", "/repo"); createTask(db, { id: "t1", runId: "run", kind: "bb", contract: envTask }); createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo' WHERE id='a1'").run();
    transitionAttempt(db, "a1", "spawn_requested"); transitionAttempt(db, "a1", "running", { threadId: "writer" });
    const core = createCore(bb, db);
    const ctx = { ...core, host: { call: async (method: string) => method === "runCommand" ? { hostId: "h", exitCode: 0, stdout: "- 0", stderr: "" } : method === "runSandboxedCommand" ? { hostId: "h", exitCode: 1, stdout: "", stderr: "EACCES: permission denied, open '/cache'", backend: "linux-bubblewrap", workspacePath: "/repo" } : {} } };
    const verify = createWriterVerify(ctx as never, { runWriterPool: { acquire: async () => () => undefined }, workspaceDirt: async () => ({ ok: true, paths: ["src/a.ts"], snapshots: [{ path: "src/a.ts", sha256: "a".repeat(64) }] }) } as never);
    const finish = createWriterFinish(ctx as never, { stageHelperSettings, validateWriterResult: verify.validateWriterResult, workspaceDirt: async () => ({ ok: true, snapshots: [] }), runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }), activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined } } as never);
    const done = await finish.finishWriterAttempt({ projectId: "P", config: { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" }, task: envTask, runId: "run", taskId: "t1", attemptId: "a1", pmThreadId: "pm", writerThreadId: "writer", dirtBefore: [] } as never);
    const row = db.prepare("SELECT state, failure_code AS failureCode, check_name AS checkName FROM lane_pilot_attempt WHERE id='a1'").get();
    const gates = gateEventsForTask(db, "run", "t1"); await harness.lifecycle.dispose(); return { result: done, attempt: row, gates };
  });

  await step("n207", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); const db = openDatabase(bb);
    createRun(db, "run", "P"); createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task("t1") });
    createAttempt(db, { id: "busy", runId: "run", taskId: "t1" }); transitionAttempt(db, "busy", "spawn_requested"); endSpawnFailure(db, "busy", "writer_provider_unavailable:owner_present:claude-code");
    createAttempt(db, { id: "free", runId: "run", taskId: "t1" }); transitionAttempt(db, "free", "spawn_requested"); transitionAttempt(db, "free", "running", { threadId: "thr" });
    transitionAttempt(db, "free", "validation_failed", { threadId: "thr", reason: "verification failed (npm test): boom" });
    const busy = getAttempt(db, "busy")?.state; const free = countChargedAttempts(db, "run", "t1"); const state = getAttempt(db, "free")?.state; await harness.lifecycle.dispose();
    return { busy, free, state, class: failureClass("spawn_rejected", "writer_provider_unavailable:owner_present:claude-code") };
  });

  const holdDeps = (rows: Array<{ key: string; state: string; openedAt: number; failures: number }> = [], coreHosts: (id: string) => boolean = () => true): WriterHoldDeps => ({ breaker: { snapshot: () => rows }, presence: undefined, usage: { hold: async () => null }, coreHosts } as never);
  await step("n208", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); const db = openDatabase(bb); const now = 1799999700000;
    createRun(db, "run", "P", "bb", "/repo"); createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task("t1") }); createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const chain = [{ providerId: "p", model: "m1" }, { providerId: "q", model: "m2" }]; const walk = await walkWriterChain(chain, { hostId: "h", settings: {} }, holdDeps([
      { key: "p/m1", state: "open", openedAt: now, failures: 3 }, { key: "q/m2", state: "open", openedAt: now, failures: 3 },
    ]), now);
    await parkForWriter({ ctx: { db, bb, log: () => undefined } } as never, { last: {} } as never, { projectId: "P", runId: "run", taskId: "t1", pmThreadId: null, plan: "p" } as never, "a1", walk);
    const row = getAttempt(db, "a1")!; const wakeAt = (db.prepare("SELECT wake_at AS wakeAt FROM lane_pilot_attempt WHERE id='a1'").get() as { wakeAt: number | null }).wakeAt; await harness.lifecycle.dispose(); return { state: row.state, reason: row.reason, wakeAt };
  });

  await step("n217", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); const db = openDatabase(bb);
    createRun(db, "run", "P", "bb", "/repo"); createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task("t1") }); createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const chain = [{ providerId: "devin", model: "d1" }]; const walk = await walkWriterChain(chain, { hostId: "h", settings: {} }, holdDeps([], () => false));
    await parkForWriter({ ctx: { db, bb, log: () => undefined } } as never, { last: {} } as never, { projectId: "P", runId: "run", taskId: "t1", pmThreadId: null, plan: "p" } as never, "a1", walk);
    const row = getAttempt(db, "a1")!; const wakeAt = (db.prepare("SELECT wake_at AS wakeAt FROM lane_pilot_attempt WHERE id='a1'").get() as { wakeAt: number | null }).wakeAt; await harness.lifecycle.dispose(); return { state: row.state, reason: row.reason, wakeAt };
  });

  await step("n259", repeatedFamilyWorld);
  await step("n260", observeTestEditHold);
  await step("n270", observeNeedsDecision);
  console.log(JSON.stringify(out)); // guardian: allow
}

main().then(() => process.exit(0), (error) => { console.log(JSON.stringify({ fatal: String(error) })); process.exit(0); });
