import { createHash } from "node:crypto";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import plugin from "../../server";
import { rpcContract } from "../../src/rooms/contracts";
import { cockpitRpc } from "../../src/rooms/cockpit";
import { runsRpc } from "../../src/rooms/runs/server/rpc/runs";
import { createCore } from "../../src/rooms/core/server/core";
import { createFakeWorktreeHost } from "../own-worktree-host";
import { buildTaskBoard } from "../../src/rooms/runs/server/task-board";
import { workFilePathError, workFileRead } from "../../src/rooms/runs/server/work-file";
import { conveyorState } from "../../src/rooms/runs/conveyor";
import { phaseBoardCards } from "../../src/rooms/phase";
import { insertPhase, savePhase } from "../../src/rooms/phase/store";
import { STATE_MACHINE_VERSION } from "../../src/rooms/contracts/state-machine";
import {
  appendGateEvaluation, attemptTransitionsForTask, createAttempt, createRun, createTask, getReasoningTrace, HARNESS_VERSION, inspectAttempt, listRunTransitions, onAttemptChanged, openDatabase,
  saveProjectSetting, savePrototypeConfig, saveReasoningTrace, saveStageReceipt, setRunThread, setTaskHeldUntil, transitionAttempt, workerOutcomesSince, workerPresenceNow,
} from "../../src/rooms/plugin-db";
import type { PhaseRecord } from "../../src/rooms/phase/logic";

function db0() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { bb, db: openDatabase(bb) };
}

const piece = (id: string, wave: number) => ({ id, title: id, wave, promise: { given: "g", when: "w", then: "t" }, task: { id, owns_paths: [`${id}/**`] } });
const PLAN: PhaseRecord = { plan: { items: [piece("a", 1), piece("b", 2)], sha: "plan-sha", contextSha: "context-sha" } };

describe("[sma:m_sw_unit_card] [sma:d_state] phase cards and held on the board", () => {
  it("a phase is one card with stage column, next action, gates and wave; a task carries held", () => {
    const { db } = db0();
    createRun(db, "run_p", "proj_p", "bb", "/w");
    createTask(db, { id: "t1", runId: "run_p", kind: "bb", contract: {} });
    createAttempt(db, { id: "a1", runId: "run_p", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested", { reason: "work" });
    transitionAttempt(db, "a1", "running", { reason: "work" });
    insertPhase(db, { id: "ph1", projectId: "proj_p", pmThreadId: "thr", title: "Phase one", goal: "goal", runId: "run_p", at: Date.now() });
    savePhase(db, "ph1", { stage: "execution", record: PLAN, at: Date.now() });
    const doneSince = Date.now() - 86_400_000;
    const phases = phaseBoardCards(db, { projectId: "proj_p", doneSince });
    const items = buildTaskBoard(db, { projectId: "proj_p", doneSince }, phases as never);
    const card = items.find((item) => item.kind === "phase");
    expect(card).toMatchObject({ kind: "phase", column: "running", title: "Phase one", wave: { n: 1, m: 2 } });
    // In execution no gate of an earlier stage is shown.
    expect(card!.gates).toEqual([]);
    const task = items.find((item) => item.kind === "task");
    expect(task).toMatchObject({ held: false, gates: null });
    setTaskHeldUntil(db, "t1", "run_p", Date.now() + 60_000);
    const held = buildTaskBoard(db, { projectId: "proj_p", doneSince }, []).find((item) => item.kind === "task");
    expect(held!.held).toBe(true);
    setTaskHeldUntil(db, "t1", "run_p", Date.now() - 1000);
    const free = buildTaskBoard(db, { projectId: "proj_p", doneSince }, []).find((item) => item.kind === "task");
    expect(free!.held).toBe(false);
  });

  it("a paused phase is blocked; a closed one is done", () => {
    const { db } = db0();
    insertPhase(db, { id: "ph2", projectId: "proj_p", pmThreadId: "thr", title: "Stopped", goal: "g", at: 1 });
    savePhase(db, "ph2", { state: "paused", at: 2 });
    const cards = phaseBoardCards(db, { projectId: "proj_p", doneSince: 0 });
    expect(cards.find((card) => card.key === "phase:ph2")?.column).toBe("blocked");
  });
});

describe("phase cards: one gate, no crash", () => {
  const doneSince = 0;
  const mk = (db: ReturnType<typeof db0>["db"], id: string, stage: string, record: unknown, state?: string) => {
    insertPhase(db, { id, projectId: "proj_g", pmThreadId: "thr", title: id, goal: "g", at: 5 });
    savePhase(db, id, { stage: stage as never, record: record as PhaseRecord, ...(state ? { state: state as never } : {}), at: 6 });
  };

  it("shows only the unmet gate of the phase's current stage; none for a later stage or a closed phase", () => {
    const { db } = db0();
    mk(db, "g_plan", "planning", { plan: { items: [piece("a", 1)], sha: "x", contextSha: "y" } });
    mk(db, "g_exec", "execution", PLAN);
    mk(db, "g_closed", "planning", {}, "closed");
    const cards = phaseBoardCards(db, { projectId: "proj_g", doneSince });
    expect(cards.find((card) => card.key === "phase:g_plan")!.gates.map((gate) => gate.name)).toEqual(["plan"]);
    expect(cards.find((card) => card.key === "phase:g_plan")!.gates[0]!.ok).toBe(false);
    expect(cards.find((card) => card.key === "phase:g_exec")!.gates).toEqual([]);
    expect(cards.find((card) => card.key === "phase:g_closed")!.gates).toEqual([]);
  });

  it("a plan record without items is «no plan», not a crash", () => {
    const { db } = db0();
    mk(db, "g_noitems", "planning", { plan: { sha: "x", contextSha: "y" } });
    const logged: string[] = [];
    const [card] = phaseBoardCards(db, { projectId: "proj_g", doneSince, onError: (message) => logged.push(message) });
    expect(logged).toEqual([]);
    expect(card!.gates[0]).toMatchObject({ name: "plan", ok: false });
    expect(card!.gates[0]!.why[0]).toMatch(/no plan/);
  });

  it("a phase that cannot be built is skipped and logged once; the others still render", () => {
    const { db } = db0();
    mk(db, "g_good", "execution", PLAN);
    mk(db, "g_bad", "execution", { plan: { items: [null] } });
    const logged: string[] = [];
    const first = phaseBoardCards(db, { projectId: "proj_g", doneSince, onError: (message) => logged.push(message) });
    expect(first.map((card) => card.key)).toEqual(["phase:g_good"]);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/g_bad/);
    phaseBoardCards(db, { projectId: "proj_g", doneSince, onError: (message) => logged.push(message) });
    expect(logged).toHaveLength(1);
  });

  it("task_board answers without phase cards when the phase call itself throws", async () => {
    const { bb, db } = db0();
    createRun(db, "run_b", "proj_b", "bb", "/w");
    createTask(db, { id: "tb", runId: "run_b", kind: "bb", contract: {} });
    createAttempt(db, { id: "ab", runId: "run_b", taskId: "tb" });
    const rpc = runsRpc(createCore(bb, db), { phaseCards: () => { throw new Error("phase store unreadable"); } } as never);
    const board = await rpc.task_board({ projectId: "proj_b", doneHours: 24 });
    expect(board.items.map((item) => item.kind)).toEqual(["task"]);
  });
});

describe("[sma:ar_ledger] attempt transitions are append-only", () => {
  it("update and delete on the journal and delete on the attempt are refused", () => {
    const { db } = db0();
    createRun(db, "run_l", "proj_l");
    createTask(db, { id: "tl", runId: "run_l", kind: "bb", contract: {} });
    createAttempt(db, { id: "al", runId: "run_l", taskId: "tl" });
    transitionAttempt(db, "al", "spawn_requested", { reason: "go" });
    transitionAttempt(db, "al", "running", { reason: "go" });
    expect(() => db.prepare("UPDATE lane_pilot_attempt_transition SET reason='x'").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM lane_pilot_attempt_transition").run()).toThrow(/append-only/);
    expect(() => db.prepare("DELETE FROM lane_pilot_attempt").run()).toThrow(/append-only/);
    const rows = listRunTransitions(db, "run_l");
    expect(rows.some((row) => row.to_state === "running")).toBe(true);
  });
});

describe("conveyor default", () => {
  it("an install that never touched the switch has the conveyor on, as on main", async () => {
    const map = new Map<string, unknown>();
    const kv = { get: async (k: string) => map.get(k), set: async (k: string, v: unknown) => { map.set(k, v); } };
    expect((await conveyorState(kv)).on).toBe(true);
    expect([...map.keys()]).toEqual([]);
  });
});

describe("[sma:d_artifact] bounded work file read", () => {
  it("refuses escapes and secret names but not ordinary code with «key» in its name", () => {
    for (const bad of ["../x", "/etc/passwd", ".git/config", "a/.git/HEAD", "a/.env", ".env.local", "k.pem", "k.key", "c.p12", "c.pfx", "id_rsa", "x/id_ed25519.pub", ".npmrc", "a/.netrc", ".pgpass",
      "credentials.json", "secrets.yaml", "secret_notes.md", "api-token.txt", "tokens.json", ".ssh/config", "home/.aws/credentials", ".gnupg/pubring.kbx"]) {
      expect(workFilePathError(bad), bad).toMatch(/refused/);
    }
    for (const fine of ["src/app.ts", "src/keyboard.ts", "src/monkey.ts", "src/keys.ts", "README.md", "src/token-bucket.ts", "docs/id_rsa-howto.md"]) {
      expect(workFilePathError(fine), fine).toBeNull();
    }
  });

  it("returns exactly the RPC's output fields from a full host reply, and the RPC's own schema accepts it", async () => {
    const { db } = db0();
    createRun(db, "run_w", "proj_w", "bb", "/w", "none", undefined, "h1");
    const calls: unknown[] = [];
    const fullReply = { schemaVersion: 1, hostId: "h1", path: "src/app.ts", content: "one\ntwo\n", contentEncoding: "utf8", sha256: "a".repeat(64), sizeBytes: 8,
      totalLines: 2, offset: 10, maxLines: 200, lineStart: 11, lineEnd: 12, truncated: false, returnedBytes: 8 };
    const host = { call: async (_method: string, input: unknown) => { calls.push(input); return fullReply; } };
    const out = await workFileRead(db, host as never, { runId: "run_w", relativePath: "src/app.ts", offset: 10 });
    expect(calls[0]).toMatchObject({ offset: 10, maxLines: 200 });
    expect(Object.keys(out).sort()).toEqual(["content", "lineEnd", "lineStart", "path", "sizeBytes", "totalLines", "truncated"]);
    expect(() => rpcContract.work_file_read.output.parse(out)).not.toThrow();
    await expect(workFileRead(db, host as never, { runId: "run_w", relativePath: "../x" })).rejects.toThrow(/refused/);
    await expect(workFileRead(db, host as never, { runId: "run_w", relativePath: "src/id_rsa" })).rejects.toThrow(/names a secret/);
  });

  it("refuses a run of another project than the window names, and a run with no checkout", async () => {
    const { db } = db0();
    createRun(db, "run_w", "proj_w", "bb", "/w", "none", undefined, "h1");
    const host = { call: async () => { throw new Error("must not be called"); } };
    await expect(workFileRead(db, host as never, { runId: "run_w", projectId: "proj_other", relativePath: "src/app.ts" })).rejects.toThrow(/does not belong to this project/);
    await expect(workFileRead(db, host as never, { runId: "no_such_run", relativePath: "src/app.ts" })).rejects.toThrow(/no checkout/);
  });
});

describe("[sma:m_wrappers] transitionAttempt journals atomically", () => {
  it("a refusal is journaled; a failure of the journal row rolls the state write back and tells no listener", () => {
    const { db } = db0();
    createRun(db, "run_t", "proj_t");
    createTask(db, { id: "tt", runId: "run_t", kind: "bb", contract: {} });
    createAttempt(db, { id: "at", runId: "run_t", taskId: "tt" });
    expect(transitionAttempt(db, "at", "accepted", { reason: "done" })).toBe(true);
    expect(transitionAttempt(db, "at", "running", { reason: "no way back" })).toBe(false);
    const rows = attemptTransitionsForTask(db, "run_t", "tt");
    expect(rows.filter((row) => row.refused === 0).map((row) => row.to_state)).toContain("accepted");
    expect(rows.some((row) => row.refused === 1)).toBe(true);

    createTask(db, { id: "tm", runId: "run_t", kind: "bb", contract: {} });
    createAttempt(db, { id: "am", runId: "run_t", taskId: "tm" });
    expect(transitionAttempt(db, "am", "spawn_requested", { reason: "go" })).toBe(true);
    // The journal insert fails in the middle of the move: the state UPDATE before it must not stay.
    db.exec("CREATE TEMP TRIGGER boom BEFORE INSERT ON lane_pilot_attempt_transition WHEN NEW.to_state='running' BEGIN SELECT RAISE(ABORT,'journal broke'); END");
    const heard: string[] = [];
    const stop = onAttemptChanged(db, (id, to) => heard.push(`${id}:${to}`));
    expect(() => transitionAttempt(db, "am", "running", { reason: "go" })).toThrow(/journal broke/);
    stop();
    expect((db.prepare("SELECT state FROM lane_pilot_attempt WHERE id='am'").get() as { state: string }).state).toBe("spawn_requested");
    expect(heard).toEqual([]);
    expect(attemptTransitionsForTask(db, "run_t", "tm").some((row) => row.to_state === "running")).toBe(false);
  });
});

describe("[sma:m_sw_worker_history] [sma:m_sw_worker_card] outcomes, presence and the worker card", () => {
  const trace = (attemptId: string, providerId: string, model: string, runId: string) => ({ planSha256: "s", sourceLength: 1,
    requestedReasoningLevel: "m", effectiveReasoningLevel: "m", fallbackReason: null, providerId, model, serviceTier: null, requestedServiceTier: "default" as const, runId, attemptId, threadId: null });

  function seed() {
    const { bb, db } = db0();
    createRun(db, "run_o", "proj_o");
    createTask(db, { id: "to", runId: "run_o", kind: "bb", contract: {} });
    for (const id of ["ao1", "ao2", "ao3"]) createAttempt(db, { id, runId: "run_o", taskId: "to" });
    saveReasoningTrace(db, trace("ao1", "p1", "m1", "run_o"));
    saveReasoningTrace(db, trace("ao2", "p1", "m1", "run_o"));
    transitionAttempt(db, "ao1", "accepted", {});
    transitionAttempt(db, "ao2", "spawn_requested", {});
    transitionAttempt(db, "ao2", "running", {});
    // ao3 has a trace that is not JSON: it counts under "unknown", it never breaks the read.
    db.prepare("INSERT INTO lane_pilot_attempt_reasoning(attempt_id,trace_json) VALUES('ao3','{not json')").run();
    transitionAttempt(db, "ao3", "canceled", {});
    return { bb, db };
  }

  it("groups done/notDone per worker and day and reports running tasks, reading only provider and model", () => {
    const { db } = seed();
    const outcomes = workerOutcomesSince(db, "proj_o", 0);
    expect(outcomes.find((row) => row.providerId === "p1" && row.model === "m1")).toMatchObject({ done: 1, notDone: 0 });
    expect(outcomes.find((row) => row.providerId === "unknown")).toMatchObject({ done: 0, notDone: 1 });
    const presence = workerPresenceNow(db, "proj_o", 0).find((row) => row.providerId === "p1");
    expect(presence).toMatchObject({ running: 1, taskIds: ["to"] });
    expect(presence!.lastAt).toBeGreaterThan(0);
  });

  it("cockpit_workers carries the card's presence and history, no usage windows, and makes no host call", async () => {
    const { bb, db } = seed();
    const today = new Date().toISOString().slice(0, 10);
    db.prepare("INSERT INTO lane_pilot_token_daily(day,project_id,provider_id,model,input_tokens,output_tokens,cached_tokens,total_tokens,uncached_tokens,cache_read_tokens,cache_write_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(today, "proj_o", "p1", "m1", 1, 1, 0, 2, 2, 0, 0);
    const hostCalls: string[] = [];
    const ctx = { db, bb: { ...bb, hosts: { experimental_client: () => ({ call: async (method: string) => { hostCalls.push(method); return {}; } }) }, storage: bb.storage }, log: () => undefined };
    const rpc = cockpitRpc(ctx as never, { front: { actions: async () => [] } } as never);
    const [worker] = await rpc.cockpit_workers({ projectId: "proj_o" }) as Array<Record<string, any>>;
    expect(worker).toMatchObject({ providerId: "p1", model: "m1", tokens: 2, running: 1, runningTasks: ["to"] });
    expect(worker!.lastAt).toBeGreaterThan(0);
    expect(worker!.days[0]).toMatchObject({ day: today, tokens: 2, done: 1, notDone: 0 });
    expect(worker).not.toHaveProperty("windows");
    expect(hostCalls).toEqual([]);
  });
});

describe("[sma:ar_stamp] the writer spawn path stamps the trace it saves", () => {
  it("a dispatched writer's reasoning trace carries the state machine version and the harness version", async () => {
    const projectId = "project-stamp";
    const pmThreadId = "pm-stamp";
    const config = { projectId, hostId: "host-test", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" };
    const efforts = ["medium", "high", "xhigh"].map((reasoningEffort) => ({ reasoningEffort, description: reasoningEffort }));
    let snapshots = 0;
    const { bb, harness } = createFakeWorktreeHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }: { threadId: string }) => threadId === pmThreadId ? { role: "pm", lanePilotRunId: "run-stamp" } : { role: "writer" },
          spawn: async () => ({ id: "writer-stamp" }),
          wait: async () => ({ matched: true, thread: { status: "idle" } }),
          get: async ({ threadId }: { threadId: string }) => threadId === pmThreadId ? { id: pmThreadId, status: "idle", projectId } : { id: "writer-stamp", status: "idle" },
          output: async () => ({ text: "created hello.txt" }),
          list: async () => [],
        },
        providers: { list: async () => [{ id: "codex", available: true, capabilities: { supportsServiceTier: true }, serviceTiers: [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }] }], models: async () => ({ models: [{ id: "codex-test", model: "codex-test", supportedReasoningEfforts: efforts }] }) },
        files: { read: async ({ path }: { path: string }) => path.endsWith("hello.txt") ? { content: "hello\n" } : { content: "fixture\n" }, write: async () => ({ ok: true }) },
      },
      experimental_callHostRpc: (call: { method: string; input: unknown }) => {
        if (call.method === "gitOwnershipBase") return { hostId: "host-test", status: "not-git", branch: null, headSha: null, baseRef: null, baseSha: null, compareCommitted: false, reason: "fixture" };
        if (call.method !== "runCommand") throw new Error(`unexpected ${call.method}`);
        const command = String((call.input as { command?: string }).command ?? "");
        return { hostId: "host-test", exitCode: 0, stdout: command.includes("porcelain") ? JSON.stringify(++snapshots <= 2 ? [] : [{ path: "hello.txt", sha256: "created" }]) : "", stderr: "" };
      },
    } as never, "host-test");
    const db = openDatabase(bb);
    savePrototypeConfig(db, config);
    saveProjectSetting(db, projectId, "plan_critique.enabled", false);
    saveProjectSetting(db, projectId, "memory.enabled", false);
    createRun(db, "run-stamp", projectId, "bb", config.writerWorkspacePath);
    setRunThread(db, "run-stamp", pmThreadId);
    await plugin(bb);
    const task = { schema_version: 2, display_title: "Stamp", kind: "feature", area: "feature:stamp", id: "stamp-task", title: "Stamp", risk: "low", lane: "writer", project_cwd: config.writerWorkspacePath,
      read_first: ["README.md"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["hello.txt"], owns_paths: ["hello.txt"], never_touch: [".git/**"], depends_on: [],
      objective: "create hello", acceptance: ["hello exists"], verify: "none", verification: [] };
    const dispatched = JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_dispatch_writer",
      { confirm: true, objective: "Stamp", plan: "A plan for the stamp test", task }, { threadId: pmThreadId, projectId })));
    await harness.behavior.callAgentTool("lane_pilot_wait_writer", { runId: "run-stamp", timeoutSec: 2 }, { threadId: pmThreadId, projectId });
    expect(getReasoningTrace(db, dispatched.attemptId)?.stamp).toMatchObject({ stateMachineVersion: STATE_MACHINE_VERSION, harnessVersion: HARNESS_VERSION });
    await harness.lifecycle.dispose();
  });
});

describe("[sma:ar_run_dir] the attempt dossier is bounded", () => {
  const big = (label: string) => `${label}:`.padEnd(40_000, "x");
  function seed() {
    const { db } = db0();
    createRun(db, "run_d", "proj_d");
    createTask(db, { id: "td", runId: "run_d", kind: "bb", contract: {} });
    createAttempt(db, { id: "ad1", runId: "run_d", taskId: "td" });
    createAttempt(db, { id: "ad2", runId: "run_d", taskId: "td" });
    db.prepare("UPDATE lane_pilot_attempt SET created_at=1000 WHERE id='ad1'").run();
    db.prepare("UPDATE lane_pilot_attempt SET created_at=2000 WHERE id='ad2'").run();
    return db;
  }
  const receipt = (stageId: "plan-fact" | "verification", at: number) => ({ runId: "run_d", taskId: "td", stageId, contractVersion: 1 as const, state: "passed" as const, inputSha256: "i".repeat(64), outputSha256: null,
    attempt: 0, providerId: "p", model: "m", threadId: null, result: { huge: big("receipt") }, reason: null, updatedAt: at });
  const gate = (at: number) => ({ projectId: "proj_d", runId: "run_d", taskId: "td", gate: "validate" as const, status: "passed" as const, inputSha256: "i".repeat(64), outputSha256: null, attempt: 0, occurredAt: at });

  it("keeps the shape of main, adds the stamp, the shas and the lengths of the trace and never its texts", () => {
    const db = seed();
    saveReasoningTrace(db, { stamp: { stateMachineVersion: STATE_MACHINE_VERSION, harnessVersion: "x" }, planSha256: "plan-sha", sourceLength: 1,
      requestedReasoningLevel: "m", effectiveReasoningLevel: "m", fallbackReason: null, providerId: "p", model: "m", serviceTier: null, requestedServiceTier: "default", runId: "run_d", attemptId: "ad2", threadId: "thr_w",
      dispatchContext: { memoryText: big("memory"), rulesText: big("rules"), executionPacket: big("packet"), executionPacketSha256: "packet-sha", pmReadContext: big("pm"), agent: "a", helperMode: "h", helperRequired: false } });
    transitionAttempt(db, "ad2", "spawn_requested", { reason: "go", threadId: "thr_w" });
    const out = inspectAttempt(db, "proj_d", "ad2")!;
    // What main returned is still there.
    expect(out).toMatchObject({ id: "ad2", run_id: "run_d", task_id: "td", state: "spawn_requested", reason_chars: 2, dirt_before_count: 0 });
    const dossier = out.dossier as Record<string, any>;
    expect(dossier.threadId).toBe("thr_w");
    expect(dossier.reasoningTrace).toMatchObject({ stamp: { stateMachineVersion: STATE_MACHINE_VERSION }, planSha256: "plan-sha", executionPacketSha256: "packet-sha",
      lengths: { executionPacket: 40_000, memoryText: 40_000, rulesText: 40_000, pmReadContext: 40_000 } });
    const printed = JSON.stringify(out);
    for (const text of ["memory:", "rules:", "packet:", "pm:", "receipt:"]) expect(printed).not.toContain(text);
    expect(printed.length).toBeLessThan(8_000);
    expect(dossier).toHaveProperty("verdict");
    expect(dossier).not.toHaveProperty("cut");
  });

  it("lists receipts and gate events of this attempt only", () => {
    const db = seed();
    saveStageReceipt(db, receipt("plan-fact", 1500));       // written while ad1 was the newest
    saveStageReceipt(db, receipt("verification", 2500));    // written while ad2 was the newest
    appendGateEvaluation(db, gate(1500));
    appendGateEvaluation(db, gate(2500));
    appendGateEvaluation(db, gate(2600));
    const first = (inspectAttempt(db, "proj_d", "ad1")!.dossier as Record<string, any>);
    const second = (inspectAttempt(db, "proj_d", "ad2")!.dossier as Record<string, any>);
    expect(first.stageReceipts.map((row: any) => row.stageId)).toEqual(["plan-fact"]);
    expect(first.gateEvents).toHaveLength(1);
    expect(second.stageReceipts.map((row: any) => row.stageId)).toEqual(["verification"]);
    expect(second.stageReceipts[0].hasResult).toBeTruthy();
    expect(second.stageReceipts[0]).not.toHaveProperty("result");
    expect(second.gateEvents).toHaveLength(2);
  });

  it("cuts each list to the newest 50 and says so", () => {
    const db = seed();
    const insert = db.prepare("INSERT INTO lane_pilot_attempt_transition(attempt_id,from_state,to_state,reason,refused,at) VALUES('ad2','queued','queued',?,0,?)");
    for (let i = 0; i < 120; i++) insert.run(`move ${i}`, 3000 + i);
    for (let i = 0; i < 70; i++) appendGateEvaluation(db, gate(2100 + i));
    const dossier = inspectAttempt(db, "proj_d", "ad2")!.dossier as Record<string, any>;
    expect(dossier.transitions).toHaveLength(50);
    expect(dossier.transitions.at(-1).reason).toBe("move 119");
    expect(dossier.transitions[0].reason).toBe("move 70");
    expect(dossier.gateEvents).toHaveLength(50);
    expect(dossier.limit).toBe(50);
    expect(dossier.cut.transitions.total).toBeGreaterThanOrEqual(120);
    expect(dossier.cut.gateEvents).toEqual({ shown: 50, total: 70 });
    expect(dossier.cut).not.toHaveProperty("stageReceipts");
  });
});
