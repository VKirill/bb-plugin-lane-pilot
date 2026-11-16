import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, observeRunPhase, parseWorkflow, readRootObservations, registerPureActions } from "@lane-pilot/workflow-engine";
import type { RunRow } from "@lane-pilot/workflow-engine";
import { openDatabase } from "../../src/rooms/plugin-db";
import type { ServerCore } from "../../src/rooms/contracts/server";
import type { Services } from "../../src/rooms/workflow/server/workflow-chain-runtime";
import { createRootObserver } from "../../src/rooms/workflow/server/workflow-root-observation";
import { workflow } from "./fixtures";

const snapshot = { at: 1, hostId: "h1", root: "/repo", head: null, files: [] as string[], workDiffHash: null, indexDiffHash: null, hashAlgorithm: "git-object" as const };

type EventRow = { seq: number; kind: string; to_state: string | null; detail: string | null; at: number };
const events = (db: ReturnType<typeof openDatabase>, runId: string): EventRow[] =>
  db.prepare("SELECT seq, kind, to_state, detail, at FROM lane_pilot_wf_event WHERE run_id=? ORDER BY seq").all(runId) as EventRow[];
const guards = (rows: EventRow[]) => rows.filter((row) => row.kind === "repo_guard");
const detail = (row: EventRow) => JSON.parse(row.detail ?? "null") as Record<string, unknown>;
const revisionOf = (db: ReturnType<typeof openDatabase>, runId: string) =>
  (db.prepare("SELECT COALESCE(MAX(seq),0) AS r FROM lane_pilot_wf_event WHERE run_id=? AND kind IN ('step','rerun')").get(runId) as { r: number }).r;
/** Pending step deliveries may precede the observation; the real boundary is the first running transition. */
const firstRunningSeq = (rows: EventRow[]) => Math.min(...rows.filter((row) => row.kind === "step" && row.to_state === "running").map((row) => row.seq));
const revisionBefore = (rows: EventRow[], seq: number) =>
  Math.max(0, ...rows.filter((row) => (row.kind === "step" || row.kind === "rerun") && row.seq < seq).map((row) => row.seq));

function engineWith(extra: Record<string, unknown> = {}) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const engine = new WorkflowEngine({ db, harnessVersion: "test", ...extra });
  registerPureActions(engine);
  engine.register("search", { reentrant: true, run: async () => ({ output: { items: [], count: 0, kind: "fresh" } }) });
  engine.register("write", { reentrant: true, run: async () => ({ output: { text: "done" } }) });
  return { db, engine };
}
const start = (engine: WorkflowEngine, extra: Record<string, unknown> = {}) =>
  engine.start({ workflow: parseWorkflow(workflow()), inputs: { query: "q" }, ...extra });

describe("root run observations", () => {
  it("journals before/afterExecution repo_guard events around the execution, before the first executor runs", async () => {
    const observeRun = vi.fn(async (_input: { phase: string }) => ({ snapshot, reason: null }));
    const { db, engine } = engineWith({ observeRun });
    // The first executor proves the journal row already exists when execution begins.
    engine.register("probe", { reentrant: true, run: async (ctx) => {
      const seen = db.prepare("SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='repo_guard' AND to_state='before'").get(ctx.runId);
      if (!seen) throw new Error("root before observation missing inside the first executor");
      return { output: { items: [], count: 0, kind: "fresh" } };
    } });
    const flow = workflow({
      nodes: [
        { id: "probe", type: "action", action: "probe", output: [{ name: "items", type: "array" }, { name: "count", type: "number" }, { name: "kind", type: "enum", values: ["fresh", "stale"] }] },
        { id: "write", type: "action", action: "write", output: [{ name: "text", type: "string" }] },
      ],
      edges: [
        { from: "start", to: "probe", with: { query: "input.query" } },
        { from: "probe", to: "write", with: { items: "probe.items" } },
        { from: "write", to: "end", with: { result: "write.text" } },
      ],
    });
    const { runId, done } = engine.start({ workflow: parseWorkflow(flow), inputs: { query: "q" } });
    const summary = await done;
    expect(summary.status).toBe("succeeded");
    expect(observeRun.mock.calls.map(([input]) => input.phase)).toEqual(["before", "afterExecution"]);
    const rows = events(db, runId);
    const gs = guards(rows);
    expect(gs.map((row) => row.to_state)).toEqual(["before", "afterExecution"]);
    expect(gs[0]!.seq).toBeLessThan(firstRunningSeq(rows));
    expect(gs[1]!.seq).toBeGreaterThan(Math.max(...rows.filter((row) => row.kind === "step" || row.kind === "rerun").map((row) => row.seq)));
    const before = detail(gs[0]!);
    expect(before.revision).toBe(revisionBefore(rows, gs[0]!.seq));
    expect(before.initialDrive).toBe(true);
    expect(before.snapshot).toEqual(snapshot);
    expect(before.reason).toBeNull();
    const after = detail(gs[1]!);
    expect(after.revision).toBe(revisionOf(db, runId));
    expect(after.initialDrive).toBe(false);
    expect(after.snapshot).toEqual(snapshot);
    const read = readRootObservations(db, runId);
    expect(read.revision).toBe(revisionOf(db, runId));
    expect(read.before?.detail).toEqual(before);
    expect(read.after?.detail).toEqual(after);
  });

  it("writes no repo_guard events when the engine has no observer (legacy unchanged)", async () => {
    const { db, engine } = engineWith();
    const { runId, done } = start(engine);
    await done;
    expect(guards(events(db, runId))).toHaveLength(0);
  });

  it("observer failure is an explicit null/reason event, never a clean snapshot", async () => {
    const observeRun = vi.fn(async () => { throw new Error("host gone"); });
    const { db, engine } = engineWith({ observeRun });
    const { runId, done } = start(engine);
    const summary = await done;
    expect(summary.status).toBe("succeeded");
    const gs = guards(events(db, runId));
    expect(gs).toHaveLength(2);
    for (const row of gs) {
      const d = detail(row);
      expect(d.snapshot).toBeNull();
      expect(String(d.reason)).toContain("observer_error");
    }
    expect(detail(gs[1]!).initialDrive).toBe(false);
  });

  it("a rerun with identical output re-audits: cached PASS is bound to execution revision", async () => {
    const auditGoals = vi.fn(async () => ({ met: ["g"], unmet: [] as Array<{ id: string; why: string }> }));
    const { db, engine } = engineWith({ observeRun: async () => ({ snapshot, reason: null }), auditGoals });
    const goals = [{ id: "g", done_when: "done", evidence: "the output", guess: true }];
    const { runId, done } = start(engine, { goals });
    await done;
    expect(auditGoals).toHaveBeenCalledTimes(1);
    const rerun = await engine.rerunNode(runId, "write");
    expect(rerun.ok).toBe(true);
    await engine.idle();
    expect(engine.get(runId)?.status).toBe("succeeded");
    expect(auditGoals).toHaveBeenCalledTimes(2);
    const gs = guards(events(db, runId)).filter((row) => row.to_state === "afterExecution");
    expect(gs).toHaveLength(2);
    expect(detail(gs[1]!).revision).toBeGreaterThan(detail(gs[0]!).revision as number);
    const audits = events(db, runId).filter((row) => row.kind === "goal_audit" && row.to_state === "pass");
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(detail(audits.at(-1)!).revision).toBe(detail(gs[1]!).revision);
    expect(detail(audits.at(-1)!).guardSeq).toBe(gs[1]!.seq);
  });

  it("child runs get no repo_guard events and the observer is never called for them; a builtin-first root still observes before it", async () => {
    const observeRun = vi.fn(async ({ run }: { run: { id: string } }) => ({ snapshot, reason: null }));
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const engine = new WorkflowEngine({ db, harnessVersion: "test", observeRun, resolveWorkflow: (id: string) => (id === "inner" ? parseWorkflow({
      schemaVersion: 1, id: "inner", name: "Inner", description: { en: "i", ru: "и" }, inputs: [{ name: "query", type: "string" }], outputs: [{ name: "result", type: "string" }],
      nodes: [{ id: "work", type: "action", action: "write", output: [{ name: "text", type: "string" }] }],
      edges: [{ from: "start", to: "work" }, { from: "work", to: "end", with: { result: "work.text" } }],
    }) : null) });
    registerPureActions(engine);
    engine.register("search", { reentrant: true, run: async () => ({ output: { items: [], count: 0, kind: "fresh" } }) });
    engine.register("write", { reentrant: true, run: async () => ({ output: { text: "done" } }) });
    const outer = workflow({
      nodes: [{ id: "call", type: "subworkflow", workflow: "inner", inputs: { query: "$inputs.query" } }],
      edges: [{ from: "start", to: "call" }, { from: "call", to: "end", with: { result: "call.result" } }],
    });
    const { runId, done } = engine.start({ workflow: parseWorkflow(outer), inputs: { query: "q" } });
    expect((await done).status).toBe("succeeded");
    const child = db.prepare("SELECT id FROM lane_pilot_wf_run WHERE parent_run_id=?").get(runId) as { id: string } | undefined;
    expect(child).toBeDefined();
    expect(guards(events(db, child!.id))).toHaveLength(0);
    expect(observeRun.mock.calls.every(([input]) => (input as { run: { id: string } }).run.id === runId)).toBe(true);
    const rootRows = events(db, runId);
    const rootGuards = guards(rootRows);
    expect(rootGuards.map((row) => row.to_state)).toEqual(["before", "afterExecution"]);
    // The root's first node is the builtin subworkflow: before still precedes its first running step.
    expect(rootGuards[0]!.seq).toBeLessThan(firstRunningSeq(rootRows));
    expect(detail(rootGuards[0]!).initialDrive).toBe(true);
    expect(detail(rootGuards[0]!).revision).toBe(revisionBefore(rootRows, rootGuards[0]!.seq));
  });

  it("a legacy resume without a before observation records unavailable, never a backdated snapshot", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const flow = parseWorkflow(workflow({
      nodes: [{ id: "ask", type: "human", question: "Go on?", options: ["yes", "no"], output: [{ name: "answer", type: "string" }] }],
      edges: [{ from: "start", to: "ask" }, { from: "ask", to: "end", with: { result: "ask.answer" } }],
    }));
    const legacy = new WorkflowEngine({ db, harnessVersion: "test" });
    registerPureActions(legacy);
    const parked = await legacy.start({ workflow: flow, inputs: { query: "q" }, key: "legacy-resume" }).done;
    expect(parked.status).toBe("waiting");
    const observeRun = vi.fn(async () => ({ snapshot, reason: null }));
    const resumed = new WorkflowEngine({ db, harnessVersion: "test", observeRun });
    registerPureActions(resumed);
    const handle = resumed.start({ workflow: flow, inputs: { query: "q" }, key: "legacy-resume" });
    expect(handle.created).toBe(false);
    await handle.done;
    const gs = guards(events(db, parked.runId));
    expect(gs).toHaveLength(1);
    expect(gs[0]!.to_state).toBe("before");
    const d = detail(gs[0]!);
    expect(d.snapshot).toBeNull();
    expect(d.reason).toBe("unavailable: not the initial drive");
    expect(d.initialDrive).toBe(false);
    expect(d.revision).toBe(revisionOf(db, parked.runId));
    expect(d.revision).toBeGreaterThan(0);
    // No historical capture is attempted on a resume: the observer is never invoked for it.
    expect(observeRun).not.toHaveBeenCalled();
  });

  it("reuses the afterExecution of the standing revision and survives malformed guard rows", async () => {
    const observeRun = vi.fn(async () => ({ snapshot, reason: null }));
    const { db, engine } = engineWith({ observeRun });
    const { runId, done } = start(engine);
    await done;
    const run = engine.journal.getRun(runId)!;
    const afters = () => guards(events(db, runId)).filter((row) => row.to_state === "afterExecution");
    expect(afters()).toHaveLength(1);
    // A re-drive of the same execution (no new step/rerun events) must not mint a second receipt.
    await observeRunPhase(engine, run, "afterExecution", false);
    await observeRunPhase(engine, run, "before", false);
    const gs = guards(events(db, runId));
    expect(afters()).toHaveLength(1);
    expect(gs.filter((row) => row.to_state === "before")).toHaveLength(1);
    expect(observeRun).toHaveBeenCalledTimes(2);
    expect(readRootObservations(db, runId).after?.seq).toBe(afters()[0]!.seq);
    // Malformed journal detail degrades to an empty record, never a throw or a clean snapshot.
    engine.journal.event(runId, null, "repo_guard", null, "before", "not-json{");
    engine.journal.event(runId, null, "repo_guard", null, "afterExecution", "[1,2]");
    const degraded = readRootObservations(db, runId);
    expect(degraded.before?.detail).toEqual({});
    expect(degraded.after).toBeNull();
  });

  it("a goal amendment during the after-execution snapshot is what the audit sees", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observeRun = vi.fn(async ({ phase }: { phase: string }) => {
      if (phase === "afterExecution") await gate;
      return { snapshot, reason: null };
    });
    const auditGoals = vi.fn(async (_input: { goals: Array<{ id: string }> }) => ({ met: ["g2"], unmet: [] as Array<{ id: string; why: string }> }));
    const { db, engine } = engineWith({ observeRun, auditGoals });
    const { runId, done } = start(engine, { goals: [{ id: "g1", done_when: "done", evidence: "the output" }] });
    await vi.waitFor(() => expect(observeRun.mock.calls.some(([input]) => (input as { phase: string }).phase === "afterExecution")).toBe(true));
    expect(engine.amendGoals(runId, [{ id: "g2", done_when: "done too", evidence: "the output" }], "test amendment").ok).toBe(true);
    release();
    await done;
    expect(auditGoals).toHaveBeenCalledTimes(1);
    const audited = auditGoals.mock.calls[0]![0];
    expect(audited.goals.map((goal) => goal.id)).toEqual(["g2"]);
    expect(guards(events(db, runId)).map((row) => row.to_state)).toEqual(["before", "afterExecution"]);
  });

  it("a cancel during the after-execution snapshot audits nothing and closes nothing", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observeRun = vi.fn(async ({ phase }: { phase: string }) => {
      if (phase === "afterExecution") await gate;
      return { snapshot, reason: null };
    });
    const auditGoals = vi.fn(async () => ({ met: [], unmet: [] as Array<{ id: string; why: string }> }));
    const { db, engine } = engineWith({ observeRun, auditGoals });
    const { runId, done } = start(engine, { goals: [{ id: "g", done_when: "done", evidence: "the output" }] });
    await vi.waitFor(() => expect(observeRun.mock.calls.some(([input]) => (input as { phase: string }).phase === "afterExecution")).toBe(true));
    expect(engine.cancel(runId, "test cancel")).toBe(true);
    release();
    const summary = await done;
    expect(summary.status).toBe("canceled");
    expect(auditGoals).not.toHaveBeenCalled();
    expect(events(db, runId).filter((row) => row.kind === "goal_audit")).toHaveLength(0);
  });

  it("a dispose during the before snapshot stops the drive before any step runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const observeRun = vi.fn(async ({ phase }: { phase: string }) => {
      if (phase === "before") await gate;
      return { snapshot, reason: null };
    });
    const { db, engine } = engineWith({ observeRun });
    const { runId, done } = start(engine);
    await vi.waitFor(() => expect(observeRun).toHaveBeenCalledTimes(1));
    engine.dispose();
    release();
    await done;
    // No second observation and no execution after the engine is gone.
    expect(observeRun).toHaveBeenCalledTimes(1);
    const rows = events(db, runId);
    expect(guards(rows).map((row) => row.to_state)).toEqual(["before"]);
    expect(rows.filter((row) => row.kind === "step" && row.to_state === "running")).toHaveLength(0);
  });

  it("the plugin observer resolves the checkout through pmCheckout and gitRepoSnapshot", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    harness.sdk.stub("projects.get", async () => ({ sources: [{ hostId: "h1", path: "/repo" }] }));
    harness.sdk.stub("hosts.list", async () => [{ id: "h1", status: "connected" }]);
    const calls: Array<{ method: string; cwd?: string }> = [];
    const host = { call: async (method: string, input: { requestedHostId: string; cwd: string }) => {
      calls.push({ method, cwd: input.cwd });
      return { hostId: input.requestedHostId, exitCode: 0, stderr: "", stdout: [
        "===HEAD===", "a".repeat(40), "===STATUS===", " M src/x.ts", "===WORKSHA===", "b".repeat(40), "===INDEXSHA===", "c".repeat(40), "===END===", "",
      ].join("\n") };
    } };
    const ctx = { db, bb, host } as unknown as ServerCore;
    const observer = createRootObserver(ctx, {} as Services);
    const run = { id: "wfrun_obs", workflow_id: "demo", idem_key: "obs-1", project_id: "p1", link_run_id: null, parent_run_id: null } as unknown as RunRow;
    const result = await observer({ run, phase: "before" });
    expect(result.reason).toBeNull();
    expect(result.snapshot?.root).toBe("/repo");
    expect(result.snapshot?.hostId).toBe("h1");
    expect(result.snapshot?.files).toEqual(["src/x.ts"]);
    expect(calls).toEqual([{ method: "runCommand", cwd: "/repo" }]);
    const unbound = await observer({ run: { ...run, workflow_id: "lp-task-pipeline" } as RunRow, phase: "before" });
    expect(unbound.snapshot).toBeNull();
    expect(String(unbound.reason)).toContain("no checkout binding");
  });
});
