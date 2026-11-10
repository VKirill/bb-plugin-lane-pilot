import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import { describe, expect, it } from "vitest";
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
