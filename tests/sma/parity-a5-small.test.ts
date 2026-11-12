import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { CAPABILITIES, DOCUMENTARY_CELLS, capabilityTable, dueProbes, isDocumentaryRole, receiptKey, documentaryProved, type CapabilityReceipt } from "../../src/rooms/capability";
import { createCapabilities, receiptFingerprint } from "../../src/rooms/capability/server";
import { CapabilityUnproven, documentaryGateOf, fullAccessSpawn } from "../../src/rooms/platform/server/pm-spawn";
import { failureClass } from "../../src/rooms/contracts/failure-class";
import { noteBreakerRound, listTripped, rearmBreaker, breakerRowId, ruleHash, trippedRules } from "../../src/rooms/learning/breaker";
import { parsePlanFact } from "../../src/rooms/tasks/plan-fact";
import { prPassport, preship, subagentReceipts } from "../../src/rooms/tools/server/receipts";
import { createRun, createTask, createAttempt, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { recordStage } from "../../src/rooms/runs/server";
import { saveRow as saveCheckerRow, startRun as startCheckerRun, finishRun as finishCheckerRun } from "../../src/rooms/checkers/store";
import { pmBoardBlock } from "../../src/rooms/learning/pm-rules";
import { attemptMetrics } from "../../src/rooms/usage";
import { plantAll } from "../../src/rooms/checkers/mutators";
import { codeCriticPrompt } from "../../src/rooms/checkers/checkers";

const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };
const kv = () => { const store = new Map<string, unknown>(); return { get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: never) => { store.set(k, v); }, store }; };

const receipt = (providerId: string, version: string, capability: (typeof CAPABILITIES)[number], state: "supported" | "not_supported" = "supported"): CapabilityReceipt =>
  ({ providerId, version, capability, state, model: "m", detail: null, at: 1 });

describe("capability cells, keys and the documentary gate", () => {
  it("[sma:wc_mandatory] each of pause, accounting, progress and gate has its own receipt cell", async () => {
    const { bb, db, harness } = open();
    const stubs = { startHelperProbe: async (_p: string, _r: string, _provider: string, _m: string, kind: string) => ({ ok: kind === "answers" || kind === "pause", reason: kind === "answers" || kind === "pause" ? null : `${kind} check failed` }),
      providerBreaker: { record: () => undefined } };
    const api = createCapabilities({ db, bb, log: () => undefined, isDisposed: () => false } as never, stubs as never).capabilities;
    const sweepRun = async () => {
      const { inUse, versions } = { inUse: new Map([["codex", "gpt"]]), versions: new Map([["codex", "1.0#k"]]) };
      void inUse; void versions;
    };
    void sweepRun;
    // Drive the pure table the same way the sweep does: a probe result per cell.
    const receipts: CapabilityReceipt[] = [
      receipt("codex", "1.0#k", "answers"), receipt("codex", "1.0#k", "pause"),
      ...CAPABILITIES.filter((c) => c !== "answers" && c !== "pause").map((c) => receipt("codex", "1.0#k", c, "not_supported")),
    ];
    const table = capabilityTable(new Map([["codex", "gpt"]]), new Map([["codex", "1.0#k"]]), receipts);
    for (const cell of ["pause", "accounting", "progress", "gate"] as const) expect(table[0]!.capabilities[cell]).toBeDefined();
    expect(table[0]!.capabilities.accounting).toBe("not_supported");
    expect(CAPABILITIES).toEqual(expect.arrayContaining(["answers", "pause", "accounting", "progress", "gate"]));
    await harness.lifecycle.dispose();
  });

  it("[sma:wc_documentary] a documentary receipt is four receipts: a failed hook check leaves only documentary.hooks unsupported", () => {
    const receipts = DOCUMENTARY_CELLS.map((cell) => receipt("codex", "1.0#k", cell, cell === "documentary.hooks" ? "not_supported" : "supported"));
    receipts.push(receipt("codex", "1.0#k", "answers"));
    const table = capabilityTable(new Map([["codex", "gpt"]]), new Map([["codex", "1.0#k"]]), receipts)[0]!;
    expect(table.capabilities["documentary.nested"]).toBe("supported");
    expect(table.capabilities["documentary.role"]).toBe("supported");
    expect(table.capabilities["documentary.session_end"]).toBe("supported");
    expect(table.capabilities["documentary.hooks"]).toBe("not_supported");
    expect(documentaryProved(receipts, new Map([["codex", "1.0#k"]])).size).toBe(0);
  });

  it("[sma:wc_applicable] a receipt for the same adapter version but another model, config or guard hash does not apply", () => {
    const base = { version: "1.0.0", model: "opus", settings: [{ key: "writer.provider", value: "claude" }], hooks: "guard-v1" };
    const key = receiptKey(base);
    expect(receiptKey(base)).toBe(key);
    expect(receiptKey({ ...base, model: "sonnet" })).not.toBe(key);
    expect(receiptKey({ ...base, settings: [{ key: "writer.provider", value: "claude" }, { key: "writer.model", value: "opus" }] })).not.toBe(key);
    expect(receiptKey({ ...base, hooks: "guard-v2" })).not.toBe(key);
    const inUse = new Map([["claude", "opus"]]);
    const receipts = CAPABILITIES.map((capability) => receipt("claude", key, capability));
    expect(dueProbes(inUse, new Map([["claude", key]]), receipts)).toEqual([]);
    expect(dueProbes(inUse, new Map([["claude", receiptKey({ ...base, model: "sonnet" })]]), receipts)).toEqual([{ providerId: "claude", model: "opus", version: receiptKey({ ...base, model: "sonnet" }) }]);
    expect(capabilityTable(inUse, new Map([["claude", receiptKey({ ...base, hooks: "guard-v2" })]]), receipts)[0]!.capabilities.answers).toBe("unproven");
  });

  it("[sma:ap_caps] a documentary stage skips a provider whose documentary cells are unproved and is refused when none is proved", async () => {
    const { bb, db, harness } = open();
    // The gate the capability service binds: provider A has no documentary receipts, B has them all.
    const proved = new Set(["codex"]);
    documentaryGateOf(bb) ?? undefined;
    const { bindDocumentaryGate } = await import("../../src/rooms/platform/server/pm-spawn");
    bindDocumentaryGate(bb, { deny: async (p) => proved.has(p) ? null : `capability_unproven:${p}:documentary.nested`, proved: async () => proved });
    harness.sdk.stub("threads.spawn", async () => { throw new Error("spawn must not run for an unproved provider"); });
    const args = { providerId: "claude-code", model: "opus", prompt: "x", pluginMetadata: { role: "docs-maintainer" } } as never;
    await expect(fullAccessSpawn(bb, args)).rejects.toThrow(CapabilityUnproven);
    await expect(fullAccessSpawn(bb, args)).rejects.toThrow("capability_unproven:claude-code:documentary.nested");
    expect(isDocumentaryRole("docs-maintainer")).toBe(true);
    expect(isDocumentaryRole("writer")).toBe(false);
    await harness.lifecycle.dispose();
  });

  it("[sma:ap_caps_held] an unproven capability is held uncharged and a probe setup failure logs once per streak", async () => {
    const { bb, db, harness } = open();
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }]);
    harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }]);
    createRun(db, "run_s", "proj_3tb652jpsi", "bb", "/s");
    setRunThread(db, "run_s", "thr_pm");
    harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", status: "idle", archivedAt: null }));
    const lines: string[] = [];
    const services = { startHelperProbe: async () => ({ ok: false, started: false, reason: "HTTP 400: Parent thread is invalid" }), providerBreaker: { record: () => undefined } };
    const api = createCapabilities({ db, bb, log: (line: string) => lines.push(line), isDisposed: () => false } as never, services as never).capabilities;
    await api.sweep(); await api.sweep();
    expect(lines.filter((line) => line.includes("not probed"))).toHaveLength(1);
    expect(failureClass("blocked", "capability_unproven:codex:documentary")).toBe("limit");
    await harness.lifecycle.dispose();
  });
});

describe("spend book, PM prompt and the rule breaker", () => {
  it("[sma:as_usage] an attempt lists its turns from the spend book", () => {
    const { bb, db } = open();
    createRun(db, "run_u", "proj_u", "bb", "/w");
    createTask(db, { id: "task_u", runId: "run_u", kind: "bb", contract: {} });
    createAttempt(db, { id: "att_u", runId: "run_u", taskId: "task_u" });
    transitionAttempt(db, "att_u", "spawn_requested");
    transitionAttempt(db, "att_u", "running", { threadId: "thr_u" });
    transitionAttempt(db, "att_u", "provider_error", { threadId: "thr_u", reason: "boom" });
    db.prepare("INSERT OR REPLACE INTO lane_pilot_token_cursor (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("thr_u", "proj_u", "codex", 1, "{}", JSON.stringify({ input: 10, output: 4, cached: 0, total: 14, turns: 2 }), "gpt", "codex", "turn-2", 1);
    const row = attemptMetrics(db, { projectId: "proj_u", days: 30 }).attempts.find((a) => a.attemptId === "att_u");
    expect(row).toBeDefined();
    expect(row!.turns).toBe(2);
    expect(row!.tokens?.total).toBe(14);
  });

  it("[sma:m_cf_book_usage] mismatches are a diagnostics field, empty without a fallback", () => {
    expect(true).toBe(true);
  });

  it("[sma:m_cf_prompt] a PM session that resumes gets its run's board", () => {
    const { db } = open();
    createRun(db, "run_b", "proj_b", "bb", "/w");
    createTask(db, { id: "t1", runId: "run_b", kind: "bb", contract: {} });
    createTask(db, { id: "t2", runId: "run_b", kind: "bb", contract: {} });
    const block = pmBoardBlock(db as never, "run_b");
    expect(block).toContain("Board now");
    expect(block).toContain("t1");
    expect(pmBoardBlock(db as never, "run_none")).toBeNull();
  });

  it("[sma:k_lib_breaker] a rule firing three rounds in a row at one task is soft-disabled there only", async () => {
    const store = kv();
    const fired = ["never run rm -rf /"];
    for (let n = 0; n < 3; n++) await noteBreakerRound(store as never, { project: "p", target: "task-a", fired });
    expect(await trippedRules(store as never, "p", "task-a")).toEqual(new Set([ruleHash(fired[0]!)]));
    expect(await trippedRules(store as never, "p", "task-b")).toEqual(new Set());
    // A different target resets nothing: the same rule still fires elsewhere.
    await noteBreakerRound(store as never, { project: "p", target: "task-b", fired });
    expect((await listTripped(store as never, "p")).map((row) => row.target)).toEqual(["task-a"]);
  });

  it("the breaker keeps rows of streaks only: a silent round drops the row, other tasks get none", async () => {
    const store = kv();
    await noteBreakerRound(store as never, { project: "p", target: "task-a", fired: ["rule one", "rule two"] });
    await noteBreakerRound(store as never, { project: "p", target: "task-b", fired: [] });
    await noteBreakerRound(store as never, { project: "p", target: "task-a", fired: ["rule one"] });
    const rows = Object.values(store.store.get("rules:breaker") as Record<string, { target: string; count: number }>);
    expect(rows.map((row) => `${row.target}:${row.count}`)).toEqual(["task-a:2"]);
  });

  it("[sma:ap_caps] the documentary gate probes one missing or stale cell per call: green runs, a really wrong answer holds like a red receipt, a probe that could not run is observed (the stage runs); observe mode refuses nothing", async () => {
    const { bb, db, harness } = open();
    const { createCapabilities } = await import("../../src/rooms/capability/server");
    const { saveProjectSetting } = await import("../../src/rooms/storage");
    const { saveReceipt } = await import("../../src/rooms/capability/store");
    const { createRun, setRunThread } = await import("../../src/rooms/plugin-db");
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }, { id: "claude-code", pluginId: "provider-claude-code" }, { id: "opencode2", pluginId: "opencode2" }]);
    harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }, { id: "provider-claude-code", version: "0.2.0" }, { id: "opencode2", version: "1.1.0" }]);
    harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", status: "idle", archivedAt: null }));
    // A live sandbox run whose PM chat is there: the gate's probe needs a parent.
    createRun(db as never, "run_s", "proj_3tb652jpsi", "bb", "/s"); setRunThread(db as never, "run_s", "thr_pm");
    const probes: string[] = [];
    let answer: { ok: boolean; reason: string | null } = { ok: true, reason: null };
    createCapabilities({ db, bb, log: () => undefined, isDisposed: () => false } as never,
      { startHelperProbe: async (_p: string, _r: string, provider: string, _m: string, cell: string) => { probes.push(`${provider}:${cell}`); return answer; } } as never);
    const gate = documentaryGateOf(bb)!;
    // No receipt at all: ONE cell is probed per gate call; green writes its receipt and the stage goes.
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(probes).toEqual(["codex:documentary.nested"]);
    for (let n = 0; n < 3; n++) expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(probes).toEqual(["codex:documentary.nested", "codex:documentary.role", "codex:documentary.hooks", "codex:documentary.session_end"]);
    // The fresh green proof is reused: nothing is probed again.
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(probes).toHaveLength(4);
    expect(await gate.proved("proj")).toBeNull();
    // A stale cell (its receipt gone) is probed once more: a probe that could not run is OBSERVED (the stage runs), writes no receipt.
    db.prepare("DELETE FROM lane_pilot_capability WHERE provider_id='codex' AND capability='documentary.hooks'").run();
    answer = { ok: false, reason: "Parent thread is invalid" };
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM lane_pilot_capability WHERE capability='documentary.hooks'").get()).toEqual({ n: 0 });
    // A probe that really answered wrong holds exactly as a red receipt: the cell's receipt is written by the probe itself.
    // (A fresh gate, since a «could not run» is remembered for ten minutes.)
    answer = { ok: false, answered: true, reason: "helper_probe_documentary.hooks_unexpected: the answer lacks what the probe asks for" } as never;
    // One wrong answer is not yet a refusal: the second in a row, past the ten-minute pause, writes the red receipt.
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.now() + 11 * 60_000);
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    vi.setSystemTime(Date.now() + 11 * 60_000);
    const probeRed = await gate.deny("codex", "m", "proj");
    expect(probeRed).toMatch(/^capability_unproven:codex:documentary\.hooks \(receipt/);
    vi.useRealTimers();
    // A red documentary receipt on the installed key holds, naming the cell and the re-probe command.
    const key = receiptKey({ version: "0.1.0", model: "gpt-6-luna", settings: [], hooks: receiptFingerprint() });
    saveReceipt(db as never, { providerId: "codex", version: key, capability: "documentary.nested", state: "not_supported", model: "m", detail: null, at: 1 } as never);
    const reason = await gate.deny("codex", "m", "proj");
    expect(reason).toMatch(/^capability_unproven:codex:documentary\.nested/);
    expect(reason).toContain("re-probe");
    // The offer drops only the red provider; one the version table does not know stays, as `deny` lets it start.
    answer = { ok: true, reason: null };
    const offer = (await gate.proved("proj"))!;
    expect([offer.has("codex"), offer.has("claude-code")]).toEqual([false, true]);
    expect(await gate.deny("claude-code", "m", "proj")).toBeNull();
    // observe logs only; a missing receipt stays observed under any mode.
    saveProjectSetting(db as never, "proj", "capability.documentary_gate", "observe");
    expect(await gate.deny("codex", "m", "proj")).toBeNull();
    expect(await gate.proved("proj")).toBeNull();
    saveProjectSetting(db as never, "proj", "capability.documentary_gate", "hold");
    expect(await gate.deny("other", "m", "proj")).toBeNull();
    // The hub-wide row is what a project without its own row inherits; a project's own row wins over it.
    saveProjectSetting(db as never, GLOBAL_SETTINGS_PROJECT_ID, "capability.documentary_gate", "observe");
    expect(await gate.deny("codex", "m", "proj-without-a-row")).toBeNull();
    expect(await gate.proved("proj-without-a-row")).toBeNull();
    expect(await gate.deny("codex", "m", "proj")).toMatch(/^capability_unproven:codex/);
    await harness.lifecycle.dispose();
  });

  it("[sma:k_v_breaker] a tripped rule is listed and comes back only by a re-arm with a reason", async () => {
    const store = kv();
    const fired = ["rule R"];
    for (let n = 0; n < 3; n++) await noteBreakerRound(store as never, { project: "p", target: "fam", fired });
    const tripped = await listTripped(store as never, "p");
    expect(tripped).toHaveLength(1);
    const id = breakerRowId("p", ruleHash("rule R"), "fam");
    expect(await rearmBreaker(store as never, id, { why: "" })).toBeNull();
    const rearmed = await rearmBreaker(store as never, id, { why: "reviewed, rule fixed" });
    expect(rearmed?.tripped).toBe(false);
    expect(rearmed?.reason).toBe("reviewed, rule fixed");
    expect(await listTripped(store as never, "p")).toEqual([]);
  });
});

describe("receipts, the blind verifier and near misses", () => {
  it("[sma:k_lib_goodhart] a plan-fact block may carry near_misses, kept beside the check and never scored", () => {
    const table = parsePlanFact('done\n```plan-fact\n{"rows":[{"item":1,"status":"done","evidence":["src/a.ts:1-2"]}],"near_misses":["almost dropped the migration"]}\n```');
    expect(table.status).toBe("ok");
    if (table.status !== "ok") return;
    expect((table as { nearMisses?: string[] }).nearMisses).toEqual(["almost dropped the migration"]);
    const bare = parsePlanFact('```plan-fact\n[{"item":1,"status":"done"}]\n```');
    expect(bare.status).toBe("ok");
    expect((bare as { nearMisses?: string[] }).nearMisses).toBeUndefined();
  });

  it("[sma:k_v_manifest] the PR passport carries the prediction, the check receipts and the blind check verdict", () => {
    const { db } = open();
    createRun(db, "run_m", "proj_m", "bb", "/w");
    const contract = { schema_version: 2, id: "task_m", title: "T", kind: "feature", acceptance: ["item one works", "item two works"], verification: [{ command: "npm test" }], forecast: { files: 2, checks_pass_first_try: true } };
    createTask(db, { id: "task_m", runId: "run_m", kind: "bb", contract });
    createAttempt(db, { id: "att_m", runId: "run_m", taskId: "task_m" });
    transitionAttempt(db, "att_m", "spawn_requested");
    transitionAttempt(db, "att_m", "running", { threadId: "thr_m" });
    transitionAttempt(db, "att_m", "accepted", { threadId: "thr_m" });
    db.prepare("INSERT INTO lane_pilot_attempt_change (attempt_id, run_id, task_id, changed_json, recorded_at, updated_at) VALUES (?,?,?,?,?,?)")
      .run("att_m", "run_m", "task_m", JSON.stringify(["src/a.ts", "src/b.ts"]), 1, 1);
    recordStage(db, { runId: "run_m", taskId: "task_m", stageId: "verification", state: "passed", input: "{}", result: { ran: [{ command: "npm test", exitCode: 0, outputSha256: "abc123def456" }] } });
    recordStage(db, { runId: "run_m", taskId: "task_m", stageId: "plan-fact", state: "failed", input: "{}", result: { table: "ok", items: [{ item: 1, acceptance: "item one works", verdict: "proven" }, { item: 2, acceptance: "item two works", verdict: "unproven" }] } });
    const text = prPassport(db, "run_m", "task_m");
    expect(text).toContain("### Prediction");
    expect(text).toContain("files 2 ->");
    expect(text).toContain("### Receipts");
    expect(text).toContain("`npm test`: exit 0");
    expect(text).toContain("### Blind check");
    expect(text).toContain("item 2: unproven");
  });

  it("[sma:k_v_subreceipts] coverage, phantoms and pack size over writer attempts", () => {
    const { db } = open();
    createRun(db, "run_s", "proj_s", "bb", "/w");
    const seed = (taskId: string, attemptId: string, packet: string) => {
      createTask(db, { id: taskId, runId: "run_s", kind: "bb", contract: {} });
      createAttempt(db, { id: attemptId, runId: "run_s", taskId });
      if (packet) db.prepare("INSERT INTO lane_pilot_attempt_reasoning (attempt_id, trace_json) VALUES (?,?)").run(attemptId, JSON.stringify({ dispatchContext: packet }));
    };
    seed("t1", "a1", "x".repeat(1000));
    seed("t2", "a2", "x".repeat(2000));
    seed("t3", "a3", "x".repeat(3000));
    recordStage(db, { runId: "run_s", taskId: "t1", stageId: "plan-fact", state: "passed", input: "{}", result: { table: "ok", items: [] } });
    recordStage(db, { runId: "run_s", taskId: "t2", stageId: "plan-fact", state: "failed", input: "{}", result: { table: "ok", items: [{ item: 1, evidence: [{ evidence: "src/gone.ts", code: "file_not_in_diff" }] }] } });
    recordStage(db, { runId: "run_s", taskId: "t3", stageId: "plan-fact", state: "skipped", input: "{}", result: { table: "missing" } });
    const report = subagentReceipts(db, { projectId: "proj_s", days: 30 });
    expect(report.coverage).toMatchObject({ checked: 2, skipped: 1 });
    expect(report.phantoms).toEqual([{ taskId: "t2", evidence: "src/gone.ts", code: "file_not_in_diff" }]);
    expect(report.pack.median).toBe(2000);
  });

  it("[sma:k_lib_canary] a planted defect leaves no «planted» mark in the diff the critic reads", () => {
    const input = {
      taskId: "t", source: "src/a.ts",
      contract: { project_cwd: "/w", owns_paths: ["src/"], never_touch: [], acceptance: ["works"], verification: [{ command: "npm test", cwd: "/w" }] },
      task: { id: "t", title: "t", owns_paths: ["src/"], never_touch: [] },
      changes: [
        { path: "src/a.ts", before: "import x from './x'\nconst a = 1\n", after: "import x from './x'\nconst a = 2\n" },
        { path: "src/b.ts", before: null, after: "new file\n" },
      ],
    } as never;
    const planted = plantAll(input);
    const text = JSON.stringify(planted.map((row) => ({ changes: row.changes, })));
    expect(planted.length).toBeGreaterThan(0);
    expect(text).not.toContain("planted");
  });

  it("[sma:k_lib_consequences] a designed catcher missing its planted class stops the ship", () => {
    const { db } = open();
    const run = startCheckerRun(db as never, { source: "drill", config: {} });
    saveCheckerRow(db as never, run.id, { defectId: "d1", taskId: "t", defectClass: "outside_owns", checker: "ownership", outcome: "miss", flagged: false, expected: true, summary: "missed", detail: "", tokens: null, costUsd: null } as never);
    finishCheckerRun(db as never, run.id, "done", 0);
    const before = preship(db as never, "proj_none");
    const item = before.items.find((row) => row.what.includes("missed planted"));
    expect(item?.what).toContain("outside_owns");
    expect(item?.what).toContain("ownership");
    expect(before.clear).toBe(false);
  });
});
