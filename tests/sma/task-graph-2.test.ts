import { describe, expect, it } from "vitest";
import { verdictSchema } from "@lane-pilot/workflow-engine";
import { acceptanceLines, type Phase, type PhaseRecord } from "../../src/rooms/phase";
import type { TaskFact } from "../../src/rooms/phase/logic";
import { FREE_CLASSES, NO_ANSWER_REASON, failureClass, nextStep } from "../../src/rooms/runs/failure-class";
import { isLegalMove } from "../../src/rooms/runs/state-machine";
import { isHeld } from "../../src/rooms/runs/server/runs-pause";
import { setRunPaused } from "../../src/rooms/runs/server/runs-halt";
import { lintContract, type LintInput } from "../../src/rooms/tasks/server/contract-lint";
import { birthFindings, blockingClass, checkProgram, queueOrder, writerMarkers } from "../../src/rooms/tasks";
import type { TaskV2 as Contract } from "../../src/rooms/contracts";
import { BaseLockBusyError } from "../../src/rooms/verification/git-integrate";
import { classifyManagedWorkspace, waitManagedWorktreeReady } from "../../src/rooms/verification/routing";
import { buildBubblewrapArgs } from "../../src/rooms/verification/sandbox";

const root = "/tmp/sma-task";
const baseTask: Contract = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:sma", id: "sma-task", title: "SMA", risk: "low", lane: "writer", project_cwd: root,
  read_first: ["src/a.ts"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["src/b.ts"],
  owns_paths: ["src/"], never_touch: [".git/**"], depends_on: [], objective: "change a", acceptance: ["done"],
  verify: "tests", verification: [{ command: "npx vitest run tests/a.test.ts", cwd: root }],
};
const lint = (task: Partial<Contract> = {}, input: Partial<LintInput> = {}) =>
  lintContract({ task: { ...baseTask, ...task }, workspacePath: root, hostId: "h", sandboxUnsafe: [], openTasks: [], deadDependencies: [],
    kinds: new Map([[`${root}/src/a.ts`, "file"]]), ...input });

const phase = (record: PhaseRecord): Phase => ({
  id: "ph_sma", projectId: "p", pmThreadId: "t", runId: "r", title: "Sum", goal: "sums", stage: "acceptance", state: "active", record, edition: 1, createdAt: 0, updatedAt: 0,
});

const memoryKv = () => {
  const store = new Map<string, unknown>();
  return { async get(key: string) { return store.has(key) ? store.get(key) : null; }, async set(key: string, value: unknown) { store.set(key, value); } };
};

describe("birth rails, sandbox and a crash that spends the attempt", () => {
  it("[sma:tb_blockers] only a missing fact, a dependency or a conflict holds the work; any other code does not", () => {
    expect(blockingClass("clarify_open")).toBe("missing_info");
    expect(blockingClass("check_not_runnable")).toBe("missing_info");
    expect(blockingClass("depends_dead")).toBe("dependency");
    expect(blockingClass("owns_overlap")).toBe("conflict");
    expect(blockingClass("display_title_too_long")).toBeNull();
  });

  it("[sma:tb_dry_run] a check is judged by its program: a missing one is refused, shell syntax and a program that exists are not", () => {
    expect(checkProgram("FOO=1 npm test")).toBe("npm");
    expect(checkProgram("(echo hi)")).toBeNull();
    const missing = lint({ verification: [{ command: "npm test", cwd: root }] }, { programs: new Map([["npm", false]]) });
    expect(missing.errors.map((error) => error.code)).toContain("check_not_runnable");
    const present = lint({ verification: [{ command: "npm test", cwd: root }] }, { programs: new Map([["npm", true]]) });
    expect(present.errors.map((error) => error.code)).not.toContain("check_not_runnable");
  });

  it("[sma:tb_design_needed] a medium screen change with no drawing is warned; a low-risk one, or one that names its drawing, is not", () => {
    const screen = { owns_paths: ["src/ui/Cart.tsx"], risk: "medium" };
    expect(birthFindings(screen).warnings.map((warning) => warning.code)).toContain("drawing_needed");
    expect(birthFindings({ ...screen, risk: "low" }).warnings.map((warning) => warning.code)).not.toContain("drawing_needed");
    expect(birthFindings({ ...screen, drawing: ["design/cart.png"] }).warnings.map((warning) => warning.code)).not.toContain("drawing_needed");
    expect(birthFindings({ owns_paths: ["src/tax.ts"], risk: "high" }).warnings.map((warning) => warning.code)).not.toContain("drawing_needed");
  });

  it("[sma:ap_sandbox] bubblewrap writes only the workspace and its temp; a guard path is read-only and a home path is not mounted", () => {
    const args = buildBubblewrapArgs({ workspacePath: "/work/repo", cwd: "/work/repo", tempPath: "/tmp/lp-sma", guardPaths: ["/work/repo/.git"] });
    expect(args).toContain("--unshare-all");
    const bound = (flag: string) => args.flatMap((arg, index) => arg === flag ? [args[index + 1]!] : []);
    expect(bound("--bind")).toEqual(["/tmp", "/work/repo", "/tmp/lp-sma"]);
    expect(bound("--ro-bind")).toContain("/work/repo/.git");
    expect(bound("--bind")).not.toContain("/home/ubuntu");
  });

  it("[sma:ap_copy_whole] a copy the daemon left failed is refused before launch; a ready one is taken", async () => {
    expect(classifyManagedWorkspace({ status: "destroyed" }, "host-1").kind).toBe("failed");
    const ready = { id: "env-1", status: "ready", hostId: "host-1", managed: true, workspaceProvisionType: "managed-worktree", path: "/work/repo" };
    let clock = 0;
    await expect(waitManagedWorktreeReady({
      threadId: "thr", expectedHostId: "host-1",
      getThread: async () => ({ environmentId: "env-1" }),
      getEnvironment: async () => ({ status: "failed" }),
      now: () => clock, sleep: async () => { clock += 1_000; }, timeoutMs: 5_000,
    })).rejects.toThrow("attempt_worktree_provision_failed:failed");
    await expect(waitManagedWorktreeReady({
      threadId: "thr", expectedHostId: "host-1",
      getThread: async () => ({ environmentId: "env-1" }),
      getEnvironment: async () => ready,
      now: () => 0, sleep: async () => {}, timeoutMs: 5_000,
    })).resolves.toEqual({ environmentId: "env-1" });
  });

  it("[sma:ae_crash] a provider crash is a real failure and the attempt is spent; an empty answer is the provider's, an answer with no files is the task's", () => {
    expect(isLegalMove("running", "provider_error")).toBe(true);
    expect(failureClass("provider_error", "connection reset")).toBe("provider");
    expect(FREE_CLASSES.has("provider")).toBe(false);
    expect(failureClass("empty_output", NO_ANSWER_REASON)).toBe("provider");
    expect(failureClass("empty_output", "the writer changed no files")).toBe("task");
    expect(nextStep("provider_error", "connection reset")).toContain("session ended");
  });

  it("[sma:ae_reasons] [sma:ag_classify] a merge, a question, a budget stop and a crash each send the person to a different next step", () => {
    expect(failureClass("blocked", "merge_conflict: src/a.ts")).toBe("merge");
    expect(nextStep("blocked", "merge_conflict: src/a.ts")).toContain("redone on the new main");
    expect(failureClass("blocked", "needs_human: which file")).toBe("judgment");
    expect(nextStep("blocked", "needs_human: which file")).toContain("answer_writer");
    expect(failureClass("blocked", "run_budget_exceeded:tokens")).toBe("budget");
    expect(nextStep("blocked", "run_budget_exceeded:tokens")).toContain("raise run.max_");
    expect(failureClass("provider_error", "connection reset")).toBe("provider");
  });

  it("[sma:ta_holder] a lost race names who holds the checkout", () => {
    expect(new BaseLockBusyError("writer-a").message).toContain("writer-a");
    expect(new BaseLockBusyError("writer-a").holder).toBe("writer-a");
    expect(new BaseLockBusyError(null).message).toContain("holds the base checkout");
  });

  it("[sma:cg_wave_hold] a paused run is held, so its rows are not issued; resuming lets them go", async () => {
    const kv = memoryKv();
    expect(await isHeld(kv, "run-1")).toBe(false);
    await setRunPaused(kv, "run-1", true);
    expect(await isHeld(kv, "run-1")).toBe(true);
    expect(await isHeld(kv, "run-2")).toBe(false);
    await setRunPaused(kv, "run-1", false);
    expect(await isHeld(kv, "run-1")).toBe(false);
  });

  it("[sma:tr_priority] a higher priority starts first, and the same priority keeps the order it was queued in", () => {
    const rows = [
      { id: "low-early", priority: "low", queuedAt: 1 },
      { id: "urgent", priority: "urgent", queuedAt: 5 },
      { id: "normal-late", priority: "normal", queuedAt: 4 },
      { id: "normal-early", queuedAt: 2 },
    ];
    expect(queueOrder(rows).map((row) => row.id)).toEqual(["urgent", "normal-early", "normal-late", "low-early"]);
  });

  it("[sma:as_lesson_check] a lesson is kept, and «none» is accepted only with a reason", () => {
    expect(writerMarkers("LESSON: the tax check must run before the write")).toEqual({ approach: null, lesson: "the tax check must run before the write", noLessonReason: null });
    expect(writerMarkers("LESSON: none").noLessonReason).toBe("no reason given");
    expect(writerMarkers("LESSON: none — the suite already covers it")).toMatchObject({ lesson: null, noLessonReason: "the suite already covers it" });
  });

  it("[sma:ta_lines] a piece that is not accepted keeps the landing line red, and the two person decisions are lines of their own", () => {
    const item = { id: "p1", title: "Sum", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: {} };
    const record: PhaseRecord = {
      plan: { items: [item], sha: "plan", contextSha: "ctx", admittedSha: "plan" },
      verification: {
        verdict: { state: "passed", detail: "green", mainSha: "abc", at: 1, inputSha: "in" },
        model: { state: "met", by: "goal", summary: "met", at: 1 },
      },
    };
    const fact = (state: string): TaskFact => ({ taskId: "p1", state, planFact: "passed", verification: "passed", codeCritique: "passed", browserQa: "passed", qaPlanned: true });
    const open = acceptanceLines(phase(record), new Map([["p1", fact("running")]]), { mainSha: "abc", openDeferrals: 0 });
    expect(open.find((line) => line.id === "landed")?.ok).toBe(false);
    expect(open.find((line) => line.id === "result_useful")?.ok).toBe(true);
    expect(open.find((line) => line.id === "limits_acknowledged")?.ok).toBe(true);
    const accepted = acceptanceLines(phase({ ...record, ownerWords: true }), new Map([["p1", fact("accepted")]]), { mainSha: "abc", openDeferrals: 0 });
    expect(accepted.find((line) => line.id === "landed")?.ok).toBe(true);
    expect(accepted.find((line) => line.id === "result_useful")?.ok).toBe(false);
    expect(accepted.find((line) => line.id === "limits_acknowledged")?.ok).toBe(false);
  });

  it("[sma:av_verdict_form] a verdict without its evidence is refused; one with a status, findings and evidence is kept", () => {
    expect(verdictSchema.safeParse({ status: "pass", findings: [] }).success).toBe(false);
    expect(verdictSchema.safeParse({ status: "pass", findings: [], evidence: "read the diff and the vitest output" }).success).toBe(true);
    expect(verdictSchema.safeParse({ status: "shrug", findings: [], evidence: "read the diff" }).success).toBe(false);
  });
});

describe("gaps the code does not keep", () => {
  it.todo("[sma:tb_birth_kinds] the birth kind chooses the gates (the list is six origin labels and does not)"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:ae_reasons] thirty-seven reasons, each pointing at the fault"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:av_verdict_form] the verdict form requires promise, correctness, regression, tests, out of scope, floor and class"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:ac_permit] a permit checks that the contract is current, nothing is held, the price is known and the reserve fits"); // deferral:dfr_seed_skip_sma_gaps
  it.todo("[sma:cg_claim_refusal] a row whose last word is said is closed before anything is paid"); // deferral:dfr_seed_skip_sma_gaps
});
