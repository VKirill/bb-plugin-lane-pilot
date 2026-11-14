import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { recordMemoryMiss } from "@lane-pilot/memory-core";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import plugin from "../../server";
import { createAttempt, createRun, createTask, migrations, openDatabase, saveProjectSetting, saveReasoningTrace } from "../../src/rooms/plugin-db";
import { createRuleScan } from "../../src/rooms/self-repair/server/rule-scan";
import { selfRepairDeps } from "../../src/rooms/self-repair/server";
import { mountNightGraphs } from "../../src/rooms/night-graphs/server";
import { adoptRuleProposal } from "../../src/rooms/self-repair/server/insights";
import { logRuleEvent, ruleTier } from "../../packages/run-insights/src/rules";
import { CURRICULUM_KV_KEY } from "../../src/rooms/tools/server/self-improve";
import { nightWorld } from "../night-graphs/world";
import { registerCli } from "../../src/rooms/tools/server/cli";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXCAVATE_LOG_ARGS, excavate, htmlReport } from "../../src/rooms/tools/server/self-improve";
import { workGraphRpc } from "../../src/rooms/work-graph/server/rpc";
import Database from "better-sqlite3";
import { memoryRecordId } from "../../packages/memory-core/src";
import { runMemoryEvalCommand } from "../../src/rooms/memory-eval/server/command";
import { createBench } from "../../src/rooms/bench/service";
import { runBenchCli } from "../../src/rooms/bench/cli";

// Region 26 · Self-improvement and measurement: each node's card input through its real entry (a CLI verb, the hub's own schedule), the result checked.
type Fn = (context: { signal: AbortSignal }) => unknown;
const signal = new AbortController().signal;

describe("the weekly curriculum job (hub schedule to brief)", () => {
  it("[sma:k_v_curriculum] the hub's Monday schedule turns the week's misses into the brief `curriculum --brief` prints; the global setting off stops it", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const registered = new Map<string, Fn>();
    (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, _cron: string, fn: Fn) => { registered.set(name, fn); };
    await plugin(bb);
    const db = openDatabase(bb);
    const kv = bb.storage.kv as unknown as { get(key: string): Promise<unknown> };
    for (let i = 0; i < 3; i += 1) recordMemoryMiss(db, "p1", "who owns the wall", Date.now() - 3_600_000);
    expect(registered.has("curriculum-weekly")).toBe(true);
    // The global switch off: the Monday job runs and writes nothing.
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "curriculum.weekly", "off");
    await registered.get("curriculum-weekly")!({ signal });
    expect(await kv.get(CURRICULUM_KV_KEY)).toBeFalsy();
    // Unset or on: the same job stores the brief, and the person's verb prints exactly it.
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "curriculum.weekly", "on");
    await registered.get("curriculum-weekly")!({ signal });
    const brief = String(await kv.get(CURRICULUM_KV_KEY));
    expect(brief).toBe("WHEN a p1 question like «who owns the wall» returns nothing → write the fact to memory (3 misses)");
    const printed = await harness.behavior.runCli(["curriculum", "--brief"]);
    expect(printed.exitCode).toBe(0);
    expect(printed.stdout).toBe(brief);
    await harness.lifecycle.dispose();
  });
});

describe("the rule maturation ladder (nightly scan to tier event)", () => {
  it("[sma:k_lib_ladder] [sma:k_v_ladder] the nightly rules scan moves a confirmed rule with ten clean applications from note to warning, logs the tier event, and `rules ladder` then shows the new tier", async () => {
    const w = nightWorld({});
    w.services.ruleScan = createRuleScan(w.ctx, w.services, selfRepairDeps());
    mountNightGraphs(w.ctx, w.services);
    const scan = w.services.ruleScan as ReturnType<typeof createRuleScan>;
    (scan.graph as unknown as { collectScan: unknown }).collectScan = async () => ({ state: "ok", triaged: 0, groups: 0, jobs: [], hostId: "host-1", path: "/proj", analyzer: { providerId: "codex", model: "gpt-6-luna", reasoningLevel: "high", serviceTier: "fast" } });
    const db = w.db;
    createRun(db, "run1", "proj-1");
    const t0 = Date.now() - 600_000;
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at)
      VALUES ('r1','proj-1','r1','run lint before commit','model','proposed',3,3,'[]',1,1,1)`).run();
    adoptRuleProposal(db, "proj-1", "r1", t0);
    db.prepare("UPDATE lane_pilot_rule_proposal SET trial_state='confirmed', form='hook' WHERE id='r1'").run();
    for (let i = 0; i < 10; i++) {
      createTask(db, { id: `t${i}`, runId: "run1", kind: "bb", contract: {} });
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,state,created_at,updated_at,attempt_no,dirt_before_json) VALUES(?,?,?,?,?,?,?,?)").run(`a${i}`, "run1", `t${i}`, "accepted", t0 + 1_000 + i, t0 + 1_000 + i, 1, "[]");
      saveReasoningTrace(db, { attemptId: `a${i}`, dispatchContext: { rulesPicked: { total: 1, picked: ["r1"] } } } as never);
    }
    expect(ruleTier(db as never, "proj-1", "r1")).toBe("note");
    await scan.startScan("proj-1", "en", { night: "2026-11-14" });
    for (let i = 0; i < 300; i += 1) { await w.engine.idle(); if ((await scan.scanState("proj-1")).state !== "running") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    const events = db.prepare("SELECT action, detail FROM lane_pilot_rule_event WHERE project_id='proj-1' AND rule_id='r1' AND action='tier'").all();
    expect(events).toEqual([{ action: "tier", detail: "warning" }]);
    expect(ruleTier(db as never, "proj-1", "r1")).toBe("warning");
    registerCli(w.ctx, w.services as unknown as Services, migrations);
    const shown = await w.harness.behavior.runCli(["rules", "ladder", "proj-1"]);
    // The move spent its evidence: the next one needs applications newer than the tier event.
    expect(shown.stdout).toMatch(/^r1 {2}warning {3}applied 0 {2}recurrences 0 {2}next warning/);
  });
});

// ---- the owner's decisions: corpus, mining, exam ----
const FROZEN_AFTER = Date.parse("2026-11-01T00:00:00Z");
function cliWorld(sdk?: Record<string, unknown>) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", ...(sdk ? { sdk: sdk as never } : {}) });
  const db = openDatabase(bb);
  const core = createCore(bb, db);
  return { bb, harness, db, core, mount: () => registerCli(core, {} as Services, migrations), run: (argv: string[]) => harness.behavior.runCli(argv) };
}
const kvOf = (bb: unknown) => (bb as { storage: { kv: { get(key: string): Promise<unknown> } } }).storage.kv;
const decision = (n: number, expected: string) => JSON.stringify({ quote: `decision ${n}`, ref: `thr:${n}`, at: FROZEN_AFTER + n * 1000, descriptor: { kind: "zz_unlisted_change" }, expected, why: `the owner decided ${n}` });

describe("the founder's decision corpus", () => {
  it("[sma:k_lib_decisioncorpus] an owner message the person adds becomes one exam item with the situation, the real decision and why, kept in the plugin store and never in policy/exam-v2.json; the same message twice stays one", async () => {
    const w = cliWorld();
    w.mount();
    const first = await w.run(["policy", "exam-add", decision(1, "owner_only")]);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout!)).toEqual({ added: 1, skipped: 0, total: 1 });
    expect(JSON.parse((await w.run(["policy", "exam-add", decision(1, "owner_only")])).stdout!)).toEqual({ added: 0, skipped: 1, total: 1 });
    const exported = JSON.parse((await w.run(["policy", "exam-export"])).stdout!) as { items: Array<Record<string, unknown>> };
    expect(exported.items).toHaveLength(1);
    expect(exported.items[0]).toMatchObject({ quote: "decision 1", descriptor: { kind: "zz_unlisted_change" }, expected: "owner_only", why: "the owner decided 1", strength: "strong", source: { type: "owner_message", ref: "thr:1" } });
    expect(await kvOf(w.bb).get("policy:exam-v2")).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(__dirname, "../../policy/exam-v2.json"), "utf8")).items).toEqual([]);
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_lib_decisioncorpus] the night's own collection turns a rule the owner accepted after the policy froze into an item that expects a proposal, and a second night adds nothing", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const registered = new Map<string, Fn>();
    (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, _cron: string, fn: Fn) => { registered.set(name, fn); };
    await plugin(bb);
    const db = openDatabase(bb);
    db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at)
      VALUES ('r9','projA','r9','run lint before commit','model','accepted',3,3,'[]',1,1,1)`).run();
    logRuleEvent(db, "projA", "r9", "owner_accepted", "kept", FROZEN_AFTER);
    expect(registered.has("policy-exam-collect")).toBe(true);
    await registered.get("policy-exam-collect")!({ signal });
    const stored = await kvOf(bb).get("policy:exam-v2") as Array<Record<string, unknown>>;
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ source: { type: "rule_proposal", ref: "projA/r9#owner_accepted" }, expected: "night_proposes", strength: "medium", descriptor: { kind: "rule_adopt" } });
    expect(String(stored[0]!.quote)).toContain("run lint before commit");
    await registered.get("policy-exam-collect")!({ signal });
    expect(await kvOf(bb).get("policy:exam-v2")).toHaveLength(1);
    await harness.lifecycle.dispose();
  });
});

describe("the replay exam", () => {
  async function seeded(items: Array<[number, string]>) {
    const w = cliWorld();
    w.mount();
    for (const [n, expected] of items) await w.run(["policy", "exam-add", decision(n, expected)]);
    return w;
  }
  const mixed = (): Array<[number, string]> => [...Array.from({ length: 16 }, (_, n): [number, string] => [n, "night_proposes"]), [16, "night_decides"], [17, "night_decides"], [18, "owner_only"], [19, "owner_only"]];
  const head = (stdout: string) => JSON.parse(stdout.slice(0, stdout.lastIndexOf("}\n") + 1)) as Record<string, unknown> & { misses: Array<{ expected: string; unsafe: boolean }>; confusion: Record<string, number> };

  it("[sma:k_v_exam] `policy-exam` scores the policy on twenty unseen decisions: sixteen right, two owner-only answers it was too lax on are named unsafe, the verdict says passed and the run is stored", async () => {
    const w = await seeded(mixed());
    const out = await w.run(["policy-exam"]);
    expect(out.exitCode).toBe(0);
    const result = head(out.stdout!);
    expect(result).toMatchObject({ total: 20, correct: 16, accuracy: 0.8, passed: true, unsafe: 2 });
    expect(result.confusion).toEqual({ "night_proposes->night_proposes": 16, "night_decides->night_proposes": 2, "owner_only->night_proposes": 2 });
    expect(result.misses.filter((miss) => miss.unsafe).map((miss) => miss.expected)).toEqual(["owner_only", "owner_only"]);
    expect(out.stdout).toContain("PASSED: 16/20 = 0.8 on unseen decisions (bar 0.8)");
    expect(await kvOf(w.bb).get("policy:exam-result")).toMatchObject({ correct: 16, total: 20, passed: true, unsafe: 2, split: "exam-v2" });
    // One more miss takes it under the bar: the verb exits 1 and says why.
    await w.run(["policy", "exam-add", decision(20, "owner_only")]);
    const failed = await w.run(["policy-exam"]);
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toContain("FAILED: 16/21");
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_lib_exam] only decisions made after the policy froze score it, and too few of them is a stated measurement gap with exit 2, not a pass", async () => {
    const w = await seeded(mixed().slice(0, 3));
    // A decision dated before the freeze (2026-10-22) is in the split but never scores.
    await w.run(["policy", "exam-add", JSON.stringify({ quote: "old", ref: "thr:old", at: Date.parse("2026-10-01T00:00:00Z"), descriptor: { kind: "zz_unlisted_change" }, expected: "night_proposes", why: "before the freeze" })]);
    const out = await w.run(["policy-exam"]);
    expect(out.exitCode).toBe(2);
    expect(head(out.stdout!)).toMatchObject({ split: "exam-v2", inSplit: 4, seenExcluded: 1, total: 3, needed: 20, enough: false, passed: false });
    expect(out.stdout).toContain("NOT ENOUGH UNSEEN DECISIONS YET: 3 of 20 needed");
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_v_approvals] `approvals-suggest` offers a rule for a decision the owner repeated three times, nothing for two, and changes no setting or policy", async () => {
    const w = await seeded([[1, "night_decides"], [2, "night_decides"], [3, "night_decides"], [4, "owner_only"], [5, "owner_only"]]);
    const before = JSON.stringify(await kvOf(w.bb).get("policy:exam-v2"));
    const out = await w.run(["approvals-suggest"]);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout!)).toEqual([{ pattern: "zz_unlisted_change→night_decides", times: 3, suggestion: "the owner decided zz_unlisted_change→night_decides 3 times: let the night policy decide it the same way" }]);
    expect(JSON.stringify(await kvOf(w.bb).get("policy:exam-v2"))).toBe(before);
    expect(w.db.prepare("SELECT count(*) AS n FROM lane_pilot_project_settings").get()).toEqual({ n: 0 });
    await w.harness.lifecycle.dispose();
  });
});

describe("mining the founder's decisions from his messages", () => {
  const asked = (text: string) => ({
    threads: { list: async () => [{ id: "thr-own", projectId: "projA", createdAt: 1 }], events: { list: async () => [
      { seq: 1, type: "client/turn/requested", createdAt: Date.now() - 3_600_000, data: { initiator: "user", requestId: "rq1", input: [{ type: "text", text }] } },
      { seq: 2, type: "client/turn/requested", createdAt: Date.now() - 1_800_000, data: { initiator: "user", requestId: "rq2", input: [{ type: "text", text: "а какая сегодня погода" }] } },
    ] } },
  });

  it("[sma:k_v_decisions] `policy decisions-mine` reads the owner's own messages, drafts the Russian «да, выкатывай» and not the weather question, never doubles it, and only an accept puts it into the exam", async () => {
    const w = cliWorld(asked("да, выкатывай"));
    w.mount();
    const mined = await w.run(["policy", "decisions-mine", "24"]);
    expect(mined.exitCode).toBe(0);
    expect(JSON.parse(mined.stdout!)).toEqual({ mined: 1, skipped: 1, total: 1 });
    expect(JSON.parse((await w.run(["policy", "decisions-mine", "24"])).stdout!)).toEqual({ mined: 0, skipped: 2, total: 1 });
    const drafts = JSON.parse((await w.run(["policy", "decisions-drafts"])).stdout!) as Array<{ id: string; quote: string; decision: string; expected: string }>;
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ quote: "да, выкатывай", decision: "approve", expected: "owner_only" });
    expect(JSON.parse((await w.run(["policy", "exam-export"])).stdout!).items).toEqual([]);
    const accepted = await w.run(["policy", "decisions-drafts", "accept", drafts[0]!.id]);
    expect(accepted.exitCode).toBe(0);
    expect(JSON.parse((await w.run(["policy", "exam-export"])).stdout!).items).toHaveLength(1);
    expect(JSON.parse((await w.run(["policy", "decisions-mine", "24"])).stdout!)).toMatchObject({ mined: 0, total: 0 });
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_v_decisions] a refusal in the owner's words is drafted as a refuse, and a message that only has the word inside another word is chatter", async () => {
    const w = cliWorld(asked("нет, не надо"));
    w.mount();
    expect(JSON.parse((await w.run(["policy", "decisions-mine"])).stdout!)).toMatchObject({ mined: 1 });
    expect((JSON.parse((await w.run(["policy", "decisions-drafts"])).stdout!) as Array<{ decision: string }>)[0]!.decision).toBe("refuse");
    const chatter = cliWorld(asked("yesterday it was fine"));
    chatter.mount();
    expect(JSON.parse((await chatter.run(["policy", "decisions-mine"])).stdout!)).toMatchObject({ mined: 0 });
    await w.harness.lifecycle.dispose();
    await chatter.harness.lifecycle.dispose();
  });
});

// ---- excavation of a foreign history ----
function foreignRepo(): { dir: string; fixed: string[] } {
  const dir = mkdtempSync(join(tmpdir(), "r26-git-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  git("init", "-q");
  const commit = (file: string, subject: string) => { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, file), `${subject}\n`); git("add", "-A"); git("commit", "-q", "-m", subject); return git("rev-parse", "HEAD"); };
  commit("src/b.ts", "add the settings screen");
  const crash = commit("src/a.ts", "fix the crash on an empty list");
  const parser = commit("src/c.ts", "исправить разбор даты");
  return { dir, fixed: [parser, crash] };
}

describe("excavation of a stranger's history", () => {
  it("[sma:k_v_excavate] `excavate <run>` reads the run's checkout through its machine and lists the fix commits with their files, newest first, and no feature commit", async () => {
    const repo = foreignRepo();
    const w = cliWorld();
    const asked: string[] = [];
    Object.assign(w.core, { host: { call: async (method: string, input: { command: string; cwd: string }) => { asked.push(`${method} ${input.command} @ ${input.cwd}`); return { hostId: "h1", exitCode: 0, stdout: execFileSync("/bin/bash", ["-c", input.command], { cwd: input.cwd, encoding: "utf8" }) }; } } });
    createRun(w.db, "run1", "projA");
    w.db.prepare("UPDATE lane_pilot_run SET writer_host_id='h1', writer_workspace_path=? WHERE id='run1'").run(repo.dir);
    w.mount();
    const out = await w.run(["excavate", "run1"]);
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout!)).toEqual([
      { commit: repo.fixed[0]!.slice(0, 12), subject: "исправить разбор даты", files: ["src/c.ts"] },
      { commit: repo.fixed[1]!.slice(0, 12), subject: "fix the crash on an empty list", files: ["src/a.ts"] },
    ]);
    expect(asked).toEqual([`runCommand git 'log' '--no-merges' '-n' '400' '--name-only' '--format=%x01%H%x02%s' @ ${repo.dir}`]);
    // A run with no checkout on a machine has nothing to read.
    createRun(w.db, "run2", "projA");
    expect((await w.run(["excavate", "run2"])).exitCode).toBe(1);
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_lib_excavate] the log arguments the verb sends make a real `git log` print a block per commit that the parser reads back as the commit's own files", () => {
    const repo = foreignRepo();
    const log = execFileSync("git", [...EXCAVATE_LOG_ARGS.map((arg) => arg.replace("%x01", "\u0001").replace("%x02", "\u0002"))], { cwd: repo.dir, encoding: "utf8" });
    const found = excavate(execFileSync("git", [...EXCAVATE_LOG_ARGS], { cwd: repo.dir, encoding: "utf8" }));
    expect(log).toContain("\u0001");
    expect(found.map((row) => [row.subject, row.files])).toEqual([["исправить разбор даты", ["src/c.ts"]], ["fix the crash on an empty list", ["src/a.ts"]]]);
  });
});

// ---- the report ----
describe("the local report", () => {
  it("[sma:k_v_metrics] `report` is one HTML page with the SMA map, the money and the cost per verified result of a project that has an accepted task", async () => {
    const w = cliWorld();
    const services = { ownerPresence: { sweep: async () => [], journal: () => [] }, money: { status: () => ({ monthUsd: 12.5, cap: 50 }) } } as unknown as Services;
    registerCli(w.core, services, migrations);
    createRun(w.db, "run1", "projA");
    const day = new Date().toISOString().slice(0, 10);
    w.db.prepare("INSERT INTO lane_pilot_token_daily(day,project_id,provider_id,model,total_tokens) VALUES (?,?,?,?,?)").run(day, "projA", "p", "m", 600);
    createTask(w.db, { id: "task-ok", runId: "run1", kind: "bb", contract: { id: "task-ok" } });
    createAttempt(w.db, { id: "att-ok", runId: "run1", taskId: "task-ok" });
    w.db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att-ok'").run();
    const out = await w.run(["report"]);
    expect(out.exitCode).toBe(0);
    const page = out.stdout!;
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("<h2>Money</h2>");
    expect(page).toContain("<td>12.5</td>");
    expect(page).toContain("<h2>Cost per verified result (30 days)</h2><table><thead><tr><th>projectId</th><th>tokens</th><th>accepted</th><th>tokensPerAccepted</th></tr></thead><tbody><tr><td>projA</td><td>600</td><td>1</td><td>600</td></tr>");
    expect(page).toMatch(/<h2>SMA map: checked by contract tests \d+(\.\d+)?%, mapped by proof links \d+(\.\d+)?%<\/h2>/);
    await w.harness.lifecycle.dispose();
  });

  it("[sma:k_lib_report] the page is one self-contained file: styles inline, no outside address, every cell escaped, columns of all rows of a section", () => {
    const page = htmlReport({ title: "A & B", sections: [
      { heading: "<spend>", rows: [{ project: "projA", note: "<script>alert(1)</script>" }, { project: "projB", extra: { n: 1 } }] },
      { heading: "none", rows: [] },
    ] });
    expect(page.startsWith("<!doctype html><meta charset=\"utf-8\"><title>A &amp; B</title><style>")).toBe(true);
    expect(page).toContain("<h2>&lt;spend&gt;</h2>");
    expect(page).toContain("<th>project</th><th>note</th><th>extra</th>");
    expect(page).toContain("<td>projB</td><td></td><td>{&quot;n&quot;:1}</td>");
    expect(page).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(page).not.toMatch(/<script|<link|<img|\bsrc=|\bhref=|https?:\/\/|url\(|@import/);
  });
});

// ---- process telemetry ----
describe("process telemetry from the stage record", () => {
  it("[sma:k_lib_metrics] the work graph reads rounds, failed rounds and time per stage from the stage events of two tasks: a task sent back once shows one return and its lead time, and reading writes nothing", async () => {
    const w = cliWorld();
    createRun(w.db, "run1", "projA");
    const t0 = Date.now() - 3_600_000;
    const event = (task: string, state: string, at: number) => w.db.prepare("INSERT INTO lane_pilot_stage_event(project_id,run_id,task_id,stage_id,state,input_sha256,output_sha256,attempt,occurred_at) VALUES ('projA','run1',?,'verification',?,'x',NULL,0,?)").run(task, state, at);
    for (const id of ["t1", "t2"]) createTask(w.db, { id, runId: "run1", kind: "bb", contract: { id } });
    event("t1", "running", t0); event("t1", "failed", t0 + 10_000); event("t1", "running", t0 + 20_000); event("t1", "passed", t0 + 50_000);
    event("t2", "running", t0); event("t2", "passed", t0 + 20_000);
    const counts = () => w.db.prepare("SELECT (SELECT count(*) FROM lane_pilot_stage_event) AS events, (SELECT count(*) FROM lane_pilot_stage_receipt) AS receipts, (SELECT count(*) FROM lane_pilot_attempt) AS attempts").get();
    const before = counts();
    const rpc = workGraphRpc({ bb: w.bb as never, db: w.db }, { tokenCursorRow: (() => null) as never });
    const graph = await rpc.work_graph_task({ runId: "run1", taskId: "t1" });
    expect(graph.cells).toEqual([{ stageId: "verification", state: "passed", rounds: 2, failures: 1, reason: null }]);
    expect(graph.summary).toMatchObject({ returns: 1, seconds: 40 });
    const stats = await rpc.work_graph_stats({ days: 30 });
    expect(stats).toMatchObject({ tasks: 2, days: 30 });
    expect(stats.stages).toEqual([{ stageId: "verification", green: 2, red: 0, skipped: 0, unknown: 0, greenShare: 1, medianRounds: 1.5, medianCostUsd: null, medianSeconds: 30 }]);
    expect(counts()).toEqual(before);
    await w.harness.lifecycle.dispose();
  });
});

// ---- the model-free bench ----
describe("the baseline bench verb", () => {
  function benchWorld() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    db.prepare("UPDATE lane_pilot_run SET writer_host_id='h1', writer_workspace_path='/repo' WHERE id='run1'").run();
    const accepted = (id: string, expected: string[], changed: string[], merge: string) => {
      createTask(db, { id, runId: "run1", kind: "bb", contract: { id, expected_outputs: expected } });
      createAttempt(db, { id: `att-${id}`, runId: "run1", taskId: id });
      db.prepare("UPDATE lane_pilot_attempt SET state='accepted', updated_at=? WHERE id=?").run(Date.now() - 3_600_000, `att-${id}`);
      db.prepare("INSERT INTO lane_pilot_attempt_change(attempt_id,run_id,task_id,merge_commit,outcome,changed_json,recorded_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
        .run(`att-${id}`, "run1", id, merge, "merged", JSON.stringify(changed.map((path) => ({ path, status: "M" }))), 1, 1);
    };
    accepted("good", ["src/a.ts"], ["src/a.ts"], "a".repeat(40));
    accepted("ghost", ["src/b.ts"], ["docs/x.md"], "b".repeat(40));
    db.prepare("INSERT INTO lane_pilot_regression(found_at,updated_at,project_id,run_id,task_id,command,kind,bisect_status,culprit_task) VALUES (1,1,'projA','run1','other','npm test','regression','found','ghost')").run();
    const probes: string[] = [];
    const host = { run: async (_host: string, _cwd: string, command: string) => { probes.push(command); return { exitCode: 0, stdout: `ok ${"a".repeat(40)}\nlost ${"b".repeat(40)}\n`, stderr: "" }; } };
    return { bench: createBench({ db: db as never, kv: bb.storage.kv as never, host, pipeline: {} as never, projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined }), probes };
  }

  it("[sma:k_v_bench] `bench baseline` prints the three model-free numbers of the accepted attempts, as text and as JSON, for one project or the window, and asks git on the project's machine", async () => {
    const { bench, probes } = benchWorld();
    const json = await runBenchCli(bench, ["baseline", "--json"]);
    expect(json.exitCode).toBe(0);
    const metrics = JSON.parse(json.stdout!);
    expect(metrics).toMatchObject({ accepted: 2, falseDone: { count: 1, rate: 0.5, tasks: ["ghost"] }, gitLoss: { merged: 2, checked: 2, recoverable: 1, rate: 0.5, lost: ["b".repeat(40)] } });
    expect(metrics.phantomWrites.attempts).toEqual([{ attemptId: "att-ghost", taskId: "ghost", missing: ["src/b.ts"] }]);
    const text = await runBenchCli(bench, ["baseline"]);
    expect(text.stdout).toContain("2 accepted task(s)");
    expect(text.stdout).toContain("false-done rate 50% (1:");
    expect(text.stdout).toContain("git loss recoverability 50% (1 of 2");
    expect(probes).toHaveLength(2);
    expect(JSON.parse((await runBenchCli(bench, ["baseline", "--project", "nobody", "--json"])).stdout!)).toMatchObject({ accepted: 0, falseDone: { count: 0, rate: null } });
    expect((await runBenchCli(bench, ["baseline", "--days", "0"])).exitCode).toBe(1);
  });
});

// ---- the memory measurement ----
describe("the memory measurement that can be repeated", () => {
  const DAY = 86_400_000;
  const T0 = Date.parse("2026-10-01T00:00:00Z");
  const zones = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
  /** An extract file as `memory-eval --export` writes it: twelve notes, one task per note's folder (positive) and eight on folders no note names (negative). */
  function extract(): string {
    const path = join(mkdtempSync(join(tmpdir(), "r26-eval-")), "extract.db");
    const out = new Database(path);
    out.exec(`CREATE TABLE memory (id TEXT, project_id TEXT, kind TEXT, content TEXT, concepts_json TEXT, created_at INTEGER, status TEXT, trust TEXT, origin TEXT, use_count INTEGER, accepted_count INTEGER);
      CREATE TABLE question (attempt_id TEXT, task_id TEXT, project_id TEXT, started_at INTEGER, attempt_no INTEGER, produced_json TEXT, picked_json TEXT, contract_json TEXT);`);
    const note = out.prepare("INSERT INTO memory VALUES (?,?,?,?,?,?,?,?,?,?,?)"), question = out.prepare("INSERT INTO question VALUES (?,?,?,?,?,?,?,?)");
    const contract = (title: string, owns: string[]) => JSON.stringify({ title, objective: `${title} in the project`, acceptance: [], owns_paths: owns, read_first: [] });
    zones.forEach((zone, n) => {
      const content = `The ${zone} screen is built in apps/web/zone${n}/panel${n}.vue and keeps its state in a store.`;
      note.run(memoryRecordId("P", "note", content), "P", "note", content, '["area"]', T0 + n * 1000, "active", "confirmed", "maintainer", 0, 0);
      question.run(`att${n}`, `task${n}`, "P", T0 + 2 * DAY + n * 1000, 1, JSON.stringify([`apps/web/zone${n}/panel${n}.vue`]), "[]", contract(`Change the ${zone} screen`, [`apps/web/zone${n}/panel${n}.vue`]));
    });
    for (let n = 12; n < 20; n += 1) question.run(`att${n}`, `task${n}`, "P", T0 + 2 * DAY + n * 1000, 1, JSON.stringify([`apps/api/area${n}/handler${n}.ts`]), "[]", contract(`Rework handler number ${n}`, [`apps/api/area${n}/handler${n}.ts`]));
    out.close();
    return path;
  }
  /** What a report says about retrieval, without the run's own timing. */
  const scores = (stdout: string) => { const report = JSON.parse(stdout); return { seed: report.seed, command: report.command, sizes: report.sizes.map((size: { size: number; scores: Array<Record<string, unknown>> }) => size.scores.map(({ latencyMs: _ms, ...rest }) => rest)) }; };

  it("[sma:k_v_baseline] the hub's data leaves in one extract file and the same seed gives the same retrieval scores from it a second time; another seed is another report", async () => {
    const live = new Database(":memory:");
    for (const statement of migrations) live.exec(statement);
    const insert = live.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,content,concepts_json,created_at,status,trust,origin,use_count,accepted_count,scope_json,audience,personal_bot,source_sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    insert.run("n1", "P", "note", "The alpha screen is built in apps/web/zone0/panel0.vue.", '["area"]', T0, "active", "confirmed", "maintainer", 0, 0, "[]", "subagent", "", "a".repeat(64));
    const exportPath = join(mkdtempSync(join(tmpdir(), "r26-export-")), "hub-extract.db");
    const exported = await runMemoryEvalCommand(live, ["--export", exportPath], migrations);
    expect(JSON.parse(exported.stdout!)).toEqual({ notes: 1, questions: 0 });
    const path = extract();
    const args = ["--source", path, "--sizes", "30", "--seed", "7", "--json"];
    const first = await runMemoryEvalCommand(null, args, migrations);
    const second = await runMemoryEvalCommand(null, args, migrations);
    expect(first.exitCode, first.stderr).toBe(0);
    expect(scores(first.stdout!)).toEqual(scores(second.stdout!));
    expect(scores(first.stdout!).seed).toBe(7);
    const writer = JSON.parse(first.stdout!).sizes[0].scores.find((row: { id: string }) => row.id === "writer");
    expect(writer.hit.n).toBe(12);
    const other = await runMemoryEvalCommand(null, ["--source", path, "--sizes", "30", "--seed", "8", "--json"], migrations);
    expect(scores(other.stdout!).seed).toBe(8);
    expect(JSON.stringify(scores(other.stdout!).sizes)).not.toBe(JSON.stringify(scores(first.stdout!).sizes));
  });

  it("[sma:k_lib_baseline] every report ends with the command that reproduces it, and running that command again gives the same scores", async () => {
    const path = extract();
    const first = await runMemoryEvalCommand(null, ["--source", path, "--sizes", "30", "--seed", "7"], migrations);
    const command = `bb lane-pilot memory-eval --source ${path} --sizes 30 --seed 7 --scope project`;
    expect(first.stdout!.trimEnd().split("\n").at(-1)).toBe(`reproduce: ${command}`);
    const asJson = await runMemoryEvalCommand(null, ["--source", path, "--sizes", "30", "--seed", "7", "--no-floor", "--json"], migrations);
    expect(JSON.parse(asJson.stdout!).command).toBe(`${command} --no-floor`);
    // The printed command, run as printed, repeats the report.
    const again = await runMemoryEvalCommand(null, [...command.replace("bb lane-pilot memory-eval ", "").split(" "), "--json"], migrations);
    const original = await runMemoryEvalCommand(null, ["--source", path, "--sizes", "30", "--seed", "7", "--json"], migrations);
    expect(scores(again.stdout!).sizes).toEqual(scores(original.stdout!).sizes);
    const shelf = await runMemoryEvalCommand(null, ["--source", path, "--shelf"], migrations);
    expect(shelf.stdout!.trimEnd().split("\n").at(-1)).toBe(`reproduce: bb lane-pilot memory-eval --source ${path} --shelf --sizes 30,300,3000 --seed 1 --scope project`);
  });

  it("[sma:k_v_eval] `memory-eval --north-star` appends the cost per verified result, and the same run without the flag does not; `--gate` runs the frozen cases and exits 0", async () => {
    const path = extract();
    const northStar = () => [{ projectId: "P", tokens: 900, accepted: 3, tokensPerAccepted: 300 }];
    const star = await runMemoryEvalCommand(null, ["--source", path, "--sizes", "30", "--north-star"], migrations, { northStar });
    expect(star.exitCode, star.stderr).toBe(0);
    expect(star.stdout).toContain("cost per verified result (tokens per accepted task):\n- P: 300 tokensPerAccepted (3");
    const plain = await runMemoryEvalCommand(null, ["--source", path, "--sizes", "30"], migrations, { northStar });
    expect(plain.stdout).not.toContain("cost per verified result");
    const gate = await runMemoryEvalCommand(null, ["--gate"], migrations);
    expect(gate.exitCode).toBe(0);
    expect(gate.stdout).toMatch(/memory gate: 40 cases, 0 leaks/);
  });
});

// END
