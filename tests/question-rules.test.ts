import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import type { TaskV2 } from "../src/rooms/contracts";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../server";
import { insertBaseline } from "../src/rooms/baseline/store";
import { criticLevel, pathsWidenedOf } from "../src/rooms/critique/critic-level";
import { isTaskSatisfied } from "../src/rooms/runs/server";
import { countChargedAttempts, createAttempt, createRun, createTask, getAttempt, getTask, openDatabase, savePrototypeConfig, saveTaskPlan, setRunThread } from "../src/rooms/plugin-db";
import { listReturns } from "../src/rooms/stage-return";
import { createWriterQuestionTimeout } from "../src/rooms/writer/server/question-timeout";
import { needsHumanQuestion } from "../src/rooms/writer/server/writer-task";
import type { Consult } from "../src/rooms/writer/server/second-pilot";
import { recordStage } from "../src/rooms/runs/server/stage-records";

const WORKSPACE = "/ws";
const T0 = 1_800_000_000_000;

const task: TaskV2 = {
  schema_version: 2, id: "T1", title: "Add the fixture", risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["a.txt"], owns_paths: ["a.txt", "b/**"], never_touch: ["secrets/**"], depends_on: [], objective: "Make a.txt and b/c.txt", acceptance: ["a.txt exists", "tests/pin.test.ts pins the old version and must change"], verify: "tests",
  verification: [{ command: "npm test", cwd: WORKSPACE }],
};

function world(question: string, options: { contract?: Partial<TaskV2>; otherTask?: Partial<TaskV2> } = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sends: Array<{ threadId: string; input: Array<{ text: string }> }> = [];
  harness.sdk.stub("threads.get", async (args: { threadId: string }) => ({ id: args.threadId, status: "idle", updatedAt: 0 }));
  harness.sdk.stub("threads.send", async (args: unknown) => { sends.push(args as never); return undefined; });
  harness.sdk.stub("threads.events.list", async () => []);
  harness.sdk.stub("files.read", async () => { throw new Error("file does not exist"); });
  harness.sdk.stub("files.write", async () => undefined);
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WORKSPACE);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, { projectId: "proj1", hostId: "h1", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" });
  createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: { ...task, ...options.contract } });
  saveTaskPlan(db, "T1", "Plan for T1");
  createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
  db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason=?, thread_id='thr_w', workspace_path='/ws/worktrees/a1', updated_at=? WHERE id='a1'").run(`needs_human: ${question}`, T0);
  for (const stageId of ["writer-agent", "verification", "acceptance-receipt"] as const) recordStage(db, { runId: "run1", taskId: "T1", stageId, state: "failed", input: "Plan for T1", reason: question });
  if (options.otherTask) {
    createTask(db, { id: "T2", runId: "run1", kind: "bb", contract: { ...task, id: "T2", owns_paths: ["tests/**"], ...options.otherTask } });
    createAttempt(db, { id: "a2", runId: "run1", taskId: "T2" });
  }
  const services = { activeWriterTasks: new Set<string>(), startWriterTask: vi.fn(), dispatchWriter: vi.fn(), providerRetry: { abandon: async () => undefined } } as unknown as Services;
  const consult = vi.fn<Consult>(async () => null);
  const timeout = createWriterQuestionTimeout(ctx, services, consult);
  const contract = () => getTask(db, "T1")!.contract as TaskV2;
  return { bb, db, sends, consult, timeout, contract };
}

describe("a writer's question settled by rule, at once", () => {
  it("outside_paths: the named file joins owns_paths, the same attempt goes on, the critic goes strict, one receipt names the rule", async () => {
    const w = world("tests/x.test.ts is outside owns_paths and the task needs it changed");
    expect(await w.timeout.sweepWriterQuestions(T0 + 1)).toEqual([{ taskId: "T1", action: "rule_outside_paths" }]);
    expect(w.contract().owns_paths).toEqual(["a.txt", "b/**", "tests/x.test.ts"]);
    expect(getAttempt(w.db, "a1")?.state).toBe("running");
    expect(countChargedAttempts(w.db, "run1", "T1")).toBe(1);
    expect(w.consult).not.toHaveBeenCalled();
    expect(w.sends[0]!.input[0]!.text).toContain("tests/x.test.ts");
    expect(await pathsWidenedOf(w.bb.storage.kv as never, "run1", "T1")).toEqual(["tests/x.test.ts"]);
    const rows = listReturns(w.db, "run1", "T1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ by: "question-rules", state: "restarted" });
    expect(rows[0]!.note).toMatch(/^rule:outside_paths answered/);
    expect(rows[0]!.detail).toContain("owns_paths += tests/x.test.ts");
  });

  it("outside_paths is refused for never_touch, more than five files, a glob, or a live task's files; the second pilot takes it", async () => {
    const cases: Array<[string, Parameters<typeof world>[1]?]> = [
      ["secrets/key.ts is outside owns_paths and I need it"],
      ["a1.ts, a2.ts, a3.ts, a4.ts, a5.ts, a6.ts are outside owns_paths and needed"],
      ["tests/x.test.ts is outside owns_paths and the task needs it", { otherTask: {} }],
    ];
    for (const [question, options] of cases) {
      const w = world(question, options);
      expect(await w.timeout.sweepWriterQuestions(T0 + 1)).toEqual([{ taskId: "T1", action: "pilot_owner" }]);
      expect(w.contract().owns_paths).toEqual(["a.txt", "b/**"]);
      expect(await pathsWidenedOf(w.bb.storage.kv as never, "run1", "T1")).toEqual([]);
    }
  });

  it("required_test_change: a test the contract names is added to test_removals; one it does not name is not", async () => {
    const w = world("test_fit rejects my edit of tests/pin.test.ts, which the acceptance requires; add it to test_removals?");
    expect(await w.timeout.sweepWriterQuestions(T0 + 1)).toEqual([{ taskId: "T1", action: "rule_required_test_change" }]);
    expect(w.contract().test_removals).toEqual(["tests/pin.test.ts"]);
    expect(w.contract().owns_paths).toContain("tests/pin.test.ts");
    expect(listReturns(w.db, "run1", "T1")[0]!.note).toMatch(/^rule:required_test_change answered/);
    expect(await pathsWidenedOf(w.bb.storage.kv as never, "run1", "T1")).toEqual(["tests/pin.test.ts"]);
    const other = world("test_fit rejects my edit of tests/other.test.ts; add it to test_removals?");
    expect(await other.timeout.sweepWriterQuestions(T0 + 1)).toEqual([{ taskId: "T1", action: "pilot_owner" }]);
    expect(other.contract().test_removals ?? []).toEqual([]);
  });

  it("sandbox: the writer is told to stop, once; a second such question goes to the second pilot", async () => {
    const w = world("check `bash scripts/c.sh` cannot run in the sandbox: mktemp: Operation not permitted");
    expect(await w.timeout.sweepWriterQuestions(T0 + 1)).toEqual([{ taskId: "T1", action: "rule_sandbox" }]);
    expect(w.sends[0]!.input[0]!.text).toContain("Lane Pilot repairs the check environment");
    expect(listReturns(w.db, "run1", "T1")[0]!.note).toMatch(/^rule:sandbox answered/);
    createAttempt(w.db, { id: "a2", runId: "run1", taskId: "T1" });
    w.db.prepare("UPDATE lane_pilot_attempt SET state='blocked', reason=?, thread_id='thr_w', workspace_path='/ws/worktrees/a2', updated_at=? WHERE id='a2'")
      .run("needs_human: check `bash scripts/c.sh` cannot run in the sandbox: mktemp: Operation not permitted", T0);
    expect(await w.timeout.sweepWriterQuestions(T0 + 2)).toEqual([{ taskId: "T1", action: "pilot_owner" }]);
  });

  it("already_done: a green baseline closes the attempt as satisfied; without one the second pilot answers it", async () => {
    const w = world("notes/x.md is not needed because main already contains it");
    insertBaseline(w.db, { projectId: "proj1", runId: "run1", taskId: "T1", attemptId: "a1", baseSha: "abcdef0123456789", state: "ran", verdict: "already_built", mode: "t", action: "proceed", summary: "", checks: [], durationMs: 1 });
    expect(await w.timeout.sweepWriterQuestions(T0 + 1)).toEqual([{ taskId: "T1", action: "rule_already_done" }]);
    expect(getAttempt(w.db, "a1")).toMatchObject({ state: "canceled" });
    expect(getAttempt(w.db, "a1")!.reason).toMatch(/^already_done:/);
    expect(await isTaskSatisfied(w.bb.storage.kv as never, "proj1", "T1")).toBeTruthy();
    const none = world("notes/x.md is not needed because main already contains it");
    expect(await none.timeout.sweepWriterQuestions(T0 + 1)).toEqual([{ taskId: "T1", action: "pilot_answer" }]);
    expect(getAttempt(none.db, "a1")?.state).toBe("running");
  });

  it("anything else goes to the second pilot at once", async () => {
    const w = world("Which of the two names do you want for the helper?");
    expect(await w.timeout.sweepWriterQuestions(T0 + 1)).toEqual([{ taskId: "T1", action: "pilot_owner" }]);
    expect(w.consult).toHaveBeenCalledTimes(1);
  });
});

describe("markers and the critic", () => {
  it("reads ASK_PM and the old NEEDS_HUMAN, in any case, with the wrappers writers add", () => {
    expect(needsHumanQuestion("ASK_PM: may I?")).toBe("may I?");
    expect(needsHumanQuestion("ask_pm: may I?")).toBe("may I?");
    expect(needsHumanQuestion("NEEDS_HUMAN: may I?")).toBe("may I?");
    expect(needsHumanQuestion("`ASK_PM: may I?`")).toBe("may I?");
    expect(needsHumanQuestion("Done.")).toBeNull();
  });

  it("a widened task is strict for the code critic, whatever else is small", () => {
    const small = { taskId: "T1", kind: "chore", risk: "low", paths: ["a.txt"], checks: [{ exitCode: 0 }] };
    expect(criticLevel(small).tier).not.toBe("strict");
    expect(criticLevel({ ...small, pathsWidened: ["tests/x.test.ts"] })).toEqual({ tier: "strict", reason: "paths_widened" });
  });
});
