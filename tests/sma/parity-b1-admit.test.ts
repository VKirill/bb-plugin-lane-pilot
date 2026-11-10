import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { FREE_CLASSES, classifyFailure, failureClass } from "../../src/rooms/contracts/failure-class";
import { blockingClass, shapeFlags, spendReserve, testOwnedImports } from "../../src/rooms/tasks";
import { effectState, getAttemptChange, recoveryState, upsertAttemptChange, appendTaskReceipt } from "../../src/rooms/rollback/store";
import { baselineRedGuard, recoveryGuard } from "../../src/rooms/writer/server/dispatch-guards";
import { createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";
import { postOwnerItem, closeOwnerItem, ownerAnsweredItem } from "../../src/rooms/owner-waiting";

const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };

describe("permit, effects, recovery, red baseline, non-work stops and the shape of the work", () => {
  it("[sma:ag_infra] context overflow, a turn ceiling and a background tail are free — the task's own reds are not", () => {
    for (const [state, reason] of [
      ["validation_failed", "prompt is too long: 210000 tokens"],
      ["blocked", "error_max_turns"],
      ["validation_failed", "context_length_exceeded"],
      ["empty_output", "writer_background_tail: npm run dev"],
      ["blocked", "maximum number of turns (30) exceeded"],
    ] as const) {
      const verdict = classifyFailure(state, reason);
      expect(verdict, reason).toEqual({ cls: "provider", confident: true });
      expect(FREE_CLASSES.has(verdict.cls)).toBe(true);
    }
    // A red check is still the task's, charged.
    expect(classifyFailure("validation_failed", "verification failed (npm test): 3 failed")).toEqual({ cls: "task", confident: true });
  });

  it("[sma:ac_permit] a retry is not spawned when the run's reserve no longer holds the task, and a task without a price is refused", async () => {
    const { harness } = open();
    // The reserve the permit re-checks at the seat: the other open task spent the rest since the dispatch admitted this one.
    const reserve = spendReserve({ budgetTokens: 1000, spentTokens: 950, openAppetites: [200], appetite: 50 });
    expect(reserve.ok).toBe(false);
    expect(reserve.why).toContain("budget");
    // The permit refusal ends the attempt blocked, uncharged (budget class), never the task's.
    expect(failureClass("blocked", `permit_refused:reserve: ${reserve.why}`)).toBe("budget");
    expect(failureClass("blocked", "permit_refused:price_unknown: the run has run.max_tokens but task t1 names no appetite.tokens")).toBe("budget");
    // The lint code the dispatch answers with is missing-info: the PM adds appetite.tokens and sends the task again.
    expect(blockingClass("price_unknown")).toBe("missing_info");
    await harness.lifecycle.dispose();
  });

  it("[sma:ac_effects] a worktree whose git read fails is recorded uncertain, not as zero changes", async () => {
    const { db, harness } = open();
    createRun(db, "run1", "projA");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { id: "t1" } as never });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    upsertAttemptChange(db, { attemptId: "a1", runId: "run1", taskId: "t1" }, { baseSha: "abc" });
    expect(effectState(getAttemptChange(db, "a1"))).toBe("intended");
    // The failed read keeps the reason and marks the row uncertain; a kept file list is not «nothing changed».
    upsertAttemptChange(db, { attemptId: "a1", runId: "run1", taskId: "t1" }, { outcome: "failed:blocked",
      worktree: { head: null, dirty: 0, ahead: 0, savedAs: null, at: 1, read: "failed", readError: "host unreachable" } });
    const uncertain = getAttemptChange(db, "a1")!;
    expect(effectState(uncertain)).toBe("uncertain");
    expect(uncertain.worktree?.readError).toBe("host unreachable");
    // A successful read makes it observed; the revert makes it compensated.
    upsertAttemptChange(db, { attemptId: "a1", runId: "run1", taskId: "t1" }, { worktree: { head: "def", dirty: 0, ahead: 1, savedAs: null, at: 2 } });
    expect(effectState(getAttemptChange(db, "a1"))).toBe("observed");
    upsertAttemptChange(db, { attemptId: "a1", runId: "run1", taskId: "t1" }, { outcome: "reverted" });
    expect(effectState(getAttemptChange(db, "a1"))).toBe("compensated");
    await harness.lifecycle.dispose();
  });

  it("[sma:ac_recovery] a task whose revert failed is rollback_failed and cannot be redispatched until it clears", async () => {
    const { db, harness } = open();
    createRun(db, "run1", "projA");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { id: "t1" } as never });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a1", "accepted", {});
    appendTaskReceipt(db, { kind: "revert", projectId: "projA", runId: "run1", taskId: "t1", attemptId: "a1", baseSha: null, changeSha: null, resultCommit: null, state: "failed", summary: "git revert failed", detail: {} });
    expect(recoveryState(db, "a1")).toBe("rollback_failed");
    // A redispatch of the family is refused and names the unfinished recovery.
    const refusal = recoveryGuard(db, "run1", "t1.2");
    expect(refusal).toContain("rollback_failed");
    expect(refusal).toContain("a1");
    // A later passed revert clears it: the family dispatches again.
    appendTaskReceipt(db, { kind: "revert", projectId: "projA", runId: "run1", taskId: "t1", attemptId: "a1", baseSha: null, changeSha: null, resultCommit: "deadbeef", state: "passed", summary: "reverted", detail: {} });
    expect(recoveryState(db, "a1")).toBe("clear");
    expect(recoveryGuard(db, "run1", "t1.2")).toBeNull();
    // A spawn lost in flight is reconciling; a blocked needs_human waits on a decision.
    createAttempt(db, { id: "a2", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a2", "spawn_requested", {});
    transitionAttempt(db, "a2", "spawn_unknown", {});
    expect(recoveryState(db, "a2")).toBe("reconciling");
    createAttempt(db, { id: "a3", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "a3", "spawn_requested", {});
    transitionAttempt(db, "a3", "running", {});
    transitionAttempt(db, "a3", "validation_failed", {});
    transitionAttempt(db, "a3", "blocked", { reason: "needs_human: which variant?" });
    expect(recoveryState(db, "a3")).toBe("needs_decision");
    await harness.lifecycle.dispose();
  });

  it("[sma:ac_baseline_red] a task stopped on a base red outside its files is not sent again without the owner's word", async () => {
    const { db, harness } = open();
    createRun(db, "run1", "projA");
    const key = "baseline-red:run1:t1";
    // No item, no refusal — with owner.words on and off alike.
    expect(baselineRedGuard(db, "run1", "t1.2", true)).toBeNull();
    postOwnerItem(db as never, { key, source: "baseline", kind: "baseline_red", projectId: "projA", what: "База красная вне файлов задачи t1", why: "npm test red in shared/api.ts" });
    const refusal = baselineRedGuard(db, "run1", "t1.2", true);
    expect(refusal).toContain(key);
    // The person steps are off: the red base stops nobody (owner.words off).
    expect(baselineRedGuard(db, "run1", "t1.2", false)).toBeNull();
    // The owner's answer closes the item and the family dispatches again.
    closeOwnerItem(db as never, key, "owner:yes");
    expect(baselineRedGuard(db, "run1", "t1.2", true)).toBeNull();
    // His yes stands for the family (the baseline stop lets the next start through); a row the janitor closed is not his yes.
    expect(ownerAnsweredItem(db as never, key)).toBe(true);
    postOwnerItem(db as never, { key: "baseline-red:run1:t9", source: "baseline", kind: "baseline_red", projectId: "projA", what: "База красная", why: "npm test red" });
    closeOwnerItem(db as never, "baseline-red:run1:t9", "janitor:term");
    expect(ownerAnsweredItem(db as never, "baseline-red:run1:t9")).toBe(false);
    await harness.lifecycle.dispose();
  });

  it("[sma:ag_shape] a new top-level folder and a test that only tests itself are flagged for a person", () => {
    // A new top-level folder among ordinary changes: only it is flagged.
    const flags = shapeFlags({ changedPaths: ["newpkg/index.ts", "src/app/a.ts"], baseTopLevel: new Set(["src", "tests", "package.json"]), newTests: [] });
    expect(flags).toEqual(["new_top_level:newpkg"]);
    // The new test importing the task's owned file is real coverage; the one importing only itself is not.
    expect(testOwnedImports("tests/a.test.ts", "import { f } from \"../src/app/a\";\nimport { describe } from \"vitest\";", ["src/app/a.ts"])).toEqual(["src/app/a"]);
    expect(testOwnedImports("tests/b.test.ts", "import { f } from \"./b-helper\";", ["src/app/a.ts"])).toEqual([]);
    const selfTest = shapeFlags({ changedPaths: ["tests/b.test.ts", "src/app/a.ts"], baseTopLevel: new Set(["src", "tests"]), newTests: [{ path: "tests/b.test.ts", imports: [] }] });
    expect(selfTest).toEqual(["self_test:tests/b.test.ts"]);
  });
});
