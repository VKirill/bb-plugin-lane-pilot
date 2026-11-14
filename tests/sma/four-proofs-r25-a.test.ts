// Region 25 · Receipts and evidence, batch a — behaviour tests for the nodes whose existing contract tests did not check the card's result.
// The other nodes of the batch are closed by the existing [sma:…] tests (tests/sma/receipts-1.test.ts, receipts-2.test.ts, parity-*.test.ts, …).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { Services } from "../../server";
import { createCore } from "../../src/rooms/core/server/core";
import { calibrationBadge, calibrate, scoreForecast } from "../../src/rooms/forecast/logic";
import { forecastReport } from "../../src/rooms/forecast/server/report";
import { createAttempt, createRun, createTask, migrations, openDatabase } from "../../src/rooms/plugin-db";
import { appendTaskReceipt, upsertAttemptChange } from "../../src/rooms/rollback/store";
import { createRollback } from "../../src/rooms/rollback/server";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { receiptChain, verifyChain } from "../../src/rooms/tools/server/receipts";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { referenceTestEdits } from "../../src/rooms/tasks/rails";
import { renderTaskManifest, resolveTaskFile } from "../../src/rooms/storage";
import { bbTaskFileIo, placeTaskHomeIn, recordAcceptanceFiles, writeDispatchHome } from "../../src/rooms/writer/server/task-home";
import { taskV2Schema } from "../../src/rooms/contracts";
import { readWires, wiresCommand } from "../../src/rooms/wires";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };

describe("receipts and evidence — the acceptance receipt on the task home", () => {
  const BASE = "/srv/proj", WT = "/wt/attempt-a", RUN = "lprun_r25";
  const contract = taskV2Schema.parse({
    schema_version: 2, id: "t1", title: "T", risk: "high", lane: "writer", project_cwd: BASE, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
    expected_outputs: ["src/a.ts"], owns_paths: ["src/**"], never_touch: [], depends_on: [], objective: "Save the form", acceptance: ["the form saves"],
    verify: "none", verification: [{ command: "npm test", cwd: BASE, timeout_sec: 60 }],
  });

  it("[sma:k_v_receipthash] a done claim is a receipt naming the command and the hash of its output, kept in the task home of the base and found by its hash", async () => {
    const { bb: host, db } = open();
    createRun(db, RUN, "proj", "bb", BASE);
    createTask(db, { id: "t1", runId: RUN, kind: "bb", contract });
    const files = new Map<string, string>();
    const bb = { log: { warn: () => undefined, info: () => undefined }, sdk: { files: {
      read: async ({ path }: { path: string }) => (files.has(path) ? { content: files.get(path) } : null),
      write: async ({ path, content }: { path: string; content: string }) => { files.set(path, content); },
    } } };
    const ctx = { bb, db, log: () => undefined } as never as Parameters<typeof recordAcceptanceFiles>[0];
    void host;
    await writeDispatchHome(db, bbTaskFileIo(bb as never, "h1", BASE), { taskId: "t1", projectId: "proj", runId: RUN, basePath: BASE, hostId: "h1", task: contract, plan: "plan" });
    await placeTaskHomeIn(ctx, { taskId: "t1", hostId: "h1", worktreePath: WT, basePath: BASE });
    // The stage receipt of the checks: the command and the sha256 of what the command printed.
    const result = { verification: [{ command: "npm test", exitCode: 0, stdout: "12 passed", stderr: "" }] };
    recordStage(db, { runId: RUN, taskId: "t1", stageId: "verification", state: "passed", input: "npm test", result });
    const stage = db.prepare("SELECT output_sha256 AS out, result_json AS json FROM lane_pilot_stage_receipt WHERE task_id='t1' AND stage_id='verification'").get() as { out: string; json: string };
    expect(stage.out).toBe(sha(JSON.stringify(result)));
    expect(stage.json).toContain("npm test");
    // The acceptance receipt is written once, into the home in the base; the worktree's copy dies with it.
    const receiptBody = `${JSON.stringify({ status: "accepted", verification: [{ command: "npm test", exitCode: 0, outputSha256: sha("12 passed") }] }, null, 2)}\n`;
    const done = await recordAcceptanceFiles(ctx, { taskId: "t1", runId: RUN, attemptId: "a1", output: "report", acceptance: "{\"ok\":true}\n", receipt: receiptBody });
    for (const path of [...files.keys()]) if (path.startsWith(WT)) files.delete(path);
    expect(done!.receiptPath).toBe(`${BASE}/.agents/tasks/t1/receipt.json`);
    expect(files.get(done!.receiptPath)).toBe(receiptBody);
    const row = (renderTaskManifest(db, "t1")?.files as Array<{ kind: string; path: string; sha256: string }>).find((file) => file.kind === "receipt")!;
    expect(row).toMatchObject({ path: "receipt.json", sha256: sha(receiptBody) });
    // A file changed behind the manifest no longer has the recorded hash; the stage chain moves when a receipt's output hash is forged.
    expect(sha(`${receiptBody} `)).not.toBe(row.sha256);
    const tip = receiptChain(db, RUN, "t1").tip;
    db.prepare("UPDATE lane_pilot_stage_receipt SET output_sha256=? WHERE task_id='t1' AND stage_id='verification'").run(sha("forged"));
    expect(verifyChain(db, RUN, "t1", tip)).toBe(false);
    expect(resolveTaskFile(db, "t1", "receipt")!.absPath).toBe(done!.receiptPath);
  });
});

describe("receipts and evidence — skeptic, near misses, goodhart", () => {
  const contractOf = (id: string, files: number) => ({
    schema_version: 2, id, title: id, risk: "low", lane: "w", project_cwd: "/w", read_first: [], interfaces: [], invariants: [],
    out_of_scope: [], expected_outputs: ["x"], owns_paths: ["src/"], never_touch: [], depends_on: [], objective: "o",
    acceptance: ["a"], verify: "none", verification: [], forecast: { files, checks_pass_first_try: true },
  });

  it("[sma:k_v_skeptic] the plan critic's countersign is scored on the same fact beside the PM's, and is named only where it was right against the PM", () => {
    const { db } = open();
    createRun(db, "run1", "projA");
    // Both tasks changed two files. t_pm: the PM said 2 (right), the critic said 6 against it. t_sk: the PM said 9, the critic said 2 against it.
    for (const [id, pmFiles, critic] of [["t_pm", 2, { agree: false, files: 6 }], ["t_sk", 9, { agree: false, files: 2 }]] as const) {
      createTask(db, { id, runId: "run1", kind: "bb", contract: contractOf(id, pmFiles) });
      createAttempt(db, { id: `a_${id}`, runId: "run1", taskId: id });
      db.prepare("UPDATE lane_pilot_attempt SET state='accepted', attempt_no=1 WHERE id=?").run(`a_${id}`);
      upsertAttemptChange(db, { attemptId: `a_${id}`, runId: "run1", taskId: id }, { outcome: "merged", changed: [{ path: "src/a.ts", status: "M" }, { path: "src/b.ts", status: "M" }] });
      recordStage(db, { runId: "run1", taskId: id, stageId: "plan-critique", state: "passed", input: "{}", result: { forecast_countersign: critic } });
    }
    const report = forecastReport(db, { projectId: "projA" });
    expect(report.scored.map((row) => `${row.taskId}:${row.score.files.error}`).sort()).toEqual(["t_pm:0", "t_sk:-7"]);
    expect(report.skeptic).not.toBeNull();
    // The skeptic's own numbers: errors +4 and 0 -> mean absolute 2; the PM's: 0 and -7 -> 3.5 (a separate sum, never mixed into the PM's).
    expect(report.skeptic!.overall).toMatchObject({ tasks: 2, filesMae: 2 });
    expect(report.calibration.overall).toMatchObject({ tasks: 2, filesMae: 3.5 });
    expect(report.skeptic!.rightAgainstPm).toEqual(["t_sk"]);
    // Without a countersign there is no skeptic line at all.
    const { db: bare } = open();
    createRun(bare, "run1", "projA");
    createTask(bare, { id: "t0", runId: "run1", kind: "bb", contract: contractOf("t0", 2) });
    createAttempt(bare, { id: "a_t0", runId: "run1", taskId: "t0" });
    bare.prepare("UPDATE lane_pilot_attempt SET state='accepted', attempt_no=1 WHERE id='a_t0'").run();
    upsertAttemptChange(bare, { attemptId: "a_t0", runId: "run1", taskId: "t0" }, { outcome: "merged", changed: [{ path: "src/a.ts", status: "M" }] });
    expect(forecastReport(bare, { projectId: "projA" }).skeptic).toBeNull();
  });

  it("[sma:k_v_skeptic] the near-miss channel lists what the writer flagged under «not scored» and changes no plan-fact verdict", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    registerCli(createCore(bb, db), {} as Services, migrations);
    createRun(db, "run_n", "proj_n");
    createTask(db, { id: "t1", runId: "run_n", kind: "bb", contract: {} });
    createTask(db, { id: "t2", runId: "run_n", kind: "bb", contract: {} });
    recordStage(db, { runId: "run_n", taskId: "t1", stageId: "plan-fact", state: "passed", input: "{}", result: { table: "ok", items: [], near_misses: ["almost dropped the migration"] } });
    recordStage(db, { runId: "run_n", taskId: "t2", stageId: "plan-fact", state: "passed", input: "{}", result: { table: "ok", items: [] } });
    const out = await harness.behavior.runCli(["nearmiss", "--project", "proj_n"]);
    expect(out.exitCode).toBe(0);
    const listed = JSON.parse(out.stdout) as { notScored: boolean; nearMisses: Array<{ taskId: string; miss: string; scored: string }> };
    expect(listed.notScored).toBe(true);
    expect(listed.nearMisses).toEqual([expect.objectContaining({ taskId: "t1", miss: "almost dropped the migration", scored: "not scored" })]);
    const none = await harness.behavior.runCli(["nearmiss", "--project", "other_project"]);
    expect(JSON.parse(none.stdout).nearMisses).toEqual([]);
  });

  it("[sma:k_lib_goodhart] an edit of a reference test or check is on the writer's trail; a new test file is not", () => {
    expect(referenceTestEdits([
      { path: "tests/a.test.ts", status: "M" }, { path: "tests/b.test.ts", status: "D" }, { path: "tests/c.test.ts", status: "R100" },
      { path: "tests/new.test.ts", status: "A" }, { path: "src/a.ts", status: "M" },
    ])).toEqual(["tests/a.test.ts", "tests/b.test.ts", "tests/c.test.ts"]);
    expect(referenceTestEdits([])).toEqual([]);
  });
});

describe("receipts and evidence — the badge, the rollback mark, the wires", () => {
  const score = (error: number, firstTry: boolean) => scoreForecast({ files: 2, checks_pass_first_try: true }, { files: 2 + error, firstTry, tokens: null, minutes: null });
  const rows = (n: number, error: number, firstTry: boolean) => Array.from({ length: n }, () => ({ area: "billing", score: score(error, firstTry) }));

  it("[sma:k_lib_passport] the badge is a pure function of the snapshot: unrated under three tasks, calibrated at files MAE 2 and first-try 0.7, miscalibrated past either", () => {
    const badge = (n: number, error: number, firstTry: boolean) => calibrationBadge(calibrate(rows(n, error, firstTry)).overall);
    expect(calibrationBadge(null)).toBe("unrated");
    expect(badge(2, 0, true)).toBe("unrated");
    expect(badge(3, 0, true)).toBe("calibrated");
    // MAE exactly 2 still holds; 3 does not.
    expect(badge(3, 2, true)).toBe("calibrated");
    expect(badge(3, 3, true)).toBe("miscalibrated");
    // First try right on 7 of 10 holds; on 6 of 10 it does not.
    const mixed = (right: number) => calibrate([...rows(right, 0, true), ...rows(10 - right, 0, false)]).overall;
    expect(calibrationBadge(mixed(7))).toBe("calibrated");
    expect(calibrationBadge(mixed(6))).toBe("miscalibrated");
    // The same snapshot gives the same badge.
    expect(badge(4, 1, true)).toBe(badge(4, 1, true));
  });

  it("[sma:k_lib_rollbackmark] the status names the cause a person stated, and says «cause unknown» when none was stated, whatever git shows", () => {
    const { db } = open();
    createRun(db, "run1", "p1");
    const revert = (taskId: string, cause: string | null) => appendTaskReceipt(db, { kind: "revert", projectId: "p1", runId: "run1", taskId, attemptId: `a_${taskId}`,
      baseSha: "b", changeSha: "c", resultCommit: "deadbeefcafe1234", state: "merged", summary: "revert of the task is clean",
      detail: { rollbackMark: { cause, by: "cli", at: new Date().toISOString() } } });
    revert("t_stated", "broke checkout");
    revert("t_silent", null);
    const { rollback } = createRollback({ db } as never, {} as never);
    expect(rollback.status("t_stated").rollback).toEqual({ commit: "deadbeefcafe1234", cause: "broke checkout" });
    expect(rollback.status("t_silent").rollback).toEqual({ commit: "deadbeefcafe1234", cause: "rolled back, cause unknown" });
    // A task that was never reverted has no rollback line at all.
    expect(rollback.status("t_other").rollback).toBeUndefined();
  });

  it("[sma:k_v_wires] on a real tree a declared wire is found where one source file names both ends and a test file does not count", () => {
    const tree = mkdtempSync(join(tmpdir(), "sma-wires-"));
    try {
      const sh = (command: string) => spawnSync("bash", ["-c", command], { cwd: tree, encoding: "utf8" });
      mkdirSync(join(tree, "src"));
      mkdirSync(join(tree, "tests"));
      writeFileSync(join(tree, "src/theme.ts"), "export const ui_theme = 'ui.theme'; loadSettings();\n");
      writeFileSync(join(tree, "src/provider.ts"), "loadSettings(); ThemeProvider();\n");
      writeFileSync(join(tree, "tests/only.test.ts"), "loadSettings(); GhostConsumer();\n");
      sh("git init -q && git add -A");
      const wires = [{ chain: ["ui.theme", "loadSettings", "ThemeProvider"] }, { chain: ["loadSettings", "GhostConsumer"] }];
      const ran = sh(wiresCommand(wires));
      expect(ran.status).toBe(0);
      const [met, gone] = readWires(wires, ran.stdout);
      expect(met!.broken).toBeNull();
      expect(met!.hops.map((hop) => hop.file)).toEqual(["src/theme.ts", "src/provider.ts"]);
      // GhostConsumer lives only in a test: the wire does not exist in the product code.
      expect(gone!.broken).toEqual({ from: "loadSettings", to: "GhostConsumer", file: null });
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });
});
