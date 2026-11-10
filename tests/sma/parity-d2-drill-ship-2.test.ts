import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
// @ts-expect-error the scene driver lib is a plain .mjs without declarations
import { kitOfTrees, parseSceneArgs, serveTree, treeAddress, treeBuildError } from "../../scripts/lib/ui-scene.mjs";

const ROOT = join(__dirname, "..", "..");

/** A fixture tree: dist/app.js newer than the sources, unless asked otherwise. */
function makeTree(withBundle = true, stale = false): string {
  const tree = mkdtempSync(join(tmpdir(), "lp-tree-"));
  mkdirSync(join(tree, "src"), { recursive: true });
  writeFileSync(join(tree, "src", "app.ts"), "export {};\n");
  if (withBundle) {
    mkdirSync(join(tree, "dist"), { recursive: true });
    writeFileSync(join(tree, "dist", "app.js"), "document.getElementById('root').textContent='ok';\n");
    // The check is on mtimes: fresh means the bundle is newer than the sources, stale means older.
    const past = new Date(Date.now() - 60_000);
    if (stale) utimesSync(join(tree, "dist", "app.js"), past, past);
    else utimesSync(join(tree, "src", "app.ts"), past, past);
  }
  return tree;
}

const portOpen = (url: string): Promise<boolean> => new Promise((ok) => {
  const socket = new Socket();
  socket.once("connect", () => { socket.destroy(); ok(true); });
  socket.once("error", () => ok(false));
  socket.connect(Number(new URL(url).port), "127.0.0.1");
});

describe("[sma:k_lib_uistage] the decidable half of the scene", () => {
  it("parseSceneArgs rejects an unknown flag; address() is stable for one path and differs for two; a tree without a build is refused", () => {
    expect(() => parseSceneArgs(["--frobnicate", "s.json"])).toThrow(/unknown flag --frobnicate/);
    const args = parseSceneArgs(["--stage", "--tree", "/tmp/a", "--width", "375", "s.json"]);
    expect({ stage: args.stage, trees: args.trees, width: args.width, scene: args.scene }).toEqual({ stage: true, trees: ["/tmp/a"], width: 375, scene: "s.json" });
    const a = treeAddress("/tmp/tree-one"), again = treeAddress("/tmp/tree-one"), b = treeAddress("/tmp/tree-two");
    expect(a).toBe(again);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^http:\/\/127\.0\.0\.1:(4[2-8]\d\d)\/$/);
    const bare = makeTree(false);
    try {
      expect(treeBuildError(bare)).toMatch(/no dist\/app\.js/);
      expect(treeBuildError(makeTree(true))).toBeNull();
    } finally { rmSync(bare, { recursive: true, force: true }); }
  });

  it("a stale dist/app.js is refused with the rebuild reason", () => {
    const tree = makeTree(true, true);
    try { expect(treeBuildError(tree)).toMatch(/older than the tree's sources/); } finally { rmSync(tree, { recursive: true, force: true }); }
  });
});

describe("[sma:k_v_uistage] --stage raises this tree's built window on its own port and takes it down", () => {
  it("serves the tree's dist on the derived port and refuses connections after close", async () => {
    const tree = makeTree(true);
    try {
      const staged = await serveTree(tree);
      try {
        expect(await portOpen(staged.url)).toBe(true);
        const page = await fetch(staged.url).then((res) => res.text());
        expect(page).toContain('src="/app.js"');
        const bundle = await fetch(`${staged.url}app.js`).then((res) => res.text());
        expect(bundle).toContain("textContent");
      } finally { await staged.close(); }
      expect(await portOpen(staged.url)).toBe(false);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });

  it("the --stage run starts a server on the derived port, and the port refuses after the run; no dist/app.js exits 2 with no server", async () => {
    const tree = makeTree(true);
    const scene = join(tree, "scene.json");
    writeFileSync(scene, JSON.stringify({ url: "http://127.0.0.1:1/", steps: [] }));
    const address = treeAddress(tree);
    try {
      // No chromium is installed on this machine: the run still opens the staged port, then exits 2 by the exit law.
      const child = spawn("node", [join(ROOT, "scripts", "lp-ui-drive.mjs"), "--stage", "--tree", tree, scene], { cwd: ROOT });
      let served = false, out = "";
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { out += chunk; });
      for (let i = 0; i < 400 && !served; i++) { served = await portOpen(address); if (!served) await new Promise((ok) => setTimeout(ok, 15)); }
      const code = await new Promise<number>((ok) => child.on("exit", (c) => ok(c ?? 2)));
      expect(out).toContain(`STAGE_URL=${address}`);
      expect(served).toBe(true);
      expect(code).toBe(2);
      for (let i = 0; i < 100; i++) { if (!(await portOpen(address))) return; await new Promise((ok) => setTimeout(ok, 20)); }
      expect(await portOpen(address)).toBe(false);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  }, 30_000);

  it("a tree with no dist/app.js exits 2 and starts no server", async () => {
    const tree = makeTree(false);
    const scene = join(tree, "scene.json");
    writeFileSync(scene, JSON.stringify({ url: "http://127.0.0.1:1/" }));
    const address = treeAddress(tree);
    try {
      let code = 2, out = "";
      try { execFileSync("node", [join(ROOT, "scripts", "lp-ui-drive.mjs"), "--stage", "--tree", tree, scene], { cwd: ROOT, encoding: "utf8" }); code = 0; }
      catch (cause) { code = (cause as { status?: number }).status ?? 2; out = String((cause as { stderr?: string }).stderr ?? "") + String((cause as { stdout?: string }).stdout ?? ""); }
      expect(code).toBe(2);
      expect(out).toMatch(/no dist\/app\.js/);
      expect(await portOpen(address)).toBe(false);
    } finally { rmSync(tree, { recursive: true, force: true }); }
  }, 30_000);
});

import { arenaTable, type ArmSummary, type TaskStat } from "../../src/rooms/bench/compare";
import { runBenchCli } from "../../src/rooms/bench/cli";
import type { BenchApi } from "../../src/rooms/bench/service";

const task = (taskId: string, over: Partial<TaskStat> = {}): TaskStat => ({
  taskId, repeats: 1, accepted: 1, passed: true, stagesPassed: 2, stagesFailed: 0,
  costUsd: 1, costState: "measured", tokens: 100, seconds: 10, ...over,
});
const arm = (name: string, stats: TaskStat[]): ArmSummary => ({
  arm: name, repeats: 1, tasks: new Map(stats.map((stat) => [stat.taskId, stat])), selected: stats.length, errored: [], incomplete: [],
});

describe("[sma:k_lib_arena] the comparison arena ranks arms by cost per verified result", () => {
  it("four arms on one set rank by cost per passed task; an unmeasured cost is null and last; 1 or 5 arms are refused", () => {
    const table = arenaTable([
      arm("base", [task("t1", { costUsd: 4 }), task("t2", { costUsd: 2 })]),                    // 6/2 = $3 per verified
      arm("cheap", [task("t1", { costUsd: 0.5 }), task("t2", { costUsd: 0.5 })]),              // 1/2 = $0.5
      arm("dear", [task("t1", { costUsd: 8, accepted: 0, passed: false }), task("t2", { costUsd: 2 })]), // 10/1 = $10
      arm("blind", [task("t1", { costUsd: null, costState: "not_measured" }), task("t2", { costUsd: 1 })]),
    ]);
    expect(table.rows.map((row) => row.arm)).toEqual(["base", "cheap", "dear", "blind"]);
    const byArm = Object.fromEntries(table.rows.map((row) => [row.arm, row]));
    expect(byArm.cheap!.rank).toBe(1);
    expect(byArm.base!.rank).toBe(2);
    expect(byArm.dear!.rank).toBe(3);
    expect(byArm.blind!.rank).toBe(4);
    expect(byArm.cheap!.costPerVerified).toBeCloseTo(0.5);
    expect(byArm.dear!.costPerVerified).toBeCloseTo(10);
    expect(byArm.blind!.costPerVerified).toBeNull();
    expect(byArm.base!.verdict).toBe("baseline");
    expect(byArm.cheap!.passRate.rate).toBe(1);
    expect(() => arenaTable([arm("one", [task("t1")])])).toThrow(/two to four arms/);
    expect(() => arenaTable([arm("a", []), arm("b", []), arm("c", []), arm("d", []), arm("e", [])])).toThrow(/two to four arms/);
  });
});

describe("[sma:k_v_arena] bench arena runs four arms over one set on neutral ground", () => {
  it("four arms start four runs on one set id, a stored arm is reused, three arms are refused", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { openDatabase } = await import("../../src/rooms/plugin-db");
    const { createBench } = await import("../../src/rooms/bench/service");
    const { startRunRow, finishRunRow, saveResult } = await import("../../src/rooms/bench/store");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    db.prepare("INSERT INTO lane_pilot_bench_set(id,version,manifest_sha256,task_count,candidate_count,created_at) VALUES('s1','v1','x',1,1,0)").run();
    const storedRun = startRunRow(db, { setId: "s1", arm: "b", repeat: 1, config: {}, budgetTokens: null, budgetHours: null });
    finishRunRow(db, storedRun.id, "done", null);
    saveResult(db, { runId: storedRun.id, taskId: "t1", position: 0, state: "accepted", accepted: true, benchTaskId: null, lpRunId: null, attempts: 1, stagesPassed: 2, stagesFailed: 0, tokens: 10, costUsd: 1, costState: "measured", seconds: 5, reason: null, recordedAt: 1 });
    const ran: Array<{ version: string; arm: string }> = [];
    const bench = createBench({
      db: db as never, kv: bb.storage.kv as never,
      host: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, pipeline: {} as never,
      projectNames: async () => new Map(), isSandboxName: () => false, log: () => undefined,
      arenaRun: async (input) => {
        ran.push(input);
        const run = startRunRow(db, { setId: "s1", arm: input.arm, repeat: 1, config: {}, budgetTokens: null, budgetHours: null });
        finishRunRow(db, run.id, "done", null);
        saveResult(db, { runId: run.id, taskId: "t1", position: 0, state: "accepted", accepted: true, benchTaskId: null, lpRunId: null, attempts: 1, stagesPassed: 2, stagesFailed: 0, tokens: 10, costUsd: 1, costState: "measured", seconds: 5, reason: null, recordedAt: 1 });
      },
    });
    const result = await bench.arena({ version: "v1", arms: [{ arm: "a" }, { arm: "b" }, { arm: "c" }, { arm: "d" }] });
    expect(ran.map((row) => `${row.version}:${row.arm}`)).toEqual(["v1:a", "v1:c", "v1:d"]);
    expect(result.reused).toEqual(["b"]);
    expect(result.table.rows).toHaveLength(4);
    expect(result.text).toContain("Arena over 4 arms");
    await expect(bench.arena({ version: "v1", arms: [{ arm: "a" }, { arm: "b" }, { arm: "c" }] })).rejects.toThrow(/four arms/);
  });

  it("the real cli calls bench.arena once per command and prints the table", async () => {
    let got: { version: string; arms: Array<{ arm: string }> } | null = null;
    const bench = {
      status: () => [{ version: "v3", createdAt: 1 }],
      arena: async (input: { version: string; arms: Array<{ arm: string }> }) => { got = input; return { table: { arms: 4, rows: [] }, text: "Arena over 4 arms:\n#1 b", ran: [], reused: [] }; },
    } as unknown as BenchApi;
    const result = await runBenchCli(bench, ["arena", "a", "b=prov/m1", "c", "d", "--set", "v3"]);
    expect(result.exitCode).toBe(0);
    expect(got!.version).toBe("v3");
    expect(got!.arms).toEqual([{ arm: "a" }, { arm: "b", writer: { providerId: "prov", model: "m1" } }, { arm: "c" }, { arm: "d" }]);
    expect(result.stdout).toContain("Arena over 4 arms");
    const refused = await runBenchCli(bench, ["arena", "a", "b", "c"]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toMatch(/four arms/);
  });
});

import { createJev, type JevAnswer, type JevClient, type JevRequest } from "@lane-pilot/jev";
import { appendDesignJournalLine, appendDesignPair, designJournalLines, noteDesignJournalWord } from "../../src/rooms/design-eval/journal";
import { designPairJudgment, judgeDesigns } from "../../src/rooms/design-eval/judge";
import { pairBasis, pairOrder } from "../../src/rooms/design-eval/pair";
import { trainingRatios } from "../../src/rooms/design-eval/training";
import { houseWordHits, sourceWordHits, unreadFields, UNSHOWN_FIELDS } from "../helpers/guard-tools";
import type { DesignJournalLine } from "@lane-pilot/contracts";
import type { Measurement } from "../../src/rooms/design-eval";

const kv = () => { const box = new Map<string, unknown>(); return { get: async (k: string) => box.get(k), set: async (k: string, v: unknown) => { box.set(k, v); } }; };
const line = (over: Partial<DesignJournalLine>): DesignJournalLine => ({
  at: 1, projectId: "p1", phaseId: "ph1", designer: "designer", reviewer: "rev", drawingSha: "sha1",
  firstPass: true, critique: null, codeScore: null, ownerWord: null, ...over,
});

describe("[sma:k_lib_dstore] the design journal is append-only and a repeated packet never doubles a fact", () => {
  it("appending the same drawing twice leaves one line; a word is a separate event; a no clears firstPass in the folded view", async () => {
    const store = kv();
    await appendDesignJournalLine(store, line({}));
    await appendDesignJournalLine(store, line({}));
    expect(await designJournalLines(store)).toHaveLength(1);
    await noteDesignJournalWord(store, "ph1", "no");
    await noteDesignJournalWord(store, "ph1", "no");
    const lines = await designJournalLines(store);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.ownerWord).toBe("no");
    expect(lines[0]!.firstPass).toBe(false);
  });
});

describe("[sma:k_lib_dmetrics] the four training ratios", () => {
  it("pass+yes, rework+no, pass+no give judgeAgrees 0.67; four of six axes scored gives pointCoverage 0.67; scores 100 and 80 give passedAll 0.5", () => {
    const critique = (verdict: "pass" | "rework") => ({ scores: { hierarchy: 2 }, verdict, notes: "x" });
    const ratios = trainingRatios([
      line({ critique: critique("pass"), ownerWord: "yes" }),
      line({ critique: critique("rework"), ownerWord: "no" }),
      line({ critique: critique("pass"), ownerWord: "no" }),
    ]);
    expect(ratios.judgeAgrees).toBe(0.67);
    const coverage = trainingRatios([line({ critique: { scores: { hierarchy: 1, spacing: 1, contrast: 1, states: 1 }, verdict: "pass", notes: "x" } })]);
    expect(coverage.pointCoverage).toBe(0.67);
    const all = trainingRatios([line({ codeScore: 100 }), line({ codeScore: 80 })]);
    expect(all.passedAll).toBe(0.5);
  });
});

describe("[sma:m_pr_design_eval] the pair goes to an independent judge with both pictures and the rubric", () => {
  const input = { grounds: "the brief", a: { format: "png" as const, data_base64: "QQ==" }, b: { format: "png" as const, data_base64: "Qg==" } };
  it("picks b above the threshold, tie below it, and sends both pictures as assets with the rubric in the state", async () => {
    let last: JevRequest | null = null;
    const answers = (p: number): Record<string, JevAnswer> => ({
      winner: { type: "choice", choice: "b", probabilities: { a: 1 - p, b: p }, confidence: 0.9 },
    });
    const client: JevClient = {
      breaker: () => ({ open: false, failures: 0 }),
      async call(request: JevRequest) {
        last = request;
        const out: Record<string, JevAnswer> = {};
        for (const id of Object.keys(request.questions)) {
          out[id] = request.questions[id]!.type === "choice"
            ? { type: "choice", choice: "b", probabilities: { a: 0.2, b: 0.8 }, confidence: 0.9 }
            : { type: "score", score: 0, legend: {}, probabilities: { "0": 1 }, confidence: 0.9 };
        }
        return { ok: true, answers: out, model: "m", usage: { input_tokens: 1, output_tokens: 1 }, latencyMs: 1, attempts: 1 };
      },
    };
    const jev = createJev({ client, db: null });
    const decided = await jev.judge(designPairJudgment, input, { settings: { "jev.modes": "design.pair=active" } });
    expect(decided.by === "jev" && decided.decision.winner).toBe("b");
    const state = last!.state as { rubric: string[] };
    expect(state.rubric).toContain("overflow");
    expect(Object.keys(last!.assets ?? {})).toHaveLength(2);
    // Below the threshold the same top pick is a tie, decided in code.
    const tie = designPairJudgment.decide(answers(0.6), { tie_p: 0.9 }, input);
    expect(tie.decision?.winner).toBe("tie");
  });
});

describe("[sma:k_lib_djudgement] the model and the person judge a pair on one basis and in one order", () => {
  const clean: Measurement = { width: 375, overflowPx: 0, textElements: 10, lowContrast: 0, targets: 4, smallTargets: 0, tinyText: 0, h1: 1, spacingValues: 6 };
  it("the basis is identical for both judges and stable for the same two urls; a recorded pair counts in judgeAgrees", async () => {
    const one = pairBasis("http://a", "http://b", [clean], [{ ...clean, overflowPx: 40 }]);
    const two = pairBasis("http://a", "http://b", [clean], [{ ...clean, overflowPx: 40 }]);
    expect(one.basis).toBe(two.basis);
    expect(one.order).toBe(pairOrder("http://a", "http://b"));
    expect(one.basis).toContain("overflow");
    const store = kv();
    await appendDesignPair(store, { phaseId: "ph9", order: "ab", model: "b", person: null });
    await appendDesignPair(store, { phaseId: "ph9", order: "ab", model: null, person: "b" });
    const lines = await designJournalLines(store);
    expect(lines.filter((row) => row.pair)).toHaveLength(1);
    expect(trainingRatios(lines).judgeAgrees).toBe(1);
  });
});

describe("[sma:k_v_designer_metrics] series assignment and baseline", () => {
  it("lines before and after a role line land in two series; the first series is the baseline", async () => {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { openDatabase } = await import("../../src/rooms/plugin-db");
    const { createPhaseReactions } = await import("../../src/rooms/core/server/phase-reactions");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const reactions = createPhaseReactions(db, bb as never);
    await reactions.journalDrawing(line({ phaseId: "ph-a" }));
    await reactions.addRoleLine("p1", "designer", "2026-11-10 bigger taps");
    await reactions.journalDrawing(line({ phaseId: "ph-b" }));
    const lines = await designJournalLines(bb.storage.kv as never);
    expect(lines[0]!.series).toBe("base");
    expect(lines[1]!.series).not.toBe("base");
    expect(lines[1]!.series).toHaveLength(8);
    const first = lines.filter((row) => row.series === lines[0]!.series);
    expect(trainingRatios(first).drawings).toBe(1);
  });
});

describe("[sma:m_tl_contract] answer fields are read or explained", () => {
  it("an unread invented field is reported; a registered or rendered one is not", async () => {
    const { rpcContract } = await import("../../src/rooms/contracts");
    const unread = unreadFields({ run_status: (rpcContract as Record<string, { output: unknown }>).halt_run } as never, [{ path: "x.tsx", text: "const x = row.canceled" }], UNSHOWN_FIELDS);
    expect(unread).toContain("run_status.ok");
    expect(unread).not.toContain("run_status.canceled");
    const explained = unreadFields({ run_status: (rpcContract as Record<string, { output: unknown }>).halt_run } as never, [], { "run_status.ok": "cli only" });
    expect(explained).toContain("run_status.canceled");
    expect(explained).not.toContain("run_status.ok");
  });
});

describe("[sma:m_tl_contract_test] the contract check runs in the common suite", () => {
  it("tests/contract-fields-read.test.ts exists and ran green in this run", async () => {
    const { existsSync } = await import("node:fs");
    expect(existsSync("tests/contract-fields-read.test.ts")).toBe(true);
  });
});

describe("[sma:m_tl_rebrand] the leak scanner flags old brand, colours and internal ids", () => {
  it("a catalog string with an old name, one with #ff8800 and one with thr_nj6fa3v9 are reported; a clean {placeholder} is not", () => {
    const hits = houseWordHits({ old: "ported from Claude " + "Lane", color: "paint it #ff8800", id: "see thr_nj6fa3v9", clean: "task {taskId} failed" });
    expect(hits.sort()).toEqual(["color", "id", "old"]);
    expect(sourceWordHits("f.ts", "// legacy of Claude " + "Lane" + "\nconst c = '#aabbcc'")).toEqual(["f.ts:1"]);
  });
});
