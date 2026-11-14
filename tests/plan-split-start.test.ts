import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { noOptionalPlugins } from "./optional-plugin-stubs";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../server";
import { recordStage } from "../src/rooms/runs/server/stage-records";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, savePrototypeConfig, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt, updateTaskContract } from "../src/rooms/plugin-db";
import { upsertAttemptChange } from "../src/rooms/rollback/store";
import { runCommand } from "../src/rooms/host-worker/host-handlers";
import { createWriterStart } from "../src/rooms/writer/server/start";
import { checkDependencyBase } from "../src/rooms/writer/server/start-dependency-base";

// The owner's rule for a split plan (ТЗ sma-parity 4д) on the real writer start path: which tasks start, in what order, from which base.
// The base checkout is a real git repository: an accepted task commits its file into main (the merge), a started task gets a worktree
// cut from main's HEAD at that moment, and the start proves every dependency's merge is an ancestor of it.
const config = (workspace: string): PrototypeConfig => ({ projectId: "proj1", hostId: "h1", pmWorkspacePath: workspace, writerWorkspacePath: workspace, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" });
const contract = (workspace: string, id: string, dependsOn: string[] = []): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: workspace, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`${id}.md`], owns_paths: [`notes/${id}/`], never_touch: [], depends_on: dependsOn,
  objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "true", cwd: workspace }],
});

let scale: string | undefined;
beforeEach(() => { scale = process.env.LANE_PILOT_POLL_SCALE; process.env.LANE_PILOT_POLL_SCALE = "0.001"; });
afterEach(() => { if (scale === undefined) delete process.env.LANE_PILOT_POLL_SCALE; else process.env.LANE_PILOT_POLL_SCALE = scale; });

function world() {
  const repo = mkdtempSync(join(tmpdir(), "lp-plan-split-"));
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd, encoding: "utf8" }).trim();
  git(repo, "init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-q", "-m", "base");
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Record<string, unknown> }) => {
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      throw new Error(`unexpected host method ${call.method}`);
    }) as never,
  });
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle" }));
  harness.sdk.stub("threads.send", async () => undefined);
  harness.sdk.stub("threads.context", async () => ({ usage: null }));
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  const cfg = config(repo);
  createRun(db, "run1", "proj1", "bb", repo);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, cfg);
  /** What happened, in order: `start <task> base=<sha>` and `accept <task>` / `block <task>`. */
  const log: string[] = [];
  const bases = new Map<string, { base: string; missing: string[] }>();
  const finish = new Map<string, (outcome: "accepted" | "blocked") => void>();
  const attemptTask = new Map<string, string>();
  const svc = {
    activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins,
    runBudgetFor: () => ({ check: () => ({ ok: true }), noteAttempt: () => undefined, noteTokens: () => undefined, snapshot: () => ({ limits: {} }) }),
    runWriterPool: { acquire: async () => () => undefined },
    stability: { breakerHolds: () => null, diskHolds: async () => null, onTaskFailed: async () => false, loadParked: async () => [] },
    startAfterAcceptance: () => undefined,
    workspaceDirt: async () => ({ ok: true, paths: [], snapshots: [] }), isLiveFolder: async () => false,
    spawnWriterAttempt: async (input: { attemptId: string; taskId: string; task: TaskV2 }) => {
      // As createWorktree does: a worktree cut from the base checkout's HEAD now, then the dependency base proof of spawn.ts.
      const worktree = join(repo, "..", `${repo.split("/").at(-1)}-${input.attemptId}`);
      git(repo, "worktree", "add", "-q", "-b", `lane/${input.attemptId}`, worktree, "HEAD");
      const proof = await checkDependencyBase(ctx, { runId: "run1", hostId: "h1", workspacePath: worktree, dependsOn: input.task.depends_on }, () => undefined);
      bases.set(input.taskId, { base: git(worktree, "rev-parse", "HEAD"), missing: proof?.missing.map((merge) => merge.taskId) ?? ["unproven"] });
      log.push(`start ${input.taskId}`);
      setAttemptWorkspace(db, input.attemptId, { path: worktree, environmentId: null, decision: {} });
      transitionAttempt(db, input.attemptId, "spawn_requested");
      transitionAttempt(db, input.attemptId, "running", { threadId: `thr_${input.attemptId}` });
      return { ok: true, threadId: `thr_${input.attemptId}`, providerId: "p", model: "wm", dirtBefore: [], workspacePath: worktree };
    },
    finishWriterAttempt: async (input: { attemptId: string }) => {
      const outcome = await new Promise<"accepted" | "blocked">((resolve) => finish.set(input.attemptId, resolve));
      const taskId = attemptTask.get(input.attemptId)!;
      if (outcome === "blocked") {
        transitionAttempt(db, input.attemptId, "blocked", { reason: "validation_failed: the check is red" });
        log.push(`block ${taskId}`);
        return { status: "blocked", produced: [], verification: [] };
      }
      // The merge into main, then «accepted» (finish-merge.ts: accepted only after the merge).
      writeFileSync(join(repo, `${taskId}.md`), `${taskId}\n`);
      git(repo, "add", `${taskId}.md`); git(repo, "commit", "-q", "-m", `${taskId}\n\nLane-Pilot-Attempt: ${input.attemptId}`);
      upsertAttemptChange(db as never, { attemptId: input.attemptId, runId: "run1", taskId }, { outcome: "merged", mergeCommit: git(repo, "rev-parse", "HEAD") });
      transitionAttempt(db, input.attemptId, "accepted");
      log.push(`accept ${taskId}`);
      return { status: "accepted", produced: [`${taskId}.md`], verification: [] };
    },
  } as unknown as Services;
  Object.assign(svc, createWriterStart(ctx, svc));
  const dispatch = (id: string, dependsOn: string[] = []) => {
    const task = contract(repo, id, dependsOn);
    createTask(db, { id, runId: "run1", kind: "bb", contract: task });
    saveTaskPlan(db, id, `Plan for ${id}`);
    for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run1", taskId: id, stageId, state: "pending", input: `Plan for ${id}` });
    const attemptId = `${id}-a1`;
    attemptTask.set(attemptId, id);
    createAttempt(db, { id: attemptId, runId: "run1", taskId: id });
    svc.startWriterTask({ projectId: "proj1", runId: "run1", taskId: id, firstAttemptId: attemptId, pmThreadId: "thr_pm", config: cfg, task, plan: `Plan for ${id}` });
    return attemptId;
  };
  const end = async (id: string, outcome: "accepted" | "blocked") => {
    await vi.waitFor(() => expect(finish.has(`${id}-a1`)).toBe(true));
    finish.get(`${id}-a1`)!(outcome);
    await vi.waitFor(() => expect(log).toContain(`${outcome === "accepted" ? "accept" : "block"} ${id}`));
  };
  const started = () => log.filter((line) => line.startsWith("start ")).map((line) => line.slice(6));
  const waiting = (id: string) => listStageReceipts(db, "run1", id).find((row) => row.stageId === "writer-agent")?.reason ?? "";
  /** Lets the waits poll a few rounds, so a task that should not start has had the chance to. */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
  const mergeOf = (id: string) => git(repo, "log", "-1", "--format=%H", `--grep=Lane-Pilot-Attempt: ${id}-a1`);
  const isAncestor = (commit: string, of: string) => { try { git(repo, "merge-base", "--is-ancestor", commit, of); return true; } catch { return false; } };
  return { db, ctx, repo, git, dispatch, end, started, waiting, settle, bases, mergeOf, isAncestor, log };
}

describe("[sma:bf_waves] [sma:p4_deps] a split plan on the real start path", () => {
  it("parallel: two tasks with no link and no shared paths start together, neither waits", async () => {
    const w = world();
    w.dispatch("p-a");
    w.dispatch("p-b");
    await vi.waitFor(() => expect(w.started().sort()).toEqual(["p-a", "p-b"]));
    expect(w.waiting("p-a")).not.toContain("waiting for");
    expect(w.waiting("p-b")).not.toContain("waiting for");
  });

  it("sequence: b starts only after a is accepted, from a main that holds a's merge", async () => {
    const w = world();
    w.dispatch("s-a");
    w.dispatch("s-b", ["s-a"]);
    await vi.waitFor(() => expect(w.started()).toEqual(["s-a"]));
    await vi.waitFor(() => expect(w.waiting("s-b")).toContain("waiting for depends_on: s-a"));
    await w.settle();
    expect(w.started()).toEqual(["s-a"]);
    await w.end("s-a", "accepted");
    await vi.waitFor(() => expect(w.started()).toEqual(["s-a", "s-b"]));
    expect(w.log.indexOf("accept s-a")).toBeLessThan(w.log.indexOf("start s-b"));
    expect(w.isAncestor(w.mergeOf("s-a"), w.bases.get("s-b")!.base)).toBe(true);
    expect(w.bases.get("s-b")!.missing).toEqual([]);
  });

  it("diamond with a failed middle: dependents wait for the failed task and its redo, independents go on; every base holds its dependencies' merges", async () => {
    const w = world();
    // d-a; d-b, d-c after d-a; d-d after d-b and d-c; d-e alone; d-f after d-d.
    w.dispatch("d-a");
    w.dispatch("d-b", ["d-a"]);
    w.dispatch("d-c", ["d-a"]);
    w.dispatch("d-d", ["d-b", "d-c"]);
    w.dispatch("d-e");
    w.dispatch("d-f", ["d-d"]);
    await vi.waitFor(() => expect(w.started().sort()).toEqual(["d-a", "d-e"]));
    await w.settle();
    expect(w.started().sort()).toEqual(["d-a", "d-e"]);
    await w.end("d-a", "accepted");
    await vi.waitFor(() => expect(w.started().slice(2).sort()).toEqual(["d-b", "d-c"]));
    // d-c fails; d-b and the independent d-e are accepted without waiting for it.
    await w.end("d-c", "blocked");
    await w.end("d-b", "accepted");
    await w.end("d-e", "accepted");
    await vi.waitFor(() => expect(w.waiting("d-d")).toContain("d-c ended blocked or canceled"));
    await w.settle();
    expect(w.started()).not.toContain("d-d");
    expect(w.started()).not.toContain("d-f");
    // The PM sends the fixed d-c again: d-c.2 starts at once (its dependency d-a is accepted), and d-d only once it is accepted.
    w.dispatch("d-c.2", ["d-a"]);
    await vi.waitFor(() => expect(w.started()).toContain("d-c.2"));
    await w.settle();
    expect(w.started()).not.toContain("d-d");
    await w.end("d-c.2", "accepted");
    await vi.waitFor(() => expect(w.started()).toContain("d-d"));
    expect(w.started()).not.toContain("d-f");
    await w.end("d-d", "accepted");
    await vi.waitFor(() => expect(w.started()).toContain("d-f"));
    await w.end("d-f", "accepted");

    const at = (line: string) => w.log.indexOf(line);
    expect(at("start d-e")).toBeLessThan(at("accept d-a"));
    for (const id of ["d-b", "d-c"]) expect(at(`start ${id}`)).toBeGreaterThan(at("accept d-a"));
    expect(at("accept d-b")).toBeLessThan(at("accept d-c.2"));
    expect(at("start d-d")).toBeGreaterThan(Math.max(at("accept d-b"), at("accept d-c.2")));
    expect(at("start d-f")).toBeGreaterThan(at("accept d-d"));
    // Every worktree base holds the merges of its dependencies (by git, and as the start proved it).
    const deps: Record<string, string[]> = { "d-b": ["d-a"], "d-c": ["d-a"], "d-c.2": ["d-a"], "d-d": ["d-b", "d-c.2"], "d-f": ["d-d"] };
    for (const [id, names] of Object.entries(deps)) {
      for (const dep of names) expect(w.isAncestor(w.mergeOf(dep), w.bases.get(id)!.base), `${id} base holds ${dep}`).toBe(true);
      expect(w.bases.get(id)!.missing, id).toEqual([]);
    }
  }, 20_000);

  it("a dependency the PM adds while the task is queued counts (live zupo-cards-bot-flow): the wait reads the stored contract every poll", async () => {
    const w = world();
    w.dispatch("z-flow-a");
    w.dispatch("z-flow-b");
    w.dispatch("z-cards", ["z-flow-a"]);
    await vi.waitFor(() => expect(w.waiting("z-cards")).toContain("waiting for depends_on: z-flow-a"));
    // While z-cards is queued, lane_pilot_update_task adds z-flow-b to its depends_on.
    updateTaskContract(w.db, "z-cards", contract(w.repo, "z-cards", ["z-flow-a", "z-flow-b"]));
    await w.end("z-flow-a", "accepted");
    await vi.waitFor(() => expect(w.waiting("z-cards")).toContain("waiting for depends_on: z-flow-b"));
    await w.settle();
    // Before: it started 6 s after z-flow-a, on a base without z-flow-b.
    expect(w.started()).not.toContain("z-cards");
    await w.end("z-flow-b", "accepted");
    await vi.waitFor(() => expect(w.started()).toContain("z-cards"));
    expect(w.isAncestor(w.mergeOf("z-flow-b"), w.bases.get("z-cards")!.base)).toBe(true);
  });

  it("a dependency name resolves inside the task's own run: an accepted «T1» of an older run does not start a new plan's T2", async () => {
    const w = world();
    createRun(w.db, "run0", "proj1", "bb", w.repo);
    createTask(w.db, { id: "T1", runId: "run0", kind: "bb", contract: contract(w.repo, "T1") });
    createAttempt(w.db, { id: "T1-old", runId: "run0", taskId: "T1" });
    transitionAttempt(w.db, "T1-old", "spawn_requested");
    transitionAttempt(w.db, "T1-old", "running", { threadId: "thr_old" });
    transitionAttempt(w.db, "T1-old", "accepted");
    w.dispatch("T2", ["T1"]);
    await vi.waitFor(() => expect(w.waiting("T2")).toContain("waiting for depends_on: T1"));
    await w.settle();
    expect(w.started()).toEqual([]);
    // Task ids are unique across runs, so dispatch names this plan's T1 «T1.2» (freeTaskId); the run's «T1» follows it.
    w.dispatch("T1.2");
    await w.end("T1.2", "accepted");
    await vi.waitFor(() => expect(w.started()).toEqual(["T1.2", "T2"]));
    expect(w.isAncestor(w.mergeOf("T1.2"), w.bases.get("T2")!.base)).toBe(true);
  });

  it("the base proof names a dependency whose merge the worktree lacks (a worktree cut before the merge)", async () => {
    const w = world();
    const before = w.git(w.repo, "rev-parse", "HEAD");
    w.dispatch("b-a");
    await w.end("b-a", "accepted");
    const stale = join(w.repo, "..", `${w.repo.split("/").at(-1)}-stale`);
    w.git(w.repo, "worktree", "add", "-q", "-b", "lane/stale", stale, before);
    const proof = await checkDependencyBase(w.ctx, { runId: "run1", hostId: "h1", workspacePath: stale, dependsOn: ["b-a"] }, () => undefined);
    expect(proof?.head).toBe(before);
    expect(proof?.missing.map((merge) => merge.taskId)).toEqual(["b-a"]);
    // The same worktree brought up to main holds it.
    w.git(stale, "merge", "-q", "--ff-only", "main");
    expect((await checkDependencyBase(w.ctx, { runId: "run1", hostId: "h1", workspacePath: stale, dependsOn: ["b-a"] }, () => undefined))?.missing).toEqual([]);
  });
});
