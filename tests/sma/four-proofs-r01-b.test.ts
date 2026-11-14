// Region 1 · Task graph, batch b: the gates and admission nodes (ag_*, ap_*). Each test checks the result the card names.
import { join } from "node:path";
import { writeFile, rm } from "node:fs/promises";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { writerFallbackChain } from "@lane-pilot/models";
import type { TaskV2 } from "../../src/rooms/contracts";
import { taskV2Schema } from "../../src/rooms/contracts";
import { NO_CODE_KINDS } from "../../src/rooms/tasks/plan-fact";
import { needsPlanFact } from "../../src/rooms/phase/logic/waves";
import { classifyWriterOutput } from "../../src/rooms/tasks";
import { reopenWriterStages, recordStage } from "../../src/rooms/runs/server/stage-records";
import { createAttempt, createRun, createTask, getAttempt, listStageReceipts, openDatabase, setAttemptHolderThread, transitionAttempt, saveTaskPlan } from "../../src/rooms/plugin-db";
import { getAttemptChange } from "../../src/rooms/rollback/store";
import { createWorktree } from "../../src/rooms/verification/git-integrate";
import { parkForWriter } from "../../src/rooms/writer/server/start-writer-holds";
import { walkWriterChain, type WriterHoldDeps } from "../../src/rooms/writer/server/writer-hold";
import { world, HOST } from "../baseline/world";
import { countChargedAttempts, endSpawnFailure, gateEventsForTask } from "../../src/rooms/storage";
import { failureClass, FREE_CLASSES } from "../../src/rooms/contracts/failure-class";
import { admitTask } from "../../src/rooms/writer/server/start-admission";
import { createWriterFinish } from "../../src/rooms/writer/server/finish";
import { forgeToolParameters, mountForge } from "../../src/rooms/forge/server";
import { registeredTools } from "../../src/rooms/platform/server/tool-result";

const root = "/tmp/sma-r01-b";
const baseTask: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:sma", id: "sma-task", title: "SMA", risk: "low", lane: "writer", project_cwd: root,
  read_first: ["src/a.ts"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["src/b.ts"],
  owns_paths: ["src/"], never_touch: [".git/**"], depends_on: [], objective: "change a", acceptance: ["done"],
  verify: "tests", verification: [{ command: "npx vitest run tests/a.test.ts", cwd: root }],
};

describe("gates: what a finished attempt must show", () => {
  it("[sma:ag_answer_gate] a task whose product is a note (docs, research, check) does not owe a plan-fact table; a code task with acceptance does", () => {
    const item = (kind: string) => ({ task: { kind, acceptance: ["the finding is written down"] } }) as never;
    expect([...NO_CODE_KINDS].sort()).toEqual(["check", "docs", "research"]);
    expect(needsPlanFact(item("research"))).toBe(false);
    expect(needsPlanFact(item("check"))).toBe(false);
    expect(needsPlanFact(item("docs"))).toBe(false);
    expect(needsPlanFact(item("feature"))).toBe(true);
    expect(needsPlanFact(item("fix"))).toBe(true);
    expect(needsPlanFact({ task: { kind: "feature", acceptance: [] } } as never)).toBe(false);
  });

  it("[sma:ag_artifact] a stage execution that changed nothing and left none of its outputs is refused as empty; a partly met output list is a validation failure; an output read as nothing is missing", () => {
    const ok = classifyWriterOutput({ task: baseTask, produced: ["src/b.ts"], contents: { "src/b.ts": "export const n = 1;\n" }, verifies: [{ command: "npm test", exitCode: 0, stdout: "", stderr: "" }] });
    expect(ok).toEqual({ ok: true });
    const prose = { ...baseTask, expected_outputs: ["a short note"] };
    expect(classifyWriterOutput({ task: prose, produced: [], contents: {}, answered: true })).toMatchObject({ ok: false, state: "empty_output", reason: "writer answered but changed no files" });
    expect(classifyWriterOutput({ task: baseTask, produced: [], contents: {}, answered: true })).toMatchObject({ ok: false, state: "empty_output", reason: "missing expected_outputs: src/b.ts" });
    const wrongFile = classifyWriterOutput({ task: baseTask, produced: ["src/c.ts"], contents: { "src/c.ts": "x\n" }, verifies: [] });
    expect(wrongFile).toMatchObject({ ok: false, state: "empty_output", reason: "missing expected_outputs: src/b.ts" });
    const two = { ...baseTask, expected_outputs: ["src/b.ts", "src/d.ts"] };
    const partly = classifyWriterOutput({ task: two, produced: ["src/b.ts"], contents: { "src/b.ts": "x\n" }, verifies: [] });
    expect(partly).toMatchObject({ ok: false, state: "validation_failed", reason: "missing expected_outputs: src/d.ts" });
    const emptyRead = classifyWriterOutput({ task: baseTask, produced: ["src/b.ts", "src/e.ts"], contents: { "src/b.ts": null, "src/e.ts": "x\n" }, verifies: [] });
    expect(emptyRead).toMatchObject({ ok: false, state: "empty_output", reason: "missing expected_outputs: src/b.ts" });
  });

  it("[sma:ag_receiptless] a task that says verify none is accepted without a check; one that promised checks and listed none is told so", () => {
    const produced = { produced: ["src/b.ts"], contents: { "src/b.ts": "export const n = 1;\n" } };
    expect(classifyWriterOutput({ ...produced, task: { ...baseTask, verify: "none", verification: [] } })).toEqual({ ok: true });
    expect(classifyWriterOutput({ ...produced, task: { ...baseTask, verify: "tests", verification: [] } })).toEqual({ ok: false, state: "validation_failed", reason: "verify is set but verification[] is empty" });
  });

  it("[sma:ap_envelope] a contract without its ownership lists, or with an empty owns_paths, is refused; the full one is read", () => {
    expect(taskV2Schema.safeParse(baseTask).success).toBe(true);
    const { never_touch: _a, ...noNever } = baseTask;
    expect(taskV2Schema.safeParse(noNever).success).toBe(false);
    const { owns_paths: _b, ...noOwns } = baseTask;
    expect(taskV2Schema.safeParse(noOwns).success).toBe(false);
    expect(taskV2Schema.safeParse({ ...baseTask, owns_paths: [] }).success).toBe(false);
    expect(taskV2Schema.safeParse({ ...baseTask, owns_paths: [""] }).success).toBe(false);
    expect(taskV2Schema.safeParse({ ...baseTask, verify: "sometimes" }).success).toBe(false);
  });
});

describe("baseline: nothing to prove, and an already built answer", () => {
  const at = (input: ReturnType<Awaited<ReturnType<typeof world>>["pendingTask"]>, patch: Record<string, unknown>) => ({ ...input, task: { ...(input.task as object), ...patch } as never });
  const told = (w: Awaited<ReturnType<typeof world>>) => (w.send.mock.calls as unknown as Array<[{ input: Array<{ text: string }> }]>).map((call) => call[0].input[0]!.text);

  it("[sma:ag_moot] a fix whose only red check looks for a new file is not started, and the PM is told which checks prove nothing", async () => {
    const w = await world();
    const done = await w.services.baseline.preflight(at(w.pendingTask("fix2", ["test -f keep.txt", "test -f feature.txt"]), { risk: "low", kind: "fix" }));
    expect(done.alreadyDone).toBeUndefined();
    expect(done.stop).toMatch(/^verdict_block: no_red_on_base: /);
    expect(w.send).toHaveBeenCalledTimes(1);
    const text = told(w)[0]!;
    expect(text.startsWith("Lane Pilot: задача fix2 не запущена: все 2 проверок(и) задачи fix2 (риск low) уже проходят на базе")).toBe(true);
    expect(text).toContain("- test -f keep.txt\n- test -f feature.txt\n");
    expect(w.ran).toEqual(expect.arrayContaining(["test -f keep.txt", "test -f feature.txt"]));
    await w.dispose();
  });

  it("[sma:ap_already_built] a check task whose every check is green on the base closes without a writer and says «already done»; a feature of the same checks does not close", async () => {
    const w = await world();
    const done = await w.services.baseline.preflight(at(w.pendingTask("chk", ["test -f keep.txt"]), { risk: "low", kind: "check" }));
    expect(done.stop).toBeNull();
    expect(done.alreadyDone).toMatch(/^already done: /);
    expect(done.record).toMatchObject({ verdict: "already_built", action: "notified", state: "ran" });
    const feature = await w.services.baseline.preflight(at(w.pendingTask("feat", ["test -f keep.txt"]), { risk: "low", kind: "feature" }));
    expect(feature.alreadyDone).toBeUndefined();
    expect(feature.stop).toBeNull();
    expect(feature.record).toMatchObject({ verdict: "already_built", action: "notified" });
    await w.dispose();
  });

  it("[sma:ag_files] the changed-files list of an attempt's worktree, deletions and new files included, is written to its record", async () => {
    const w = await world();
    w.pendingTask("t1", ["test -f keep.txt"]);
    const made = await createWorktree({ basePath: w.base, name: "att_t1", targetPath: join(w.root, "wt", "att_t1", "project") });
    await writeFile(join(made.path!, "server.ts"), "line1\nchanged\nline3\n");
    await rm(join(made.path!, "keep.txt"));
    await writeFile(join(made.path!, "new.txt"), "new\n");
    const out = await w.services.rollback.noteWorktree({ attemptId: "att_t1", hostId: HOST, basePath: w.base, worktreePath: made.path!, outcome: "failed:blocked" });
    expect(out).toEqual({ recorded: true });
    const record = getAttemptChange(w.db, "att_t1")!;
    expect(record.outcome).toBe("failed:blocked");
    expect(record.baseSha).toBe(made.baseSha);
    expect([...record.changed].sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: "keep.txt", status: "D" }, { path: "new.txt", status: "A" }, { path: "server.ts", status: "M" },
    ]);
    // A worktree that is gone holds nothing: recorded, and the list is not invented.
    const gone = await w.services.rollback.noteWorktree({ attemptId: "att_t1", hostId: HOST, basePath: w.base, worktreePath: join(w.root, "no-such"), outcome: "failed:gone" });
    expect(gone).toEqual({ recorded: true });
    expect(getAttemptChange(w.db, "att_t1")!.changed).toHaveLength(3);
    await w.dispose();
  });
});

describe("attempt row and stages", () => {
  const fresh = () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1", "bb", root);
    for (const id of ["T1", "T2"]) createTask(db, { id, runId: "run1", kind: "bb", contract: {} });
    return { db, harness };
  };

  it("[sma:ap_number] the attempt number of a task only grows, whatever became of the earlier ones; another task counts from one", async () => {
    const { db, harness } = fresh();
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    transitionAttempt(db, "a1", "canceled", { reason: "stopped" });
    createAttempt(db, { id: "a2", runId: "run1", taskId: "T1" });
    transitionAttempt(db, "a2", "spawn_requested");
    transitionAttempt(db, "a2", "running", { threadId: "thr_w" });
    transitionAttempt(db, "a2", "validation_failed", { threadId: "thr_w", reason: "verification failed (npm test): boom" });
    createAttempt(db, { id: "a3", runId: "run1", taskId: "T1" });
    createAttempt(db, { id: "b1", runId: "run1", taskId: "T2" });
    expect(["a1", "a2", "a3", "b1"].map((id) => getAttempt(db, id)!.attempt_no)).toEqual([1, 2, 3, 1]);
    expect(getAttempt(db, "a3")!.state).toBe("queued");
    await harness.lifecycle.dispose();
  });

  it("[sma:ap_assign] the worker is written on the queued row once; a second writer, an empty id or a row that already started does not replace it", async () => {
    const { db, harness } = fresh();
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    const holder = (id: string) => (db.prepare("SELECT holder_thread_id AS h FROM lane_pilot_attempt WHERE id=?").get(id) as { h: string | null }).h;
    expect(setAttemptHolderThread(db, "a1", "thr_holder")).toBe(true);
    expect(holder("a1")).toBe("thr_holder");
    expect(setAttemptHolderThread(db, "a1", "thr_other")).toBe(false);
    expect(holder("a1")).toBe("thr_holder");
    expect(() => setAttemptHolderThread(db, "a1", "  ")).toThrow("holder thread id must be non-empty");
    createAttempt(db, { id: "a2", runId: "run1", taskId: "T2" });
    transitionAttempt(db, "a2", "spawn_requested");
    transitionAttempt(db, "a2", "running", { threadId: "thr_w" });
    expect(setAttemptHolderThread(db, "a2", "thr_late")).toBe(false);
    expect(holder("a2")).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("[sma:ap_step_reset] a task parked after a failed writer starts over at the writer stages; the receipts before the writer stay as they were", async () => {
    const { db, harness } = fresh();
    saveTaskPlan(db, "T1", "the plan");
    const stage = (stageId: string, ...states: string[]) => { for (const state of states) recordStage(db, { runId: "run1", taskId: "T1", stageId: stageId as never, state: state as never, input: "the plan", reason: state === "failed" ? "boom" : null }); };
    stage("pm-read", "running", "passed");
    stage("plan-critique", "running", "passed");
    stage("writer-agent", "running", "failed");
    stage("verification", "running", "blocked");
    stage("acceptance-receipt", "skipped");
    reopenWriterStages(db, "run1", "T1", "restart after a machine fault");
    const states = Object.fromEntries(listStageReceipts(db, "run1", "T1").map((row) => [row.stageId, row.state]));
    expect(states).toEqual({ "pm-read": "passed", "plan-critique": "passed", "writer-agent": "pending", "verification": "pending", "acceptance-receipt": "pending" });
    // A stage that already passed is not reopened.
    stage("writer-agent", "running", "passed");
    reopenWriterStages(db, "run1", "T1", "again");
    expect(listStageReceipts(db, "run1", "T1").find((row) => row.stageId === "writer-agent")!.state).toBe("passed");
    await harness.lifecycle.dispose();
  });
});

describe("the writer pool and the route", () => {
  const NOW = 1_800_000_000_000;
  const open = (providerId: string, model: string, openedAt: number) => ({ key: `${providerId}/${model}`, state: "open", openedAt, failures: 3 });
  const deps = (rows: ReturnType<typeof open>[] = []) => ({ breaker: { snapshot: () => rows }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true }) as unknown as WriterHoldDeps;

  it("[sma:ap_pool] the pool is the writer's fallbacks then the PM's model: none repeats the writer or another, and a slot with no provider is not in it", () => {
    const primary = { providerId: "p", model: "m1" };
    const fallbacks = [{ providerId: "p", model: "m1", reasoningLevel: "high" }, { providerId: "q", model: "m2", reasoningLevel: "high" }, { providerId: "", model: "x", reasoningLevel: "high" }, { providerId: "r", model: "m3", reasoningLevel: "low" }];
    expect(writerFallbackChain(primary, fallbacks, { providerId: "q", model: "m2" })).toEqual([
      { providerId: "q", model: "m2", reasoningLevel: "high", pm: false }, { providerId: "r", model: "m3", reasoningLevel: "low", pm: false },
    ]);
    expect(writerFallbackChain(primary, [], { providerId: "z", model: "m9" })).toEqual([{ providerId: "z", model: "m9", reasoningLevel: "", pm: true }]);
  });

  it("[sma:ap_route] the first member of the chain that no source holds takes the work, with its place; a held one before it is passed over", async () => {
    const chain = [{ providerId: "p", model: "m1" }, { providerId: "q", model: "m2" }, { providerId: "r", model: "m3" }];
    const all = await walkWriterChain(chain, { hostId: "h", settings: {} }, deps(), NOW);
    expect(all.free).toEqual({ member: chain[0], index: 0 });
    const walk = await walkWriterChain(chain, { hostId: "h", settings: {} }, deps([open("p", "m1", NOW)]), NOW);
    expect(walk.free).toEqual({ member: chain[1], index: 1 });
    expect(walk.holds.map((row) => row.member.providerId)).toEqual(["p"]);
    expect(walk.wakeAt).toBe(NOW + 300_000);
  });

  it("[sma:ap_no_route] when every writer is held the attempt stays queued with the shortest wait and its reason, the stage says why, and the task is not failed", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1", "bb", root);
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    const chain = [{ providerId: "p", model: "m1" }, { providerId: "q", model: "m2" }, { providerId: "r", model: "m3" }];
    const walk = await walkWriterChain(chain, { hostId: "h", settings: {} }, deps([open("p", "m1", NOW), open("q", "m2", NOW - 120_000), open("r", "m3", NOW)]), NOW);
    expect(walk.free).toBeUndefined();
    const state = { last: {} } as never as Parameters<typeof parkForWriter>[1];
    const ctx = { db, bb, log: () => undefined };
    const input = { projectId: "proj1", runId: "run1", taskId: "T1", pmThreadId: null, plan: "the plan" } as never;
    expect(await parkForWriter({ ctx } as never, state, input, "a1", walk)).toBe(true);
    const attempt = getAttempt(db, "a1")!;
    expect(attempt.state).toBe("queued");
    expect(attempt.reason).toBe(`waiting_writer:writer_provider_unavailable:breaker_open:q/m2: 3 provider failures`);
    const wake = (db.prepare("SELECT wake_at AS w FROM lane_pilot_attempt WHERE id='a1'").get() as { w: number }).w;
    expect(wake).toBe(NOW - 120_000 + 300_000);
    const receipt = listStageReceipts(db, "run1", "T1").find((row) => row.stageId === "writer-agent")!;
    expect(receipt.state).toBe("pending");
    expect(receipt.reason).toMatch(/^Ждёт писателя: провайдер q временно недоступен после сбоев, проверка через \d+ мин$/);
    expect((state as { last: { status?: string } }).last.status).toBe("queued");
    // No provider of the chain runs on this core: nothing to wait for, the attempt ends blocked.
    createAttempt(db, { id: "a2", runId: "run1", taskId: "T1" });
    const dead = await walkWriterChain(chain, { hostId: "h", settings: {} }, { ...deps(), coreHosts: () => false } as never, NOW);
    expect(dead.allUnsupported).toBe(true);
    expect(await parkForWriter({ ctx } as never, { last: {} } as never, input, "a2", dead)).toBe(true);
    expect(getAttempt(db, "a2")).toMatchObject({ state: "blocked", reason: "writer_provider_unavailable:core_unsupported:p" });
    await harness.lifecycle.dispose();
  });
});

describe("an attempt that stops at a door, a busy writer and a corrected contract", () => {
  const config = { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "codex", pmModel: "m", writerProviderId: "codex", writerModel: "m" };
  const repoTask: TaskV2 = { ...baseTask, id: "t1", project_cwd: "/repo", owns_paths: ["a.txt"], expected_outputs: ["a.txt"], verification: [] };

  it("[sma:ag_skip] a writer that stops to ask a person ends the attempt blocked, and the accept gate records «skipped» with the reason: no gate asked the work anything", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "cli", "/repo");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: repoTask });
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "writer-1" });
    const ctx = { state: { disposed: false }, bb: { storage: bb.storage, log: { warn() {}, error() {} }, sdk: { threads: { stop: async () => undefined, events: { list: async () => [] },
      get: async () => ({ status: "idle" }), output: async () => ({ text: "NEEDS_HUMAN: May I widen owns_paths?" }) }, files: { read: async () => ({ content: "x" }) } } },
      db, getThreadBounded: async () => ({ status: "idle" }), host: { call: async () => ({}) }, isDisposed: () => false, log: () => undefined };
    const finish = createWriterFinish(ctx as never, { validateWriterResult: async () => ({ status: "accepted" }), workspaceDirt: async () => ({ ok: true, snapshots: [] }), runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }) } as never);
    const result = await finish.finishWriterAttempt({ projectId: "P", config: config as never, task: repoTask, runId: "run", taskId: "t1", attemptId: "a1", pmThreadId: "pm", writerThreadId: "writer-1", dirtBefore: [] });
    expect(result).toMatchObject({ status: "blocked", reason: "needs_human: May I widen owns_paths?" });
    expect(gateEventsForTask(db, "run", "t1").map((row) => [row.gate, row.status])).toEqual([["accept", "skipped"]]);
    expect(getAttempt(db, "a1")).toMatchObject({ state: "blocked", barrier: { gate: "accept", status: "skipped", reason: "needs_human" } });
    await harness.lifecycle.dispose();
  });

  it("[sma:ap_route_race] an attempt the spawn gate turned away because the writer's provider got busy is not charged against the task; a failed product is", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "bb", "/repo");
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: repoTask });
    for (const [id, reason] of [["busy", "writer_provider_unavailable:owner_present:claude-code"], ["breaker", "writer_provider_unavailable:breaker_open:codex/m: 3 provider failures"]] as const) {
      createAttempt(db, { id, runId: "run", taskId: "t1" });
      transitionAttempt(db, id, "spawn_requested");
      expect(endSpawnFailure(db, id, reason)).toBe("spawn_rejected");
      expect(failureClass("spawn_rejected", reason)).toBe("limit");
    }
    expect(FREE_CLASSES.has("limit")).toBe(true);
    expect(getAttempt(db, "busy")).toMatchObject({ state: "spawn_rejected", reason: "writer_provider_unavailable:owner_present:claude-code" });
    expect(countChargedAttempts(db, "run", "t1")).toBe(0);
    createAttempt(db, { id: "real", runId: "run", taskId: "t1" });
    transitionAttempt(db, "real", "spawn_requested");
    transitionAttempt(db, "real", "running", { threadId: "thr_real" });
    transitionAttempt(db, "real", "validation_failed", { threadId: "thr_real", reason: "verification failed (npm test): boom" });
    expect(countChargedAttempts(db, "run", "t1")).toBe(1);
    await harness.lifecycle.dispose();
  });

  it("[sma:ap_executor] a chain of writers none of which this core can run does not start: the attempt ends blocked with the provider named, and nothing waits", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "proj1", "bb", root);
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    const chain = [{ providerId: "devin", model: "d1" }, { providerId: "devin", model: "d2" }];
    const deps = { breaker: { snapshot: () => [] }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => false } as unknown as WriterHoldDeps;
    const walk = await walkWriterChain(chain, { hostId: "h", settings: {} }, deps);
    expect(walk).toMatchObject({ free: undefined, allUnsupported: true, wakeAt: null });
    const state = { last: {} } as never as Parameters<typeof parkForWriter>[1];
    expect(await parkForWriter({ ctx: { db, bb, log: () => undefined } } as never, state, { projectId: "proj1", runId: "run1", taskId: "T1", pmThreadId: null, plan: "p" } as never, "a1", walk)).toBe(true);
    expect(getAttempt(db, "a1")).toMatchObject({ state: "blocked", reason: "writer_provider_unavailable:core_unsupported:devin" });
    expect((state as { last: unknown }).last).toEqual({ status: "blocked", reason: "writer_provider_unavailable:core_unsupported:devin", attemptId: "a1" });
    const ok = await walkWriterChain([...chain, { providerId: "codex", model: "c1" }], { hostId: "h", settings: {} }, { ...deps, coreHosts: (id: string) => id === "codex" } as never);
    expect(ok.free).toEqual({ member: { providerId: "codex", model: "c1" }, index: 2 });
    await harness.lifecycle.dispose();
  });

  it("[sma:ap_promise_refresh] a task the PM corrected while it waited starts from the stored contract and plan, not the ones it was sent with; a canceled attempt does not start", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "bb", "/repo");
    const stored = { ...repoTask, promise: { given: "a file", when: "it is saved", then: "the new text shows" } };
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: stored });
    saveTaskPlan(db, "t1", "the corrected plan");
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const canceled: string[] = [];
    const deps = { admitted: new Map(), ctx: { db, markCanceledWriterStages: (row: { id: string }) => { canceled.push(row.id); }, refreshRun: () => undefined } };
    const input = { projectId: "P", runId: "run", taskId: "t1", task: { ...repoTask, objective: "the old objective" }, plan: "the old plan", config } as never as Parameters<typeof admitTask>[2];
    const state = { key: "run:t1", attemptId: "a1", writerThreadId: undefined, activeTask: undefined } as never as Parameters<typeof admitTask>[1];
    expect(await admitTask(deps as never, state, input)).toBe(true);
    expect((input as { plan: string }).plan).toBe("the corrected plan");
    expect((input as { task: TaskV2 }).task).toMatchObject({ objective: "change a", promise: stored.promise, project_cwd: "/repo" });
    expect(listStageReceipts(db, "run", "t1").find((row) => row.stageId === "writer-agent")).toMatchObject({ state: "running" });
    // A reopened turn of a live writer keeps the contract it started with.
    const reopened = { projectId: "P", runId: "run", taskId: "t1", task: { ...repoTask, objective: "kept" }, plan: "kept plan", config } as never as Parameters<typeof admitTask>[2];
    await admitTask(deps as never, { key: "run:t1", attemptId: "a1", writerThreadId: "thr_w" } as never, reopened);
    expect((reopened as { plan: string }).plan).toBe("kept plan");
    transitionAttempt(db, "a1", "canceled", { reason: "stopped" });
    expect(await admitTask(deps as never, { key: "run:t1", attemptId: "a1" } as never, input)).toBe(false);
    expect(canceled).toEqual(["a1"]);
    await harness.lifecycle.dispose();
  });

  it("[sma:ap_forge] the forge sends the Creator as a writer task that owns exactly the one draft folder, expects exactly the one draft file and is checked by the forge lint", async () => {
    const { bb: fake } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(fake);
    createRun(db, "runA", "projA", "bb", "/ws", "none", undefined, "host-1");
    const sent: Array<{ task: Record<string, unknown> }> = [];
    const agents = { registerTool: () => undefined };
    const bb = { agents, storage: { kv: { get: async () => undefined, set: async () => undefined } }, sdk: { threads: { getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "runA" }) } },
      hosts: { experimental_client: () => ({ call: async () => ({ status: "applied" }) }) } };
    mountForge({ db, bb } as never, { dispatchWriter: (async (call: { task: Record<string, unknown> }) => { sent.push(call); return { ok: true }; }) as never, readWriterWorkspaceFile: (async () => ({ content: "" })) as never });
    const tool = registeredTools(agents).get("lane_pilot_forge")!;
    await tool.execute(forgeToolParameters.parse({ action: "draft", kind: "role", name: "fixer", brief: "Fixes one failing check and reports what changed." }) as never, { threadId: "thr_pm", projectId: "projA" } as never);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.task).toMatchObject({
      id: "forge-role-fixer", kind: "docs", owns_paths: [".agents/forge/roles/fixer/"], expected_outputs: [".agents/forge/roles/fixer/fixer.md"], never_touch: [".claude/", ".lane-pilot/"],
      verification: [{ command: "bb lane-pilot forge-lint role fixer .agents/forge/roles/fixer/fixer.md", cwd: "/ws", timeout_sec: 60 }],
    });
  });
});
