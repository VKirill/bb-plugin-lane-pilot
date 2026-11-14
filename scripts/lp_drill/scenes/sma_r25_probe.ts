// Probe of scenes/sma_r25.py (Region 25 · Receipts and evidence): runs the REAL code of THIS checkout (the commit under drill) on scratch databases and a scratch git
// repository, and prints what it found as one JSON line. It judges nothing: the scene compares each value with the node card's expected result and prove()s it.
// No model, no hub write, no network. Each section is independent: a section that throws reports its error and the scene fails only the nodes that read it.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { calibrationBadge, calibrationLine, calibrate, scoreForecast, stampForecastModel } from "../../../src/rooms/forecast/logic";
import { calibrationPassport, forecastReport } from "../../../src/rooms/forecast/server/report";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting } from "../../../src/rooms/plugin-db";
import { appendTaskReceipt, upsertAttemptChange } from "../../../src/rooms/rollback/store";
import { createRollback } from "../../../src/rooms/rollback/server";
import { recordStage } from "../../../src/rooms/runs/server/stage-records";
import { prPassport, preship, receiptChain, subagentReceipts, verifyChain } from "../../../src/rooms/tools/server/receipts";
import { saveRow as saveCheckerRow, startRun as startCheckerRun, finishRun as finishCheckerRun } from "../../../src/rooms/checkers/store";
import { plantAll, plantDefect } from "../../../src/rooms/checkers/mutators";
import { parsePlanFact } from "../../../src/rooms/tasks/plan-fact";
import { referenceTestEdits } from "../../../src/rooms/tasks/rails";
import { readWires, wiresCommand } from "../../../src/rooms/wires";
import { installJournal } from "../../../src/rooms/phase/server/driver-journal";
import { sameUnresolvedFindings, shouldRequestRepair, writerRepairReplySchema } from "../../../src/rooms/critique/code-critique";
import { createWorktree, integrateWorktree, removeLaneWorktree } from "../../../src/rooms/verification/git-integrate";
import { mergeInfo, revertCommitsInWorktree, worktreeState } from "../../../src/rooms/verification/git-rollback";
import { resolveGitOwnershipBase } from "../../../src/rooms/verification/git-ownership";
import { gateResolverFor } from "../../../src/rooms/verification/server";

const out: Record<string, unknown> = {};
const open = () => { const { bb } = createFakePluginHost({ pluginId: "lane-pilot" }); return openDatabase(bb); };
const section = async (name: string, run: () => unknown | Promise<unknown>) => { try { out[name] = await run(); } catch (cause) { out[name] = { error: cause instanceof Error ? cause.message : String(cause) }; } };
const git = (cwd: string, ...args: string[]) => spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

const forecastContract = (id: string, files: number, model?: string) => ({
  schema_version: 2, id, title: id, risk: "low", lane: "w", project_cwd: "/w", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["x"], owns_paths: ["src/"], never_touch: [], depends_on: [], objective: "o", acceptance: ["a"], verify: "none", verification: [],
  forecast: { files, checks_pass_first_try: true, ...(model ? { model } : {}) },
});
const accept = (db: ReturnType<typeof open>, id: string, files: number, model?: string, changed = 2, attemptNo = 1) => {
  createTask(db, { id, runId: "run1", kind: "bb", contract: forecastContract(id, files, model) });
  createAttempt(db, { id: `a_${id}`, runId: "run1", taskId: id });
  db.prepare("UPDATE lane_pilot_attempt SET state='accepted', attempt_no=? WHERE id=?").run(attemptNo, `a_${id}`);
  upsertAttemptChange(db, { attemptId: `a_${id}`, runId: "run1", taskId: id }, { outcome: "merged", changed: Array.from({ length: changed }, (_, i) => ({ path: `src/f${i}.ts`, status: "M" })) });
};

async function main() {
  // n1682, n1696, n1703: the forecast scored by arithmetic, with the declared footprint.
  await section("predict", () => {
    const score = scoreForecast({ files: 2, checks_pass_first_try: true, tokens: 100, minutes: 10 }, { files: 5, firstTry: false, tokens: 250, minutes: null });
    const footprint = scoreForecast({ files: 2, lines: 40, dependencies: ["zod"], checks_pass_first_try: true } as never,
      { files: 3, firstTry: true, tokens: null, minutes: null, lines: 90, dependencies: ["zod", "lodash"], changedPaths: ["a.ts", "b.ts", "c.ts"] }, ["a.ts", "b.ts"]);
    return { score, footprint };
  });
  // n1683, n1697, n1701: calibration per area, the model's own priors.
  await section("calibration", () => {
    const bad = scoreForecast({ files: 1, checks_pass_first_try: true }, { files: 4, firstTry: false, tokens: null, minutes: null });
    const good = scoreForecast({ files: 1, checks_pass_first_try: true }, { files: 1, firstTry: true, tokens: null, minutes: null });
    const report = calibrate([{ area: "docs", score: good }, { area: "billing", score: bad }, { area: "billing", score: bad }]);
    const forModel = (model: string) => calibrate([...Array.from({ length: 5 }, () => ({ area: "a", score: good, model: "m/a" })), { area: "a", score: good, model: "m/b" }], model);
    const db = open();
    createRun(db, "run1", "projA");
    const stamped = stampForecastModel({ forecast: { files: 1, checks_pass_first_try: true, model: "pm/sent" } } as never, "claude/opus") as { forecast: { model: string } };
    return { byArea: report.byArea.map((row) => ({ area: row.area, tasks: row.tasks, filesMae: row.filesMae, firstTryHit: row.firstTryHit })), overall: report.overall?.tasks, empty: calibrate([]),
      modelA: forModel("m/a").overall?.tasks, modelB: forModel("m/b").overall?.tasks, lineB: calibrationLine(forModel("m/b").overall ?? undefined), lineA: calibrationLine(forModel("m/a").overall ?? undefined), stamped: stamped.forecast.model };
  });
  // n1687, n1700: the calibration passport and its badge.
  await section("passport", () => {
    const db = open();
    createRun(db, "run1", "projA");
    for (const [key, value] of [["hostId", "h"], ["pmWorkspacePath", "/p"], ["writerWorkspacePath", "/w"], ["pmProviderId", "codex"], ["pmModel", "gpt-a"], ["writerProviderId", "codex"], ["writerModel", "gpt-w"]] as const)
      saveProjectSetting(db, "projA", key, value);
    for (let i = 0; i < 4; i++) accept(db, `pa${i}`, 2, "codex/gpt-a");
    accept(db, "pb0", 2, "codex/gpt-b");
    saveProjectSetting(db, "projA", "pmModel", "gpt-b");
    const forB = calibrationPassport(db, "projA");
    saveProjectSetting(db, "projA", "pmModel", "gpt-a");
    const forA = calibrationPassport(db, "projA");
    accept(db, "pa4", 15, "codex/gpt-a", 2, 2);
    const worse = calibrationPassport(db, "projA");
    const rows = (n: number, error: number, firstTry: boolean) => Array.from({ length: n }, () => ({ area: "x", score: scoreForecast({ files: 2, checks_pass_first_try: true }, { files: 2 + error, firstTry, tokens: null, minutes: null }) }));
    const badge = (n: number, error: number, firstTry: boolean) => calibrationBadge(calibrate(rows(n, error, firstTry)).overall);
    return { forB: { model: forB.model, tasks: forB.tasks, badge: forB.badge }, forA: { tasks: forA.tasks, badge: forA.badge }, worse: worse.badge,
      badges: { none: calibrationBadge(null), two: badge(2, 0, true), three: badge(3, 0, true), mae2: badge(3, 2, true), mae3: badge(3, 3, true) } };
  });
  // n1686: the skeptic's countersign next to the PM's.
  await section("skeptic", () => {
    const db = open();
    createRun(db, "run1", "projA");
    for (const [id, pmFiles, critic] of [["t_pm", 2, { agree: false, files: 6 }], ["t_sk", 9, { agree: false, files: 2 }]] as const) {
      accept(db, id, pmFiles);
      recordStage(db, { runId: "run1", taskId: id, stageId: "plan-critique", state: "passed", input: "{}", result: { forecast_countersign: critic } });
    }
    const report = forecastReport(db, { projectId: "projA" });
    return { skeptic: report.skeptic?.overall?.filesMae, pm: report.calibration.overall?.filesMae, rightAgainstPm: report.skeptic?.rightAgainstPm };
  });
  // n1692 and the chain over a receipt: a changed receipt moves the tip, the old tip no longer verifies.
  await section("chain", () => {
    const db = open();
    createRun(db, "run1", "projA");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { id: "t1" } as never });
    recordStage(db, { runId: "run1", taskId: "t1", stageId: "verification", state: "passed", input: "npm test", result: { exitCode: 0 } });
    const first = receiptChain(db, "run1", "t1");
    const same = verifyChain(db, "run1", "t1", first.tip);
    db.prepare("UPDATE lane_pilot_stage_receipt SET output_sha256='forged' WHERE task_id='t1'").run();
    const second = receiptChain(db, "run1", "t1");
    return { same, moved: second.tip !== first.tip, oldVerifies: verifyChain(db, "run1", "t1", first.tip), newVerifies: verifyChain(db, "run1", "t1", second.tip), links: first.links.length };
  });
  // n1695, n1704: what stops a ship.
  await section("preship", () => {
    const db = open();
    createRun(db, "run1", "projA");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: { id: "t1" } as never });
    createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
    db.prepare("UPDATE lane_pilot_attempt SET state='running' WHERE id='a1'").run();
    const open1 = preship(db, "projA");
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='a1'").run();
    db.prepare("INSERT INTO lane_pilot_deferral(id, project_id, what, kind, state, created_at, updated_at) VALUES('d1','projA','wait for the owner','plan_decision','open',1,1)").run();
    const kept = preship(db, "projA");
    const run = startCheckerRun(db as never, { source: "drill", config: {} });
    saveCheckerRow(db as never, run.id, { defectId: "d1", taskId: "t", defectClass: "outside_owns", checker: "ownership", outcome: "miss", flagged: false, expected: true, summary: "missed", detail: "", tokens: null, costUsd: null } as never);
    finishCheckerRun(db as never, run.id, "done", 0);
    const missed = preship(db, "projA");
    return { open: { clear: open1.clear, items: open1.items.map((item) => item.what) }, kept: { clear: kept.clear, items: kept.items.map((item) => item.disposition) },
      missed: { clear: missed.clear, items: missed.items.map((item) => item.what) } };
  });
  // n1705: the pull-request pack from the task's receipts, n1693: the receipt coverage report.
  await section("pack", () => {
    const db = open();
    createRun(db, "run_m", "proj_m", "bb", "/w");
    const contract = { schema_version: 2, id: "task_m", title: "T", kind: "feature", acceptance: ["item one works", "item two works"], verification: [{ command: "npm test" }], forecast: { files: 2, checks_pass_first_try: true } };
    createTask(db, { id: "task_m", runId: "run_m", kind: "bb", contract });
    createAttempt(db, { id: "att_m", runId: "run_m", taskId: "task_m" });
    db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att_m'").run();
    db.prepare("INSERT INTO lane_pilot_attempt_change (attempt_id, run_id, task_id, changed_json, recorded_at, updated_at) VALUES (?,?,?,?,?,?)").run("att_m", "run_m", "task_m", JSON.stringify(["src/a.ts", "src/b.ts"]), 1, 1);
    recordStage(db, { runId: "run_m", taskId: "task_m", stageId: "verification", state: "failed", input: "{}", result: { ran: [{ command: "npm test", exitCode: 1, outputSha256: "abc123def456aa" }] } });
    recordStage(db, { runId: "run_m", taskId: "task_m", stageId: "plan-fact", state: "failed", input: "{}", result: { table: "ok", items: [{ item: 1, acceptance: "item one works", verdict: "proven" }, { item: 2, acceptance: "item two works", verdict: "unproven" }] } });
    const text = prPassport(db, "run_m", "task_m");
    const cover = open();
    createRun(cover, "run_s", "proj_s", "bb", "/w");
    const seed = (taskId: string, attemptId: string, packet: string) => {
      createTask(cover, { id: taskId, runId: "run_s", kind: "bb", contract: {} });
      createAttempt(cover, { id: attemptId, runId: "run_s", taskId });
      cover.prepare("INSERT INTO lane_pilot_attempt_reasoning (attempt_id, trace_json) VALUES (?,?)").run(attemptId, JSON.stringify({ dispatchContext: packet }));
    };
    seed("t1", "a1", "x".repeat(1000)); seed("t2", "a2", "x".repeat(2000)); seed("t3", "a3", "x".repeat(3000));
    recordStage(cover, { runId: "run_s", taskId: "t1", stageId: "plan-fact", state: "passed", input: "{}", result: { table: "ok", items: [] } });
    recordStage(cover, { runId: "run_s", taskId: "t2", stageId: "plan-fact", state: "failed", input: "{}", result: { table: "ok", items: [{ item: 1, evidence: [{ evidence: "src/gone.ts", code: "file_not_in_diff" }] }] } });
    recordStage(cover, { runId: "run_s", taskId: "t3", stageId: "plan-fact", state: "skipped", input: "{}", result: { table: "missing" } });
    const report = subagentReceipts(cover, { projectId: "proj_s", days: 30 });
    return { lines: text.split("\n").filter((line) => /^(### |- item|- `npm|- verification|Receipt chain)/.test(line)), tipLine: text.split("\n").at(-1)?.startsWith("Receipt chain tip: `") ?? false,
      coverage: report.coverage, phantoms: report.phantoms, median: report.pack.median };
  });
  // n1698, n1685: planted defects are real edits that carry no mark; n1699: reference-test trail and near misses.
  await section("canary", () => {
    const input = { taskId: "t", source: "src/a.ts",
      contract: { project_cwd: "/w", owns_paths: ["src/"], never_touch: [], acceptance: ["works"], verification: [{ command: "npm test", cwd: "/w" }] },
      changes: [{ path: "src/a.ts", before: "import x from './x'\nconst a = 1\nif (i < n) return i\n", after: "import x from './x'\nconst a = 2\nif (i < n) return i\n" }, { path: "src/b.ts", before: null, after: "new file\n" }] } as never;
    const planted = plantAll(input);
    const off = plantDefect({ ...(input as object), changes: [{ path: "src/a.ts", before: null, after: "if (i < n) return i;\n" }] } as never, "off_by_one");
    return { classes: planted.map((row) => row.defect.class), marked: JSON.stringify(planted.map((row) => ({ changes: row.changes }))).includes("planted"), offAfter: off?.changes[0]?.after, expected: off?.defect.expected };
  });
  await section("goodhart", () => {
    const table = parsePlanFact('done\n```plan-fact\n{"rows":[{"item":1,"status":"done","evidence":["src/a.ts:1-2"]}],"near_misses":["almost dropped the migration"]}\n```') as { status: string; nearMisses?: string[] };
    return { edits: referenceTestEdits([{ path: "tests/a.test.ts", status: "M" }, { path: "tests/b.test.ts", status: "D" }, { path: "tests/new.test.ts", status: "A" }, { path: "src/a.ts", status: "M" }]), nearMisses: table.nearMisses };
  });
  // n1702: a challenge closes only on a judged dispute or a change; n1688: an open grill blocks the plan.
  await section("grill", () => {
    const finding = { id: "f1", severity: "blocking" as const, finding: "f", criterion: "c", path: "a.ts", line: 1, evidence: "x" };
    const reply = (status: string, evidence?: string) => writerRepairReplySchema.safeParse({ replies: [{ id: "f1", status, ...(evidence !== undefined ? { evidence } : {}) }] }).success;
    const settings = { enabled: true, mode: "gate", autoFix: true, maxRounds: 3 } as never;
    const db = open();
    const journal = installJournal({ db, now: () => 100, reactions: {} } as never);
    const run = (id: string, status: string, planSha: string, open: string[]) => db.prepare(`INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,link_run_id,status,inputs_json,output_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, "grill-plan", 1, "s", "{}", "projA", "run1", "succeeded", JSON.stringify({ plan_sha: planSha }), JSON.stringify({ status, open }), 10, 10);
    run("g1", "open", "shaA", ["the migration is not reversible", "no owner for the queue"]);
    const phase = (sha: string, words: unknown[] = [], grillGate?: boolean) => ({ projectId: "projA", runId: "run1", record: { ...(grillGate === false ? { grillGate: false } : {}), words, plan: { sha, submittedAt: 1 } } }) as never;
    const blocked = journal.grillBlock(phase("shaA"));
    return { disputeWithEvidence: reply("disputed", "counterexample in tests/x.test.ts"), disputeEmpty: reply("disputed", ""), fixedNoEvidence: reply("fixed"),
      repeated: sameUnresolvedFindings([finding], [finding]), changed: sameUnresolvedFindings([finding], [{ ...finding, id: "f2", criterion: "other", path: "b.ts" }]), nothingLeft: sameUnresolvedFindings([finding], []),
      repairOnRework: shouldRequestRepair({ settings, result: { status: "rework", summary: "s", decision: "changes_requested", findings: [finding] } as never, round: 0 }),
      repairOnBlock: shouldRequestRepair({ settings, result: { status: "block", summary: "s", decision: "changes_requested", findings: [finding] } as never, round: 0 }),
      blocked: blocked ? { run: blocked.runId, open: blocked.open } : null, otherPlan: journal.grillBlock(phase("shaB")), switchedOff: journal.grillBlock(phase("shaA", [], false)),
      lifted: journal.grillBlock(phase("shaA", [{ turn: "planning", decision: "yes", key: "shaA", at: 50 }])) };
  });
  // n1690, n1707: the declared wires on a real tree.
  await section("wires", () => {
    const tree = mkdtempSync(join(tmpdir(), "sma-r25-wires-"));
    try {
      mkdirSync(join(tree, "src")); mkdirSync(join(tree, "tests"));
      writeFileSync(join(tree, "src/theme.ts"), "ui.theme; loadSettings();\n");
      writeFileSync(join(tree, "src/provider.ts"), "loadSettings(); ThemeProvider();\n");
      writeFileSync(join(tree, "tests/only.test.ts"), "loadSettings(); GhostConsumer();\n");
      git(tree, "init", "-q");
      const wires = [{ chain: ["ui.theme", "loadSettings", "ThemeProvider"] }, { chain: ["loadSettings", "GhostConsumer"] }];
      const ran = spawnSync("bash", ["-c", wiresCommand(wires)], { cwd: tree, encoding: "utf8" });
      const [met, gone] = readWires(wires, ran.stdout);
      return { exit: ran.status, hops: met!.hops.map((hop) => hop.file), metBroken: met!.broken, goneBroken: gone!.broken, parsed: readWires([wires[0]!], "__lp_wire__ 0 0 src/theme.ts\n")[0]!.broken };
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });
  // n1681, n1694, n1709: reverify on the accepted commit, a revert with a stated cause, the status that names it.
  await section("rollback", async () => {
    const root = mkdtempSync(join(tmpdir(), "sma-r25-undo-"));
    const base = join(root, "project");
    const HOST = "host-1";
    try {
      git(root, "init", "-q", "-b", "main", base);
      writeFileSync(join(base, "server.ts"), "line1\nline2\nline3\n");
      git(base, "add", "-A"); git(base, "commit", "-qm", "base");
      const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
      const db = openDatabase(bb);
      createRun(db, "run1", "projA", "bb", base, "none", undefined, HOST);
      const host = { call: async (method: string, input: Record<string, any>) => {
        const hostId = HOST;
        switch (method) {
          case "gitCreateWorktree": return { hostId, ...await createWorktree({ basePath: input.basePath, name: input.name, commit: input.commit, targetPath: join(root, "wt", input.name, basename(input.basePath)) }) };
          case "gitPrepareWorktree": return { hostId, linked: [] };
          case "gitRemoveWorktree": return { hostId, ...await removeLaneWorktree({ basePath: input.basePath, worktreePath: input.worktreePath }) };
          case "gitMergeInfo": return { hostId, ...await mergeInfo({ basePath: input.basePath, commit: input.commit, attemptId: input.attemptId }) };
          case "gitRevertCommits": return { hostId, ...await revertCommitsInWorktree({ worktreePath: input.worktreePath, commits: input.commits }) };
          case "gitWorktreeState": return { hostId, ...await worktreeState({ basePath: input.basePath, worktreePath: input.worktreePath }) };
          case "gitOwnershipBase": return { hostId, ...await resolveGitOwnershipBase({ projectCwd: input.projectCwd }) };
          case "gitIntegrate": return { hostId, ...await integrateWorktree({ basePath: input.basePath, worktreePath: input.worktreePath, message: input.message, removeWorktree: input.removeWorktree }) };
          default: throw new Error(`unexpected host call ${method}`);
        }
      } };
      const { rollback } = createRollback({ bb, db, host, log: () => undefined, isDisposed: () => false, configForRun: async () => ({ projectId: "projA", hostId: HOST, writerWorkspacePath: base }) } as never, {
        resolveIntegrationGate: gateResolverFor({ host, db, log: () => undefined } as never),
        runVerification: async (_config: unknown, task: { verification: Array<{ command: string; cwd: string }> }) => task.verification.map((check) => {
          const ran = spawnSync("bash", ["-lc", check.command], { cwd: check.cwd, encoding: "utf8" });
          return { command: check.command, exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
        }),
      } as never);
      const task = { schema_version: 2, id: "t1", title: "title of t1", risk: "low", lane: "server", project_cwd: base, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
        expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: "t1", acceptance: ["done"], verify: "tests", verification: [{ command: "grep -qx rewritten server.ts", cwd: base }] };
      createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: task });
      createAttempt(db, { id: "att_t1", runId: "run1", taskId: "t1" });
      const made = await createWorktree({ basePath: base, name: "att_t1", targetPath: join(base, "..", "wt", "att_t1", "project") });
      rollback.noteBase("att_t1", made.baseSha);
      writeFileSync(join(made.path!, "server.ts"), "rewritten\n");
      const merged = await integrateWorktree({ basePath: base, worktreePath: made.path!, message: "t1: title of t1\n\nLane-Pilot-Attempt: att_t1", removeWorktree: true });
      rollback.noteMerge("att_t1", merged);
      db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att_t1'").run();
      const before = rollback.status("t1").rollback ?? null;
      const reverted = await rollback.revert("t1", { why: "broke checkout", by: "owner" });
      const after = rollback.status("t1").rollback ?? null;
      const tree = readFileSync(join(base, "server.ts"), "utf8");
      // Main is back to the old text now; the accepted change is still checked as it was accepted, on its own commit.
      const checked = await rollback.reverify("t1");
      const refused = await rollback.revert("t1", { skipGate: true });
      return { reverify: { ok: checked.ok, state: checked.state, summary: checked.summary }, before, reverted: { ok: reverted.ok, state: reverted.state, files: (reverted.files as unknown[] | undefined)?.length ?? 0 },
        tree, after: after ? { cause: (after as { cause: string }).cause, hasCommit: Boolean((after as { commit: unknown }).commit) } : null, silentRefused: refused.state, refusedSummary: refused.summary, revertedIn: checked.revertedIn === reverted.commit };
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  // n1709 again: a revert nobody gave a cause for says so, whatever git shows.
  await section("mark", () => {
    const db = open();
    createRun(db, "run1", "p1");
    appendTaskReceipt(db, { kind: "revert", projectId: "p1", runId: "run1", taskId: "t1", attemptId: "a1", baseSha: "b", changeSha: "c", resultCommit: "abc", state: "merged", summary: "s", detail: { rollbackMark: { cause: null, by: "cli", at: "now" } } });
    return { silent: createRollback({ db } as never, {} as never).rollback.status("t1").rollback };
  });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
void main();
