// Region 16 (slash commands and workflows), batch c: the verify-work cards, the debug session, the stand-alone commands (forensics, health, undo, docs, report, stats,
// explore, spike, quick, fast, do, autonomous, manager) — n1205 … n1236. The scratch world the node tests and the scene probe (scripts/lp_drill/scenes/sma_r16_c_probe.ts)
// share. Each `observeC.<smaId>()` runs the REAL code of the node (the real workflow engine on the real graph file with the model steps stubbed, the phase driver on a
// scratch database and a fake host, a scratch git repository) and returns plain data. No vitest import: the probe loads this file under vite-node. No model, no hub,
// nothing outside the machine. Batches a and b's observations are in r16-world.ts and r16-world-b.ts (not edited here).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { git } from "../verification/git-integrate-helpers";
import { sha256Hex } from "@lane-pilot/kit";
import { WorkflowEngine, outputFields, registerPureActions, registerReducers } from "@lane-pilot/workflow-engine";
// By relative path: a mutation of the router under packages/ of this checkout must be the one the test runs (a bare package name resolves from the main checkout).
import { routeIntent, setRouterModel } from "../../packages/workflow-engine/src/router";
import type { Field, Workflow } from "@lane-pilot/workflow-engine";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import { autoDue } from "../../src/rooms/phase/server/auto-stages";
import type { Phase, PlanItem } from "../../src/rooms/phase/logic";
import { designPoints, markUatLine, uatState, uatText } from "../../src/rooms/phase/stages";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { plansFix, plansHealth } from "../../src/rooms/project-life/plans-health";
import { quickStateEdit } from "../../src/rooms/workflow/server/workflow-planning-files";
import { projectStats } from "../../src/rooms/tools/server/project-stats";
import { taskTimeline } from "../../src/rooms/runs";
import { recordStage } from "../../src/rooms/runs/server";
import { createRollback } from "../../src/rooms/rollback/server";
import { createWorktree, integrateWorktree, removeLaneWorktree } from "../../src/rooms/verification/git-integrate";
import { mergeInfo, revertCommitsInWorktree, worktreeState } from "../../src/rooms/verification/git-rollback";
import { runGateOnHost } from "../../src/rooms/verification/integration-gate-host";
import { gateResolverFor } from "../../src/rooms/verification/server";
import { resolveGitOwnershipBase } from "../../src/rooms/verification/git-ownership";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { createWorkflowOps } from "../../src/rooms/workflow/server/workflow-ops";
import { createWorkflowLibrary } from "../../src/rooms/workflow/server/workflow-library";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import { buildDailyReport } from "../../src/rooms/reports/server/daily";
import { runSqliteChild } from "../../src/rooms/reports/server";
import type { ChainRuntime, ServerCore } from "../../src/rooms/contracts/server";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { appendTaskReceipt, upsertAttemptChange } from "../../src/rooms/rollback/store";
import { journalDb } from "../workflow/engine-helpers";
import { publishedCatalog } from "../workflow/router-catalog";
import { chainStore, runSim } from "../workflow/chain-harness";
import { PH, item } from "./r16-world";

type Row = Record<string, unknown>;
const ids = (items: readonly PlanItem[]) => items.map((row) => row.id);
void ids;

// ---------------------------------------------------------------- what a step of a finished run received (the engine's own journal, not a stub's say-so)
function stepInputs(db: ReturnType<typeof journalDb>, runId: string): Record<string, { with: Row; via: Row | null }> {
  const rows = db.prepare("SELECT node_id, input_json FROM lane_pilot_wf_step WHERE run_id=? AND state='succeeded' ORDER BY rowid").all(runId) as Array<{ node_id: string; input_json: string | null }>;
  return Object.fromEntries(rows.map((row) => { const input = JSON.parse(row.input_json ?? "{}") as { with?: Row; via?: Row }; return [row.node_id, { with: input.with ?? {}, via: input.via ?? null }]; }));
}
const output = (run: { summary: { output?: unknown } }) => (run.summary.output ?? {}) as Row;

// A model or owner step the table does not name still answers a value of the right type for each declared output (as tests/workflow/chain-harness.ts does).
const FALSE_BY_NAME = /(^|_)(stalled|warn|has_ui|blocked|failed|thin|timeout|drift|error|errors|missing|dirty|unmet|needs|skipped|breaking|regression|rejected|duplicate|no)(_|$)/;
const defaultOf = (field: Field): unknown => {
  switch (field.type) {
    case "string": return field.default ?? "stub";
    case "number": return field.default ?? 1;
    case "boolean": return field.default ?? !FALSE_BY_NAME.test(field.name);
    case "enum": return field.default ?? field.values![0];
    case "array": return field.default ?? [];
    default: return field.default ?? {};
  }
};

// ---------------------------------------------------------------- the real engine with the real actions, writing into a temp checkout (the debug session file)
async function engineWorld() {
  const PROJECT = "r16c-project", PM = "r16c-pm", RUN = "r16c-run";
  const checkout = mkdtempSync(join(tmpdir(), "lp-r16c-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  const { bb, harness } = createFakePluginHost({
    pluginId: "lane-pilot",
    experimental_callHostRpc: (async (call: { method: string; input: Record<string, unknown> }) => {
      if (call.method === "runCommand") return runCommand(call.input as never, undefined as never);
      throw new Error(`unexpected host method ${call.method}`);
    }) as never,
    sdk: {
      threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadId === PM ? { role: "pm", lanePilotRunId: RUN } : {}),
        spawn: async () => ({ id: "helper-1" }),
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId: PROJECT, environmentId: "env-pm", sourceThreadId: PM, lifecycleOwnerThreadId: PM }),
        events: { list: async ({ threadId }: { threadId: string }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }] },
        send: async () => ({}), stop: async () => ({ ok: true }), output: async () => ({ output: "no script" }),
      },
      environments: { get: async () => ({ id: "env-pm", hostId: "local", path: checkout, status: "ready" }) },
      projects: { get: async () => ({ id: PROJECT, name: "Project", sources: [{ hostId: "local", path: checkout }] }) },
      files: {
        write: async (args: unknown) => { const input = args as { path: string; content: string }; mkdirSync(dirname(input.path), { recursive: true }); writeFileSync(input.path, input.content); return { ok: true, outcome: "written" }; },
        read: async (args: unknown) => {
          const filePath = String((args as { path?: unknown }).path ?? "");
          if (!existsSync(filePath)) throw Object.assign(new Error(`file not found: ${filePath}`), { code: "not_found", serverCode: "file_not_found" });
          const content = readFileSync(filePath, "utf8");
          return { content, sha256: sha256Hex(content), sizeBytes: Buffer.byteLength(content, "utf8"), contentEncoding: "utf8", truncated: false };
        },
      },
    } as never,
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = { dispatchWriter: async () => ({ runId: RUN, taskId: "t", state: "queued" }), stability: { loadParked: async () => [] }, taskUsage } as unknown as Services;
  const store = await chainStore();
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services), resolveWorkflow: store.resolve });
  registerPureActions(engine); registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  registerDispatchExecutors(engine, ctx.bb);
  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };
  const wf = (name: string): Workflow => store.get(name.replace(/\.json$/, ""))!.workflow;
  const calls: Array<{ node: string; with: Row; session: string | undefined }> = [];
  // The model steps answer from the table by node id (a list is one answer per visit); the owner's steps answer from the same kind of table.
  const answerBy = (table: Record<string, Row | Row[]>, kind: string) => {
    const visits = new Map<string, number>();
    return { reentrant: true, run: async (c: { nodeId: string; workflow: Workflow; node: never; input: { with: Row } }) => {
      const n = (visits.get(c.nodeId) ?? 0) + 1; visits.set(c.nodeId, n);
      calls.push({ node: c.nodeId, with: c.input.with, session: (c.node as { session?: string }).session });
      const given = table[c.nodeId] ?? table[c.nodeId.replace(/:child$/, "")];
      const row = Array.isArray(given) ? given[Math.min(n - 1, given.length - 1)] : given;
      const fields = outputFields(c.workflow, c.node);
      const base = fields === "unknown" ? {} : Object.fromEntries(fields.map((field) => [field.name, defaultOf(field)]));
      return { output: { ...base, ...(kind === "agent" ? { handoff: `${c.nodeId} done` } : {}), ...(row ?? {}) } };
    } } as never;
  };
  const run = async (name: string, inputs: Row, agents: Record<string, Row | Row[]>, humans: Record<string, Row | Row[]> = {}, mode?: "quick" | "standard" | "full") => {
    calls.length = 0;
    engine.register("agent", answerBy(agents, "agent"));
    engine.register("builtin:human", answerBy(humans, "human"));
    const summary = await engine.start({ workflow: wf(name), inputs, ...(mode ? { mode } : {}), runtime: rt, link: { projectId: PROJECT, runId: RUN } }).done;
    const steps = db.prepare("SELECT node_id, state, input_json FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid").all(summary.runId) as Array<{ node_id: string; state: string; input_json: string | null }>;
    return { summary, calls: [...calls], status: summary.status, reason: (summary as { reason?: string | null }).reason ?? null, path: steps.filter((s) => s.state === "succeeded").map((s) => s.node_id).filter((id) => !id.endsWith(":fan") && !id.endsWith(":child")), skipped: steps.filter((s) => s.state === "skipped").map((s) => s.node_id), out: (summary.output ?? {}) as Row,
      input: (node: string) => (JSON.parse(steps.find((s) => s.node_id === node && s.state === "succeeded")?.input_json ?? "{}") as { with?: Row; via?: Row }) };
  };
  return { checkout, run, file: (path: string) => { try { return readFileSync(join(checkout, path), "utf8"); } catch { return null; } },
    put: (path: string, text: string) => { mkdirSync(dirname(join(checkout, path)), { recursive: true }); writeFileSync(join(checkout, path), text); },
    dispose: () => { harness.lifecycle.dispose(); rmSync(checkout, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------- the phase driver on a fake host that records what the PM is told
const planRec = (items: PlanItem[], over: Record<string, unknown> = {}) => ({ items, contextSha: "ctx", sha: sha256Hex(JSON.stringify(ids(items))), admittedSha: sha256Hex(JSON.stringify(ids(items))), critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } }, objective: "o", premortem: ["a", "b", "c"], ...over });
function phaseWorldC(pmStatus = "idle") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const messages: string[] = [];
  harness.sdk.stub("threads.send", async (args: { input?: Array<{ text?: string }> }) => { messages.push(String(args.input?.[0]?.text ?? "")); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status: pmStatus, environmentId: "env_pm" }));
  harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const texts = new Map<string, string>();
  const commits: Array<{ paths: string[]; message: string }> = [];
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "writePhaseBook") {
      const edits = input.edits as Array<{ path: string; content: string; expectedSha256: string | null }>;
      return { status: "applied", writes: edits.map((edit) => { texts.set(edit.path, edit.content); return { path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) }; }) };
    }
    if (method === "gitCommitDocs") { commits.push({ paths: input.paths as string[], message: String(input.message) }); return { commit: "c".repeat(40) }; }
    if (method === "runCommand") return { exitCode: 0, stdout: `${"a".repeat(64)}\n`, stderr: "" };
    if (method === "readBoundedFile") return { path: input.relativePath, content: texts.get(String(input.relativePath)) ?? "file body", truncated: false };
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', writer_workspace_path='/repo', pm_thread_id='t' WHERE id='run1'").run();
  const services = {
    runBudgets: { get: () => undefined },
    readWriterWorkspaceFile: async (i: { path: string }) => { if (!texts.has(i.path)) throw new Error("no file"); const c = texts.get(i.path)!; return { content: c, sha256: sha256Hex(c), sizeBytes: c.length }; },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task as never }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  return { phases, db, texts, commits, messages };
}
type WorldC = ReturnType<typeof phaseWorldC>;
async function openedC(w: WorldC, record: Record<string, unknown>, stage: Phase["stage"]) {
  const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  savePhase(w.db, made.id, { stage, state: "active", runId: "run1", record: { ...made.record, ...record } as never, at: 2 });
  return made.id;
}
const ROADMAP = "# Map\n\n## Milestone v1\n\n- [ ] 1.1 Hud — build it\n- [ ] 1.2 Menu — the menu\n\n## Backlog\n\n- [ ] 999.1 Later — parked\n";
const uatLines = (states: Array<"open" | "passed" | "failed">) => states.map((state, index) => ({ n: index + 1, pieceId: `p${index + 1}`, state }));
const refusal = async (fn: () => Promise<unknown>) => { try { await fn(); return null; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } };

export const observeC = {
  /** n1205: only checklist items of the drawing's contract become points, at most 40, each with a stable id from its text, a repeated line counted once, and the cut is counted. */
  k_wv_design() {
    const spec = ["# UI-SPEC", "", "- a plain bullet", "* another plain one", ...Array.from({ length: 45 }, (_, i) => `- [${i % 2 ? "x" : " "}] point ${i + 1}: the screen shows ${i + 1}`), "- [ ] point 1: the screen shows 1", "- [X]   padded   "].join("\n");
    const found = designPoints(spec);
    const small = designPoints("- plain\n* plain too\n- [ ] one\n- [x] two\n- [ ] one\n");
    return { total: found.total, kept: found.points.length, first: found.points[0], last: found.points.at(-1)!.text, idLooksRight: found.points.every((p) => /^design_[0-9a-f]{8}$/.test(p.id)), small: small.points.map((p) => p.text), smallTotal: small.total,
      stable: designPoints("- [ ] one\n").points[0]!.id === small.points[0]!.id, ids: new Set(found.points.map((p) => p.id)).size };
  },

  /** n1206: tests are derived from a finished phase's summaries, the owner agrees or strikes lines (a timeout blocks the run), and the writer gets the agreed list; gaps given by hand skip both. */
  async k_wv_extract() {
    const gaps = [{ file: "src/sum.ts", layer: "L1", priority: "high" }, { file: "src/avg.ts", layer: "L1", priority: "low" }];
    const stubs = { derive: { gaps }, write_tests: { state: "accepted" }, inventory: { status: "measured", tests_added: 3, runner_ok: true }, run: { ok: true, pass_rate: 100 } };
    const agreed = await runSim("test-gen", { input: { scope: "src", phase_id: "ph_1" }, stubs, humans: { confirm: { answer: "agree", answer_kind: "agree" } } });
    const timeout = await runSim("test-gen", { input: { scope: "src", phase_id: "ph_1" }, stubs, humans: { confirm: { answer: "", answer_kind: "timeout" } } });
    const given = await runSim("test-gen", { input: { scope: "src", gaps }, stubs });
    const writeIn = stepInputs(agreed.db, agreed.summary.runId).write_tests;
    return { agreed: { path: agreed.path, status: output(agreed).status, added: output(agreed).tests_added, fromDerive: writeIn?.via?.fromStep ?? null },
      timeout: { path: timeout.path, status: output(timeout).status }, given: { path: given.path, skipped: given.skipped, status: output(given).status } };
  },

  /** n1207: the acceptance session's file tracks the answers (open, passed, failed) line by line, and a fresh read of the text gives back the same state after a context clear. */
  k_wv_uatfile() {
    const items = [item("p1"), item("p2"), item("p3")];
    const lines = [{ n: 1, pieceId: "p1", state: "passed", by: "owner", at: 1 }, { n: 2, pieceId: "p2", state: "failed", note: "the total is wrong", by: "owner", at: 2 }, { n: 3, pieceId: "p3", state: "open" }];
    const bare = uatText({ id: PH, title: "Sum", goal: "sums", record: { plan: { items } } } as never);
    const answered = uatText({ id: PH, title: "Sum", goal: "sums", record: { plan: { items }, uat: { path: "UAT.md", sha256: "s", at: 1, lines } } } as never);
    const marked = (text: string) => text.split("\n").filter((row) => row.startsWith("- ["));
    return { bare: marked(bare), answered: marked(answered), head: answered.split("\n").slice(0, 3), readBack: uatState(answered), readBare: uatState(bare), main: bare.split("\n")[4], rule: bare.split("\n")[6] };
  },

  /** n1208: a person answers one test at a time by its number, pass or fail, and the answer (with his note, who and when) is recorded on the phase and in its book; an unknown number or a phase with no session is refused. */
  async k_wv_present() {
    const w = phaseWorldC();
    const id = await openedC(w, { plan: planRec([item("p1"), item("p2"), item("p3")]), uat: { path: ".agents/phases/x/UAT.md", sha256: "s", at: 1, lines: uatLines(["open", "open", "open"]) } }, "acceptance");
    await w.phases.uatLine({ phaseId: id, line: 2, result: "pass", by: "owner via screen" });
    await w.phases.uatLine({ phaseId: id, line: 3, result: "fail", note: "  the total   is wrong ", by: "owner" });
    const lines = (getPhase(w.db, id)!.record.uat?.lines ?? []).map((row) => ({ n: row.n, state: row.state, note: row.note ?? null, by: row.by ?? null }));
    const book = listParts(w.db, id).filter((part) => part.kind === "uat_line").map((part) => part.text);
    await w.phases.uatLine({ phaseId: id, line: 3, result: "pass", by: "owner" });
    const redone = getPhase(w.db, id)!.record.uat!.lines!.find((row) => row.n === 3)!;
    const unknown = await refusal(() => w.phases.uatLine({ phaseId: id, line: 9, result: "pass" }));
    const bare = phaseWorldC();
    const bareId = await openedC(bare, {}, "acceptance");
    return { lines, book, redone: { state: redone.state, note: redone.note ?? null }, unknown, noSession: await refusal(() => bare.phases.uatLine({ phaseId: bareId, line: 1, result: "pass" })) };
  },

  /** n1209: the session is complete only when every line passed: the owner's yes is refused while a line is open or failed (it says how many), counts when all passed, and a «no» sends the work back to execution. */
  async k_wv_complete() {
    const run = async (states: Array<"open" | "passed" | "failed">, decision: "yes" | "no" = "yes") => {
      const w = phaseWorldC();
      const id = await openedC(w, { plan: planRec([item("p1"), item("p2"), item("p3")]), uat: { path: ".agents/phases/x/UAT.md", sha256: "s", at: 1, lines: uatLines(states) } }, "acceptance");
      const why = await refusal(() => w.phases.word({ phaseId: id, turn: "uat", decision, text: decision === "yes" ? "да" : "the totals are wrong", by: "owner" }));
      const after = getPhase(w.db, id)!;
      return { why, stage: after.stage, words: (after.record.words ?? []).map((row) => [row.turn, row.decision]) };
    };
    return { open: await run(["passed", "open", "passed"]), failed: await run(["passed", "failed", "passed"]), all: await run(["passed", "passed", "passed"]), none: await run([]) };
  },

  /** n1235: with autonomous on, a closed phase opens the next open roadmap row (never a parked 999 one) as the next phase at its discussion at once and tells the PM nothing; off, the PM is told which row is next and nothing is opened. */
  async k_c_autonomous() {
    const run = async (autonomous: boolean, roadmap = ROADMAP) => {
      const w = phaseWorldC();
      const id = await openedC(w, { roadmapRow: "1.1", ...(autonomous ? { autonomous: true } : {}) }, "closed");
      savePhase(w.db, id, { record: { ...getPhase(w.db, id)!.record, bookWritten: { seq: 0, sha256: "", at: 1 } }, at: Date.now() });
      w.texts.set(".agents/planning/ROADMAP.md", roadmap);
      await w.phases.tick();
      const all = w.phases.list({ projectId: "projA" } as never) as Array<{ id: string; title: string; stage: string; record: { roadmapRow?: string } }>;
      const next = all.filter((row) => row.id !== id).map((row) => [row.title, row.stage, row.record.roadmapRow ?? null]);
      return { next, book: listParts(w.db, id).filter((part) => part.kind === "transition").map((part) => part.text.replace(/ph_[0-9a-f]+/, "<id>")), told: w.messages.filter((text) => text.includes("Next on the roadmap")).map((text) => text.replace(/ph_[0-9a-f]+/, "<id>").slice(0, 120)), closed: getPhase(w.db, id)!.state };
    };
    return { on: await run(true), off: await run(false), lastRow: await run(true, "# Map\n\n## Milestone v1\n\n- [x] 1.1 Hud — build it\n\n## Backlog\n\n- [ ] 999.1 Later — parked\n") };
  },

  /** n1215: the post-mortem of one task from the hub's own records: when it arrived, each attempt and its moves (with the reason), its stage receipts and baseline verdicts, in the order they happened. */
  k_c_forensics() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA", "bb", "/repo");
    createTask(db, { id: "T1", runId: "run1", kind: "bb", contract: { title: "Task", objective: "obj" } } as never);
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "thr1" });
    transitionAttempt(db, "a1", "blocked", { reason: "verification_failed: npm test" } as never);
    recordStage(db, { runId: "run1", taskId: "T1", stageId: "verification", state: "failed", attempt: 1, input: "v" });
    const baseline = () => [{ at: Date.now() + 5_000, attempt_id: "a1", verdict: "red", action: "kept", summary: "main was red too" }];
    const line = taskTimeline(db, "T1", "run1", baseline);
    const none = taskTimeline(db, "nope");
    return { entries: line.entries.map((row) => `${row.kind}: ${row.text}`.replace(/sha [0-9a-f]{12}/, "sha <12>")), sorted: line.entries.every((row, index) => index === 0 || line.entries[index - 1]!.at <= row.at), receipts: line.receipts.map((row) => [row.stageId, row.state, row.attempt]), birth: line.birth, none: { runId: none.runId, entries: none.entries.length } };
  },

  /** n1216: the planning files' integrity — an index entry whose folder is gone and an item missing from its index are named per area, prose is no entry, a healthy area is not listed; the fix drops the dead entry, adds the missing one, keeps a backup. */
  k_c_health() {
    const root = join(mkdtempSync(join(tmpdir(), "lp-r16c-health-")), ".agents");
    const put = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    const INDEX = ["# Todos", "", "- real-one — the live item", "- ghost-item — the folder was deleted", "- Remember to review this weekly", "", "## Notes", "ghost-prose: a sentence, not an entry", ""].join("\n");
    put("todos/items/real-one/meta.yaml", "status: open\n"); put("todos/items/unlisted/meta.yaml", "status: open\n"); put("todos/INDEX.md", INDEX);
    put("plans/2026-11-01-big-plan.md", "# plan\n"); put("plans/2026-11-02-new-plan.md", "# plan\n"); put("plans/INDEX.md", "# Plans\n- 2026-11-01-big-plan\n");
    put("clean/x.md", "x");
    const report = plansHealth(root);
    const fixed = plansFix(root);
    const read = (path: string) => readFileSync(join(root, path), "utf8");
    const after = plansHealth(root);
    const out = { report, fixed, todos: read("todos/INDEX.md"), todosBak: read("todos/INDEX.md.bak") === INDEX, plans: read("plans/INDEX.md"), after };
    rmSync(dirname(root), { recursive: true, force: true });
    return out;
  },

  /** n1226: the project's report counts its phases and the pieces of their plans by state, what the accepted merges changed (commits, files) and the timeline, from the hub's own tables. */
  async k_c_stats() {
    const w = phaseWorldC();
    const a = await openedC(w, { plan: planRec([item("p1"), item("p2"), item("p3"), item("p4"), item("p5")].map((row, index) => ({ ...row, state: ["accepted", "done", "withdrawn", "dropped", "open"][index] }) as never)) }, "execution");
    await openedC(w, {}, "planning");
    createTask(w.db, { id: "T1", runId: "run1", kind: "bb", contract: { title: "Task", objective: "obj" } } as never);
    createAttempt(w.db, { id: "a1", runId: "run1", taskId: "T1" });
    transitionAttempt(w.db, "a1", "spawn_requested"); transitionAttempt(w.db, "a1", "running", { threadId: "thr1" }); transitionAttempt(w.db, "a1", "accepted");
    upsertAttemptChange(w.db, { attemptId: "a1", runId: "run1", taskId: "T1" }, { mergeCommit: "abc123", changed: [{ path: "a.ts", status: "M" }, { path: "b.ts", status: "A" }, { path: "c.ts", status: "D" }] } as never);
    const stats = projectStats(w.db, "projA", 30);
    const other = projectStats(w.db, "elsewhere", 30);
    return { phases: stats.phases.map((row) => [row.id === a ? "first" : "second", row.stage, row.state]).sort(), plans: stats.plans, requirements: stats.requirements, git: stats.git, timeline: stats.timeline.map((row) => row.what).filter((what) => !what.startsWith("book part")), days: stats.days, other: { phases: other.phases.length, plans: other.plans, git: other.git } };
  },

  /** n1218: the runs of a workflow are listed newest first with each run's status, one page at a time (the page says whether more follow), and only the project's own runs are listed. */
  async k_wdb_list() {
    const db = journalDb();
    const globalDir = mkdtempSync(join(tmpdir(), "lp-r16c-ops-"));
    const ctx = { db, log: () => undefined, host: { call: async () => ({ hostId: "h", files: [] }) } } as unknown as ServerCore;
    const services = { workflowEngine: {}, docsPlaces: async () => [] } as unknown as Services;
    const ops = createWorkflowOps(ctx, services, createWorkflowLibrary(ctx, services, { globalDir }));
    const insert = db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
    ([["r1", "debug", "p1", "succeeded"], ["r2", "debug", "p1", "failed"], ["r3", "other", "p1", "succeeded"], ["r4", "debug", "p1", "running"], ["r5", "debug", "p2", "succeeded"]] as const).forEach(([id, wf, project, status], at) => insert.run(id, wf, 1, "x", "{}", project, status, (at + 1) * 10, (at + 1) * 10));
    const list = (input: Record<string, unknown>) => { const page = ops.runs({ id: "debug", limit: 5, ...input } as never); return { runs: page.runs.map((row) => [row.id, row.status]), hasMore: page.hasMore }; };
    const out = { all: list({}), mine: list({ projectId: "p1" }), page: list({ limit: 2 }), next: list({ limit: 2, before: 30 }), exact: list({ limit: 4 }), nobody: list({ projectId: "nobody" }) };
    rmSync(globalDir, { recursive: true, force: true });
    return out;
  },

  /** n1210: a failed verification is diagnosed before anything is planned: one debugger per gap, each on its own, and the causes come back together as one list the repair plans start from. */
  async k_wv_diagnose() {
    const gaps = ["check p1 red: lint fails", "check p2 red: the total is wrong", "check p3 red: timeout"];
    const causes = gaps.map((gap, index) => ({ status: "confirmed", root_cause: `cause ${index + 1}`, confidence: 70 + index, fix_direction: `fix ${index + 1}`, affected_files: [`src/f${index + 1}.ts`] }));
    const many = await runSim("debug", { input: { mode: "from_failures", failures: gaps, session: "" }, stubs: { diagnose: causes } });
    const one = await runSim("debug", { input: { mode: "from_failures", symptom: ["check p1 red: lint fails"], session: "" }, stubs: { investigate: { status: "inconclusive", refuted: 0 } } });
    const list = (output(many).diagnoses ?? []) as Array<Row>;
    return { path: many.path, skipped: many.skipped, status: output(many).status, count: list.length, causes: list.map((row) => row.root_cause), gaps: list.map((row) => row.gap ?? null), single: one.path };
  },

  /** n1214: a debugging run keeps its session file, tests hypotheses, has a fresh agent re-check the cause and only then reports it confirmed; a weak cause is looked at once more and then reported inconclusive. */
  async k_c_debug() {
    const strong = { status: "confirmed", confidence: 82, pressure_pass: true, contradictions: 0, affected_files: ["src/import/csv.ts:48"], refuted: 1, root_cause: "the last empty line yields an undefined row", fix_direction: "skip empty trailing rows in parseCsv", mechanism: "split on undefined", session_entry: "- h2: trailing empty row — confirmed\n", evidence_entry: "{\"line\":\"csv:48\"}" };
    const symptom = "CSV import crashes with 'Cannot read properties of undefined (reading split)' on files with an empty last line";
    const w = await engineWorld();
    try {
      const sure = await w.run("debug.json", { symptom, session: "csv-crash" }, { investigate: strong, verify_cause: { confirmed: true } });
      const second = await w.run("debug.json", { symptom, session: "csv-full" }, { investigate: strong, verify_cause: { confirmed: true } }, {}, "full");
      const weak = await w.run("debug.json", { symptom, session: "csv-weak" }, { investigate: { ...strong, confidence: 30 }, verify_cause: { confirmed: true } }, {}, "full");
      const objection = await w.run("debug.json", { symptom, session: "csv-obj" }, { investigate: strong, verify_cause: [{ confirmed: false, objections: ["a cheaper explanation: the BOM"] }, { confirmed: true }] }, {}, "full");
      return { sure: { path: sure.path, status: sure.out.status, root: sure.out.root_cause, files: sure.out.affected_files, confidence: sure.out.confidence, session: (w.file(".agents/planning/debug/csv-crash.md") ?? "").split("\n").slice(0, 4) },
        second: { path: second.path, status: second.out.status }, weak: { path: weak.path, status: weak.out.status }, objection: { path: objection.path, status: objection.out.status } };
    } finally { w.dispose(); }
  },

  /** n1219: with a session named and no symptom the investigation resumes from the session file the earlier run left: nobody is asked the symptoms again and the file is not overwritten. */
  async k_wdb_continue() {
    const w = await engineWorld();
    try {
      const old = "# Debug session — flaky\n\nStatus: open\n\n## Symptom\n\nthe suite flakes on CI only\n\n## Hypotheses\n\n- h1: a race in setup — refuted\n";
      w.put(".agents/planning/debug/flaky.md", old);
      const strong = { status: "confirmed", confidence: 80, pressure_pass: true, contradictions: 0, affected_files: ["a.ts:1"], refuted: 1, session_entry: "- h2: resumed — confirmed\n", evidence_entry: "{\"line\":\"a:1\"}" };
      const resumed = await w.run("debug.json", { symptom: "", session: "flaky" }, { investigate: strong, verify_cause: { confirmed: true } });
      const after = w.file(".agents/planning/debug/flaky.md") ?? "";
      return { status0: resumed.status, reason: resumed.reason, path: resumed.path, skipped: resumed.skipped, asked: resumed.calls.filter((call) => call.node.startsWith("ask_")).length, status: resumed.out.status, kept: after.startsWith(old), appended: after === old + "- h2: resumed — confirmed\n" };
    } finally { w.dispose(); }
  },

  /** n1220: a new problem described in a few words is asked for what was expected, what happened, the error text, since when and how to reproduce; a description that already says enough, a list of failures or a resumed session is not asked. */
  async k_wdb_symptoms() {
    const w = await engineWorld();
    try {
      const strong = { status: "confirmed", confidence: 80, pressure_pass: true, contradictions: 0, affected_files: ["a.ts:1"], refuted: 1, session_entry: "- h1: entry\n", evidence_entry: "{}" };
      const agents = { investigate: strong, verify_cause: { confirmed: true } };
      const form = { answer: "expected: a total; got: NaN; error: none; since v2.3; steps: import a file with an empty row", answer_kind: "given" };
      const short = await w.run("debug.json", { symptom: "it crashes", session: "" }, agents, { ask_symptoms: form });
      const long = await w.run("debug.json", { symptom: "the import crashes on files with an empty last line, since v2.3, error: cannot read split", session: "" }, agents);
      const failures = await w.run("debug.json", { failures: ["check p1 red", "check p2 red"], mode: "from_failures", session: "" }, { ...agents, diagnose: { status: "confirmed", root_cause: "c", confidence: 80, fix_direction: "f" } });
      const asked = (await w.run("debug.json", { symptom: "x", session: "" }, agents, { ask_symptoms: form })).input("investigate");
      return { short: { path: short.path, status: short.out.status }, long: { path: long.path, skipped: long.skipped.includes("ask_symptoms") }, failures: failures.path, handed: asked.via?.fromStep ?? null };
    } finally { w.dispose(); }
  },

  /** n1221: a new session is a file under .agents/planning/debug named by a safe slug, started with the symptom and the status open; a slug cannot name a place outside that folder. */
  async k_wdb_setup() {
    const w = await engineWorld();
    try {
      const symptom = "the import crashes on files with an empty last line, since v2.3";
      const strong = { status: "confirmed", confidence: 80, pressure_pass: true, contradictions: 0, affected_files: ["a.ts:1"], refuted: 1, session_entry: "- h1: fresh entry\n", evidence_entry: "{\"line\":\"a:1\"}" };
      const fresh = await w.run("debug.json", { symptom, session: "csv crash!" }, { investigate: strong, verify_cause: { confirmed: true } });
      const hostile = await w.run("debug.json", { symptom, session: "../../etc/passwd" }, { investigate: strong, verify_cause: { confirmed: true } });
      return { path: fresh.path, file: w.file(".agents/planning/debug/csv-crash.md"), hostile: { path: hostile.path, escaped: w.file("../etc/passwd") !== null, kept: w.file(".agents/planning/debug/etc-passwd.md") !== null },
        none: (await w.run("debug.json", { symptom, session: "" }, { investigate: strong, verify_cause: { confirmed: true } })).path };
    } finally { w.dispose(); }
  },

  /** n1222: the investigation runs in sessions of its own (each failure's debugger, the re-check) and the calling chat receives only the summary the run reports — status, cause, confidence, files, direction, tests, risks, evidence path — never the working. */
  async k_wdb_manager() {
    const w = await engineWorld();
    try {
      const strong = { status: "confirmed", confidence: 82, pressure_pass: true, contradictions: 0, affected_files: ["a.ts:1"], refuted: 1, root_cause: "rc", fix_direction: "fd", mechanism: "mech", evidence_path: "ev.ndjson", regression_tests: ["t"], risks: ["r"], hypotheses_log: "twenty pages of working", session_entry: "- h1: entry\n", evidence_entry: "{}" };
      const one = await w.run("debug.json", { symptom: "the import crashes on files with an empty last line, since v2.3", session: "" }, { investigate: strong, verify_cause: { confirmed: true } });
      const many = await w.run("debug.json", { mode: "from_failures", failures: ["gap one", "gap two"], session: "" }, { diagnose: { status: "confirmed", root_cause: "c", confidence: 80, fix_direction: "f" } });
      return { keys: Object.keys(one.out).sort(), out: one.out, sessions: one.calls.map((call) => [call.node, call.session ?? null]), fanout: many.calls.map((call) => [call.node, call.session ?? null]), manyKeys: Object.keys(many.out).sort() };
    } finally { w.dispose(); }
  },

  /** n1211: the findings of a review go to the planner in its gap mode (the findings as the gaps, the goal unchanged), and what it plans goes on to the build; a second review's findings go the same way. */
  async k_wv_gapplan() {
    const findings = [{ file: "src/a.ts", line: 12, severity: "high", evidence: "return value of save() ignored" }];
    const again = [{ file: "src/b.ts", line: 3, severity: "medium", evidence: "empty catch" }];
    const stubs = { "lp.plan": { status: "ok", task_count: 1, tasks: [{ id: "f1", objective: "f1", depends_on: [] }] }, "lp.build": { status: "done", merged_commits: ["f1"] }, "lp.review": [{ status: "rework", remaining_actionable: 1, findings: again }, { status: "pass", remaining_actionable: 0 }] };
    const r = await runSim("review-fix", { input: { goal: "Fix review findings", findings }, stubs });
    const inputs = stepInputs(r.db, r.summary.runId);
    return { path: r.path, plan: inputs.plan_fix?.with ?? null, build: inputs.build_fix?.with ?? null, plan2: inputs.plan_fix2?.with ?? null, status: output(r).status };
  },

  /** n1212: a plan of three or more tasks is checked as a whole by a second agent in the role of the plan critic — never the planner itself — before it goes on; a small plan in the standard mode is not, a pass carries its verdict out. */
  async k_wv_gapcheck() {
    const plan = (count: number) => ({ status: "ok", task_count: count, tasks: Array.from({ length: count }, (_, i) => ({ id: `t${i + 1}`, objective: "o", depends_on: [] })), waves: [["t1"]], objective: "o" });
    const lint = { ok: true, errors: [], waves: [["t1"]] };
    const big = await runSim("lp.plan", { input: { goal: "g", mode: "gaps", gaps: ["a gap"] }, stubs: { plan: plan(3), lint, plan_critic: { status: "pass", summary: "fine", findings: [] } } });
    const small = await runSim("lp.plan", { input: { goal: "g", mode: "gaps", gaps: ["a gap"] }, stubs: { plan: plan(2), lint } });
    const quick = await runSim("lp.plan", { input: { goal: "g" }, mode: "quick", stubs: { plan: plan(4), lint } });
    const live = (r: Awaited<ReturnType<typeof runSim>>) => r.path.filter((id) => !r.skipped.includes(id));
    const nodes = big.workflow.nodes as unknown as Array<{ id: string; role?: string }>;
    const role = (id: string) => nodes.find((node) => node.id === id)?.role ?? null;
    return { big: { path: live(big), verdict: output(big).plan_verdict, status: output(big).status }, small: { path: live(small), verdict: output(small).plan_verdict ?? null }, quick: live(quick),
      roles: [role("plan"), role("plan_critic")] };
  },

  /** n1213: a critic's concerns send the plan back to the planner with the findings as its gaps, the checked plan is the revised one, and the loop has a limit: after three checks the plan goes on as low-confidence. */
  async k_wv_revision() {
    const plan = { status: "ok", task_count: 3, tasks: [{ id: "t1", objective: "o", depends_on: [] }, { id: "t2", objective: "o", depends_on: [] }, { id: "t3", objective: "o", depends_on: [] }], waves: [["t1", "t2", "t3"]], objective: "o" };
    const lint = { ok: true, errors: [], waves: [["t1", "t2", "t3"]] };
    const findings = [{ id: "c1", severity: "high", file: "PLAN", line: 1, evidence: "t2 depends on a task that does not exist" }];
    const fixed = await runSim("lp.plan", { input: { goal: "g" }, stubs: { plan, lint, plan_critic: [{ status: "rework", summary: "fix t2", findings }, { status: "pass", summary: "ok", findings: [] }] } });
    const endless = await runSim("lp.plan", { input: { goal: "g" }, stubs: { plan, lint, plan_critic: { status: "rework", summary: "still wrong", findings } } });
    const handed = fixed.called("plan").map((call) => call.input.gaps ?? null);
    return { fixed: { path: fixed.path.filter((id) => id === "plan" || id === "plan_critic" || id === "ok" || id === "low"), handed, verdict: output(fixed).plan_verdict, status: output(fixed).status },
      endless: { plans: endless.called("plan").length, critics: endless.called("plan_critic").length, status: output(endless).status } };
  },

  /** n1227: an idea is questioned against the real code before any plan, in branches whose number follows the depth; what the code settles is locked and what it cannot is left open, and nothing is changed; an unanchored question is asked once more. */
  async k_c_explore() {
    const walked = { branches_walked: 5, questions_without_anchor: 0, terminology: [{ term: "cache", meaning: "the API cache" }] };
    const open = await runSim("grill-plan", { input: { goal: "Add Redis cache", plan: "cache GET by URL for 60s" }, stubs: { walk: walked, synth: { locked: ["GET only"], open: ["invalidation on write"], deferred: [], risk_register: [{ risk: "stale reads", severity: "high" }] } } });
    const done = await runSim("grill-plan", { input: { goal: "Add Redis cache" }, stubs: { walk: walked, synth: { locked: ["GET only"], open: [], deferred: ["metrics"], risk_register: [] } } });
    const again = await runSim("grill-plan", { input: { goal: "Add Redis cache" }, stubs: { walk: [{ ...walked, questions_without_anchor: 2 }, walked], synth: { locked: ["x"], open: [], deferred: [], risk_register: [] } } });
    return { open: { path: open.path, out: output(open) }, done: { path: done.path, status: output(done).status, deferred: output(done).deferred }, again: { path: again.path, walks: again.called("walk").length } };
  },

  /** n1228: a spike answers its question in a box of time: an answered experiment whose result passes the check is reported answered with its decision and file; an experiment that did not answer, or a result that fails the check, is reported inconclusive and keeps no skill draft. */
  async k_c_spike() {
    const answered = { answered: true, decision: "yes, fts5 handles 1M rows", document: "# spike\n", skill_draft: "draft.md" };
    const opened = { spike_path: "spikes/fts.md" };
    const ok = await runSim("spike", { input: { question: "can sqlite fts handle 1M rows" }, stubs: { spike_new: opened, experiment: answered, write_spike: { spike_path: "spikes/fts.md" }, goal_check: { ok: true, verdict: "pass" } } });
    const failed = await runSim("spike", { input: { question: "can sqlite fts handle 1M rows" }, stubs: { spike_new: opened, experiment: answered, write_spike: { spike_path: "spikes/fts.md" }, goal_check: { ok: false, verdict: "fail", reason: "no spike file" } } });
    const none = await runSim("spike", { input: { question: "can sqlite fts handle 1M rows" }, stubs: { spike_new: opened, experiment: { answered: false, decision: "unclear", document: "# spike\n", skill_draft: "draft.md" }, write_spike: { spike_path: "spikes/fts.md" } } });
    return { ok: { path: ok.path, out: output(ok) }, failed: { path: failed.path, status: output(failed).status, draft: output(failed).skill_draft }, none: { path: none.path, status: output(none).status, draft: output(none).skill_draft } };
  },

  /** n1233: a trivial task runs inline — one self-check, one task, no plan and no review; a task that is not concrete, bounded and single is sent to the full chain instead and writes nothing; a task the writer could not land is reported blocked. */
  async k_c_fastc() {
    const fine = { passes: true, concrete: true, bounded: true, single_concern: true, reason: "one named file" };
    const done = await runSim("companion", { input: { goal: "Add the dist folder to .gitignore", scope: ".gitignore" }, stubs: { self_check: fine, task: { state: "accepted", merge_commit: "c0ffee1", files: [".gitignore"] } } });
    const big = await runSim("companion", { input: { goal: "Rework the payments module" }, stubs: { self_check: { ...fine, passes: false, bounded: false, reason: "spans three modules" }, "lp.propose_workflow": { ok: true } } });
    const failed = await runSim("companion", { input: { goal: "Add the dist folder to .gitignore" }, stubs: { self_check: fine, task: { state: "failed", merge_commit: "", files: [] } } });
    return { done: { path: done.path, out: output(done) }, big: { path: big.path, out: output(big), wrote: big.called("task").length }, failed: { path: failed.path, status: output(failed).status } };
  },

  /** n1223: one docs unit of the night is written by the docs agent and checked against the code before it is committed: an unchecked or skipped result is never committed, nothing to do ends before the agent; the commit step receives the checked result. */
  async k_c_docsupdate() {
    const input = { project_id: "proj_1", host_id: "host_1", path: "/tmp/docs", unit: { docsDir: "docs" } };
    const stubs = { prepare: { state: "ready", plan: {} }, write: { state: "written", thread_id: "thr_docs" }, verify: { state: "ok", checked: { pages: 3 } }, commit: { row: { state: "passed", pages: 3 } } };
    const whole = await runSim("lp.docs-night", { input, stubs });
    const unverified = await runSim("lp.docs-night", { input, stubs: { ...stubs, verify: { state: "skipped", row: { state: "skipped", why: "the check could not run" } } } });
    const idle = await runSim("lp.docs-night", { input, stubs: { ...stubs, prepare: { state: "skipped", row: { state: "skipped", why: "no code changed" } } } });
    const live = (r: Awaited<ReturnType<typeof runSim>>) => r.path.filter((id) => !r.skipped.includes(id));
    return { whole: { path: live(whole), row: output(whole).row, commitGot: stepInputs(whole.db, whole.summary.runId).commit?.via?.fromStep ?? null }, unverified: { path: live(unverified), row: output(unverified).row }, idle: { path: live(idle), wrote: idle.called("write").length } };
  },

  /** n1232: a small issue goes the short way — class, one task from the planner, the writer, a row in STATE, closed — and a plan of several tasks or a high risk is proposed to the full chain instead and writes nothing; a writer that fails ends it partial. */
  async k_c_quick() {
    const task = { id: "q1", acceptance: ["npx vitest run tests/button.test.ts"] };
    const plan = (over: Row = {}) => ({ status: "ok", clear: true, task_count: 1, risk: "low", already_met: false, objective: "Fix the Send button label", tasks: [task], task, waves: [["q1"]], ...over });
    const input = { title: "Typo in button label", text: "The Send button says 'Sned' in app.tsx." };
    const live = (r: Awaited<ReturnType<typeof runSim>>) => r.path.filter((id) => !r.skipped.includes(id));
    const short = await runSim("issue-quick", { input, stubs: { plan: plan(), write: { state: "accepted", merged_commits: ["q1"] }, state: { ok: true, note: "", comment: "quick path: built and verified" } } });
    const several = await runSim("issue-quick", { input, stubs: { plan: plan({ task_count: 2 }), write: { state: "accepted", merged_commits: ["q1"] } } });
    const risky = await runSim("issue-quick", { input, stubs: { plan: plan({ risk: "high" }), write: { state: "accepted", merged_commits: ["q1"] } } });
    const failed = await runSim("issue-quick", { input, stubs: { plan: plan(), write: { state: "failed", merged_commits: [] } } });
    const text = "---\nphase: \"a\"\n---\n# State\n";
    const first = quickStateEdit({ exitCode: 0, stdout: text }, { date: "2026-11-10", task: "Typo in button label", commit: "q1" });
    const second = quickStateEdit({ exitCode: 0, stdout: first!.content }, { date: "2026-11-10", task: "second", commit: "q2" });
    return { short: { path: live(short), out: output(short), stateGot: stepInputs(short.db, short.summary.runId).state?.with.title ?? null }, several: { path: live(several), status: output(several).status, wrote: several.called("write").length }, risky: { path: live(risky), status: output(risky).status, wrote: risky.called("write").length },
      failed: { path: live(failed), status: output(failed).status }, row: first!.content.split("\n").filter((line) => line.startsWith("|")), rows2: second!.content.split("\n").filter((line) => line.startsWith("|")).length, none: quickStateEdit({ exitCode: 1, stdout: "" }, { date: "d", task: "t", commit: "c" }) };
  },

  /** n1234: a request in free words is only routed — to a workflow with its evidence, or to up to three questions when it is vague, or told that «continue» is not a workflow; the answer is a decision and the work itself is never started. */
  async k_c_do() {
    setRouterModel(null);
    const catalog = publishedCatalog();
    const route = async (intent: string, extra: Record<string, unknown> = {}) => { const r = await routeIntent({ intent, workflows: catalog, ...extra } as never); return { decision: r.decision, workflowId: r.workflowId, questions: r.questions.length, rule: r.evidence.rules[0]?.id ?? null }; };
    return { full: await route("Resolve LP-12 properly, with a thorough review"), quick: await route("Закрой LP-12, просто опечатка"), debug: await route("The checkout page crashes with an error after v2.3 and nobody knows why"), vague: await route("Help me with the project"), cont: await route("Давай продолжим"), short: await route("Do it", { context: "We agreed to deploy the new version to production today" }) };
  },

  /** n1217: undo is a git revert of the task's merge in a scratch worktree, merged like every writer merge — history grows, nothing is reset; a second undo is refused; a revert that collides with later work is refused naming the later task and main is left alone. */
  async k_c_undo() {
    const root = mkdtempSync(join(tmpdir(), "lp-r16c-undo-"));
    const base = join(root, "project");
    const HOST = "host-1";
    git(root, "init", "-q", "-b", "main", base);
    writeFileSync(join(base, "server.ts"), "line1\nline2\nline3\n"); writeFileSync(join(base, "keep.txt"), "keep\n");
    git(base, "add", "-A"); git(base, "commit", "-qm", "base");
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA", "bb", base, "none", undefined, HOST);
    let interleaveReceiptFor: string | null = null;
    let interleavedMergeInfo = 0;
    const host = { call: async (method: string, input: Record<string, any>) => {
      switch (method) {
        case "gitCreateWorktree": return { hostId: HOST, ...await createWorktree({ basePath: input.basePath, name: input.name, commit: input.commit, targetPath: join(root, "wt", input.name, "project") }) };
        case "gitPrepareWorktree": return { hostId: HOST, linked: [] };
        case "gitRemoveWorktree": return { hostId: HOST, ...await removeLaneWorktree({ basePath: input.basePath, worktreePath: input.worktreePath, ...(input.release ? { releaseDir: join(root, "released") } : {}) }) };
        case "gitMergeInfo": {
          const found = await mergeInfo({ basePath: input.basePath, commit: input.commit, attemptId: input.attemptId });
          if (interleaveReceiptFor === input.attemptId && found.status === "found" && found.commit) {
            interleavedMergeInfo += 1;
            appendTaskReceipt(db, { kind: "revert", projectId: "projA", runId: "run1", taskId: "t4", state: "merged", summary: "receipt inserted while change provenance was loading", attemptId: "att_t4", baseSha: found.base ?? null, changeSha: found.commit, resultCommit: "f".repeat(40), detail: {} });
            interleaveReceiptFor = null;
          }
          return { hostId: HOST, ...found };
        }
        case "gitRevertCommits": return { hostId: HOST, ...await revertCommitsInWorktree({ worktreePath: input.worktreePath, commits: input.commits }) };
        case "gitWorktreeState": return { hostId: HOST, ...await worktreeState({ basePath: input.basePath, worktreePath: input.worktreePath }) };
        case "gitOwnershipBase": return { hostId: HOST, ...await resolveGitOwnershipBase({ projectCwd: input.projectCwd }) };
        case "gitIntegrate": return { hostId: HOST, ...await integrateWorktree({ basePath: input.basePath, worktreePath: input.worktreePath, message: input.message,
          removeWorktree: input.removeWorktree, expectedHead: input.expectedHead, baseInHead: input.baseInHead, committedOnly: input.committedOnly,
          bookkeeping: input.bookkeeping, ownsPaths: input.ownsPaths, lockWaitMs: input.indexLockWaitMs }) };
        case "runCommand": {
          const timeout = Math.max(1_000, Math.min(45_000, Number(input.timeoutSec ?? 30) * 1_000));
          const ran = spawnSync("bash", ["-lc", input.command], { cwd: input.cwd, encoding: "utf8", timeout });
          return { hostId: HOST, exitCode: ran.status ?? 124, stdout: ran.stdout ?? "", stderr: ran.stderr ?? (ran.error ? String(ran.error) : "") };
        }
        case "gateRun": return { hostId: HOST, ...await runGateOnHost({ basePath: input.basePath, command: input.command, timeoutSec: input.timeoutSec }) };
        default: throw new Error(`unexpected host call ${method}`);
      }
    } };
    const ctx = { bb, db, host, log: () => undefined, isDisposed: () => false, configForRun: async (projectId: string) => ({ projectId, hostId: HOST, writerWorkspacePath: base }) };
    const services = { resolveIntegrationGate: gateResolverFor(ctx as never), runVerification: async (_config: unknown, task: { verification: Array<{ command: string; cwd: string }> }) => task.verification.map((check) => {
      const ran = spawnSync("bash", ["-lc", check.command], { cwd: check.cwd, encoding: "utf8" });
      return { command: check.command, exitCode: ran.status ?? 1, stdout: ran.stdout ?? "", stderr: ran.stderr ?? "" };
    }) };
    const { rollback } = createRollback(ctx as never, services as never);
    const accepted = async (id: string, edit: (dir: string) => void, record = true) => {
      createTask(db, { id, runId: "run1", kind: "bb", contract: { schema_version: 2, id, title: `title of ${id}`, risk: "low", lane: "server", project_cwd: base, read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["x"], owns_paths: ["**"], never_touch: [], depends_on: [], objective: id, acceptance: ["done"], verify: "tests", verification: [{ command: "test -f keep.txt", cwd: base }] } as never });
      const attemptId = `att_${id}`;
      createAttempt(db, { id: attemptId, runId: "run1", taskId: id });
      const made = await createWorktree({ basePath: base, name: attemptId, targetPath: join(root, "wt", attemptId, "project") });
      rollback.noteBase(attemptId, made.baseSha);
      edit(made.path!);
      const merged = await integrateWorktree({ basePath: base, worktreePath: made.path!, message: `${id}: title of ${id}\n\nLane-Pilot-Attempt: ${attemptId}`, removeWorktree: true });
      if (record) rollback.noteMerge(attemptId, merged);
      db.prepare("UPDATE lane_pilot_attempt SET state='accepted', updated_at=? WHERE id=?").run(Date.now(), attemptId);
      return merged.commit!;
    };
    const exists = (path: string) => { try { readFileSync(join(base, path)); return true; } catch { return false; } };
    const slim = (r: Awaited<ReturnType<typeof rollback.revert>>) => ({ ok: r.ok, state: r.state, summary: String(r.summary).replace(/[0-9a-f]{12}/g, "<sha>"), next: r.next ?? null, conflicts: (r.conflicts as string[] | undefined) ?? null });
    try {
      const t1 = await accepted("t1", (dir) => writeFileSync(join(dir, "lib.ts"), "x\n"));
      const reverted = await rollback.revert("t1");
      const out1 = { result: slim(reverted), libGone: !exists("lib.ts"), clean: git(base, "status", "--porcelain").trim() === "", subject: git(base, "log", "-1", "--format=%s").trim(), keepsMerge: git(base, "merge-base", "--is-ancestor", t1, "HEAD") === "", worktrees: git(base, "worktree", "list").trim().split("\n").length };
      const again = slim(await rollback.revert("t1"));
      const a = await accepted("t2", (dir) => writeFileSync(join(dir, "server.ts"), "line1 from t2\nline2\nline3\n"));
      void a;
      await accepted("t3", (dir) => writeFileSync(join(dir, "server.ts"), "line1 from t3\nline2\nline3\n"));
      const head = git(base, "rev-parse", "HEAD").trim();
      const collide = slim(await rollback.revert("t2"));
      const out2 = { collide, mainKept: git(base, "rev-parse", "HEAD").trim() === head, text: readFileSync(join(base, "server.ts"), "utf8"), worktrees: git(base, "worktree", "list").trim().split("\n").length };
      const order = [slim(await rollback.revert("t3")).state, slim(await rollback.revert("t2")).state];
      await accepted("t4", (dir) => writeFileSync(join(dir, "interleaved.ts"), "x\n"), false);
      interleaveReceiptFor = "att_t4";
      const interleaved = slim(await rollback.revert("t4"));
      return { first: out1, again, collide: out2, order, interleaved, interleavedMergeInfo, back: readFileSync(join(base, "server.ts"), "utf8"), noTask: slim(await rollback.revert("nope")) };
    } finally { await harness.lifecycle.dispose(); rmSync(root, { recursive: true, force: true }); }
  },

  /** n1225: the report of the work done and spent: the daily report names the attempts of the day by outcome, keeps the sandbox and the old versions apart, and states the window and where to look further — read from the hub's own tables. */
  async k_c_sessreport() {
    const dir = mkdtempSync(join(tmpdir(), "lp-r16c-daily-"));
    const data = new Database(join(dir, "data.db"));
    data.exec(`create table lane_pilot_run(id text primary key, project_id text not null);
      create table lane_pilot_attempt(id text primary key, run_id text not null, task_id text not null, state text not null, reason text, failure_code text, created_at integer not null, updated_at integer, harness_version text, thread_id text);
      create table lane_pilot_token_cursor(thread_id text primary key, provider_id text not null default '', last_provider text not null default '', total_json text not null default '{}');
      create table lane_pilot_failure_triage(project_id text, attempt_id text, reason text, origin text, failed_at integer);
      create table lane_pilot_project_settings(project_id text, key text, value text);`);
    const now = Date.now();
    data.exec("insert into lane_pilot_run values ('r1', 'proj_real'), ('r2', 'proj_sbx')");
    const insert = data.prepare("insert into lane_pilot_attempt(id, run_id, task_id, state, reason, created_at, updated_at, harness_version) values (?, ?, ?, ?, ?, ?, ?, '0.1.559')");
    insert.run("a1", "r1", "t1", "accepted", null, now - 3_600_000, now - 3_000_000);
    insert.run("a2", "r1", "t2", "blocked", "internal_error: x | y", now - 3_600_000, now - 3_000_000);
    insert.run("a3", "r2", "drill-1", "accepted", null, now - 3_600_000, now - 3_000_000);
    insert.run("a4", "r1", "old", "accepted", null, now - 40 * 86_400_000, now - 40 * 86_400_000);
    const coreSnapshot = async () => ({ snapshot: { projects: [{ id: "proj_real", name: "SelfyStudio" }, { id: "proj_sbx", name: "LP sandbox 1" }], threads: [], threadPluginMetadata: [] }, degraded: [] as string[] });
    const text = await buildDailyReport({ db: data as never, dataFile: join(dir, "data.db"), coreSnapshot, run: runSqliteChild, now: () => now });
    data.close(); rmSync(dir, { recursive: true, force: true });
    const grab = (re: RegExp) => re.exec(text)?.[1] ?? null;
    return { head: text.split("\n")[0]!.slice(0, 33), done: grab(/Живые проекты, по задачам: ([^.]*\(\d+\.\d%\))/), lpErrors: grab(/Ошибка LP: (\d+)/), outside: grab(/Вне счёта: ([^.]*)\./), sandbox: grab(/Песочницы и учения отдельно: (\d+ попыток, принято [\d.]+%)/), old: grab(/Старые версии \(до [\d.]+\), для сравнения: (\d+ попыток, принято [\d.]+%)/),
      usage: grab(/Токены писателей за 7 дней \(измерено\/попыток\): ([^;]*);/), where: text.includes("(bb lane-pilot metrics)"), oldAttemptCounted: /3 задач/.test(text) };
  },

  /** n1236: the PM at the console is told the one step the phase needs now — once per step, not on every pass — and a new step as soon as the phase moves; a busy PM is not queued a step. */
  async k_c_manager() {
    const run = async (pmStatus: string) => {
      const w = phaseWorldC(pmStatus);
      const id = await openedC(w, {}, "planning");
      await w.phases.tick();
      const first = w.messages.length;
      await w.phases.tick();
      const second = w.messages.length;
      savePhase(w.db, id, { stage: "acceptance", at: Date.now() });
      await w.phases.tick();
      return { first, second, third: w.messages.length, texts: w.messages.map((text) => text.replace(/ph_[0-9a-f]+/g, "<id>").slice(0, 90)) };
    };
    return { idle: await run("idle"), busy: await run("running") };
  },
};
