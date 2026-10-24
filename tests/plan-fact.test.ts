import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { blindPlanFact, diffHunksCommand, hunksFromCommandOutput, parseDiffHunks, parsePlanFact, planFactOutcome, PLAN_FACT_BRIEF_LINE } from "../src/rooms/tasks/plan-fact";
import type { PlanFactFacts } from "../src/rooms/tasks/plan-fact";
import { writerBriefSegments, stickyTurnPrompt, previousAttemptBrief } from "../src/rooms/writer/server/writer-task";
import { runPlanFactStage, planFactMode, tableFromAnswers } from "../src/rooms/writer/server/plan-fact";
import { buildAcceptanceCard } from "../src/rooms/acceptance/card";
import { applyCodeCriticDefault, resolveCodeCriticDefault } from "../src/rooms/critique/quality-mode";
import { createAttempt, createRun, createTask, openDatabase, saveTaskGitBase } from "../src/rooms/storage/database";
import { taskV2Schema } from "../src/rooms/contracts";

const fence = (json: unknown, tag = "plan-fact") => `Done.\n\n\`\`\`${tag}\n${JSON.stringify(json)}\n\`\`\`\n`;
const facts = (extra: Partial<PlanFactFacts> = {}): PlanFactFacts => ({
  produced: ["src/a.ts", "src/new.ts"], changed: { "src/a.ts": [[10, 24], [40, 41]], "src/new.ts": "all" }, lineCount: { "src/new.ts": 30 }, hunksKnown: true,
  contractCommands: ["npm test", "npm run lint"], ran: [{ command: "npm test", exitCode: 0 }, { command: "npm run lint", exitCode: 1 }], ...extra,
});
const ACCEPTANCE = ["the form saves", "errors are shown", "docs mention it"];

describe("the plan-fact table in the writer's answer", () => {
  it("reads the last plan-fact block and nothing around it", () => {
    const rows = [{ item: 1, status: "done", evidence: ["src/a.ts:10-12", "cmd:npm test"] }, { item: 2, status: "not_done", why: "needs a decision" }];
    const table = parsePlanFact(`I did everything, trust me.\n${fence([{ item: 1, status: "done" }])}\nAfter review:\n${fence(rows)}`);
    expect(table).toEqual({ status: "ok", rows });
  });

  it("is missing without a block, and invalid with a reason for broken JSON, a wrong shape or a repeated item", () => {
    expect(parsePlanFact("All acceptance items are done.")).toEqual({ status: "missing" });
    expect(parsePlanFact(fence([], "json"))).toEqual({ status: "missing" });
    expect(parsePlanFact("```plan-fact\n{not json\n```")).toMatchObject({ status: "invalid", reason: expect.stringContaining("not JSON") });
    expect(parsePlanFact(fence([{ item: 1, status: "finished" }]))).toMatchObject({ status: "invalid" });
    expect(parsePlanFact(fence([{ item: 1, status: "done", extra: 1 }]))).toMatchObject({ status: "invalid" });
    expect(parsePlanFact(fence([]))).toMatchObject({ status: "invalid" });
    expect(parsePlanFact(fence([{ item: 1, status: "done" }, { item: 1, status: "done" }]))).toEqual({ status: "invalid", reason: "item 1 appears twice" });
  });

  it("falls back to an earlier answer when a repair round's reply has no table", () => {
    const rows = [{ item: 1, status: "done", evidence: ["src/a.ts"] }];
    expect(tableFromAnswers(["Fixed the finding.", fence(rows)])).toEqual({ status: "ok", rows });
    expect(tableFromAnswers(["Fixed.", "Also fixed."])).toEqual({ status: "missing" });
    expect(tableFromAnswers(["```plan-fact\nnope\n```", "Done."]).status).toBe("invalid");
  });
});

describe("the blind check", () => {
  const table = (rows: unknown[]) => parsePlanFact(fence(rows)) as Extract<ReturnType<typeof parsePlanFact>, { status: "ok" }>;

  it("proves an item by a changed hunk or a passed contract command, and says why each piece of evidence holds or not", () => {
    const check = blindPlanFact(ACCEPTANCE, table([
      { item: 1, status: "done", evidence: ["src/a.ts:12-30", "cmd:npm test"] },
      { item: 2, status: "done", evidence: ["src/a.ts:100-110", "src/new.ts:5", "src/ghost.ts", "npm test", "cmd:npm run lint", "cmd:rm -rf /"] },
      { item: 3, status: "done", evidence: ["src/new.ts:31"] },
    ]), facts());
    const [one, two, three] = check.items;
    expect(one).toMatchObject({ verdict: "proven", severity: "ok" });
    expect(one!.evidence.map((row) => row.code)).toEqual(["lines_changed", "command_passed"]);
    // Item 2: the new file's line 5 holds; the rest fails in five different ways, so it is proven with warnings.
    expect(two).toMatchObject({ verdict: "proven", severity: "warning" });
    expect(two!.evidence.map((row) => row.code)).toEqual(["lines_not_changed", "lines_changed", "file_not_in_diff", "unparsed", "command_failed", "command_not_in_contract"]);
    expect(three).toMatchObject({ verdict: "unproven", severity: "blocking" });
    expect(three!.evidence[0]!.code).toBe("lines_missing");
    expect(check.blocking).toEqual([3]);
  });

  it("blocks an item claimed done without evidence, an item the writer says is not done, and an item with no row", () => {
    const check = blindPlanFact(ACCEPTANCE, table([{ item: 1, status: "done" }, { item: 2, status: "not_done", why: "needs an API key" }, { item: 9, status: "done", evidence: ["src/a.ts"] }]), facts());
    expect(check.items.map((row) => [row.verdict, row.severity])).toEqual([["unproven", "blocking"], ["declared_not_done", "blocking"], ["no_row", "blocking"]]);
    expect(check.items[1]!.why).toBe("needs an API key");
    expect(check.extraRows).toEqual([9]);
    expect(check.blocking).toEqual([1, 2, 3]);
    expect(planFactOutcome(check)).toEqual({ state: "failed", reason: "plan_fact_unproven: acceptance item 1, 2, 3 have no evidence that holds in the diff" });
  });

  it("never reads the prose: a convincing story with no table checks nothing and is not a refusal", () => {
    const check = blindPlanFact(ACCEPTANCE, parsePlanFact("Every acceptance item is done; see src/a.ts:10-24 and npm test passed."), facts());
    expect(check).toMatchObject({ table: "missing", items: [], blocking: [] });
    expect(check.notChecked[0]).toContain("no readable plan-fact table");
    expect(planFactOutcome(check)).toMatchObject({ state: "skipped", reason: expect.stringContaining("plan_fact_table_missing") });
    const broken = blindPlanFact(ACCEPTANCE, parsePlanFact("```plan-fact\n[1]\n```"), facts());
    expect(planFactOutcome(broken)).toMatchObject({ state: "skipped", reason: expect.stringContaining("plan_fact_table_invalid") });
  });

  it("checks files only, and says so, when the diff against the base is unavailable", () => {
    const check = blindPlanFact(["one"], table([{ item: 1, status: "done", evidence: ["src/a.ts:500-510"] }]), facts({ hunksKnown: false, changed: {} }));
    expect(check.items[0]).toMatchObject({ verdict: "proven", severity: "warning" });
    expect(check.items[0]!.evidence[0]!.code).toBe("lines_unchecked");
    expect(check.notChecked[0]).toContain("line ranges");
    const missingFile = blindPlanFact(["one"], table([{ item: 1, status: "done", evidence: ["src/other.ts:1"] }]), facts({ hunksKnown: false, changed: {} }));
    expect(missingFile.items[0]).toMatchObject({ verdict: "unproven", severity: "blocking" });
  });

  it("strips the workspace root and ./ from cited paths", () => {
    const check = blindPlanFact(["one"], table([{ item: 1, status: "done", evidence: ["/work/tree/src/a.ts:11", "./src/a.ts:12"] }]), facts({ root: "/work/tree" }));
    expect(check.items[0]!.evidence.map((row) => row.ok)).toEqual([true, true]);
  });

  it("a command counts only when the contract lists it and its result came back with exit code 0", () => {
    const check = blindPlanFact(["a", "b"], table([{ item: 1, status: "done", evidence: ["cmd:  npm   test "] }, { item: 2, status: "done", evidence: ["cmd:npm run lint"] }]), facts());
    expect(check.items.map((row) => row.verdict)).toEqual(["proven", "unproven"]);
    const notRun = blindPlanFact(["a"], table([{ item: 1, status: "done", evidence: ["cmd:npm test"] }]), facts({ ran: [] }));
    expect(notRun.items[0]!.evidence[0]!.code).toBe("command_not_run");
  });
});

describe("the diff behind the line check", () => {
  const diff = ["+++ b/src/a.ts", "@@ -3,0 +4,2 @@", "@@ -9 +11 @@ fn", "+++ b/src/gone.ts", "@@ -1,3 +0,0 @@", "+++ /dev/null"].join("\n");

  it("reads hunk ranges per path from git diff -U0 lines, a deletion sitting at the line it leaves", () => {
    expect(parseDiffHunks(diff)).toEqual({ "src/a.ts": [[4, 5], [11, 11]], "src/gone.ts": [[0, 0]] });
  });

  it("builds one command with the base, the paths quoted, and reads hunks and untracked files from its output", () => {
    const command = diffHunksCommand("a".repeat(40), ["src/a.ts", "it's new.ts"]);
    expect(command).toContain(`git -c core.quotepath=off diff -U0 --no-color --no-ext-diff ${"a".repeat(40)} -- 'src/a.ts' 'it'\\''s new.ts'`);
    expect(command).toContain("git ls-files --others --exclude-standard");
    const out = hunksFromCommandOutput(`+++ b/src/a.ts\n@@ -1 +1,3 @@\n---untracked---\nsrc/new.ts\nsrc/other.ts\n`, ["src/a.ts", "src/new.ts"]);
    expect(out).toEqual({ hunksKnown: true, changed: { "src/a.ts": [[1, 3]], "src/new.ts": "all" } });
    expect(hunksFromCommandOutput("---nobase---\n---untracked---\n", ["src/a.ts"])).toEqual({ hunksKnown: false, changed: {} });
  });
});

describe("what the writer is told and what a retry is told", () => {
  const task = taskV2Schema.parse({
    schema_version: 2, id: "t1", title: "T", risk: "medium", lane: "writer", project_cwd: "/w", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
    expected_outputs: ["src/a.ts"], owns_paths: ["src/**"], never_touch: [], depends_on: [], objective: "o", acceptance: ["a"], verify: "none", verification: [],
  });

  it("puts the format in the first brief and in a continuing turn, only for a contract with acceptance items", () => {
    expect(writerBriefSegments(task).some((segment) => segment.text === PLAN_FACT_BRIEF_LINE && segment.hidden)).toBe(true);
    expect(stickyTurnPrompt({ kind: "retry", task, previousAttempt: "Result: x" })).toContain("```plan-fact");
    expect(PLAN_FACT_BRIEF_LINE).toContain('"status":"not_done"');
    expect(PLAN_FACT_BRIEF_LINE).toContain("cmd:");
    expect(writerBriefSegments({ ...task, acceptance: [] }).some((segment) => segment.text === PLAN_FACT_BRIEF_LINE)).toBe(false);
  });

  it("sends an unproven item back with what to cite", () => {
    const text = previousAttemptBrief({ status: "validation_failed", reason: "plan_fact_unproven: acceptance item 2, 3 have no evidence that holds in the diff" }, task);
    expect(text).toContain("acceptance item 2, 3 had no evidence that holds in the diff");
    expect(text).toContain("path:first-last");
  });
});

describe("the code critic by risk", () => {
  it("stays off by default, and turns on by the task's risk only when nothing else decided", () => {
    expect(resolveCodeCriticDefault(undefined)).toBe("off");
    expect(resolveCodeCriticDefault("medium")).toBe("medium");
    expect(resolveCodeCriticDefault("medium", "off")).toBe("off");
    expect(resolveCodeCriticDefault("off", "high")).toBe("high");
    expect(resolveCodeCriticDefault("sometimes", "maybe")).toBe("off");
    const on = (level: "off" | "medium" | "high", risk: string, settings: Record<string, unknown> = {}, mode: "quick" | "standard" | "full" = "standard") =>
      applyCodeCriticDefault(settings, mode, risk, level)["code_critique.enabled"] === true;
    expect(["low", "medium", "high", "critical"].map((risk) => on("off", risk))).toEqual([false, false, false, false]);
    expect(["low", "medium", "high", "critical"].map((risk) => on("medium", risk))).toEqual([false, true, true, true]);
    expect(["low", "medium", "high", "critical"].map((risk) => on("high", risk))).toEqual([false, false, true, true]);
    // The project's own switch wins either way, and quick or full decide before the risk does.
    expect(on("medium", "high", { "code_critique.enabled": false })).toBe(false);
    expect(on("medium", "high", {}, "quick")).toBe(false);
    const settings = { "code_critique.enabled": false };
    expect(applyCodeCriticDefault(settings, "standard", "high", "medium")).toBe(settings);
  });
});

describe("the plan-fact stage and the acceptance card on a database", () => {
  const BASE = "b".repeat(40);
  function world(extra: Record<string, unknown> = {}) {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "proj", "bb", "/repo");
    const task = taskV2Schema.parse({
      schema_version: 2, id: "t1", title: "T", risk: "high", lane: "writer", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [],
      expected_outputs: ["src/a.ts"], owns_paths: ["src/**"], never_touch: [], depends_on: [], objective: "Save the form", acceptance: ["the form saves", "errors are shown"], verify: "none",
      verification: [{ command: "npm test", cwd: "/repo", timeout_sec: 60 }], ...extra,
    });
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task });
    createAttempt(db, { id: "att1", runId: "run", taskId: "t1" });
    saveTaskGitBase(db, "t1", { baseRef: "main", baseSha: BASE, initialHeadSha: BASE, branch: "lp/t1", compareCommitted: true });
    const commands: string[] = [];
    const ctx = {
      db, bb: { sdk: { files: { read: async () => ({ content: "a\nb\nc\n" }) } } },
      host: { call: async (_method: string, input: { command: string }) => { commands.push(input.command); return { hostId: "h", exitCode: 0, stdout: "+++ b/src/a.ts\n@@ -3 +4,2 @@\n---untracked---\nsrc/new.ts\n", stderr: "" }; } },
    };
    return { db, task, ctx, commands };
  }
  const run = (w: ReturnType<typeof world>, answers: string[]) => runPlanFactStage(w.ctx as never, {
    projectId: "proj", runId: "run", taskId: "t1", attempt: 1, hostId: "h", task: w.task, answers,
    produced: ["src/a.ts", "src/new.ts"], verification: [{ command: "npm test", exitCode: 0 }],
  });

  it("records a passed stage, reads the diff once against the task's base, and shows it on the card", async () => {
    const w = world();
    const result = await run(w, [fence([{ item: 1, status: "done", evidence: ["src/a.ts:4-5", "cmd:npm test"] }, { item: 2, status: "done", evidence: ["src/new.ts:2"] }])]);
    expect(result.refusal).toBeNull();
    expect(w.commands).toHaveLength(1);
    expect(w.commands[0]).toContain(`diff -U0 --no-color --no-ext-diff ${BASE} -- 'src/a.ts' 'src/new.ts'`);
    const card = buildAcceptanceCard(w.db, { runId: "run", taskId: "t1" })!;
    expect(card.planFact).toMatchObject({ state: "passed", table: "ok", mode: "record" });
    expect(card.planFact!.items.map((row) => row.verdict)).toEqual(["proven", "proven"]);
    expect(card.receipts.find((row) => row.stageId === "plan-fact")).toMatchObject({ state: "passed", proof: "code", proofKind: "file" });
    expect(card).toMatchObject({ risk: "high", base: { sha: BASE, branch: "lp/t1", compareCommitted: true }, contract: { acceptance: ["the form saves", "errors are shown"], ownsPaths: ["src/**"] } });
  });

  it("records an unproven item as a failed stage and refuses only in gate mode", async () => {
    const answers = [fence([{ item: 1, status: "done", evidence: ["src/a.ts:300"] }, { item: 2, status: "done", evidence: ["cmd:npm test"] }])];
    const record = world();
    const recorded = await run(record, answers);
    expect(recorded.refusal).toBeNull();
    expect(buildAcceptanceCard(record.db, { runId: "run", taskId: "t1" })!.planFact).toMatchObject({ state: "failed", mode: "record", reason: expect.stringContaining("plan_fact_unproven") });

    const gated = world();
    gated.db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES('proj','','plan_fact.mode','\"gate\"',1,1)").run();
    const refused = await run(gated, answers);
    expect(refused.refusal).toBe("plan_fact_unproven: acceptance item 1 has no evidence that holds in the diff");
  });

  it("a missing table is a skipped stage, listed as not run on the card, and never a refusal", async () => {
    const w = world();
    w.db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES('proj','','plan_fact.mode','\"gate\"',1,1)").run();
    const result = await run(w, ["All done, see the diff."]);
    expect(result.refusal).toBeNull();
    expect(w.commands).toHaveLength(0);
    const card = buildAcceptanceCard(w.db, { runId: "run", taskId: "t1" })!;
    expect(card.planFact).toMatchObject({ state: "skipped", table: "missing" });
    expect(card.notRun.map((row) => row.stageId)).toEqual(expect.arrayContaining(["plan-critique", "code-critique", "plan-fact"]));
    expect(card.notRun.find((row) => row.stageId === "plan-fact")!.why).toContain("plan-fact");
    expect(card.cost).toMatchObject({ state: "not_measured", usd: null });
  });

  it("a working-tree base (no base commit, only the head the writer started from) is diffed against that head", async () => {
    const w = world();
    const HEAD = "c".repeat(40);
    w.db.prepare("DELETE FROM lane_pilot_task_git_base WHERE task_id='t1'").run();
    saveTaskGitBase(w.db, "t1", { baseRef: null, baseSha: null, initialHeadSha: HEAD, branch: "main", compareCommitted: false });
    const result = await run(w, [fence([{ item: 1, status: "done", evidence: ["src/a.ts:4-5"] }, { item: 2, status: "done", evidence: ["src/new.ts:2"] }])]);
    expect(w.commands[0]).toContain(`--no-ext-diff ${HEAD} --`);
    expect(result.check.notChecked).toEqual([]);
    expect(result.check.items.flatMap((row) => row.evidence.map((entry) => entry.code))).not.toContain("lines_unchecked");
    expect(buildAcceptanceCard(w.db, { runId: "run", taskId: "t1" })!.base).toMatchObject({ sha: HEAD, compareCommitted: false });
  });

  it("a retry replaces the receipt; a task without a recorded base checks the files only", async () => {
    const w = world();
    await run(w, ["no table"]);
    w.db.prepare("DELETE FROM lane_pilot_task_git_base WHERE task_id='t1'").run();
    const result = await run(w, [fence([{ item: 1, status: "done", evidence: ["src/a.ts:500"] }, { item: 2, status: "done", evidence: ["src/new.ts"] }])]);
    expect(result.check.notChecked.join(" ")).toContain("no recorded base commit");
    expect(w.commands).toHaveLength(0);
    const card = buildAcceptanceCard(w.db, { runId: "run", taskId: "t1" })!;
    expect(card.planFact).toMatchObject({ state: "passed", table: "ok" });
    expect(card.planFact!.items[0]!.evidence[0]!.code).toBe("lines_unchecked");
    expect(card.base).toBeNull();
    expect(card.notRun.some((row) => row.why.includes("line ranges"))).toBe(true);
  });

  it("reads plan_fact.mode as record unless it says gate", () => {
    expect(planFactMode({})).toBe("record");
    expect(planFactMode({ "plan_fact.mode": "gate" })).toBe("gate");
    expect(planFactMode({ "plan_fact.mode": "strict" })).toBe("record");
  });
});

describe("the per-task override a dispatch carries for the code critic", () => {
  it("is stored per task, read back, and ignores values that are not off, medium or high", async () => {
    const { saveCriticCodeDefault, loadCriticCodeDefault } = await import("../src/rooms/writer/server/critic-override");
    const store = new Map<string, unknown>();
    const kv = { get: async (key: string) => store.get(key), set: async (key: string, value: never) => { store.set(key, value); } };
    await saveCriticCodeDefault(kv, "t1", "medium");
    await saveCriticCodeDefault(kv, "t2", undefined);
    expect(await loadCriticCodeDefault(kv, "t1")).toBe("medium");
    expect(await loadCriticCodeDefault(kv, "t2")).toBeUndefined();
    store.set("critic-code-default:t3", "always");
    expect(await loadCriticCodeDefault(kv, "t3")).toBeUndefined();
    expect(resolveCodeCriticDefault("off", await loadCriticCodeDefault(kv, "t1"))).toBe("medium");
  });
});

describe("an acceptance item that says something stays as it was", () => {
  const facts = { produced: ["src/handler.ts"], changed: { "src/handler.ts": [[80, 90]] as Array<[number, number]> }, lineCount: {}, hunksKnown: true, contractCommands: [], ran: [] };
  const table = (evidence: string[]) => ({ status: "ok" as const, rows: [{ item: 1, status: "done" as const, evidence }] });

  it("is proven by the lines the candidate left out of its changes", () => {
    const check = blindPlanFact(["Legacy and error responses unchanged"], table(["src/handler.ts:60-72"]), facts);
    expect(check.items[0]).toMatchObject({ verdict: "proven", severity: "ok" });
    expect(check.items[0]!.evidence[0]!.code).toBe("lines_kept");
  });

  it("is proven, as a warning, by a file the candidate did not touch", () => {
    const check = blindPlanFact(["Старый адрес работает по-прежнему"], table(["src/legacy.ts"]), facts);
    expect(check.items[0]).toMatchObject({ verdict: "proven", severity: "warning" });
  });

  it("an ordinary item still needs changed lines", () => {
    const check = blindPlanFact(["The keyed response is cached privately"], table(["src/handler.ts:60-72"]), facts);
    expect(check.items[0]).toMatchObject({ verdict: "unproven", severity: "blocking" });
  });
});

describe("a contract command the writer shortened", () => {
  const long = "( D=$(mktemp -d /tmp/notes.XXXXXX) && export NOTES_FILE=\"$D/n.json\" && node scripts/notes.js add 'Купить молоко' --tag home && node scripts/notes.js list )";
  it("is found by its start when one contract command begins with it", () => {
    const check = blindPlanFact(["the scenario works"], { status: "ok", rows: [{ item: 1, status: "done", evidence: ["cmd:( D=$(mktemp -d /tmp/notes.XXXXXX) && export NOTES_FILE=\"$D/n.json\" && node scripts/notes.js add 'Купить молоко' ... )"] }] },
      facts({ contractCommands: [long], ran: [{ command: long, exitCode: 0 }] }));
    expect(check.items[0]).toMatchObject({ verdict: "proven" });
  });
  it("a too short start proves nothing", () => {
    const check = blindPlanFact(["the scenario works"], { status: "ok", rows: [{ item: 1, status: "done", evidence: ["cmd:( D=$(mktemp ..."] }] },
      facts({ contractCommands: [long], ran: [{ command: long, exitCode: 0 }] }));
    expect(check.items[0]).toMatchObject({ verdict: "unproven" });
  });
});
