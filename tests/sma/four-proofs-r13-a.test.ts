// Region 13 · Guard tools — the behaviour proofs of the map nodes n1036–n1047 (docs/sma-evidence.md). Each test checks the
// result a card names (the strings reported, the lines written, the receipts saved), not that a function was called.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FORBIDDEN_WORDS, houseWordHits, internalIds, leakFindings, leaks, parityGaps, sourceWordHits, UNSHOWN_FIELDS, unreadFields } from "../../src/rooms/guard-tools/guard-tools";
import { rpcContract } from "../../src/rooms/contracts";
import { roomFaceFiles } from "../support/room-files";
import { attemptSessionLayers, permissionEntries, terminalParity, type ParityLayerSet } from "../../src/rooms/native-agent/terminal-parity";
import { accountingPartsProblem, PROBES } from "../../src/rooms/native-agent/server/helper-probe";
import { CAPABILITIES, DOCUMENTARY_CELLS, listReceipts } from "../../src/rooms/capability";
import { createCapabilities, runCapabilityCli } from "../../src/rooms/capability/server";
import { failedTasksAllProjects } from "../../src/rooms/storage/attempts-store";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { SANDBOX_PROJECT_ID } from "../../src/rooms/contracts";
import type { TaskV2 } from "../../src/rooms/contracts";

vi.mock("@lane-pilot/thread-observe", async (importOriginal) => ({ ...(await importOriginal() as Record<string, unknown>), waitThreadIdle: async () => undefined }));

const ROOT = join(__dirname, "../..");
// A literal built in two pieces: this file is itself scanned for the old brand.
const OLD_BRAND = ["Claude", "Lane"].join(" ");
const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };
const contract = (id: string): TaskV2 => ({
  schema_version: 2, id, display_title: `Task ${id}`, kind: "feature", title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: "/ws",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [],
  depends_on: [], objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: "/ws" }],
});

describe("guard tools: leak scanner (n1036, n1037, n1038)", () => {
  it("[sma:m_tl_rebrand] each class of leak is reported by its key, and a clean text is not", () => {
    const hits = houseWordHits({
      brand: `ported from ${OLD_BRAND}`,
      shortColour: "paint it #abc",
      longColour: "paint it #FF8800",
      attemptId: "open lpattempt_0123456789abcdef",
      runId: "see lprun_0123456789abcdef",
      clean: "Lane Pilot task {taskId} failed, colour token is accent",
      plainNumber: "version 12",
    });
    expect(hits.sort()).toEqual(["attemptId", "brand", "longColour", "runId", "shortColour"]);
    expect(houseWordHits({})).toEqual([]);
    // comments, docs and tests: one `path|matched text` per occurrence; the new brand, colours and ids are not source hits
    expect(sourceWordHits("a.ts", `// from ${OLD_BRAND}\nconst c = "#aabbcc"; // lpattempt_0123456789abcdef\n// ${OLD_BRAND}, twice`)).toEqual([`a.ts|${OLD_BRAND}`, `a.ts|${OLD_BRAND}`]);
    expect(sourceWordHits("b.ts", "// Lane Pilot")).toEqual([]);
    expect(FORBIDDEN_WORDS.every(({ reason }) => reason.trim().split(/\s+/).length >= 3)).toBe(true);
    // secret-shaped strings come out with their line numbers
    expect(leaks(`ok\n${"sk"}-${"a".repeat(24)}\nok`)).toEqual([{ line: 2, shape: expect.any(String) }]);
  });

  it("[sma:m_tl_rebrand_ids] every house id prefix is refused in a catalog string, a placeholder or a short word is not", () => {
    const strings = {
      attempt: "Open lpattempt_0123456789abcdef to continue",
      run: "Run lprun_0123456789abcdef is done",
      thread: "Thread thr_nj6fa3v9 is waiting",
      project: "Project proj_3tb652jpsi",
      host: "Host host_abcdefghij",
      placeholder: "Task {taskId} is waiting",
      short: "thr_short is too small to be an id",
      word: "the thread is waiting",
    };
    expect(internalIds(strings)).toEqual(["attempt", "run", "thread", "project", "host"]);
    expect(internalIds({})).toEqual([]);
  });

  it("[sma:m_tl_rebrand_wired] the scan shared by the test run and the publish gate lists every leak as path:line in the shipped trees only", () => {
    const root = mkdtempSync(join(tmpdir(), "lp-r13-leak-"));
    try {
      for (const dir of ["src", "docs", "packages/i18n/src", "elsewhere", "src/node_modules/x"]) mkdirSync(join(root, dir), { recursive: true });
      const secret = ["sk", "abcdefghijklmnopqrstuvwxyz0123456789"].join("-");
      writeFileSync(join(root, "src", "a.ts"), `export const ok = 1;\nexport const planted = "${secret}";\n`);
      writeFileSync(join(root, "docs", "n.md"), `# note\n\n${["gh", "p_"].join("")}${"A".repeat(30)}\n`);
      writeFileSync(join(root, "packages/i18n/src", "t.json"), `{"k": "-----BEGIN ${"RSA"} PRIVATE KEY-----"}\n`);
      writeFileSync(join(root, "elsewhere", "x.ts"), `export const out = "${secret}";\n`);
      writeFileSync(join(root, "src/node_modules/x", "y.ts"), `export const dep = "${secret}";\n`);
      writeFileSync(join(root, "src", "guard-tools-probe.ts"), `export const own = "${secret}";\n`);
      writeFileSync(join(root, "src", "image.png"), secret);
      expect(leakFindings(root).sort()).toEqual(["docs/n.md:3", "packages/i18n/src/t.json:1", "src/a.ts:2"]);
      rmSync(join(root, "src", "a.ts"));
      rmSync(join(root, "docs", "n.md"));
      rmSync(join(root, "packages/i18n/src", "t.json"));
      expect(leakFindings(root)).toEqual([]);
    } finally { rmSync(root, { recursive: true, force: true }); }
    // and the repository itself ships none
    expect(leakFindings(ROOT)).toEqual([]);
  });
});

describe("guard tools: window contract (n1039, n1040, n1041)", () => {
  const contractOf = (shape: Record<string, z.ZodTypeAny>) => ({ output: z.object(shape) });

  it("[sma:m_tl_contract] a field no rendering code reads and no register explains is reported, qualified by its method and sorted", () => {
    const methods = { zeta: contractOf({ a: z.string(), b: z.number(), c: z.boolean(), d: z.string() }), alpha: contractOf({ a: z.string() }), loose: { output: z.unknown() }, list: { output: z.array(z.string()) } };
    const sources = [{ path: "x.tsx", text: "const v = row.a; const { b } = row; render({ d: 1 })" }];
    // `a` is read by property, `b` destructured, `d` as a key; `c` is read nowhere
    expect(unreadFields(methods as never, sources, {})).toEqual(["zeta.c"]);
    expect(unreadFields(methods as never, [], {})).toEqual(["alpha.a", "zeta.a", "zeta.b", "zeta.c", "zeta.d"]);
    // an explanation counts only for its own method: «zeta.a» does not cover alpha.a
    expect(unreadFields(methods as never, [], { "zeta.a": "for the CLI only", "zeta.c": "for the PM only" })).toEqual(["alpha.a", "zeta.b", "zeta.d"]);
    // a field named inside another word is not read
    expect(unreadFields({ m: contractOf({ id: z.string() }) } as never, [{ path: "y.tsx", text: "const valid = 1; const idle = 2" }], {})).toEqual(["m.id"]);
  });

  it("[sma:m_tl_not_shown] every registered unshown field names a real answer field with a reason of at least three words, and the register silences it", () => {
    const entries = Object.entries(UNSHOWN_FIELDS);
    expect(entries.length).toBeGreaterThan(0);
    const unread = new Set(unreadFields(rpcContract as never, [], {}));
    const silenced = new Set(unreadFields(rpcContract as never, [], UNSHOWN_FIELDS));
    for (const [field, reason] of entries) {
      expect(field).toMatch(/^[a-z0-9_]+\.[A-Za-z0-9_]+$/);
      expect(reason.trim().split(/\s+/).length).toBeGreaterThanOrEqual(3);
      // the register entry is about a method the contract has, and the register takes a checkable field off the unread list
      expect(Object.keys(rpcContract), `${field}: the method is not in the contract, a stale register entry`).toContain(field.split(".")[0]);
      expect(silenced.has(field), `${field} is still reported unread with the register`).toBe(false);
    }
    // the work_file_read page range is a checkable field nobody draws: unread without the register, explained with it
    expect(["work_file_read.lineStart", "work_file_read.totalLines"].every((field) => unread.has(field) && !silenced.has(field))).toBe(true);
  });

  it("[sma:m_tl_contract_test] the real contract has no unread field outside the baseline, and a field no screen reads would be caught", () => {
    const baseline = new Set(JSON.parse(readFileSync(join(ROOT, "tests/fixtures/unread-fields-baseline.json"), "utf8")) as string[]);
    const sources = [...roomFaceFiles("ui"), join(ROOT, "app.tsx")].map((path) => ({ path, text: readFileSync(path, "utf8") }));
    const real = unreadFields(rpcContract as never, sources, UNSHOWN_FIELDS);
    expect(real.length).toBeGreaterThan(0);
    expect(real.filter((field) => !baseline.has(field))).toEqual([]);
    // the same contract read by no screen at all: nearly every field is outside the baseline, so the suite would be red
    const unreadByNone = unreadFields(rpcContract as never, [{ path: "empty.tsx", text: "" }], UNSHOWN_FIELDS);
    expect(unreadByNone.filter((field) => !baseline.has(field)).length).toBeGreaterThan(real.length);
    // a screen that starts reading a baseline field takes it off the list
    const [first] = real;
    const field = first!.split(".")[1]!;
    expect(unreadFields(rpcContract as never, [...sources, { path: "new.tsx", text: `const x = row.${field}` }], UNSHOWN_FIELDS)).not.toContain(first);
  });
});

describe("guard tools: parity (n1042, n1043)", () => {
  const layers = (over: Partial<ParityLayerSet> = {}): ParityLayerSet => ({ hooks: ["0.1.1"], memory: ["m1", "m2"], rules: ["r1"], skills: ["s1"], permissions: ["a"], model: ["claude-code/m"], ...over });

  it("[sma:m_tl_terminal_parity] six lines in order: same with a count, a named difference per side, and a missing side is «not compared», never «same»", () => {
    const lines = terminalParity(layers(), layers());
    expect(lines.map((line) => line.layer)).toEqual(["hooks", "memory", "rules", "skills", "permissions", "model"]);
    expect(lines.every((line) => line.same === true)).toBe(true);
    expect(lines.find((line) => line.layer === "memory")!.detail).toBe("2 entries");
    expect(lines.find((line) => line.layer === "rules")!.detail).toBe("1 entry");
    const differ = terminalParity(layers({ memory: ["m1", "m3"], skills: [] }), layers({ memory: ["m1", "m2"], skills: ["s9"] }));
    expect(differ.find((line) => line.layer === "memory")).toEqual({ layer: "memory", same: false, detail: "only in the session: m3; only in the terminal: m2" });
    expect(differ.find((line) => line.layer === "skills")).toEqual({ layer: "skills", same: false, detail: "only in the terminal: s9" });
    expect(differ.find((line) => line.layer === "hooks")!.same).toBe(true);
    // one side has no record: not compared, on either side, and both missing too
    for (const [a, b] of [[layers({ rules: null }), layers()], [layers(), layers({ rules: null })], [layers({ rules: null }), layers({ rules: null })]] as const) {
      expect(terminalParity(a, b).find((line) => line.layer === "rules")).toEqual({ layer: "rules", same: null, detail: "not compared: one side has no record of this layer" });
    }
    const permissions = terminalParity(layers({ permissions: null }), layers()).find((line) => line.layer === "permissions")!;
    expect(permissions.same).toBeNull();
    expect(permissions.detail).toMatch(/^not compared: permissions were not recorded/);
    // a narrowed policy group shows in the permission list, so a tighter writer diffs against an open terminal
    const tight = permissionEntries({ policy: { required: true, mcpServers: { mode: "allow", names: ["metamcp"] } }, disallowedTools: ["Bash"] });
    expect(tight).toContain("mcpServers:allow(metamcp)");
    expect(tight).toContain("required:true");
    expect(permissionEntries({ policy: null, disallowedTools: ["Bash"] })).toContain("mcpServers:inherit");
    const { db } = open();
    expect(attemptSessionLayers(db, "no_such_attempt")).toBeNull();
  });

  it("[sma:m_tl_rules_parity] a tool only the worker has and a tool only the person has are both named, sorted, once", () => {
    expect(parityGaps(["Read", "Bash", "Edit"], ["Read"])).toEqual({ onlySession: ["Bash", "Edit"], onlyTerminal: [] });
    expect(parityGaps(["Read"], ["Write", "Read", "Glob"])).toEqual({ onlySession: [], onlyTerminal: ["Glob", "Write"] });
    expect(parityGaps(["Read", "Bash"], ["Read", "Grep"])).toEqual({ onlySession: ["Bash"], onlyTerminal: ["Grep"] });
    expect(parityGaps(["Read", "Read", "Bash"], ["Bash", "Bash"])).toEqual({ onlySession: ["Read"], onlyTerminal: [] });
    expect(parityGaps([], [])).toEqual({ onlySession: [], onlyTerminal: [] });
  });
});

describe("guard tools: provider drills (n1044, n1045)", () => {
  const withUsage = (events: unknown[]) => createFakePluginHost({ pluginId: "lane-pilot", sdk: { threads: { events: { list: async (args: { threadId: string; afterSeq?: string; limit?: string }) => {
    const after = args.afterSeq ? Number(args.afterSeq) : 0;
    return (args.threadId === "thr" ? events : []).filter((event) => (event as { seq: number }).seq > after).slice(0, Number(args.limit ?? 100));
  } } } } } as never).bb;
  const usageEvent = (seq: number, last: Record<string, number>) => ({ seq, createdAt: 1_000 * seq, type: "thread/tokenUsage/updated", data: { turnId: "turn-1", tokenUsage: { last, total: last } } });

  it("[sma:m_tl_codex_lane] the accounting probe passes on a usage event with all four numbers and names a missing count; a thread with no spend is not on the books", async () => {
    expect(accountingPartsProblem(undefined)).toBeNull();
    expect(accountingPartsProblem({ input: 10, output: 5, cached: 2, total: 15 })).toBeNull();
    expect(accountingPartsProblem({ input: 0, output: 0, cached: 0, total: 0 })).toBeNull();
    for (const key of ["input", "output", "cached", "total"] as const) {
      const parts: Record<string, unknown> = { input: 10, output: 5, cached: 2, total: 15 };
      delete parts[key];
      expect(accountingPartsProblem(parts)).toBe(`accounting: the usage event is missing a numeric ${key} count`);
    }
    expect(accountingPartsProblem({ input: 10, output: Number.NaN, cached: 2, total: 15 })).toMatch(/numeric output count/);
    expect(accountingPartsProblem({ input: 10, output: 5, cached: "2", total: 15 })).toMatch(/numeric cached count/);
    expect(accountingPartsProblem({ input: Number.POSITIVE_INFINITY, output: 5, cached: 2, total: 15 })).toMatch(/numeric input count/);
    // the probe cell itself: judged on the thread's recorded usage
    const good = withUsage([usageEvent(1, { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2, totalTokens: 15 })]);
    expect(await PROBES.accounting.check({ bb: good, threadId: "thr" } as never)).toEqual({ ok: true });
    const none = withUsage([]);
    const refused = await PROBES.accounting.check({ bb: none, threadId: "thr" } as never) as { ok: boolean; reason?: string };
    expect(refused.ok).toBe(false);
    expect(refused.reason).toContain("not on the books");
  });

  it("[sma:m_tl_cap_drill] one sweep probes pause and every documentary cell, saves a receipt per cell, and a failing pause probe is a not_supported receipt", async () => {
    const { bb, db, harness } = open();
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }]);
    harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }]);
    createRun(db, "run_s", SANDBOX_PROJECT_ID);
    setRunThread(db, "run_s", "thr_pm");
    harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", status: "idle", archivedAt: null }));
    const probed: string[] = [];
    const api = createCapabilities({ db, bb, log: () => undefined, isDisposed: () => false } as never, {
      startHelperProbe: async (_p: string, _r: string, _provider: string, _m: string, kind: string) => { probed.push(kind); return kind === "pause" ? { ok: false, started: true, answered: true, reason: "pause: the sleep was not resumed" } : { ok: true, reason: null }; },
      providerBreaker: { record: () => undefined },
    } as never).capabilities;
    const swept = await api.sweep();
    expect([...probed].sort()).toEqual([...CAPABILITIES].sort());
    expect(probed).toEqual(expect.arrayContaining(["pause", ...DOCUMENTARY_CELLS]));
    const receipts = listReceipts(db).filter((row) => row.providerId === "codex");
    expect(receipts.map((row) => row.capability).sort()).toEqual([...CAPABILITIES].sort());
    expect(receipts.find((row) => row.capability === "pause")).toMatchObject({ state: "not_supported", model: expect.anything() });
    expect(receipts.every((row) => row.version.startsWith("0.1.0"))).toBe(true);
    expect(receipts.find((row) => row.capability === "pause")!.detail).toContain("not resumed");
    for (const cell of DOCUMENTARY_CELLS) expect(receipts.find((row) => row.capability === cell)).toMatchObject({ state: "supported", detail: null });
    expect(swept.filter((row) => row.state === "pause:not_supported")).toHaveLength(1);
    // the command line shows the same table
    const cli = await runCapabilityCli(api, ["--probe"]);
    const out = JSON.parse(cli.stdout!);
    const row = out.table.find((item: { providerId: string }) => item.providerId === "codex");
    expect(row.capabilities.pause).toBe("not_supported");
    for (const cell of DOCUMENTARY_CELLS) expect(row.capabilities[cell]).toBe("supported");
    await harness.lifecycle.dispose();
  });
});

describe("guard tools: failure journal and crash census (n1046, n1047)", () => {
  it("[sma:m_tl_bug_sweep] the sweep lists the latest attempt of each failed task, across projects, newest first, and leaves accepted, live and old ones out", () => {
    const { db } = open();
    const task = (runId: string, projectId: string, taskId: string) => { createRun(db, runId, projectId); createTask(db, { id: taskId, runId, kind: "bb", contract: contract(taskId) }); };
    task("r1", "projA", "t_fail_twice"); task("r2", "projB", "t_blocked"); task("r3", "projA", "t_fixed"); task("r4", "projA", "t_running");
    const attempt = (id: string, runId: string, taskId: string, ...moves: Array<[string, Record<string, unknown>?]>) => {
      createAttempt(db, { id, runId, taskId });
      transitionAttempt(db, id, "spawn_requested");
      for (const [state, extra] of moves) transitionAttempt(db, id, state as never, extra as never);
    };
    attempt("a1", "r1", "t_fail_twice", ["running", { threadId: "tw1" }], ["provider_error", { reason: "boom" }]);
    attempt("a2", "r1", "t_fail_twice", ["blocked", { reason: "still broken" }]);
    attempt("a3", "r2", "t_blocked", ["blocked", { reason: "nope" }]);
    attempt("a4", "r3", "t_fixed", ["blocked", { reason: "was broken" }]);
    attempt("a5", "r3", "t_fixed", ["running", { threadId: "tw5" }], ["accepted"]);
    attempt("a6", "r4", "t_running", ["running", { threadId: "tw6" }]);
    const rows = failedTasksAllProjects(db, 0);
    // one line per failed task, its LATEST attempt: a2 (not a1), a3; t_fixed's latest is accepted, t_running's is live
    expect(rows.map((row) => row.attemptId).sort()).toEqual(["a2", "a3"]);
    expect(rows.find((row) => row.attemptId === "a2")).toMatchObject({ projectId: "projA", runId: "r1", taskId: "t_fail_twice", state: "blocked", reason: "still broken" });
    expect(rows.find((row) => row.attemptId === "a3")).toMatchObject({ projectId: "projB", taskId: "t_blocked", reason: "nope" });
    expect(rows.map((row) => row.failedAt)).toEqual([...rows.map((row) => row.failedAt)].sort((x, y) => y - x));
    // `since` keeps only what failed after it
    const newest = Math.max(...rows.map((row) => row.failedAt));
    expect(failedTasksAllProjects(db, newest + 1)).toEqual([]);
    expect(failedTasksAllProjects(db, newest).every((row) => row.failedAt >= newest)).toBe(true);
  });

  it("[sma:m_tl_crash] a writer killed mid-work leaves a census that did not shrink and a database the readiness check calls ready; a damaged file is not ready", () => {
    const dir = mkdtempSync(join(tmpdir(), "lp-r13-crash-"));
    const py = (code: string) => spawnSync("python3", ["-I", "-c", `import sys; sys.path.insert(0, ${JSON.stringify(join(ROOT, "scripts"))})\n${code}`], { encoding: "utf8", cwd: ROOT });
    const census = (db: string) => {
      const out = py(`import json, pathlib\nfrom lp_drill.scenes.hub_outage import _db_census\nprint(json.dumps(_db_census(${JSON.stringify(join(ROOT, "scripts/hub-watchdog.sh"))}, ${JSON.stringify({ PATH: process.env.PATH, HOME: dir })}, pathlib.Path(${JSON.stringify(db)}))))`);
      return JSON.parse(out.stdout.trim().split("\n").pop()!) as { rows: number; ready: boolean };
    };
    try {
      const db = join(dir, "stand.db");
      execFileSync("sqlite3", [db, "pragma journal_mode=WAL; create table beats(n integer);"]);
      expect(census(db)).toEqual({ rows: 0, ready: true });
      const writer = spawn("bash", ["-c", `for i in $(seq 1 200000); do sqlite3 ${JSON.stringify(db)} 'insert into beats values (1);' 2>/dev/null; done`], { stdio: "ignore" });
      let before = { rows: 0, ready: false };
      for (let i = 0; i < 60 && before.rows <= 10; i++) { execFileSync("sleep", ["0.2"]); before = census(db); }
      expect(before.rows).toBeGreaterThan(10);
      expect(before.ready).toBe(true);
      writer.kill("SIGKILL");
      execFileSync("sleep", ["0.3"]);
      const after = census(db);
      expect(after.ready).toBe(true);
      expect(after.rows).toBeGreaterThanOrEqual(before.rows);
      // the count is the table's own: it equals what sqlite itself reads once the writer is gone
      expect(after.rows).toBe(Number(execFileSync("sqlite3", ["-readonly", db, "select count(*) from beats;"], { encoding: "utf8" }).trim()));
      // a database that is not a database: not ready
      const broken = join(dir, "broken.db");
      writeFileSync(broken, "this is not a sqlite file, only text that is long enough to fill a header page ".repeat(80));
      expect(census(broken).ready).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 120_000);
});
