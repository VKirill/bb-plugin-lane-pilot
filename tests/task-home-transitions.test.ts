import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createAttempt, createRun, createTask, openDatabase, saveTaskGitBase } from "../src/rooms/plugin-db";
import { taskV2Schema } from "../src/rooms/contracts";
import { openTaskHome, readTaskFile, recordTaskFile, renderTaskManifest, resolveTaskFile, type TaskFileKind } from "../src/rooms/storage";
import {
  bbTaskFileIo, placeTaskHomeIn, recordAcceptanceFiles, recordCheckFiles, recordCritiqueRound, recordPlanCritique, recordTaskClose, recordTaskEdition,
  recordWriterReport, stagePlanText, taskHomeBrief, writeDispatchHome,
} from "../src/rooms/writer/server/task-home";
import { taskFolderLines } from "../src/rooms/writer/server/writer-task";
import { readFirstScopeFindings } from "../src/rooms/tasks/server/read-first-scope";
import { runPlanFactStage } from "../src/rooms/writer/server/plan-fact";

/**
 * One test per node → node transition of the main task path (audit handoff-map §5.5, T1–T17): the next node finds the previous node's output
 * THROUGH THE MANIFEST of the task's home (docs/task-folder.md). Each test names the producer mutation that must break it.
 */
const BASE = "/srv/proj";
const WT = "/wt/attempt-a";
const RUN = "lprun_t";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const contract = (id: string) => taskV2Schema.parse({
  schema_version: 2, id, title: "T", risk: "high", lane: "writer", project_cwd: BASE, read_first: [], interfaces: [], invariants: [], out_of_scope: [],
  expected_outputs: ["src/a.ts"], owns_paths: ["src/**"], never_touch: [], depends_on: [], objective: "Save the form", acceptance: ["the form saves"],
  verify: "none", verification: [{ command: "npm test", cwd: BASE, timeout_sec: 60 }],
});

function world(opts: { failWrites?: (path: string) => boolean } = {}) {
  const { bb: host } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(host);
  createRun(db, RUN, "proj", "bb", BASE);
  const files = new Map<string, string>();
  const bb = {
    log: { warn: () => undefined, info: () => undefined },
    sdk: { files: {
      read: async ({ path }: { path: string }) => (files.has(path) ? { content: files.get(path) } : null),
      write: async ({ path, content }: { path: string; content: string }) => { if (opts.failWrites?.(path)) throw new Error("EACCES: disk refused"); files.set(path, content); },
    } },
  };
  const ctx = { bb, db, log: () => undefined } as never as Parameters<typeof stagePlanText>[0] & { log: (line: string) => void };
  const io = bbTaskFileIo(bb as never, "h1", BASE);
  const task = (id: string) => { createTask(db, { id, runId: RUN, kind: "bb", contract: contract(id) }); return contract(id); };
  const dispatch = (id: string, plan: string, phaseId?: string) =>
    writeDispatchHome(db, io, { taskId: id, projectId: "proj", runId: RUN, basePath: BASE, hostId: "h1", task: task(id), plan, ...(phaseId ? { phaseId } : {}) });
  const kinds = (id: string) => (renderTaskManifest(db, id)?.files as Array<{ kind: TaskFileKind; path: string; readers: string[]; read_by: Array<{ node: string; sha256: string }> }>) ?? [];
  return { db, bb, ctx, io, files, task, dispatch, kinds };
}

describe("main path transitions through the task manifest", () => {
  // Mutation: dispatch recording PLAN.md under another kind, skipping the plan-source row, or keeping the path line as the plan.
  it("[sma:ap_context] T1 dispatch → task-folder: contract.v1.json, PLAN.md (the plan TEXT) and context/plan-source.md with source_path and sha256 are in the manifest", async () => {
    const w = world();
    const shared = "# Plan X\n\n1. do the form\n";
    w.files.set(`${BASE}/.agents/plans/x.md`, shared);
    w.files.set(`${BASE}/.agents/plans/notes.md`, "shared notes\n");
    const { planText } = await w.dispatch("t1", ".agents/plans/x.md");
    expect(planText).toBe(shared);
    expect(w.kinds("t1").map((row) => `${row.kind}:${row.path}`)).toEqual(["contract:contract.v1.json", "plan:PLAN.md", "plan-source:context/plan-source.md"]);
    expect(w.files.get(resolveTaskFile(w.db, "t1", "plan")!.absPath)).toBe(shared);
    const source = w.files.get(resolveTaskFile(w.db, "t1", "plan-source")!.absPath)!;
    expect(source).toContain("source_path: .agents/plans/x.md");
    expect(source).toContain(`sha256: ${sha(shared)}`);
    // A plan in prose that names a shared file gets that file snapshotted too; the prose stays the plan.
    await w.dispatch("t2", "Follow .agents/plans/notes.md and fix the form.");
    expect(w.files.get(resolveTaskFile(w.db, "t2", "plan")!.absPath)).toBe("Follow .agents/plans/notes.md and fix the form.\n");
    expect(w.files.get(resolveTaskFile(w.db, "t2", "plan-source")!.absPath)).toContain(`sha256: ${sha("shared notes\n")}`);
  });

  // Mutation: the dispatch logging a failed home write and going on.
  it("T1 a failed home write stops the dispatch and leaves no plan to resolve", async () => {
    const w = world({ failWrites: (path) => path.endsWith("/PLAN.md") });
    await expect(w.dispatch("t1", "plan text")).rejects.toThrow(/EACCES/);
    expect(resolveTaskFile(w.db, "t1", "plan")).toBeNull();
    await expect(stagePlanText(w.ctx, "t1", "pm-read", "in-memory plan")).rejects.toThrow(/lists no PLAN.md/);
  });

  // Mutation: PLAN.md recorded for a neighbour task, or pm-read reading the dispatch's in-memory plan instead of the manifest.
  it("[sma:pc_folder] T2 task-folder → pm-read: pm-read reads PLAN.md through the manifest, not the in-memory plan, and its read is recorded", async () => {
    const w = world();
    await w.dispatch("t1", "the real plan");
    await w.dispatch("t2", "the neighbour's plan");
    expect(await stagePlanText(w.ctx, "t1", "pm-read", "a stale in-memory plan")).toBe("the real plan\n");
    expect(w.kinds("t1").find((row) => row.kind === "plan")!.read_by).toEqual([expect.objectContaining({ node: "pm-read", sha256: sha("the real plan\n") })]);
    // Two current rows of one kind are ambiguous: the resolver refuses rather than guess.
    w.db.prepare("INSERT INTO lane_pilot_task_file(task_id,path,kind,sha256,bytes,producer_json,plugin_version,created_at) VALUES('t1','PLAN-2.md','plan','x',1,'{}','0',1)").run();
    expect(resolveTaskFile(w.db, "t1", "plan")).toBeNull();
  });

  // Mutation: the critic reading another PLAN.md than the manifest's, or the verdict not recorded as kind plan-critique.
  it("T3 pm-read → plan-critique: the critic's input is PLAN.md's manifest sha; each verdict is critique/plan.r<K>.json and supersedes the last", async () => {
    const w = world();
    await w.dispatch("t1", "plan one");
    const text = await stagePlanText(w.ctx, "t1", "plan-critique", "ignored");
    expect(sha(text)).toBe(resolveTaskFile(w.db, "t1", "plan")!.sha256);
    await recordPlanCritique(w.ctx, { taskId: "t1", runId: RUN, allowed: false, reason: "no checks" });
    await recordPlanCritique(w.ctx, { taskId: "t1", runId: RUN, allowed: true });
    const verdict = resolveTaskFile(w.db, "t1", "plan-critique")!;
    expect(verdict.path).toBe("critique/plan.r2.json");
    expect(JSON.parse(w.files.get(verdict.absPath)!)).toMatchObject({ round: 2, allowed: true, plan: { path: "PLAN.md", sha256: sha("plan one\n") } });
    expect(w.kinds("t1").find((row) => row.path === "critique/plan.r2.json")).toMatchObject({ supersedes: "critique/plan.r1.json" });
  });

  // Mutation: the phase id dropped from the home row.
  it("[sma:p4_result] T5 phase plan → task: a task of a phase names the phase as its parent and the phase's manifest by reference", async () => {
    const w = world();
    await w.dispatch("t1", "plan", "ph_abc");
    expect(renderTaskManifest(w.db, "t1")).toMatchObject({ phase_id: "ph_abc", parent: { kind: "phase", id: "ph_abc", manifest: ".agents/phases/ph_abc/manifest.json" } });
  });

  // Mutation: placing a folder listing (every task's home, or the old shared items folder) instead of the manifest's own files.
  it("[sma:wi_spool] T6 task-folder → worktree: the worktree gets its own task's manifest-listed files and nothing of the neighbour", async () => {
    const w = world();
    await w.dispatch("t1", "plan one");
    await w.dispatch("t2", "plan two");
    w.files.set(`${BASE}/.agents/plans/items/t2/PLAN.md`, "old neighbour\n");
    const placed = await placeTaskHomeIn(w.ctx, { taskId: "t1", hostId: "h1", worktreePath: WT, basePath: BASE });
    expect(placed.sort()).toEqual([".agents/tasks/t1/PLAN.md", ".agents/tasks/t1/contract.v1.json", ".agents/tasks/t1/manifest.json"]);
    expect([...w.files.keys()].filter((path) => path.startsWith(WT)).every((path) => path.startsWith(`${WT}/.agents/tasks/t1/`))).toBe(true);
  });

  // Mutation: the brief listing a folder (or naming a shared plan) instead of the manifest's PLAN.md; the linter letting a shared plan through.
  it("[sma:wi_spool] T8 brief → writer: the brief names PLAN.md from the manifest; read_first into a shared plan, another home or another chat is refused", async () => {
    const w = world();
    await w.dispatch("t1", "plan one");
    await w.dispatch("t2", "plan two");
    const brief = taskHomeBrief(w.db, "t1", "a1")!;
    const lines = taskFolderLines({ path: brief.path, files: brief.files, home: { plan: brief.plan, checkLog: brief.checkLog, attemptFolder: brief.attemptFolder } }).join("\n");
    expect(lines).toContain("Read the plan first: .agents/tasks/t1/PLAN.md");
    expect(lines).not.toContain("t2");
    const codes = (paths: string[]) => readFirstScopeFindings({ id: "t1", read_first: paths }, "thr_pm").map((finding) => finding.code);
    expect(codes([".agents/plans/x.md"])).toEqual(["read_first_shared_plan"]);
    expect(codes([".agents/plans/items/t2/PLAN.md"])).toEqual(["read_first_shared_plan"]);
    expect(codes([".agents/tasks/t2/PLAN.md"])).toEqual(["read_first_foreign_task"]);
    expect(codes([".bb/chats/thr_other/artifacts/a.md"])).toEqual(["read_first_foreign_chat"]);
    expect(codes(["src/a.ts", ".agents/tasks/t1/PLAN.md", ".bb/chats/thr_pm/a.md"])).toEqual([]);
    expect(readFirstScopeFindings({ id: "t1", read_first: [".bb/chats/thr_pm/a.md"] }).map((finding) => finding.code)).toEqual(["read_first_foreign_chat"]);
  });

  // Mutation: report.md written from a template instead of the output, the check log recorded under another kind or another attempt.
  it("[sma:ap_run_dir] T9 writer → checks: attempts/<a>/report.md is the real output; checks.json and the failed check's log are recorded, and the next attempt's brief finds the log by the manifest", async () => {
    const w = world();
    await w.dispatch("t1", "plan");
    await recordWriterReport(w.ctx, { taskId: "t1", attemptId: "a1", runId: RUN }, "I changed src/a.ts.\nLESSON: run the form test first");
    expect(w.files.get(resolveTaskFile(w.db, "t1", "writer-report", { attemptId: "a1" })!.absPath)).toBe("I changed src/a.ts.\nLESSON: run the form test first\n");
    const recorded = await recordCheckFiles(w.ctx, { taskId: "t1", runId: RUN, attemptId: "a1", cleanOutput: (text) => text,
      verifies: [{ command: "npm run lint", exitCode: 0 }, { command: "npm test", exitCode: 1, stdout: "1 failed", stderr: "" }] });
    expect(recorded!.checkLog).toBe(".agents/tasks/t1/attempts/a1/logs/02-npm-test.log");
    expect(JSON.parse(w.files.get(resolveTaskFile(w.db, "t1", "checks")!.absPath)!).checks).toEqual([
      { command: "npm run lint", exit_code: 0 }, { command: "npm test", exit_code: 1, log: "attempts/a1/logs/02-npm-test.log" }]);
    expect(taskHomeBrief(w.db, "t1", "a2")!.checkLog).toBe(".agents/tasks/t1/attempts/a1/logs/02-npm-test.log");
    // Every file of the attempt sits in its own folder: one folder per attempt.
    expect(w.kinds("t1").filter((row) => row.path.startsWith("attempts/")).every((row) => row.path.startsWith("attempts/a1/"))).toBe(true);
  });

  // Mutation: plan-fact reading the in-memory answer instead of the attempt's report.md, or report.md recorded for another attempt.
  it("T10 checks → plan-fact: plan-fact reads the attempt's report.md through the manifest and records plan-fact.json naming it", async () => {
    const w = world();
    const BASE_SHA = "b".repeat(40);
    await w.dispatch("t1", "plan");
    createAttempt(w.db, { id: "a1", runId: RUN, taskId: "t1" });
    saveTaskGitBase(w.db, "t1", { baseRef: "main", baseSha: BASE_SHA, initialHeadSha: BASE_SHA, branch: "lp/t1", compareCommitted: true });
    const table = (status: string) => `Done.\n\n\`\`\`plan-fact\n${JSON.stringify([{ item: 1, status, evidence: ["src/a.ts:4-5"] }])}\n\`\`\`\n`;
    await recordWriterReport(w.ctx, { taskId: "t1", attemptId: "a1", runId: RUN }, table("done"));
    const host = { call: async () => ({ hostId: "h", exitCode: 0, stdout: "+++ b/src/a.ts\n@@ -3 +4,2 @@\n---untracked---\n", stderr: "" }) };
    const result = await runPlanFactStage({ ...(w.ctx as object), host } as never, { projectId: "proj", runId: RUN, taskId: "t1", attempt: 1, hostId: "h1", task: contract("t1"),
      answers: ["no table in memory"], attemptId: "a1", produced: ["src/a.ts"], verification: [{ command: "npm test", exitCode: 0 }] });
    expect(result.check).toMatchObject({ table: "ok" });
    const fact = resolveTaskFile(w.db, "t1", "plan-fact", { attemptId: "a1" })!;
    expect(fact.path).toBe("attempts/a1/plan-fact.json");
    expect(JSON.parse(w.files.get(fact.absPath)!).report).toEqual({ path: "attempts/a1/report.md", sha256: sha(table("done")) });
    expect(w.kinds("t1").find((row) => row.kind === "writer-report")!.read_by.map((read) => read.node)).toContain("plan-fact");
  });

  // Mutation: barrier-input written into the worktree (it dies with the merge) or the verdict of round K not recorded with its round.
  it("[sma:ap_run_dir] T11–T12 checks → code-critique → repair: barrier-input.json is in the base home; round K's findings resolve as code-critique.r<K>.json", async () => {
    const w = world();
    await w.dispatch("t1", "plan");
    await recordCritiqueRound(w.ctx, { taskId: "t1", runId: RUN, attemptId: "a1", round: 0, barrierInput: { diff: "d0" }, verdict: { state: "blocked", findings: ["f1"] } });
    await recordCritiqueRound(w.ctx, { taskId: "t1", runId: RUN, attemptId: "a1", round: 1, barrierInput: { diff: "d1" }, verdict: { state: "passed" } });
    const input = resolveTaskFile(w.db, "t1", "barrier-input", { attemptId: "a1" })!;
    expect(input.absPath).toBe(`${BASE}/.agents/tasks/t1/attempts/a1/barrier-input.json`);
    expect(JSON.parse(w.files.get(input.absPath)!)).toEqual({ diff: "d1" });
    const verdict = resolveTaskFile(w.db, "t1", "code-critique", { attemptId: "a1" })!;
    expect(verdict).toMatchObject({ path: "attempts/a1/code-critique.r1.json", round: 1 });
    expect(w.kinds("t1").find((row) => row.path === "attempts/a1/code-critique.r1.json")).toMatchObject({ supersedes: "attempts/a1/code-critique.r0.json" });
    expect(JSON.parse(w.files.get(`${BASE}/.agents/tasks/t1/attempts/a1/code-critique.r0.json`)!)).toMatchObject({ findings: ["f1"] });
  });

  // Mutation: the receipts written into the worktree only, or into the run's shared artifacts.
  it("[sma:ta_cleanup] T13 code-critique → acceptance: acceptance.json and receipt.json are written once into the base home; acceptancePath exists after the worktree is removed", async () => {
    const w = world();
    await w.dispatch("t1", "plan");
    await placeTaskHomeIn(w.ctx, { taskId: "t1", hostId: "h1", worktreePath: WT, basePath: BASE });
    const done = await recordAcceptanceFiles(w.ctx, { taskId: "t1", runId: RUN, attemptId: "a1", output: "the report", acceptance: "{\"ok\":true}\n", receipt: "{\"status\":\"accepted\"}\n" });
    for (const path of [...w.files.keys()]) if (path.startsWith(WT)) w.files.delete(path);
    expect(done!.acceptancePath).toBe(`${BASE}/.agents/tasks/t1/acceptance.json`);
    expect(w.files.get(done!.acceptancePath)).toBe("{\"ok\":true}\n");
    expect(w.files.has(done!.receiptPath)).toBe(true);
    expect([...w.files.keys()].filter((path) => path.endsWith("/acceptance.json"))).toEqual([done!.acceptancePath]);
    // The real output became the attempt's report.md when the finish had not recorded it.
    expect(w.files.get(resolveTaskFile(w.db, "t1", "writer-report")!.absPath)).toBe("the report\n");
  });

  // Mutation: the close reading reports by a folder listing (or not at all), or OUTCOME.md/lessons.md recorded without their readers.
  it("[sma:k_pl_quick] T14–T15 acceptance → lessons: OUTCOME.md and lessons.md land in the task's one folder beside its plan; lessons come from each attempt's report.md read by the manifest", async () => {
    const w = world();
    await w.dispatch("t1", "plan");
    await recordWriterReport(w.ctx, { taskId: "t1", attemptId: "a1", runId: RUN }, "first try\nLESSON: the form test needs the db seed");
    await recordWriterReport(w.ctx, { taskId: "t1", attemptId: "a2", runId: RUN }, "second try, no lesson");
    await recordAcceptanceFiles(w.ctx, { taskId: "t1", runId: RUN, attemptId: "a2", output: "second try, no lesson", acceptance: "{}\n", receipt: "{}\n" });
    const closed = await recordTaskClose(w.ctx, { taskId: "t1", runId: RUN, attemptId: "a2", status: "accepted", reason: "", mergeCommit: "abc123",
      changed: [{ status: "M", path: "src/a.ts" }], lessonOf: (text) => /LESSON:\s*(.+)/.exec(text)?.[1] ?? null });
    expect(w.files.get(closed!.outcome!.absPath)).toContain("merge: abc123");
    const lessons = w.files.get(closed!.lessons!.absPath)!;
    expect(lessons).toContain("- a1: the form test needs the db seed");
    expect(lessons).toContain(`attempts/a2/report.md (sha256 ${sha("second try, no lesson\n")})`);
    const rows = w.kinds("t1");
    expect(rows.find((row) => row.kind === "lesson")!.readers).toEqual(["memory", "project-life"]);
    expect(rows.find((row) => row.kind === "acceptance")!.read_by.map((read) => read.node)).toContain("lessons");
    expect(rows.filter((row) => row.kind === "writer-report").every((row) => row.read_by.some((read) => read.node === "lessons"))).toBe(true);
    expect(rows.map((row) => row.kind)).toEqual(expect.arrayContaining(["plan", "outcome", "lesson"]));
  });

  // Mutation: update_task writing the new edition only in the base (the running writer keeps the old words) or not as a new contract edition.
  it("T17 update_task → open worktree: contract.v2.json and PLAN.v2.md (superseding PLAN.md) are recorded and written again into the open worktree", async () => {
    const w = world();
    await w.dispatch("t1", "plan one");
    w.db.prepare("INSERT INTO lane_pilot_task_contract_edition(task_id,edition,sha256,contract_json,plan,reason,at) VALUES('t1',2,'x','{}',NULL,'update',2)").run();
    await recordTaskEdition(w.ctx, { taskId: "t1", task: contract("t1"), plan: "plan two", mirrorRoot: WT });
    expect(resolveTaskFile(w.db, "t1", "contract")!.path).toBe("contract.v2.json");
    expect(w.files.get(`${WT}/.agents/tasks/t1/PLAN.v2.md`)).toBe("plan two\n");
    expect(resolveTaskFile(w.db, "t1", "plan")!.path).toBe("PLAN.v2.md");
    expect((renderTaskManifest(w.db, "t1")!.files as Array<{ path: string; supersedes?: string }>).find((row) => row.path === "PLAN.v2.md")).toMatchObject({ supersedes: "PLAN.md" });
    expect(w.files.get(`${WT}/.agents/tasks/t1/contract.v2.json`)).toBeDefined();
    expect(await stagePlanText(w.ctx, "t1", "pm-read", "x")).toBe("plan two\n");
    expect(renderTaskManifest(w.db, "t1")!.contract).toMatchObject({ edition: 2, path: "contract.v2.json" });
  });

  // Mutation: a file row without its sha256 or producer, or a reader not checking the hash.
  it("[sma:k_v_manifest] the manifest is the task's evidence passport: every file has its sha256, producer and plugin version; a file changed behind it reads as drift", async () => {
    const w = world();
    await w.dispatch("t1", "plan");
    for (const row of (renderTaskManifest(w.db, "t1")!.files as Array<Record<string, unknown>>)) {
      expect(row).toMatchObject({ sha256: expect.stringMatching(/^[0-9a-f]{64}$/), produced_by: { node: "dispatch" }, plugin_version: expect.any(String) });
    }
    w.files.set(`${BASE}/.agents/tasks/t1/PLAN.md`, "edited by hand\n");
    const read = await readTaskFile(w.db, w.io, { taskId: "t1", kind: "plan", reader: "audit" });
    expect(read).toMatchObject({ drift: true, recordedSha256: sha("plan\n"), sha256: sha("edited by hand\n") });
    // An agent never writes the manifest: the file name is refused to every caller of the one writer.
    await expect(recordTaskFile(w.db, w.io, { taskId: "t1", kind: "plan", name: "manifest.json", content: "{}", producer: { node: "agent" } })).rejects.toThrow(/not a file name/);
  });

  it("a home opened once keeps its first root: a second open never moves a task between two roots", () => {
    const w = world();
    w.task("t1");
    openTaskHome(w.db, { taskId: "t1", projectId: "proj", runId: RUN, basePath: BASE, hostId: "h1" });
    const again = openTaskHome(w.db, { taskId: "t1", projectId: "proj", runId: RUN, basePath: "/elsewhere", hostId: "h2" });
    expect(again).toMatchObject({ base_path: BASE, host_id: "h1" });
  });
});
