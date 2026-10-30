import { describe, expect, it, vi } from "vitest";
import { buildAcceptanceCard } from "../../src/rooms/acceptance/card";
import { getBaseline } from "../../src/rooms/baseline";
import { recordCheckDuration } from "../../src/rooms/storage";
import { classifyFailure } from "../../src/rooms/runs/failure-class";
import { git } from "../verification/git-integrate-helpers";
import { world } from "./world";

vi.setConfig({ testTimeout: 180_000 });

describe("the baseline before a writer (D1-3)", () => {
  it("records which checks are green and which red on the base, runs them in a throwaway worktree, and lets the attempt start", async () => {
    const w = await world();
    const input = w.pendingTask("t1", ["test -f keep.txt", "test -f feature.txt"]);
    const result = await w.services.baseline.preflight(input);
    expect(result.stop).toBeNull();
    const row = getBaseline(w.db, "run1", "t1")!;
    expect(row).toMatchObject({ state: "ran", verdict: "partial", action: "proceed", baseSha: git(w.base, "rev-parse", "HEAD").trim() });
    expect(row.checks.map((check) => [check.command, check.status])).toEqual([["test -f keep.txt", "green"], ["test -f feature.txt", "red"]]);
    // the checks ran in a worktree of the base, not in the project's own folder, and the worktree is gone
    expect(w.runs.every((run) => run.cwd !== w.base)).toBe(true);
    expect(w.worktrees()).toBe(1);
    expect(w.send).not.toHaveBeenCalled();
    await w.dispose();
  });

  it("tells the PM «already built» and lets the attempt start in the default notify mode; the acceptance card shows it", async () => {
    const w = await world();
    const input = w.pendingTask("t1", ["test -f keep.txt", "grep -q line2 server.ts"]);
    const result = await w.services.baseline.preflight(input);
    expect(result.stop).toBeNull();
    expect(getBaseline(w.db, "run1", "t1")).toMatchObject({ verdict: "already_built", action: "notified" });
    expect(w.send).toHaveBeenCalledTimes(1);
    const sent = (w.send.mock.calls[0] as unknown as [{ threadId: string; input: Array<{ text: string }> }])[0];
    expect(sent.threadId).toBe("thr_pm");
    expect(sent.input[0]!.text).toContain("все 2 проверок(и) задачи t1 уже проходят на базе");
    expect(sent.input[0]!.text).toContain("test -f keep.txt");
    const card = buildAcceptanceCard(w.db, { runId: "run1", taskId: "t1" })!;
    expect(card.baseline).toMatchObject({ verdict: "already_built", action: "notified", turnedRed: null });
    expect(card.baseline!.checks.map((check) => check.status)).toEqual(["green", "green"]);
    await w.dispose();
  });

  it("in stop mode the attempt does not start: a block verdict the PM reads, with the evidence, and no writer is asked", async () => {
    const w = await world({ settings: { "baseline.already_built": "stop" } });
    const input = w.pendingTask("t1", ["test -f keep.txt"]);
    const result = await w.services.baseline.preflight(input);
    expect(result.stop).toMatch(/^verdict_block: baseline already_built: all 1 check\(s\) already pass/);
    // the PM's own class, never redone as it is
    expect(classifyFailure("blocked", result.stop).cls).toBe("contract");
    expect(getBaseline(w.db, "run1", "t1")).toMatchObject({ verdict: "already_built", action: "stopped" });
    const text = (w.send.mock.calls[0] as unknown as [{ input: Array<{ text: string }> }])[0].input[0]!.text;
    expect(text).toContain("задача t1 не запущена");
    expect(text).toContain("test -f keep.txt");
    await w.dispose();
  });

  it("does not run a check again for the same base and command, and keeps the first answer of a task started twice", async () => {
    const w = await world();
    await w.services.baseline.preflight(w.pendingTask("t1", ["test -f keep.txt", "test -f feature.txt"]));
    const afterFirst = w.ran.length;
    const worktreesMade = w.calls.filter((call) => call === "gitCreateWorktree").length;
    await w.services.baseline.preflight(w.pendingTask("t2", ["test -f feature.txt", "test -f keep.txt"]));
    expect(w.ran.length).toBe(afterFirst);
    expect(w.calls.filter((call) => call === "gitCreateWorktree").length).toBe(worktreesMade);
    expect(getBaseline(w.db, "run1", "t2")!.checks.every((check) => check.cached === true)).toBe(true);
    // the same task started again (a reload) keeps its first answer
    const again = w.pendingTask("t3", ["test -f keep.txt"]);
    await w.services.baseline.preflight(again);
    await w.services.baseline.preflight(again);
    expect(w.services.baseline.status("t3")).toHaveLength(1);
    await w.dispose();
  });

  it("skips what is too slow or carries secrets, says so, and then does not claim «already built»", async () => {
    const w = await world({ settings: { "baseline.time_cap_sec": 30 } });
    // its own history says «sleep 100» takes about 100 s
    for (let index = 0; index < 3; index += 1) recordCheckDuration(w.db, { projectId: "projA", command: "sleep 100", cwd: w.base, root: w.base, durationMs: 100_000, exitCode: 0 });
    const input = w.pendingTask("t1", ["test -f keep.txt", { command: "sleep 100", timeout_sec: 600 }, { command: "echo $TOKEN", secrets: ["TOKEN"] }]);
    await w.services.baseline.preflight(input);
    const row = getBaseline(w.db, "run1", "t1")!;
    expect(row.checks.map((check) => check.status)).toEqual(["green", "skipped", "skipped"]);
    expect(row.checks[1]!.note).toContain("too slow");
    expect(row.checks[2]!.note).toContain("secrets");
    expect(row.verdict).toBe("partial");
    expect(w.ran).toEqual(["test -f keep.txt"]);
    expect(w.send).not.toHaveBeenCalled();
    await w.dispose();
  });

  it("does nothing at all when the cap is 0, and records a skip for a folder that is not a git checkout", async () => {
    const off = await world({ settings: { "baseline.time_cap_sec": 0 } });
    expect((await off.services.baseline.preflight(off.pendingTask("t1", ["true"]))).stop).toBeNull();
    expect(getBaseline(off.db, "run1", "t1")).toBeUndefined();
    expect(off.ran).toEqual([]);
    await off.dispose();

    const w = await world();
    const input = w.pendingTask("t1", ["true"]);
    // a run whose folder is not a git checkout (the live-folder mode never gets here, but a mistaken path must not stop the task)
    const task = { ...(input.task as object), project_cwd: w.root };
    w.db.prepare("UPDATE lane_pilot_run SET writer_workspace_path=? WHERE id='run1'").run(w.root);
    w.db.prepare("UPDATE lane_pilot_task SET contract_json=? WHERE id='t1'").run(JSON.stringify(task));
    const result = await w.services.baseline.preflight({ ...input, task: task as never });
    expect(result.stop).toBeNull();
    expect(getBaseline(w.db, "run1", "t1")).toMatchObject({ state: "skipped", verdict: "unknown", action: "proceed" });
    await w.dispose();
  });

  it("names, after the merge, the checks that were green on the base and are red on main", async () => {
    const w = await world();
    await w.services.baseline.preflight(w.pendingTask("t1", ["test -f keep.txt", "test -f feature.txt", "grep -q line2 server.ts"]));
    const turned = w.services.baseline.afterMerge({ runId: "run1", taskId: "t1", mergeCommit: "abc", checks: [
      { command: "test -f keep.txt", exitCode: 1 }, { command: "test -f feature.txt", exitCode: 0 }, { command: "grep -q line2 server.ts", exitCode: 1, hostError: true },
    ] });
    expect(turned).toEqual(["test -f keep.txt"]);
    expect(getBaseline(w.db, "run1", "t1")!.after).toMatchObject({ turnedRed: ["test -f keep.txt"], mergeCommit: "abc", checked: 3 });
    expect(buildAcceptanceCard(w.db, { runId: "run1", taskId: "t1" })!.baseline!.turnedRed).toEqual(["test -f keep.txt"]);
    expect(w.services.baseline.afterMerge({ runId: "run1", taskId: "nope", checks: [] })).toEqual([]);
    await w.dispose();
  });

  it("never fails the task: a host that breaks mid-way leaves a record, not an exception", async () => {
    const w = await world();
    w.services.rollback.kit.makeWorktree = async () => { throw new Error("disk gone"); };
    const result = await w.services.baseline.preflight(w.pendingTask("t1", ["test -f keep.txt"]));
    expect(result.stop).toBeNull();
    expect(getBaseline(w.db, "run1", "t1")).toMatchObject({ verdict: "unknown", action: "proceed" });
    expect(getBaseline(w.db, "run1", "t1")!.checks[0]).toMatchObject({ status: "unknown", note: "disk gone" });
    await w.dispose();
  });
});

describe("red before green (checks.require_red_on_base)", () => {
  const at = (input: ReturnType<Awaited<ReturnType<typeof world>>["pendingTask"]>, patch: Record<string, unknown>) => ({ ...input, task: { ...(input.task as object), ...patch } as never });

  it("blocks a feature whose every check is already green, and tells the PM the checks prove nothing", async () => {
    const w = await world();
    const input = at(w.pendingTask("t1", ["test -f keep.txt", "grep -q line2 server.ts"]), { risk: "medium", kind: "feature" });
    const result = await w.services.baseline.preflight(input);
    expect(result.alreadyDone).toBeUndefined();
    expect(result.stop).toMatch(/no_red_on_base/);
    expect(result.stop).toContain("проверки уже зелёные — они не отличают сделанное от несделанного; добавь проверку, которая сейчас красная");
    expect(getBaseline(w.db, "run1", "t1")).toMatchObject({ verdict: "already_built", action: "stopped" });
    const text = (w.send.mock.calls[0] as unknown as [{ input: Array<{ text: string }> }])[0].input[0]!.text;
    expect(text).toContain("проверки уже зелёные — они не отличают сделанное от несделанного; добавь проверку, которая сейчас красная");
    expect(text).toContain("- test -f keep.txt");
    expect(text).toContain("- grep -q line2 server.ts");
    await w.dispose();
  });

  it("closes a check whose every check is already green", async () => {
    const w = await world();
    const done = await w.services.baseline.preflight(at(w.pendingTask("chk", ["test -f keep.txt"]), { risk: "low", kind: "check" }));
    expect(done.stop).toBeNull();
    expect(done.alreadyDone).toMatch(/^already done: /);
    await w.dispose();
  });

  it("starts the attempt when one check is red on the base", async () => {
    const w = await world();
    const result = await w.services.baseline.preflight(at(w.pendingTask("t1", ["test -f keep.txt", "test -f feature.txt"]), { risk: "high" }));
    expect(result.stop).toBeNull();
    expect(getBaseline(w.db, "run1", "t1")).toMatchObject({ verdict: "partial", action: "proceed" });
    expect(w.send).not.toHaveBeenCalled();
    await w.dispose();
  });

  it("leaves low risk, refactor and docs kinds, risk below the setting, and the off setting alone", async () => {
    const w = await world();
    expect((await w.services.baseline.preflight(w.pendingTask("low", ["test -f keep.txt"]))).stop).toBeNull();
    expect((await w.services.baseline.preflight(at(w.pendingTask("ref", ["test -f keep.txt"]), { risk: "high", kind: "refactor" }))).stop).toBeNull();
    expect((await w.services.baseline.preflight(at(w.pendingTask("doc", ["test -f keep.txt"]), { risk: "critical", kind: "docs" }))).stop).toBeNull();
    await w.dispose();
    const high = await world({ settings: { "checks.require_red_on_base": "high" } });
    expect((await high.services.baseline.preflight(at(high.pendingTask("m", ["test -f keep.txt"]), { risk: "medium" }))).stop).toBeNull();
    expect((await high.services.baseline.preflight(at(high.pendingTask("h", ["test -f keep.txt"]), { risk: "high" }))).stop).toMatch(/no_red_on_base/);
    await high.dispose();
    const off = await world({ settings: { "checks.require_red_on_base": "off" } });
    expect((await off.services.baseline.preflight(at(off.pendingTask("m", ["test -f keep.txt"]), { risk: "critical" }))).stop).toBeNull();
    await off.dispose();
  });

  it("asks a fix of low risk for a red check too: check.sh green on the base is no proof of a fix (Vampirism Fire vf-fix-b1-*, magicseo F1)", async () => {
    const w = await world();
    const done = await w.services.baseline.preflight(at(w.pendingTask("fix1", ["test -f keep.txt"]), { risk: "low", kind: "fix" }));
    expect(done.alreadyDone).toBeUndefined();
    expect(done.stop).toMatch(/no_red_on_base/);
    expect(getBaseline(w.db, "run1", "fix1")).toMatchObject({ action: "stopped" });
    const told = (w.send.mock.calls[0] as unknown as [{ input: Array<{ text: string }> }])[0].input[0]!.text;
    expect(told).toContain("- test -f keep.txt");
    expect(told).toContain("добавь проверку, которая сейчас красная");
    // A red check that only looks for the new file proves no behaviour of a fix; one that runs something does.
    expect((await w.services.baseline.preflight(at(w.pendingTask("fix2", ["test -f keep.txt", "test -f feature.txt"]), { risk: "low", kind: "fix" }))).stop).toMatch(/no_red_on_base/);
    expect((await w.services.baseline.preflight(at(w.pendingTask("fix2b", ["test -f keep.txt", "cat feature.txt"]), { risk: "low", kind: "fix" }))).stop).toBeNull();
    await w.dispose();
    const high = await world({ settings: { "checks.require_red_on_base": "high" } });
    expect((await high.services.baseline.preflight(at(high.pendingTask("fix3", ["test -f keep.txt"]), { risk: "low", kind: "fix" }))).stop).toBeNull();
    await high.dispose();
    const off = await world({ settings: { "checks.require_red_on_base": "off" } });
    expect((await off.services.baseline.preflight(at(off.pendingTask("fix4", ["test -f keep.txt"]), { risk: "low", kind: "fix" }))).stop).toBeNull();
    await off.dispose();
  });

  it("asks again when the PM sends the task back with a red check, and does not claim «all green» for checks it could not run", async () => {
    const w = await world();
    const first = at(w.pendingTask("t1", ["test -f keep.txt"]), { risk: "medium", kind: "feature" });
    expect((await w.services.baseline.preflight(first)).stop).toMatch(/no_red_on_base/);
    // the same task, strengthened
    const stronger = { ...first, task: { ...(first.task as object), verification: [{ command: "test -f keep.txt", cwd: w.base }, { command: "test -f feature.txt", cwd: w.base }] } as never };
    expect((await w.services.baseline.preflight(stronger)).stop).toBeNull();
    expect(getBaseline(w.db, "run1", "t1")).toMatchObject({ action: "proceed", verdict: "partial" });
    const unknown = at(w.pendingTask("t2", ["test -f keep.txt", { command: "echo $TOKEN", secrets: ["TOKEN"] }]), { risk: "medium" });
    expect((await w.services.baseline.preflight(unknown)).stop).toBeNull();
    await w.dispose();
  });
});
