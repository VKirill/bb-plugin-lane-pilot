import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { listRegressions } from "../../src/rooms/baseline";
import { runBaselineCli } from "../../src/rooms/baseline/server";
import { composeMorningList } from "../../src/rooms/policy/morning";
import { recordCheckDuration, saveStageReceipt } from "../../src/rooms/storage";
import { git } from "../verification/git-integrate-helpers";
import { world } from "./world";

vi.setConfig({ testTimeout: 240_000 });

/** A was merged green; later C, B (which deletes A's file), D and E land on top of it. */
async function history(w: Awaited<ReturnType<typeof world>>) {
  const a = await w.acceptedTask("A", async (dir) => { await writeFile(join(dir, "a.txt"), "a\n"); }, ["test -f a.txt", "test -f keep.txt"]);
  await w.acceptedTask("C", async (dir) => { await writeFile(join(dir, "c.txt"), "c\n"); }, ["test -f c.txt"]);
  const b = await w.acceptedTask("B", async (dir) => { await rm(join(dir, "a.txt")); await writeFile(join(dir, "b.txt"), "b\n"); }, ["test -f b.txt"]);
  await w.acceptedTask("D", async (dir) => { await writeFile(join(dir, "d.txt"), "d\n"); }, ["test -f d.txt"]);
  await w.acceptedTask("E", async (dir) => { await writeFile(join(dir, "e.txt"), "e\n"); }, ["test -f e.txt"]);
  return { a, b };
}

describe("the regression pass over accepted tasks (D1-2)", () => {
  it("finds a check that went red, bisects to the commit and the task that broke it, and records it for the morning list; nothing is reverted", async () => {
    const w = await world();
    const { a, b } = await history(w);
    const head = git(w.base, "rev-parse", "HEAD").trim();
    const result = await w.services.regression.run({ projectId: "projA" });
    const pass = result.projects[0]!;
    expect(pass.head).toBe(head);
    expect(pass.tasks.map((task) => task.taskId).sort()).toEqual(["A", "B", "C", "D", "E"]);
    const findings = pass.findings;
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ taskId: "A", command: "test -f a.txt", kind: "regression", bisect: "found", culpritTask: "B", fresh: true });
    // the culprit is B's commit: it is one of B's, not A's and not a later one
    expect(git(w.base, "merge-base", "--is-ancestor", findings[0]!.culpritCommit!, b.merged.commit!)).toBe("");
    expect(git(w.base, "merge-base", "--is-ancestor", a.merged.commit!, findings[0]!.culpritCommit!)).toBe("");
    expect(findings[0]!.culpritCommit).not.toBe(a.merged.commit);
    // the other checks of A (keep.txt) and the other tasks are green; the same command shared by tasks ran once
    const aReport = pass.tasks.find((task) => task.taskId === "A")!;
    expect(aReport.checks.map((check) => [check.command, check.state])).toEqual([["test -f a.txt", "red"], ["test -f keep.txt", "green"]]);
    // project's checkout untouched; no worktrees left
    expect(git(w.base, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(w.base, "status", "--porcelain").trim()).toBe("");
    expect(w.worktrees()).toBe(1);
    const open = listRegressions(w.db, { projectId: "projA" });
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ taskId: "A", culpritTask: "B", greenAt: a.merged.commit, redAt: head, state: "open", kind: "regression" });
    expect((open[0]!.evidence as { output: string }).output).toBeDefined();
    // the morning list names it with the commit
    const line = composeMorningList(w.db)[1];
    // S2c: a culprit other than the broken task is named in the morning line.
    expect(line).toContain(`Сломано после приёмки: 1 (A ← ${open[0]!.culpritCommit!.slice(0, 8)} (виновник B))`);
    await w.dispose();
  });

  it("does not run again while main has not moved, runs a shared command once, and settles the finding when the check is green again", async () => {
    const w = await world();
    await history(w);
    await w.services.regression.run({ projectId: "projA" });
    const ranBefore = w.ran.length;
    // E, D, C, B, A each carry their own check; no command is shared here, but a re-run on the same head must not happen at all
    const again = await w.services.regression.run({ projectId: "projA" });
    expect(again.projects[0]!.skipped).toContain("has not moved");
    expect(w.ran.length).toBe(ranBefore);
    expect(listRegressions(w.db, { projectId: "projA" })).toHaveLength(1);
    // main moves: a fix puts a.txt back; the finding closes by itself
    await writeFile(join(w.base, "a.txt"), "a\n");
    git(w.base, "add", "-A"); git(w.base, "commit", "-qm", "put a.txt back");
    const fixed = await w.services.regression.run({ projectId: "projA" });
    expect(fixed.projects[0]!.findings).toHaveLength(0);
    expect(fixed.projects[0]!.closed).toHaveLength(1);
    expect(listRegressions(w.db, { projectId: "projA" })).toHaveLength(0);
    expect(listRegressions(w.db, { projectId: "projA", includeClosed: true })[0]).toMatchObject({ state: "closed" });
    expect(composeMorningList(w.db)[1]).not.toContain("Сломано");
    await w.dispose();
  });

  it("names the files the culprit task shares with the broken task, and does not open a finding the PM settled by hand while the check stays red", async () => {
    const w = await world();
    await history(w);
    const first = await w.services.regression.run({ projectId: "projA" });
    const finding = first.projects[0]!.findings[0]!;
    expect(finding.note).toContain("the culprit task changed the same file(s): a.txt");
    expect(listRegressions(w.db, { projectId: "projA" })[0]!.evidence).toMatchObject({ sharedFiles: ["a.txt"] });
    expect(finding.sharedFiles).toEqual(["a.txt"]);
    // the open finding seen again (the run-goal check forces a pass): the shared files come with it and stay in its evidence
    const seen = (await w.services.regression.run({ projectId: "projA", force: true })).projects[0]!.findings[0]!;
    expect(seen).toMatchObject({ fresh: false, id: finding.id, sharedFiles: ["a.txt"] });
    expect(listRegressions(w.db, { projectId: "projA" })[0]!.evidence).toMatchObject({ sharedFiles: ["a.txt"] });
    expect(w.services.regression.close(finding.id!, "the release pin was meant").ok).toBe(true);
    expect(w.services.regression.close(finding.id!, "again").ok).toBe(false);
    // main moves on, the check is still red: it stays settled, no new finding, nothing on the morning list
    await writeFile(join(w.base, "later.txt"), "x\n");
    git(w.base, "add", "-A"); git(w.base, "commit", "-qm", "later work");
    const second = await w.services.regression.run({ projectId: "projA" });
    expect(second.projects[0]!.findings[0]).toMatchObject({ taskId: "A", fresh: false, id: finding.id });
    expect(second.projects[0]!.findings[0]!.note).toContain("settled by hand earlier (the release pin was meant)");
    expect(listRegressions(w.db, { projectId: "projA" })).toHaveLength(0);
    expect(composeMorningList(w.db)[1]).not.toContain("Сломано");
    // the check goes green, the settlement is released: a later red is a new finding
    await writeFile(join(w.base, "a.txt"), "a\n");
    git(w.base, "add", "-A"); git(w.base, "commit", "-qm", "put a.txt back");
    await w.services.regression.run({ projectId: "projA" });
    await rm(join(w.base, "a.txt"));
    git(w.base, "add", "-A"); git(w.base, "commit", "-qm", "remove a.txt again");
    const third = await w.services.regression.run({ projectId: "projA" });
    expect(third.projects[0]!.findings[0]).toMatchObject({ taskId: "A", fresh: true });
    expect(listRegressions(w.db, { projectId: "projA" })).toHaveLength(1);
    await w.dispose();
  });

  it("a dry run runs the checks and reports, but writes no finding and no pass and bisects nothing; a plan only picks", async () => {
    const w = await world();
    await history(w);
    const planned = await w.services.regression.run({ projectId: "projA", plan: true });
    expect(w.ran).toEqual([]);
    expect(planned.projects[0]!.tasks.find((task) => task.taskId === "A")!.checks.map((check) => check.state)).toEqual(["planned", "planned"]);
    const dry = await w.services.regression.run({ projectId: "projA", dryRun: true });
    expect(dry.projects[0]!.findings).toHaveLength(1);
    expect(dry.projects[0]!.findings[0]).toMatchObject({ taskId: "A", bisect: "skipped", fresh: false, id: null });
    expect(w.calls).not.toContain("gateBisect");
    expect(listRegressions(w.db, { includeClosed: true })).toHaveLength(0);
    expect(w.db.prepare("SELECT count(*) AS n FROM lane_pilot_regress_pass").get()).toEqual({ n: 0 });
    await w.dispose();
  });

  it("with a run id it picks every accepted task of that run, past lastN, and of no other run (the run-goal check)", async () => {
    const w = await world();
    await history(w);
    const capped = await w.services.regression.run({ projectId: "projA", plan: true, lastN: 2 });
    expect(capped.projects[0]!.tasks).toHaveLength(2);
    const whole = await w.services.regression.run({ projectId: "projA", plan: true, lastN: 2, runId: "run1" });
    expect(whole.projects[0]!.tasks.map((task) => task.taskId).sort()).toEqual(["A", "B", "C", "D", "E"]);
    expect((await w.services.regression.run({ projectId: "projA", plan: true, runId: "run_other" })).projects[0]!.tasks).toEqual([]);
    await w.dispose();
  });

  it("a check that is red at its own merge commit too is unstable, not a regression, and stays off the morning list", async () => {
    const w = await world();
    await w.acceptedTask("F", async (dir) => { await writeFile(join(dir, "f.txt"), "f\n"); }, ["false"]);
    await w.acceptedTask("G", async (dir) => { await writeFile(join(dir, "g.txt"), "g\n"); }, ["test -f g.txt"]);
    const result = await w.services.regression.run({ projectId: "projA" });
    expect(result.projects[0]!.findings).toHaveLength(1);
    expect(result.projects[0]!.findings[0]).toMatchObject({ taskId: "F", kind: "unstable", bisect: "skipped" });
    // «flaky or the machine» now carries the reading taken before that run, or says there was none (this world's host cannot answer diskFree)
    expect(result.projects[0]!.findings[0]!.note).toMatch(/flaky or the machine, not later work; (?:no machine reading was available|no limit crossed|machine pressure)/);
    expect(listRegressions(w.db, { projectId: "projA", kind: "regression" })).toHaveLength(0);
    expect(composeMorningList(w.db)[1]).not.toContain("Сломано");
    expect(w.calls).not.toContain("gateBisect");
    await w.dispose();
  });

  it("leaves out what is not cheap, what carried secrets, what was not green at acceptance, reverted tasks and the ones outside the window", async () => {
    const w = await world({ settings: { "regress.check_cap_sec": 60, "regress.last_n": 4 } });
    for (let index = 0; index < 3; index += 1) recordCheckDuration(w.db, { projectId: "projA", command: "sleep 100", cwd: w.base, root: w.base, durationMs: 100_000, exitCode: 0 });
    await w.acceptedTask("S", async (dir) => { await writeFile(join(dir, "s.txt"), "s\n"); }, ["sleep 100"]);
    await w.acceptedTask("T", async (dir) => { await writeFile(join(dir, "t.txt"), "t\n"); }, ["test -f t.txt", { command: "echo $KEY", timeout_sec: 5, secrets: ["KEY"] } as never]);
    await w.acceptedTask("U", async (dir) => { await writeFile(join(dir, "u.txt"), "u\n"); }, ["test -f u.txt", "test -f nothere.txt"]);
    saveStageReceipt(w.db, { runId: "run1", taskId: "U", stageId: "verification", contractVersion: 1, state: "passed", inputSha256: "x", outputSha256: "y", attempt: 1, providerId: null, model: null, threadId: null,
      result: { verification: [{ command: "test -f u.txt", exitCode: 0 }, { command: "test -f nothere.txt", exitCode: 1 }] }, reason: null, updatedAt: Date.now() });
    await w.acceptedTask("V", async (dir) => { await writeFile(join(dir, "v.txt"), "v\n"); }, ["test -f v.txt"]);
    await w.acceptedTask("W", async (dir) => { await writeFile(join(dir, "w.txt"), "w\n"); }, ["test -f w.txt"]);
    w.db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id='att_W'").run(Date.now() - 400 * 86_400_000);
    const result = await w.services.regression.run({ projectId: "projA" });
    const pass = result.projects[0]!;
    // last 4 of 6 within the window: V, U, T, S (W is too old)
    expect(pass.tasks.map((task) => task.taskId)).toEqual(["V", "U", "T", "S"]);
    expect(pass.tasks.find((task) => task.taskId === "S")).toMatchObject({ skipped: "no cheap check that was green at acceptance" });
    expect(pass.tasks.find((task) => task.taskId === "S")!.checks[0]!.note).toContain("too slow");
    expect(pass.tasks.find((task) => task.taskId === "T")!.checks.map((check) => [check.state, check.note?.includes("secrets") ?? false])).toEqual([["green", false], ["skipped", true]]);
    expect(pass.tasks.find((task) => task.taskId === "U")!.checks.map((check) => check.state)).toEqual(["green", "skipped"]);
    expect(w.ran).not.toContain("sleep 100");
    expect(w.ran).not.toContain("test -f nothere.txt");
    expect(pass.findings).toHaveLength(0);
    // a reverted task is not checked
    w.db.prepare("INSERT INTO lane_pilot_task_receipt(at,kind,project_id,run_id,task_id,state,summary) VALUES (?,?,?,?,?,?,?)").run(Date.now(), "revert", "projA", "run1", "V", "merged", "reverted");
    const second = await w.services.regression.run({ projectId: "projA", force: true });
    expect(second.projects[0]!.tasks.find((task) => task.taskId === "V")).toMatchObject({ skipped: "the task was reverted" });
    await w.dispose();
  });

  it("F-001: cheap watch skips a slow check; full mode keeps it", async () => {
    const w = await world({ settings: { "regress.check_cap_sec": 60 } });
    for (let index = 0; index < 3; index += 1) recordCheckDuration(w.db, { projectId: "projA", command: "sleep 100", cwd: w.base, root: w.base, durationMs: 100_000, exitCode: 0 });
    await w.acceptedTask("S", async (dir) => { await writeFile(join(dir, "s.txt"), "s\n"); }, ["sleep 100", "test -f s.txt"]);
    const cheap = await w.services.regression.run({ projectId: "projA", plan: true });
    expect(cheap.projects[0]!.tasks[0]!.checks.find((check) => check.command === "sleep 100")!.state).toBe("skipped");
    const full = await w.services.regression.run({ projectId: "projA", plan: true, mode: "full" });
    expect(full.projects[0]!.tasks[0]!.checks.find((check) => check.command === "sleep 100")!.state).toBe("planned");
    expect(full.projects[0]!.tasks[0]!.checks.find((check) => check.command === "test -f s.txt")!.state).toBe("planned");
    await w.dispose();
  });

  it("skips the bisect, and says why, when the range is longer than regress.bisect_steps allows", async () => {
    const w = await world({ settings: { "regress.bisect_steps": 1 } });
    await history(w);
    const result = await w.services.regression.run({ projectId: "projA" });
    expect(result.projects[0]!.findings[0]).toMatchObject({ taskId: "A", kind: "regression", bisect: "skipped", culpritCommit: null });
    expect(result.projects[0]!.findings[0]!.note).toContain("regress.bisect_steps");
    expect(composeMorningList(w.db)[1]).toContain("Сломано после приёмки: 1 (A ← ?)");
    await w.dispose();
  });
});

describe("bb lane-pilot regress / regressions / regress-close / baseline", () => {
  it("runs from the command line, exits 1 on a regression, lists it and closes it by hand", async () => {
    const w = await world();
    await history(w);
    const apis = { baseline: w.services.baseline, regression: w.services.regression };
    const plan = await runBaselineCli(apis, "regress", ["projA", "--plan", "--last", "2"]);
    expect(plan.exitCode).toBe(0);
    expect(JSON.parse(plan.stdout!).projects[0].tasks).toHaveLength(2);
    const ran = await runBaselineCli(apis, "regress", ["projA"]);
    expect(ran.exitCode).toBe(1);
    expect(JSON.parse(ran.stdout!).projects[0].findings[0]).toMatchObject({ taskId: "A", culpritTask: "B" });
    const listed = JSON.parse((await runBaselineCli(apis, "regressions", ["projA"])).stdout!);
    expect(listed).toHaveLength(1);
    const closed = await runBaselineCli(apis, "regress-close", [String(listed[0].id), "the", "break", "was", "accepted"]);
    expect(closed.exitCode).toBe(0);
    expect(JSON.parse((await runBaselineCli(apis, "regressions", ["projA"])).stdout!)).toHaveLength(0);
    expect(JSON.parse((await runBaselineCli(apis, "regressions", ["--all"])).stdout!)[0]).toMatchObject({ state: "closed", closedReason: "the break was accepted" });
    expect((await runBaselineCli(apis, "regress", ["--nope"])).exitCode).toBe(1);
    expect((await runBaselineCli(apis, "baseline", ["A"])).exitCode).toBe(0);
    await w.dispose();
  });
});

describe("worktrees a stopped pass left", () => {
  it("are removed by the next pass once they are older than any pass can run; a fresh one is left alone", async () => {
    const w = await world();
    await w.acceptedTask("A", async (dir) => { await writeFile(join(dir, "a.txt"), "a\n"); }, ["test -f a.txt"]);
    const before = w.worktrees();
    // What a plugin reload in the middle of a pass leaves: the worktree and its KV record, the `finally` never ran.
    const old = join(w.root, "wt", "regress-old", "project");
    git(w.base, "worktree", "add", "-q", "-b", "lane/regress-old", old, "main");
    const fresh = join(w.root, "wt", "regress-fresh", "project");
    git(w.base, "worktree", "add", "-q", "-b", "lane/regress-fresh", fresh, "main");
    await w.bb.storage.kv.set(`regress-worktree:${old}`, { hostId: "host-1", basePath: w.base, at: Date.now() - 7 * 3_600_000 });
    await w.bb.storage.kv.set(`regress-worktree:${fresh}`, { hostId: "host-1", basePath: w.base, at: Date.now() - 60_000 });

    await w.services.regression.run({ projectId: "projA" });

    const listed = git(w.base, "worktree", "list");
    expect(listed).not.toContain("regress-old");
    expect(listed).toContain("regress-fresh");
    expect(w.worktrees()).toBe(before + 1);
    expect(await w.bb.storage.kv.list("regress-worktree:")).toEqual([`regress-worktree:${fresh}`]);
  });
});

describe("the stale sweep (W32 rank 8)", () => {
  const put = (w: Awaited<ReturnType<typeof world>>, row: { taskId: string; command: string; kind: string; foundAt: number; greenAt?: string | null }) =>
    w.db.prepare(`INSERT INTO lane_pilot_regression(found_at,updated_at,project_id,run_id,task_id,command,kind,state,bisect_status,green_at)
      VALUES(?,?,'projA','run1',?,?,?,'open','skipped',?)`).run(row.foundAt, row.foundAt, row.taskId, row.command, row.kind, row.greenAt ?? null);

  it("closes a week-old unstable, a version-pinned check and a finding whose merge commit left main's history; the rest stay open", async () => {
    const w = await world();
    const day = 86_400_000, now = Date.now();
    const a = await w.acceptedTask("A", async (dir) => { await writeFile(join(dir, "a.txt"), "a\n"); }, ["test -f a.txt"]);
    put(w, { taskId: "A", command: "npm run test:flaky", kind: "unstable", foundAt: now - 8 * day });
    put(w, { taskId: "A", command: "npm run test:flaky-now", kind: "unstable", foundAt: now - day });
    put(w, { taskId: "A", command: `grep -q '"version": "0.8.7"' package.json`, kind: "regression", foundAt: now - day, greenAt: a.merged.commit });
    put(w, { taskId: "A", command: "npm test", kind: "regression", foundAt: now - day, greenAt: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" });
    put(w, { taskId: "A", command: "npm run lint", kind: "regression", foundAt: now - day, greenAt: a.merged.commit });

    await w.services.regression.run({ projectId: "projA", force: true });

    const rows = w.db.prepare("SELECT command,state,closed_reason FROM lane_pilot_regression ORDER BY rowid").all() as Array<{ command: string; state: string; closed_reason: string | null }>;
    expect(rows[0]).toMatchObject({ state: "closed", closed_reason: expect.stringContaining("unstable for a week") });
    expect(rows[1]).toMatchObject({ state: "open" });
    expect(rows[2]).toMatchObject({ state: "closed", closed_reason: expect.stringContaining("package version") });
    expect(rows[3]).toMatchObject({ state: "closed", closed_reason: expect.stringContaining("not in the history of main") });
    expect(rows[4]).toMatchObject({ state: "open" });
    await w.dispose();
  });
});

