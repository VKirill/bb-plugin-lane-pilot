import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
// @ts-expect-error the scene driver lib is a plain .mjs without declarations
import { kitOfTrees, parseSceneArgs, serveTree, treeAddress, treeBuildError } from "../../scripts/lib/ui-scene.mjs";

const ROOT = join(__dirname, "..", "..");
// The staged runs are judged with no browser to launch, whatever this machine has installed: Playwright looks in a folder that does not exist.
const NO_BROWSER = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(tmpdir(), "lp-no-browser-here") };

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
      // With no browser to launch the run still opens the staged port, then exits 2 by the exit law.
      const child = spawn("node", [join(ROOT, "scripts", "lp-ui-drive.mjs"), "--stage", "--tree", tree, scene], { cwd: ROOT, env: NO_BROWSER });
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
    expect(result.table!.rows).toHaveLength(4);
    expect(result.text).toContain("Arena over 4 arms");
    await expect(bench.arena({ version: "v1", arms: [{ arm: "a" }, { arm: "b" }, { arm: "c" }] })).rejects.toThrow(/four arms/);
  });

  it("the real cli calls bench.arena once per command and prints the table", async () => {
    let got: { version: string; arms: Array<{ arm: string }> } | null = null;
    const bench = {
      status: () => [{ version: "v3", createdAt: 1 }],
      arena: async (input: { version: string; arms: Array<{ arm: string }> }) => { got = input; return { table: { arms: 4, rows: [] }, text: "Arena over 4 arms:\n#1 b", ran: [], reused: [], failed: [] }; },
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

import { appendDesignJournalLine, appendDesignPair, designJournalLines, noteDesignJournalWord } from "../../src/rooms/design-eval/journal";
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
  it("every unread field of the real contract is in the baseline or the register, and a new unread field would be caught", async () => {
    const { rpcContract } = await import("../../src/rooms/contracts");
    const { roomFaceFiles } = await import("../support/room-files");
    const { readFileSync } = await import("node:fs");
    const baseline = new Set(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/unread-fields-baseline.json"), "utf8")) as string[]);
    const sources = [...roomFaceFiles("ui"), join(ROOT, "app.tsx")].map((path) => ({ path, text: readFileSync(path, "utf8") }));
    // The same computation as tests/contract-fields-read.test.ts: nothing outside the baseline.
    expect(unreadFields(rpcContract as never, sources, UNSHOWN_FIELDS).filter((field) => !baseline.has(field))).toEqual([]);
    // A field no screen reads and no register explains is outside the baseline, so the check would fail on it.
    const invented = unreadFields({ run_status: (rpcContract as Record<string, { output: unknown }>).halt_run } as never, [{ path: "x.tsx", text: "" }], UNSHOWN_FIELDS);
    expect(invented.filter((field) => !baseline.has(field)).length).toBeGreaterThan(0);
  });
});

describe("[sma:m_tl_rebrand] the leak scanner flags old brand, colours and internal ids", () => {
  it("a catalog string with an old name, one with #ff8800 and one with thr_nj6fa3v9 are reported; a clean {placeholder} is not", () => {
    const hits = houseWordHits({ old: "ported from Claude " + "Lane", color: "paint it #ff8800", id: "see thr_nj6fa3v9", clean: "task {taskId} failed" });
    expect(hits.sort()).toEqual(["color", "id", "old"]);
    // The source scan keys a hit by file and matched text, not by line; it flags the old brand only (colours and ids are checked in catalogs).
    expect(sourceWordHits("f.ts", "// legacy of Claude " + "Lane" + "\nconst c = '#aabbcc'\n// Claude " + "Lane again")).toEqual(["f.ts|Claude " + "Lane", "f.ts|Claude " + "Lane"]);
    expect(sourceWordHits("f.ts", "const c = '#aabbcc'")).toEqual([]);
  });
});

// ---- review fixes: the design-pair door, the journal, the staged server, the arena ----
import { pairUrlRefusal } from "../../src/rooms/design-eval/url-guard";
import { pairUrlsRefusal, runDesignPairCli, type DesignPairCliDeps } from "../../src/rooms/design-eval/server/pair-cli";
import { DESIGN_EVENTS_KEY, DESIGN_JOURNAL_KEY, designPairOf } from "../../src/rooms/design-eval/journal";

describe("[sma:k_v_designer_metrics] which URLs a design pair may open", () => {
  const refused: string[] = [
    "file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)", "not a url", "data:text/html,hi",
    "http://localhost/", "http://LOCALHOST:3000/", "http://app.localhost/", "http://localhost./",
    "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f000001/", "http://0177.0.0.1/", "http://127.255.255.254/",
    "http://10.0.0.1/", "http://172.16.0.1/", "http://172.31.255.255/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://0.0.0.0/", "http://0/", "http://[::1]/", "http://[::]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/", "http://[febf::1]/",
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:7f00:1]/", "http://[::ffff:10.1.2.3]/", "http://[::ffff:c0a8:101]/", "http://[::127.0.0.1]/", "http://[64:ff9b::7f00:1]/",
    "https://[::1]:8443/",
  ];
  const allowed: string[] = [
    "https://example.com/", "http://example.com:8080/path?q=1", "http://93.184.216.34/", "http://172.15.0.1/", "http://172.32.0.1/",
    "http://192.169.0.1/", "http://11.0.0.1/", "http://[2606:4700::1111]/", "http://[::ffff:5db8:d822]/", "http://169.253.0.1/",
  ];
  it.each(refused)("refuses %s with a reason", (url) => {
    const reason = pairUrlRefusal(url);
    expect(reason, url).toMatch(/^refused: /);
  });
  it.each(allowed)("allows %s", (url) => { expect(pairUrlRefusal(url), url).toBeNull(); });

  it("the owner's --local lets a local page through but never a file: URL", () => {
    expect(pairUrlRefusal("http://localhost:4200/", { local: true })).toBeNull();
    expect(pairUrlRefusal("http://10.0.0.5/", { local: true })).toBeNull();
    expect(pairUrlRefusal("file:///etc/passwd", { local: true })).toMatch(/only http: and https:/);
  });

  it("the hub's own port is refused on a host name that resolves to this machine, and a name that resolves to a private address is refused on any port", async () => {
    const own = () => ["203.0.113.5", "127.0.0.1"];
    const lookup = async (host: string) => host === "me.example.com" ? ["203.0.113.5"] : host === "rebind.example.com" ? ["10.0.0.9"] : ["198.51.100.7"];
    expect(await pairUrlsRefusal(["http://me.example.com:6051/x"], { hubPorts: [6051], lookup, ownAddresses: own })).toMatch(/hub's own port/);
    expect(await pairUrlsRefusal(["http://203.0.113.5:6051/"], { hubPorts: [6051], lookup, ownAddresses: own })).toMatch(/hub's own port/);
    expect(await pairUrlsRefusal(["http://me.example.com:8080/"], { hubPorts: [6051], lookup, ownAddresses: own })).toBeNull();
    expect(await pairUrlsRefusal(["http://other.example.com:6051/"], { hubPorts: [6051], lookup, ownAddresses: own })).toBeNull();
    expect(await pairUrlsRefusal(["http://rebind.example.com/"], { hubPorts: [6051], lookup, ownAddresses: own })).toMatch(/resolves to 10\.0\.0\.9/);
    expect(await pairUrlsRefusal(["http://me.example.com:6051/"], { local: true, hubPorts: [6051], lookup, ownAddresses: own })).toBeNull();
  });
});

describe("[sma:k_lib_djudgement] the design-pair verbs: who may call them, what they refuse, what they record", () => {
  const PM = { projectId: "p1", role: "pm" };
  function fixture(over: Partial<DesignPairCliDeps> = {}) {
    const calls = { measure: 0, judge: 0, posted: [] as string[], closed: [] as string[] };
    const store = kv();
    const shot = Buffer.from("png").toString("base64");
    const deps: DesignPairCliDeps = {
      kv: store, threadId: null, thread: async (id) => id === "pm1" ? PM : id === "pm2" ? { projectId: "p2", role: "pm" } : id === "w1" ? { projectId: "p1", role: "writer" } : null,
      phaseProject: (id) => id === "ph-p1" ? "p1" : null,
      measure: async () => { calls.measure++; return JSON.stringify({ order: "ba", basis: "basis text", shots: { a: shot, b: shot } }); },
      script: "/plugin/scripts/lp-design-eval.ts", scriptExists: () => true,
      ownerItem: { post: (item) => { calls.posted.push(item.key); }, close: (key) => { calls.closed.push(key); } },
      hubPorts: [6051], lookup: async () => ["198.51.100.7"], ownAddresses: () => ["203.0.113.5"], ...over,
    };
    return { deps, calls, store };
  }
  const start = ["design-pair", "ph-p1", "https://a.example.com/", "https://b.example.com/"] as const;
  const run = (deps: DesignPairCliDeps, ...argv: string[]) => runDesignPairCli(deps, argv[0] as "design-pair", argv.slice(1));

  it("the owner at a terminal and the project's PM chat may run it; a writer, another project's PM and an unknown thread are refused with a reason", async () => {
    const owner = fixture();
    expect((await run(owner.deps, ...start)).exitCode).toBe(0);
    const pm = fixture({ threadId: "pm1" });
    expect((await run(pm.deps, ...start)).exitCode).toBe(0);
    for (const [threadId, reason] of [["w1", /not for a writer thread/], ["pm2", /reaches only that thread's own project/], ["ghost", /unknown/]] as const) {
      const f = fixture({ threadId });
      const refusal = await run(f.deps, ...start);
      expect(refusal.exitCode).toBe(1);
      expect(refusal.stderr).toMatch(reason);
      expect(f.calls.measure).toBe(0);
      expect(f.calls.judge).toBe(0);
    }
    const unknownPhase = fixture({ threadId: "pm1" });
    expect((await run(unknownPhase.deps, "design-pair", "nope", "https://a.example.com/", "https://b.example.com/")).stderr).toMatch(/phase nope is unknown/);
  });

  it("--local is refused from any thread; the owner may pass it", async () => {
    const f = fixture({ threadId: "pm1" });
    const refusal = await run(f.deps, ...start, "--local");
    expect(refusal.stderr).toMatch(/--local .* owner at a terminal/);
    expect(f.calls.measure).toBe(0);
    const owner = fixture();
    expect((await run(owner.deps, "design-pair", "ph-p1", "http://localhost:4200/", "http://localhost:4201/", "--local")).exitCode).toBe(0);
  });

  it("a refused URL never starts the measure (no browser, no screenshot) and never reaches the judge", async () => {
    for (const bad of ["file:///etc/passwd", "http://127.0.0.1:6051/", "http://[::ffff:7f00:1]/", "http://169.254.169.254/"]) {
      const f = fixture();
      const refusal = await run(f.deps, "design-pair", "ph-p1", "https://a.example.com/", bad);
      expect(refusal.exitCode, bad).toBe(1);
      expect(refusal.stderr).toMatch(/^refused: /);
      expect(f.calls.measure).toBe(0);
      expect(f.calls.judge).toBe(0);
      expect(f.calls.posted).toEqual([]);
    }
  });

  it("a phase that already has a pair is refused unless --again; the money cap and a missing script refuse before any browser or judge call", async () => {
    const f = fixture();
    expect((await run(f.deps, ...start)).exitCode).toBe(0);
    const again = await run(f.deps, ...start);
    expect(again.stderr).toMatch(/already has a design pair.*--again/);
    expect(f.calls.measure).toBe(1);
    expect((await run(f.deps, ...start, "--again")).exitCode).toBe(0);
    expect(f.calls.measure).toBe(2);
    const missing = fixture({ scriptExists: () => false });
    const gone = await run(missing.deps, ...start);
    expect(gone.stderr).toMatch(/\/plugin\/scripts\/lp-design-eval\.ts is not in this plugin's directory/);
    expect(missing.calls.measure).toBe(0);
  });

  it("no model picks: the pair is recorded without a model verdict and waits for the person", async () => {
    const f = fixture();
    const result = JSON.parse((await run(f.deps, ...start)).stdout!);
    expect(result).toMatchObject({ model: null, order: "ba", asked: true });
    expect(await designPairOf(f.store, "ph-p1")).toEqual({ order: "ba", model: null, person: null });
  });

  it("the answer keeps the stored order, is refused for an unknown pair, closes the owner item, and is for the PM or the owner only", async () => {
    const f = fixture();
    const unknown = await run(f.deps, "design-pair-answer", "ph-ghost", "a");
    expect(unknown.exitCode).toBe(1);
    expect(unknown.stderr).toMatch(/no design pair was started for ph-ghost/);
    expect(await designPairOf(f.store, "ph-ghost")).toBeNull();
    await run(f.deps, ...start);
    expect(f.calls.posted).toEqual(["design-pair:ph-p1"]);
    const worker = fixture({ threadId: "w1", kv: f.store });
    expect((await run(worker.deps, "design-pair-answer", "ph-p1", "b")).stderr).toMatch(/not for a writer thread/);
    const answered = await run(f.deps, "design-pair-answer", "ph-p1", "b");
    expect(JSON.parse(answered.stdout!).recorded).toEqual({ phaseId: "ph-p1", person: "b", order: "ba" });
    expect(await designPairOf(f.store, "ph-p1")).toMatchObject({ order: "ba", person: "b" });
    expect(f.calls.closed).toEqual(["design-pair:ph-p1"]);
    expect((await run(f.deps, "design-pair-answer", "ph-p1", "maybe")).exitCode).toBe(1);
  });
});

describe("[sma:k_lib_dstore] the journal: a word stays on its drawing, a redraw is a fact, main's shape reads as before", () => {
  it("a «no» on drawing 1 stays on drawing 1 when drawing 2 arrives; a «yes» said later lands on drawing 2", async () => {
    const store = kv();
    await appendDesignJournalLine(store, line({ at: 10, drawingSha: "d1" }));
    await noteDesignJournalWord(store, "ph1", "no");
    await appendDesignJournalLine(store, line({ at: 20, drawingSha: "d2" }));
    let lines = await designJournalLines(store);
    expect(lines.map((row) => [row.drawingSha, row.ownerWord, row.firstPass])).toEqual([["d1", "no", false], ["d2", null, true]]);
    await noteDesignJournalWord(store, "ph1", "yes");
    lines = await designJournalLines(store);
    expect(lines.map((row) => [row.drawingSha, row.ownerWord])).toEqual([["d1", "no"], ["d2", "yes"]]);
  });

  it("a word for a phase with no line writes nothing", async () => {
    const store = kv();
    await noteDesignJournalWord(store, "ph-none", "no");
    expect(await store.get(DESIGN_EVENTS_KEY)).toBeUndefined();
    expect(await store.get(DESIGN_JOURNAL_KEY)).toBeUndefined();
  });

  it("a byte-identical redraw after the owner's «no» is kept; the same packet sent twice in a row is one fact", async () => {
    const store = kv();
    await appendDesignJournalLine(store, line({ at: 10 }));
    await appendDesignJournalLine(store, line({ at: 11 }));
    expect(await designJournalLines(store)).toHaveLength(1);
    await noteDesignJournalWord(store, "ph1", "no");
    await appendDesignJournalLine(store, line({ at: Date.now() + 5 }));
    const lines = await designJournalLines(store);
    expect(lines).toHaveLength(2);
    expect(lines.map((row) => row.ownerWord)).toEqual(["no", null]);
    // Another phase's identical drawing is its own fact.
    await appendDesignJournalLine(store, line({ phaseId: "ph2", at: 12 }));
    expect(await designJournalLines(store)).toHaveLength(3);
  });

  it("a journal stored in main's shape (lines without event, the same key) reads as main read it, and what the new code writes is not an event in that key", async () => {
    const store = kv();
    const mainShape = [line({ at: 1, phaseId: "a", drawingSha: "x", ownerWord: "no", firstPass: false }), line({ at: 2, phaseId: "b", drawingSha: "y" })];
    await store.set("lp.design.journal", JSON.parse(JSON.stringify(mainShape)));
    expect(await designJournalLines(store)).toEqual(mainShape);
    // The new code adds a drawing, a word and a pair; the old reader (main: the key's value as the list of lines) must see lines only.
    await appendDesignJournalLine(store, line({ at: 3, phaseId: "b", drawingSha: "z" }));
    await noteDesignJournalWord(store, "b", "yes");
    await appendDesignPair(store, { phaseId: "b", order: "ab", model: "a", person: null });
    const oldReader = (await store.get("lp.design.journal")) as Array<Record<string, unknown>>;
    expect(oldReader).toHaveLength(3);
    expect(oldReader.every((row) => !("event" in row) && typeof row.phaseId === "string" && typeof row.drawingSha === "string")).toBe(true);
    expect(((await store.get(DESIGN_EVENTS_KEY)) as unknown[]).length).toBe(2);
    // An old line with no key and an old word with no target still fold (a word without a target takes the latest line).
    expect((await designJournalLines(store)).find((row) => row.drawingSha === "z")!.ownerWord).toBe("yes");
  });

  it("events have their own cap (newest 1000) and never push drawings out of theirs (2000)", async () => {
    const store = kv();
    await store.set(DESIGN_JOURNAL_KEY, Array.from({ length: 2000 }, (_, i) => line({ at: i, phaseId: `p${i}`, drawingSha: `s${i}`, key: `k${i}` })));
    await store.set(DESIGN_EVENTS_KEY, Array.from({ length: 1000 }, (_, i) => ({ event: "design-pair", at: i, phaseId: `e${i}`, order: "ab", model: null, person: null })));
    await appendDesignPair(store, { phaseId: "newest", order: "ab", model: null, person: null });
    await noteDesignJournalWord(store, "p1999", "no");
    const events = (await store.get(DESIGN_EVENTS_KEY)) as Array<{ phaseId: string }>;
    expect(events).toHaveLength(1000);
    expect(events.at(-2)!.phaseId).toBe("newest");
    expect(events[0]!.phaseId).toBe("e2");
    expect(((await store.get(DESIGN_JOURNAL_KEY)) as unknown[]).length).toBe(2000);
    await appendDesignJournalLine(store, line({ at: 5000, phaseId: "fresh", drawingSha: "f" }));
    const kept = (await store.get(DESIGN_JOURNAL_KEY)) as Array<{ phaseId: string }>;
    expect(kept).toHaveLength(2000);
    expect(kept.at(-1)!.phaseId).toBe("fresh");
  });
});

describe("[sma:k_v_uistage] the staged server refuses what leaves its tree and survives a bad request", () => {
  const rawGet = (url: string, path: string): Promise<{ status: number; body: string }> => new Promise((ok, fail) => {
    const target = new URL(url);
    import("node:http").then(({ request }) => {
      const req = request({ host: "127.0.0.1", port: Number(target.port), path, method: "GET" }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => ok({ status: res.statusCode ?? 0, body }));
      });
      req.on("error", fail);
      req.end();
    });
  });

  it("a path into a sibling directory that starts with the same letters is a 404, a malformed % is a 400, and the server answers the next request", async () => {
    const tree = makeTree(true);
    writeFileSync(join(tree, "dist-old"), "x");
    rmSync(join(tree, "dist-old"));
    mkdirSync(join(tree, "dist-old"));
    writeFileSync(join(tree, "dist-old", "secret.txt"), "SECRET");
    try {
      const staged = await serveTree(tree);
      try {
        for (const path of ["/../dist-old/secret.txt", "/%2e%2e/dist-old/secret.txt", "/..%2fdist-old%2fsecret.txt", "/../../etc/passwd"]) {
          const answer = await rawGet(staged.url, path);
          expect(answer.status, path).toBe(404);
          expect(answer.body).not.toContain("SECRET");
        }
        expect((await rawGet(staged.url, "/%")).status).toBe(400);
        expect((await rawGet(staged.url, "/%E0%A4%A")).status).toBe(400);
        const good = await rawGet(staged.url, "/app.js");
        expect(good.status).toBe(200);
        expect(good.body).toContain("textContent");
      } finally { await staged.close(); }
    } finally { rmSync(tree, { recursive: true, force: true }); }
  });

  it("a port that is taken fails the listen and leaves no temp dir behind", async () => {
    const tree = makeTree(true);
    const { createServer } = await import("node:http");
    const { readdirSync } = await import("node:fs");
    const blocker = createServer();
    await new Promise<void>((ok) => blocker.listen(0, "127.0.0.1", ok));
    const taken = (blocker.address() as { port: number }).port;
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("lp-ui-stage-")));
    try {
      await expect(serveTree(tree, { port: taken })).rejects.toThrow(/EADDRINUSE/);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith("lp-ui-stage-") && !before.has(name))).toEqual([]);
    } finally { blocker.close(); rmSync(tree, { recursive: true, force: true }); }
  });

  it("--trees a,b stages each tree in turn on its own port, and --port with several trees is refused", async () => {
    const one = makeTree(true), two = makeTree(true);
    const scene = join(one, "scene.json");
    writeFileSync(scene, JSON.stringify({ url: "http://127.0.0.1:1/", steps: [] }));
    try {
      let out = "";
      const child = spawn("node", [join(ROOT, "scripts", "lp-ui-drive.mjs"), "--stage", "--trees", `${one},${two}`, scene], { cwd: ROOT, env: NO_BROWSER });
      child.stdout.on("data", (chunk) => { out += chunk; });
      child.stderr.on("data", (chunk) => { out += chunk; });
      const code = await new Promise<number>((ok) => child.on("exit", (c) => ok(c ?? 2)));
      // No browser here: each tree is still served in turn, so both addresses are announced, in order.
      const urls = [...out.matchAll(/STAGE_URL=(\S+)/g)].map((hit) => hit[1]);
      expect(urls).toEqual([treeAddress(one), treeAddress(two)]);
      expect(code).toBe(2);
      let refused = "";
      try { execFileSync("node", [join(ROOT, "scripts", "lp-ui-drive.mjs"), "--stage", "--trees", `${one},${two}`, "--port", "4999", scene], { cwd: ROOT, encoding: "utf8", stdio: "pipe" }); }
      catch (cause) { refused = String((cause as { stderr?: string }).stderr); }
      expect(refused).toMatch(/--port names one address/);
    } finally { rmSync(one, { recursive: true, force: true }); rmSync(two, { recursive: true, force: true }); }
  }, 30_000);

  it("an unknown flag that starts with -- is a usage error; a word that does not is the scene path", () => {
    expect(() => parseSceneArgs(["--bogus", "scene.json"])).toThrow(/unknown flag --bogus/);
    expect(parseSceneArgs(["-x.json"]).scene).toBe("-x.json");
  });
});

describe("[sma:k_v_arena] the arena refuses what costs without bound and keeps what finished", () => {
  async function arenaFixture(arenaRun: (input: { arm: string }) => Promise<void>) {
    const { createFakePluginHost } = await import("@get-bb/plugin-sdk/testing");
    const { openDatabase } = await import("../../src/rooms/plugin-db");
    const { createBench } = await import("../../src/rooms/bench/service");
    const { startRunRow, finishRunRow, saveResult } = await import("../../src/rooms/bench/store");
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    db.prepare("INSERT INTO lane_pilot_bench_set(id,version,manifest_sha256,task_count,candidate_count,created_at) VALUES('s1','v1','x',3,3,0)").run();
    const finishArm = (name: string, state: "done" | "failed") => {
      const run = startRunRow(db, { setId: "s1", arm: name, repeat: 1, config: {}, budgetTokens: null, budgetHours: null });
      finishRunRow(db, run.id, state, state === "failed" ? "provider refused" : null);
      saveResult(db, { runId: run.id, taskId: "t1", position: 0, state: "accepted", accepted: true, benchTaskId: null, lpRunId: null, attempts: 1, stagesPassed: 2, stagesFailed: 0, tokens: 10, costUsd: 1, costState: "measured", seconds: 5, reason: null, recordedAt: 1 });
    };
    const logs: string[] = [];
    const started: string[] = [];
    const bench = createBench({
      db: db as never, kv: bb.storage.kv as never, host: { run: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, pipeline: {} as never,
      projectNames: async () => new Map(), isSandboxName: () => false, log: (line: string) => { logs.push(line); },
      arenaRun: async (input) => { started.push(input.arm); await arenaRun(input); },
    });
    return { bench, finishArm, logs, started };
  }
  const four = (names: string[]) => names.map((arm) => ({ arm }));

  it("duplicate arm names and a --repeat above 10 are refused before anything runs", async () => {
    const f = await arenaFixture(async () => undefined);
    await expect(f.bench.arena({ version: "v1", arms: four(["A", "A", "B", "C"]) })).rejects.toThrow(/four different names, A is given twice/);
    await expect(f.bench.arena({ version: "v1", arms: four(["A", "B", "C", "D"]), repeat: 11 })).rejects.toThrow(/from 1 to 10/);
    await expect(f.bench.arena({ version: "v1", arms: four(["A", "B", "C", "D"]), repeat: 0 })).rejects.toThrow(/from 1 to 10/);
    expect(f.started).toEqual([]);
  });

  it("the plan (series and tasks) is announced before the first run, and a failed arm is named while the finished arms keep their table", async () => {
    let order: string[] = [];
    const f = await arenaFixture(async (input) => {
      order.push(`run:${input.arm}`);
      if (input.arm === "C") throw new Error("host refused");
      f.finishArm(input.arm, "done");
    });
    f.finishArm("B", "done");
    const logs = f.logs;
    const result = await f.bench.arena({ version: "v1", arms: four(["A", "B", "C", "D"]), repeat: 2 });
    expect(logs[0]).toMatch(/3 new series \(A, C, D\) x 2 repeats = 6 runs of 3 tasks each on set v1; 1 arm\(s\) reused/);
    expect(f.started).toEqual(["A", "C"]);
    expect(result.failed).toEqual([{ arm: "C", reason: "host refused" }]);
    expect(result.table!.rows.map((row) => row.arm).sort()).toEqual(["A", "B"]);
    expect(result.text).toContain("arm C did not finish: host refused");
    expect(result.text).toContain("Arena over 2 arms");
  });

  it("a series that ended failed is named, stops the arena and is not ranked; fewer than two finished arms give no table", async () => {
    const f = await arenaFixture(async (input) => { f.finishArm(input.arm, input.arm === "B" ? "failed" : "done"); });
    const result = await f.bench.arena({ version: "v1", arms: four(["A", "B", "C", "D"]) });
    expect(result.table).toBeNull();
    expect(result.failed.map((row) => row.arm)).toEqual(["B"]);
    // The arena stops at the failed series: C and D are not paid for.
    expect(f.started).toEqual(["A", "B"]);
    expect(result.text).toMatch(/no ranking: 1 arm\(s\) finished/);
    expect(result.text).toContain("not started because of that: C, D");
  });

  it("the cli prints the table of the finished arms with the failed arm named, and exits 1", async () => {
    const bench = {
      status: () => [{ version: "v1", createdAt: 1 }],
      arena: async () => ({ table: null, text: "plan\narm C did not finish: host refused", ran: [], reused: [], failed: [{ arm: "C", reason: "host refused" }] }),
    } as unknown as BenchApi;
    const result = await runBenchCli(bench, ["arena", "A", "B", "C", "D"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("arm C did not finish");
  });
});
