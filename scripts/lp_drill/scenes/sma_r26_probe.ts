// Probe of scenes/sma_r26.py: drives the real entries of THIS checkout (the commit under drill) on scratch databases and folders, and prints what they
// returned as one JSON line. It judges nothing: the scene compares each value with the card's expected result and prove()s it. No model, no hub write.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { memoryRecordId } from "../../../packages/memory-core/src";
import { createAttempt, createRun, createTask } from "../../../src/rooms/storage";
import { migrations, openDatabase } from "../../../src/rooms/plugin-db";
import plugin from "../../../server";
import { createRuleScan } from "../../../src/rooms/self-repair/server/rule-scan";
import { selfRepairDeps } from "../../../src/rooms/self-repair/server";
import { mountNightGraphs } from "../../../src/rooms/night-graphs/server";
import { adoptRuleProposal } from "../../../src/rooms/self-repair/server/insights";
import { ruleTier } from "../../../packages/run-insights/src/rules";
import { saveReasoningTrace } from "../../../src/rooms/storage";
import { nightWorld } from "../../../tests/night-graphs/world";
import { recordMemoryMiss } from "@lane-pilot/memory-core";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { saveProjectSetting } from "../../../src/rooms/storage";
import { logRuleEvent } from "../../../packages/run-insights/src/rules";
import { CURRICULUM_KV_KEY } from "../../../src/rooms/tools/server/self-improve";
import { finishRunRow, saveResult, startRunRow } from "../../../src/rooms/bench/store";
import { createBench } from "../../../src/rooms/bench/service";
import { runBenchCli } from "../../../src/rooms/bench/cli";
import { createCore } from "../../../src/rooms/core/server/core";
import { registerCli } from "../../../src/rooms/tools/server/cli";
import { costPerVerified, htmlReport } from "../../../src/rooms/tools/server/self-improve";
import { workGraphRpc } from "../../../src/rooms/work-graph/server/rpc";
import type { Services } from "../../../server";
import { runMemoryEvalCommand } from "../../../src/rooms/memory-eval/server/command";

const jsonOf = (text: string | undefined) => { try { return JSON.parse(text ?? "null"); } catch { return null; } };
const out: Record<string, unknown> = {};

type Fn = (context: { signal: AbortSignal }) => unknown;
const signal = new AbortController().signal;
const kvOf = (bb: unknown) => (bb as { storage: { kv: { get(key: string): Promise<unknown> } } }).storage.kv;
const FROZEN_AFTER = Date.parse("2026-11-01T00:00:00Z");
const decision = (n: number, expected: string) => JSON.stringify({ quote: `decision ${n}`, ref: `thr:${n}`, at: FROZEN_AFTER + n * 1000, descriptor: { kind: "zz_unlisted_change" }, expected, why: `the owner decided ${n}` });
async function world(sdk?: Record<string, unknown>) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", ...(sdk ? { sdk: sdk as never } : {}) });
  const registered = new Map<string, Fn>();
  (bb.background as unknown as Record<string, unknown>).experimental_vkSchedule = (name: string, _cron: string, fn: Fn) => { registered.set(name, fn); };
  await plugin(bb);
  const db = openDatabase(bb);
  return { bb, harness, db, registered, run: (argv: string[]) => harness.behavior.runCli(argv), fire: (name: string) => registered.get(name)!({ signal }) };
}

// ---- the weekly curriculum (n1710, n1721) ----
{
  const w = await world();
  for (let i = 0; i < 3; i += 1) recordMemoryMiss(w.db, "p1", "who owns the wall", Date.now() - 3_600_000);
  saveProjectSetting(w.db, GLOBAL_SETTINGS_PROJECT_ID, "curriculum.weekly", "off");
  await w.fire("curriculum-weekly");
  const whenOff = (await kvOf(w.bb).get(CURRICULUM_KV_KEY)) ?? null;
  saveProjectSetting(w.db, GLOBAL_SETTINGS_PROJECT_ID, "curriculum.weekly", "on");
  await w.fire("curriculum-weekly");
  const brief = (await kvOf(w.bb).get(CURRICULUM_KV_KEY)) ?? null;
  out.curriculum = { scheduled: w.registered.has("curriculum-weekly"), whenOff, brief, printed: (await w.run(["curriculum", "--brief"])).stdout ?? null };
  await w.harness.lifecycle.dispose();
}

// ---- the decision corpus, the exam, the approvals (n1723, n1713, n1724, n1719) ----
{
  const w = await world();
  const first = jsonOf((await w.run(["policy", "exam-add", decision(1, "owner_only")])).stdout);
  const again = jsonOf((await w.run(["policy", "exam-add", decision(1, "owner_only")])).stdout);
  const item = jsonOf((await w.run(["policy", "exam-export"])).stdout)?.items?.[0];
  w.db.prepare(`INSERT INTO lane_pilot_rule_proposal (id,project_id,signature,rule,author,state,occurrences,task_count,examples_json,first_seen_at,last_seen_at,updated_at)
    VALUES ('r9','projA','r9','run lint before commit','model','accepted',3,3,'[]',1,1,1)`).run();
  logRuleEvent(w.db, "projA", "r9", "owner_accepted", "kept", FROZEN_AFTER);
  await w.fire("policy-exam-collect");
  await w.fire("policy-exam-collect");
  const stored = await kvOf(w.bb).get("policy:exam-v2") as Array<{ source: { type: string }; expected: string }>;
  out.corpus = { first, again, item: item ? { quote: item.quote, expected: item.expected, why: item.why, strength: item.strength, source: item.source?.type } : null, storedTotal: stored.length, collected: stored.filter((row) => row.source.type === "rule_proposal").map((row) => row.expected) };
  await w.harness.lifecycle.dispose();
}
{
  const w = await world();
  const kinds = [...Array.from({ length: 16 }, () => "night_proposes"), "night_decides", "night_decides", "owner_only", "owner_only"];
  for (const [n, expected] of kinds.entries()) await w.run(["policy", "exam-add", decision(n, expected)]);
  const scored = await w.run(["policy-exam"]);
  const text = scored.stdout ?? "";
  const head = jsonOf(text.slice(0, text.lastIndexOf("}\n") + 1));
  out.exam = { exitCode: scored.exitCode, total: head?.total, correct: head?.correct, unsafe: head?.unsafe, passed: head?.passed, verdict: text.includes("PASSED: 16/20 = 0.8 on unseen decisions (bar 0.8)") };
  await w.harness.lifecycle.dispose();
  const few = await world();
  for (const n of [1, 2, 3]) await few.run(["policy", "exam-add", decision(n, "night_decides")]);
  await few.run(["policy", "exam-add", JSON.stringify({ quote: "old", ref: "thr:old", at: Date.parse("2026-10-01T00:00:00Z"), descriptor: { kind: "zz_unlisted_change" }, expected: "night_decides", why: "before the freeze" })]);
  const gap = await few.run(["policy-exam"]);
  const gtext = gap.stdout ?? "";
  const ghead = jsonOf(gtext.slice(0, gtext.lastIndexOf("}\n") + 1));
  out.examGap = { exitCode: gap.exitCode, inSplit: ghead?.inSplit, seenExcluded: ghead?.seenExcluded, total: ghead?.total, enough: ghead?.enough, said: gtext.includes("NOT ENOUGH UNSEEN DECISIONS YET: 3 of 20 needed") };
  out.approvals = jsonOf((await few.run(["approvals-suggest"])).stdout);
  await few.harness.lifecycle.dispose();
}

// ---- mining the owner's messages (n1712) ----
{
  const asked = { threads: { list: async () => [{ id: "thr-own", projectId: "projA", createdAt: 1 }], events: { list: async () => [
    { seq: 1, type: "client/turn/requested", createdAt: Date.now() - 3_600_000, data: { initiator: "user", requestId: "rq1", input: [{ type: "text", text: "да, выкатывай" }] } },
    { seq: 2, type: "client/turn/requested", createdAt: Date.now() - 1_800_000, data: { initiator: "user", requestId: "rq2", input: [{ type: "text", text: "а какая сегодня погода" }] } },
  ] } } };
  const w = await world(asked);
  const first = jsonOf((await w.run(["policy", "decisions-mine", "24"])).stdout);
  const second = jsonOf((await w.run(["policy", "decisions-mine", "24"])).stdout);
  const drafts = jsonOf((await w.run(["policy", "decisions-drafts"])).stdout) as Array<{ id: string; quote: string; decision: string; expected: string }>;
  const before = jsonOf((await w.run(["policy", "exam-export"])).stdout)?.items?.length;
  await w.run(["policy", "decisions-drafts", "accept", drafts[0]?.id ?? "none"]);
  const after = jsonOf((await w.run(["policy", "exam-export"])).stdout)?.items?.length;
  out.mine = { first, second, drafts: drafts.map((d) => [d.quote, d.decision, d.expected]), before, after };
  await w.harness.lifecycle.dispose();
}

// ---- the nightly rules scan and the ladder verb (n1711, n1722): the scan runs on a scratch night world, no model ----
{
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
  const before = ruleTier(db as never, "proj-1", "r1");
  await scan.startScan("proj-1", "en", { night: "2026-11-14" });
  for (let i = 0; i < 300; i += 1) { await w.engine.idle(); if ((await scan.scanState("proj-1")).state !== "running") break; await new Promise((resolve) => setTimeout(resolve, 10)); }
  const events = db.prepare("SELECT action, detail FROM lane_pilot_rule_event WHERE project_id='proj-1' AND rule_id='r1' AND action='tier'").all();
  registerCli(w.ctx, w.services as unknown as Services, migrations);
  const shown = await w.harness.behavior.runCli(["rules", "ladder", "proj-1"]);
  out.ladder = { before, events, after: ruleTier(db as never, "proj-1", "r1"), shown: shown.stdout ?? null };
}

// ---- the arena (n1714, n1725) ----
{
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  db.prepare("INSERT INTO lane_pilot_bench_set(id,version,manifest_sha256,task_count,candidate_count,created_at) VALUES('s1','v1','x',1,1,0)").run();
  const put = (arm: string, costUsd: number, accepted: boolean) => {
    const run = startRunRow(db, { setId: "s1", arm, repeat: 1, config: {}, budgetTokens: null, budgetHours: null });
    finishRunRow(db, run.id, "done", null);
    saveResult(db, { runId: run.id, taskId: "t1", position: 0, state: accepted ? "accepted" : "rejected", accepted, benchTaskId: null, lpRunId: null, attempts: 1, stagesPassed: 2, stagesFailed: 0, tokens: 10, costUsd, costState: "measured", seconds: 5, reason: null, recordedAt: 1 });
  };
  put("stored", 4, true);
  const ran: string[] = [];
  const costs: Record<string, [number, boolean]> = { dear: [9, true], cheap: [0.5, true], failing: [3, false] };
  const bench = createBench({ db: db as never, kv: bb.storage.kv as never, host: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, pipeline: {} as never, projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined,
    arenaRun: async (input: { arm: string }) => { ran.push(input.arm); put(input.arm, costs[input.arm]![0], costs[input.arm]![1]); } } as never);
  const arena = await runBenchCli(bench, ["arena", "stored", "dear", "cheap", "failing", "--set", "v1", "--json"]);
  const table = jsonOf(arena.stdout)?.table as { rows: Array<{ arm: string; rank: number; costPerVerified: number | null }> } | null;
  out.arena = { exitCode: arena.exitCode, ran, ranks: table?.rows.map((row) => [row.arm, row.rank, row.costPerVerified]) ?? null };
}

// ---- the model-free bench (n1715) ----
{
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
  const host = { run: async () => ({ exitCode: 0, stdout: `ok ${"a".repeat(40)}\nlost ${"b".repeat(40)}\n`, stderr: "" }) };
  const bench = createBench({ db: db as never, kv: bb.storage.kv as never, host, pipeline: {} as never, projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined });
  const json = jsonOf((await runBenchCli(bench, ["baseline", "--json"])).stdout);
  out.baseline = { accepted: json?.accepted, falseDone: json?.falseDone, phantom: json?.phantomWrites?.attempts, gitLoss: json?.gitLoss, text: (await runBenchCli(bench, ["baseline"])).stdout ?? null };
}

// ---- the memory measurement (n1716, n1727, n1717, n1728) ----
{
  const DAY = 86_400_000, T0 = Date.parse("2026-10-01T00:00:00Z");
  const zones = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima"];
  const path = join(mkdtempSync(join(tmpdir(), "r26-eval-")), "extract.db");
  const file = new Database(path);
  file.exec(`CREATE TABLE memory (id TEXT, project_id TEXT, kind TEXT, content TEXT, concepts_json TEXT, created_at INTEGER, status TEXT, trust TEXT, origin TEXT, use_count INTEGER, accepted_count INTEGER);
    CREATE TABLE question (attempt_id TEXT, task_id TEXT, project_id TEXT, started_at INTEGER, attempt_no INTEGER, produced_json TEXT, picked_json TEXT, contract_json TEXT);`);
  const note = file.prepare("INSERT INTO memory VALUES (?,?,?,?,?,?,?,?,?,?,?)"), question = file.prepare("INSERT INTO question VALUES (?,?,?,?,?,?,?,?)");
  const contract = (title: string, owns: string[]) => JSON.stringify({ title, objective: `${title} in the project`, acceptance: [], owns_paths: owns, read_first: [] });
  zones.forEach((zone, n) => {
    const content = `The ${zone} screen is built in apps/web/zone${n}/panel${n}.vue and keeps its state in a store.`;
    note.run(memoryRecordId("P", "note", content), "P", "note", content, '["area"]', T0 + n * 1000, "active", "confirmed", "maintainer", 0, 0);
    question.run(`att${n}`, `task${n}`, "P", T0 + 2 * DAY + n * 1000, 1, JSON.stringify([`apps/web/zone${n}/panel${n}.vue`]), "[]", contract(`Change the ${zone} screen`, [`apps/web/zone${n}/panel${n}.vue`]));
  });
  for (let n = 12; n < 20; n += 1) question.run(`att${n}`, `task${n}`, "P", T0 + 2 * DAY + n * 1000, 1, JSON.stringify([`apps/api/area${n}/handler${n}.ts`]), "[]", contract(`Rework handler number ${n}`, [`apps/api/area${n}/handler${n}.ts`]));
  file.close();
  const scoresOf = (stdout: string | undefined) => { const report = jsonOf(stdout); return report ? { seed: report.seed, sizes: report.sizes.map((size: { scores: Array<Record<string, unknown>> }) => size.scores.map(({ latencyMs: _ms, ...rest }) => rest)) } : null; };
  const args = ["--source", path, "--sizes", "30", "--seed", "7", "--json"];
  const first = await runMemoryEvalCommand(null, args, migrations);
  const second = await runMemoryEvalCommand(null, args, migrations);
  const text = await runMemoryEvalCommand(null, ["--source", path, "--sizes", "30", "--seed", "7"], migrations);
  const command = `bb lane-pilot memory-eval --source ${path} --sizes 30 --seed 7 --scope project`;
  const printed = await runMemoryEvalCommand(null, [...command.replace("bb lane-pilot memory-eval ", "").split(" "), "--json"], migrations);
  const ns = { northStar: () => [{ projectId: "P", tokens: 900, accepted: 3, tokensPerAccepted: 300 }] };
  const star = await runMemoryEvalCommand(null, ["--source", path, "--sizes", "30", "--north-star"], migrations, ns);
  const plain = await runMemoryEvalCommand(null, ["--source", path, "--sizes", "30"], migrations, ns);
  const gate = await runMemoryEvalCommand(null, ["--gate"], migrations);
  out.memory = {
    repeated: JSON.stringify(scoresOf(first.stdout)) === JSON.stringify(scoresOf(second.stdout)), seed: scoresOf(first.stdout)?.seed,
    reproduceLine: (text.stdout ?? "").trimEnd().split("\n").at(-1), command,
    printedRepeats: JSON.stringify(scoresOf(printed.stdout)?.sizes) === JSON.stringify(scoresOf(first.stdout)?.sizes),
    northStar: (star.stdout ?? "").includes("- P: 300 tokensPerAccepted (3"), noNorthStar: !(plain.stdout ?? "").includes("cost per verified result"), gate: [gate.exitCode, (gate.stdout ?? "").slice(0, 60)],
  };
}

// ---- excavation, cost per verified result, the report, process telemetry (n1718, n1730, n1729, n1720, n1732, n1731) ----
{
  const dir = mkdtempSync(join(tmpdir(), "r26-git-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env }).trim();
  git("init", "-q");
  const commit = (file: string, subject: string) => { mkdirSync(join(dir, "src"), { recursive: true }); writeFileSync(join(dir, file), `${subject}\n`); git("add", "-A"); git("commit", "-q", "-m", subject); return git("rev-parse", "HEAD").slice(0, 12); };
  commit("src/b.ts", "add the settings screen");
  const crash = commit("src/a.ts", "fix the crash on an empty list");
  const parser = commit("src/c.ts", "исправить разбор даты");
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const core = createCore(bb, db);
  const asked: string[] = [];
  Object.assign(core, { host: { call: async (_method: string, input: { command: string; cwd: string }) => { asked.push(input.command); return { hostId: "h1", exitCode: 0, stdout: execFileSync("/bin/bash", ["-c", input.command], { cwd: input.cwd, encoding: "utf8" }) }; } } });
  const services = { ownerPresence: { sweep: async () => [], journal: () => [] }, money: { status: () => ({ monthUsd: 12.5, cap: 50 }) } } as unknown as Services;
  registerCli(core, services, migrations);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h1', writer_workspace_path=? WHERE id='run1'").run(dir);
  const found = jsonOf((await harness.behavior.runCli(["excavate", "run1"])).stdout) as Array<{ commit: string; subject: string; files: string[] }> | null;
  out.excavate = { found: found?.map((row) => [row.commit, row.subject, row.files]) ?? null, expected: [[parser, "исправить разбор даты", ["src/c.ts"]], [crash, "fix the crash on an empty list", ["src/a.ts"]]], asked };

  const day = new Date().toISOString().slice(0, 10);
  db.prepare("INSERT INTO lane_pilot_token_daily(day,project_id,provider_id,model,total_tokens) VALUES (?,?,?,?,?)").run(day, "projA", "p", "m", 600);
  createTask(db, { id: "task-ok", runId: "run1", kind: "bb", contract: { id: "task-ok" } });
  createAttempt(db, { id: "att-ok", runId: "run1", taskId: "task-ok" });
  db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att-ok'").run();
  out.cost = costPerVerified(db as never).map((row) => [row.projectId, row.tokens, row.accepted, row.tokensPerAccepted]);
  const page = (await harness.behavior.runCli(["report"])).stdout ?? "";
  out.report = { doctype: page.startsWith("<!doctype html>"), money: page.includes("<td>12.5</td>"), cost: page.includes("<tr><td>projA</td><td>600</td><td>1</td><td>600</td></tr>"), map: /<h2>SMA map: checked by contract tests [\d.]+%, mapped by proof links [\d.]+%<\/h2>/.test(page) };
  const small = htmlReport({ title: "A & B", sections: [{ heading: "<spend>", rows: [{ project: "projA", note: "<script>alert(1)</script>" }, { project: "projB", extra: { n: 1 } }] }] });
  out.page = { heading: small.includes("<h2>&lt;spend&gt;</h2>"), columns: small.includes("<th>project</th><th>note</th><th>extra</th>"), escaped: small.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), outside: /<script|<link|<img|\bsrc=|\bhref=|https?:\/\/|url\(|@import/.test(small) };

  const t0 = Date.now() - 3_600_000;
  const event = (task: string, state: string, at: number) => db.prepare("INSERT INTO lane_pilot_stage_event(project_id,run_id,task_id,stage_id,state,input_sha256,output_sha256,attempt,occurred_at) VALUES ('projA','run1',?,'verification',?,'x',NULL,0,?)").run(task, state, at);
  for (const id of ["t1", "t2"]) createTask(db, { id, runId: "run1", kind: "bb", contract: { id } });
  event("t1", "running", t0); event("t1", "failed", t0 + 10_000); event("t1", "running", t0 + 20_000); event("t1", "passed", t0 + 50_000);
  event("t2", "running", t0); event("t2", "passed", t0 + 20_000);
  const counts = () => JSON.stringify(db.prepare("SELECT (SELECT count(*) FROM lane_pilot_stage_event) AS events, (SELECT count(*) FROM lane_pilot_stage_receipt) AS receipts, (SELECT count(*) FROM lane_pilot_attempt) AS attempts").get());
  const before = counts();
  const rpc = workGraphRpc({ bb: bb as never, db }, { tokenCursorRow: (() => null) as never });
  const graph = await rpc.work_graph_task({ runId: "run1", taskId: "t1" });
  const stats = await rpc.work_graph_stats({ days: 30 });
  out.telemetry = { cells: graph.cells, returns: graph.summary.returns, seconds: graph.summary.seconds, stage: stats.stages[0], writes: counts() !== before };
  await harness.lifecycle.dispose();
}

process.stdout.write(`${JSON.stringify(out)}\n`);
process.exit(0);
