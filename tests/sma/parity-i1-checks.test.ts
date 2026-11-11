import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import {
  createAttempt, createRun, createTask, getTask, openDatabase, setTaskClosedWords, clearTaskClosedWords,
  setTaskHeldUntil, updateTaskContract, updateTaskContractJson, taskHeldUntil, transitionAttempt,
} from "../../src/rooms/plugin-db";
import { saveProjectSetting } from "../../src/rooms/storage/settings-store";
import { checkMeasureOf } from "../../src/rooms/tasks/server/conversation-tools";
import { getAttemptChange, upsertAttemptChange, type LandingSuite } from "../../src/rooms/rollback/store";
import { createRollback } from "../../src/rooms/rollback/server";
import { registeredTools } from "../../src/rooms/platform/server";
import { registerConversationTools } from "../../src/rooms/tasks/server/conversation-tools";

function db0() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { bb, db: openDatabase(bb) };
}

const taskSeq = (db: ReturnType<typeof db0>["db"], id: string): number | null =>
  (db.prepare("SELECT world_seq FROM lane_pilot_task WHERE id=?").get(id) as { world_seq: number | null }).world_seq;
const attemptSeq = (db: ReturnType<typeof db0>["db"], id: string): number | null =>
  (db.prepare("SELECT world_seq FROM lane_pilot_attempt WHERE id=?").get(id) as { world_seq: number | null }).world_seq;
const journal = (db: ReturnType<typeof db0>["db"], id: string) =>
  db.prepare("SELECT field FROM lane_pilot_task_transition WHERE task_id=? ORDER BY rowid").all(id) as Array<{ field: string }>;

describe("[sma:m_wrappers] task and hold writes sit in the same frame as attempt writes", () => {
  it("every task-row write lands its write, a journal row and one shared world counter in a single transaction", () => {
    const { db } = db0();
    createRun(db, "run_p", "proj_p", "bb", "/w");
    createTask(db, { id: "t1", runId: "run_p", kind: "bb", contract: { schema_version: 2 } });
    createAttempt(db, { id: "a1", runId: "run_p", taskId: "t1" });
    expect(journal(db, "t1").map((row) => row.field)).toEqual(["created"]);
    expect(taskSeq(db, "t1")).not.toBeNull();
    // Contract, held_until and closed_words: each write is framed.
    updateTaskContract(db, "t1", { schema_version: 2, v: 1 });
    setTaskHeldUntil(db, "t1", "run_p", 12345);
    expect(taskHeldUntil(db, "t1")).toBe(12345);
    setTaskClosedWords(db, "t1", "done enough");
    clearTaskClosedWords(db, "t1");
    updateTaskContractJson(db, "t1", "run_p", "{\"schema_version\":2,\"v\":2}");
    expect(journal(db, "t1").map((row) => row.field)).toEqual(["created", "contract_json", "held_until", "closed_words", "closed_words", "contract_json"]);
    // The counter is one domain: a task write climbs past an attempt's, and a later attempt transition past it.
    transitionAttempt(db, "a1", "spawn_requested", { reason: "work" });
    const seqAfterAttempt = taskSeq(db, "t1")!;
    expect(seqAfterAttempt).toBeLessThan(attemptSeq(db, "a1")!);
    setTaskHeldUntil(db, "t1", "run_p", null);
    expect(taskSeq(db, "t1")).toBeGreaterThan(attemptSeq(db, "a1")!);
    // A write that hits no row is not journaled and does not spend the counter.
    setTaskHeldUntil(db, "other", "run_p", 5);
    expect(journal(db, "other")).toEqual([]);
    expect(getTask(db, "t1")).toBeTruthy();
  });
});

const result = (rootsManifest?: { before: string; after: string; changed: boolean; partial?: boolean }) =>
  ({ exitCode: 0, stdout: "ok", stderr: "", backend: "linux-bubblewrap", policySha256: "p", rootsManifest });

describe("[sma:m_ck_required] every check measure names the five required measures", () => {
  it("recipe, copy, cleared env, closed publication and the roots manifest are on the record", () => {
    const measure = checkMeasureOf({ command: "npm test", cwd: "/w", expectExit: 0, timeoutSec: 60, throwaway: true, recipe: "quick", copy: "worktree", result: result() });
    expect(measure).toMatchObject({ env: "cleared", publication: "closed", recipe: "quick", copy: "worktree", passed: true });
    // A live-checkout fallback says `none: <reason>` instead of pretending a copy.
    const live = checkMeasureOf({ command: "npm test", cwd: "/w", expectExit: 0, timeoutSec: 60, throwaway: false, copy: "none: verification.copy=off", result: result() });
    expect(live.copy).toBe("none: verification.copy=off");
    expect(live.passed).toBe(true);
  });
});

describe("[sma:m_ck_isolated] a changed protected root fails only in a throwaway copy", () => {
  const changed = { before: "a", after: "b", changed: true };
  it("throwaway: the measure fails even when the command's exit matched", () => {
    const measure = checkMeasureOf({ command: "git config x", cwd: "/w", expectExit: 0, timeoutSec: 60, throwaway: true, result: result(changed) });
    expect(measure.passed).toBe(false);
    expect(measure.rootsChanged).toBe(true);
    expect(measure.evidence).toContain("protected roots");
  });
  it("live checkout: the change is recorded, never a failure; a partial manifest never counts", () => {
    const live = checkMeasureOf({ command: "git config x", cwd: "/w", expectExit: 0, timeoutSec: 60, throwaway: false, result: result(changed) });
    expect(live.passed).toBe(true);
    expect(live.rootsChanged).toBe(true);
    const partial = checkMeasureOf({ command: "x", cwd: "/w", expectExit: 0, timeoutSec: 60, throwaway: true, result: result({ ...changed, partial: true }) });
    expect(partial.passed).toBe(true);
    expect(partial.rootsPartial).toBe(true);
  });
});

/** The landing sweep with a stand-in host and a scripted check runner (the shape the h2 tests use). */
function sweepWorld(verdict: (task: { verification: Array<{ command: string }> }) => Array<{ command: string; exitCode: number; stdout: string; stderr: string; hostError?: true }>) {
  const { bb, db } = db0();
  const gateRuns: Array<{ command: string; basePath: string }> = [];
  const host = { call: async (method: string, input: { command?: string; basePath?: string }) => {
    if (method === "gitCreateWorktree") return { hostId: "h", status: "ready", path: "/tmp/lp-suite-i1" };
    if (method === "gateRun") { gateRuns.push({ command: input.command!, basePath: input.basePath! }); return { hostId: "h", exitCode: input.command!.includes("fail") ? 1 : 0, stdout: "", stderr: "", head: null }; }
    return { hostId: "h" };
  } };
  const ctx = { bb, db, host, log: () => undefined, isDisposed: () => false,
    configForRun: async (projectId: string) => ({ projectId, hostId: "h", writerWorkspacePath: "/w" }) };
  const services = { runVerification: async (_config: unknown, task: { verification: Array<{ command: string }> }) => verdict(task) };
  const { rollback } = createRollback(ctx as never, services as never);
  createRun(db, "run_l", "proj_l", "bb", "/w", "none", undefined, "h");
  let n = 0;
  const land = (at: number, checks = true) => {
    const id = `l${++n}`;
    createTask(db, { id: `task_${id}`, runId: "run_l", kind: "bb", contract: {
      schema_version: 2, id: `task_${id}`, title: id, risk: "low", lane: "server", project_cwd: "/w", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
      expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: id, acceptance: ["done"], verify: "tests",
      verification: checks ? [{ command: "npm test", cwd: "/w" }] : [] } });
    createAttempt(db, { id: `att_${id}`, runId: "run_l", taskId: `task_${id}` });
    upsertAttemptChange(db, { attemptId: `att_${id}`, runId: "run_l", taskId: `task_${id}` }, { outcome: "merged", mergeCommit: id.padEnd(40, "0") }, at);
    return `att_${id}`;
  };
  const suiteOf = (attemptId: string): LandingSuite | null => getAttemptChange(db, attemptId)!.suite;
  const items = () => (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_owner_item").get() as { n: number }).n;
  return { db, rollback, gateRuns, land, suiteOf, items };
}
const GREEN = (task: { verification: Array<{ command: string }> }) => task.verification.map((c) => ({ command: c.command, exitCode: 0, stdout: "ok", stderr: "" }));

describe("[sma:k_lib_landing] the landing sweep runs the project's named suite, unset means not named", () => {
  it("unset: the record says not named and no gate is run; named green: recorded, never blocking", async () => {
    const w = sweepWorld(GREEN);
    await w.rollback.landingSuite();
    const id = w.land(Date.now() + 5_000);
    expect(await w.rollback.landingSuite()).toBe(1);
    expect(w.suiteOf(id)).toMatchObject({ suite: "green", projectSuite: { command: null, state: "not named" } });
    expect(w.gateRuns).toEqual([]);
    saveProjectSetting(w.db, "proj_l", "verification.project_suite", "npm run suite");
    const id2 = w.land(Date.now() + 6_000);
    expect(await w.rollback.landingSuite()).toBe(1);
    expect(w.gateRuns).toEqual([{ command: "npm run suite", basePath: "/tmp/lp-suite-i1" }]);
    expect(w.suiteOf(id2)).toMatchObject({ suite: "green", projectSuite: { command: "npm run suite", state: "green", exitCode: 0 } });
    expect(w.items()).toBe(0);
  });

  it("a red project suite is the same owner item as a red check; the merge row keeps its verdict", async () => {
    const w = sweepWorld(GREEN);
    saveProjectSetting(w.db, "proj_l", "verification.project_suite", "npm run suite:fail");
    await w.rollback.landingSuite();
    const id = w.land(Date.now() + 5_000);
    expect(await w.rollback.landingSuite()).toBe(1);
    expect(w.suiteOf(id)).toMatchObject({ suite: "red", projectSuite: { command: "npm run suite:fail", state: "red", exitCode: 1 } });
    expect((w.db.prepare("SELECT key FROM lane_pilot_owner_item").get() as { key: string }).key).toBe(`landing-suite:${id}`);
    expect(w.items()).toBe(1);
  });
});

describe("[sma:k_lib_landing] a named suite runs for a landing whose contract names no checks", () => {
  it("no checks and no suite: none; no checks and a named suite: the suite runs and its verdict is the landing's", async () => {
    const w = sweepWorld(GREEN);
    const bare = w.land(Date.now() + 5_000, false);
    await w.rollback.landingSuite();
    expect(w.suiteOf(bare)).toMatchObject({ suite: "none" });
    expect(w.gateRuns).toEqual([]);
    saveProjectSetting(w.db, "proj_l", "verification.project_suite", "npm run fail-suite");
    const id = w.land(Date.now() + 6_000, false);
    await w.rollback.landingSuite();
    expect(w.gateRuns).toEqual([{ command: "npm run fail-suite", basePath: "/tmp/lp-suite-i1" }]);
    expect(w.suiteOf(id)).toMatchObject({ suite: "red", red: ["npm run fail-suite"], projectSuite: { state: "red", exitCode: 1 } });
  });
});

/** The chat check with a scripted host: `status` is what `git status --porcelain` prints in the workspace. */
function checkWorld(opts: { status?: string; prepare?: "fail"; createGate?: Promise<void> } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run_c" }));
  const calls: Array<{ method: string; cwd?: string }> = [];
  const host = { call: async (method: string, input: { cwd?: string; command?: string }) => {
    calls.push({ method, cwd: input.cwd });
    if (method === "runCommand") return { hostId: "h", exitCode: 0, stdout: opts.status ?? "", stderr: "" };
    if (method === "gitCreateWorktree") { await opts.createGate; return { hostId: "h", status: "ready", path: "/tmp/lp-check-copy" }; }
    if (method === "gitPrepareWorktree") { if (opts.prepare === "fail") throw new Error("no node_modules in the base"); return { hostId: "h" }; }
    if (method === "runSandboxedCommand") return { hostId: "h", exitCode: 0, stdout: "ok", stderr: "" };
    return { hostId: "h" };
  } };
  const db = openDatabase(bb);
  createRun(db, "run_c", "proj_c", "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "h");
  registerConversationTools({ db, bb, host, log: () => undefined } as never, { spendByModel: () => [] } as never);
  const check = registeredTools(bb.agents).get("lane_pilot_check")!;
  const run = async (signal: AbortSignal = new AbortController().signal) => {
    const text: unknown = await check.execute(
      { action: "run", request: "run the tests", commands: [{ command: "npm test", cwd: ".", timeoutSec: 30, expectExit: 0 }] },
      { threadId: "thr_c", projectId: "proj_c", signal } as never);
    return JSON.parse(String(text)) as { state: string; deduplicated?: boolean; measures: Array<{ copy?: string; cwd?: string }> };
  };
  const made = (method: string) => calls.filter((call) => call.method === method);
  return { run, made };
}

describe("[sma:m_ck_isolated] the chat check's copy holds the code being checked, and a stop or a repeat finds it", () => {
  it("a clean workspace is checked in a throwaway copy that is removed afterwards", async () => {
    const w = checkWorld();
    const done = await w.run();
    expect(done.measures[0]).toMatchObject({ copy: "worktree", cwd: "/tmp/lp-check-copy" });
    expect(w.made("gitCreateWorktree")).toHaveLength(1);
    expect(w.made("gitRemoveWorktree")).toHaveLength(1);
  });

  it("uncommitted changes: no copy of HEAD is made, the workspace is checked where it stands and the measure says why", async () => {
    const w = checkWorld({ status: " M src/a.ts\n?? src/new.ts\n" });
    const done = await w.run();
    expect(w.made("gitCreateWorktree")).toHaveLength(0);
    expect(done.measures[0]!.cwd).toBe("/ws");
    expect(done.measures[0]!.copy).toMatch(/^none: 2 uncommitted file/);
  });

  it("dependencies that could not be linked into the copy are named on the measure", async () => {
    const w = checkWorld({ prepare: "fail" });
    const done = await w.run();
    expect(done.measures[0]!.copy).toBe("worktree (dependencies not prepared: no node_modules in the base)");
  });

  it("a turn stopped while the copy is being made runs no command, and the copy is removed", async () => {
    let open!: () => void;
    const w = checkWorld({ createGate: new Promise<void>((wake) => { open = wake; }) });
    const turn = new AbortController();
    const pending = w.run(turn.signal);
    await new Promise((wake) => setTimeout(wake, 20));
    turn.abort();
    open();
    const done = await pending;
    expect(done.state).toBe("stopped_by_turn_stop");
    expect(w.made("runSandboxedCommand")).toHaveLength(0);
    expect(w.made("gitRemoveWorktree")).toHaveLength(1);
  });

  it("the same request repeated while the copy is being made gets the running receipt, not a second copy", async () => {
    let open!: () => void;
    const w = checkWorld({ createGate: new Promise<void>((wake) => { open = wake; }) });
    const first = w.run();
    await new Promise((wake) => setTimeout(wake, 20));
    const second = await w.run();
    expect(second).toMatchObject({ state: "running", deduplicated: true });
    open();
    expect((await first).state).toBe("passed");
    expect(w.made("gitCreateWorktree")).toHaveLength(1);
  });
});
