// Model-free traces for n1059, n1060, n1077, n132 and n1621. The scene judges this JSON; this file only observes real code.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { searchMemoryRecords, storeMemoryRecords } from "@lane-pilot/memory-core";
import { WorkflowEngine, parseWorkflow, registerPureActions, registerReducers } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDecisions } from "../../../src/rooms/learning/decide";
import { getItem, insertItem, type Item } from "../../../src/rooms/learning/store";
import { enrichMemoryContext } from "../../../src/rooms/memory-tiers/server";
import { createMemoryStage } from "../../../src/rooms/memory/server/memory";
import { createCore } from "../../../src/rooms/core/server/core";
import { createRun, createTask, listStageReceipts, openDatabase, savePrototypeConfig, saveProjectSetting, setRunThread } from "../../../src/rooms/plugin-db";
import { recordStage } from "../../../src/rooms/runs/server/stage-records";
import { insertPhase, resolvePhaseRef, savePhase } from "../../../src/rooms/phase/store";
import { openTaskHome, resolveTaskFile } from "../../../src/rooms/storage";
import { chainRuntimeFor, registerChainExecutors } from "../../../src/rooms/workflow/server/workflow-executors";
import { createWorkflowAgents } from "../../../src/rooms/workflow/server/workflow-agent";
import { registerDispatchExecutors, taskUsage } from "../../../src/rooms/writer/server";
import type { ChainRuntime } from "../../../src/rooms/contracts/server";
import type { PrototypeConfig, TaskV2 } from "../../../src/rooms/contracts";
import type { Services } from "../../../server";

const PROJECT = "tail-project";
const WORKSPACE = "/tmp/lane-pilot-tail-traces";
const memoryDb = () => openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
const waiting = (id: string, projectId: string, over: Partial<Item> = {}): Item => ({ id, obsId: `thr_tail:${id}:0`, projectId, threadId: "thr_tail", kind: "preference", text: "Always answer in Russian", audience: "both", reach: "owner", dueAt: null, state: "pending_owner", target: "bb-memory", evidence: `owner message thr_tail:${id}:0`, duplicateOf: null, confirmations: 0, note: null, createdAt: 1, decidedAt: null, announcedAt: null, ...over });

async function observeLearningDecision() {
  const db = memoryDb(), mem = memoryDb();
  insertItem(db as never, waiting("pref", "P"));
  insertItem(db as never, waiting("replace", "P", { kind: "rule", reach: "project", target: "replace", text: "Run the migration before the seed" }));
  const proposals: string[] = [];
  const decisions = createDecisions({ db: db as never, now: () => 42,
    rules: { list: () => [], propose: (_project, input) => { proposals.push(input.rule); return { id: "rp-tail", created: true, repeatOf: null }; }, adopt: () => true, confirm: () => undefined, retire: () => undefined, reject: () => undefined },
    notes: { remember: (projectId, text) => storeMemoryRecords(mem, { projectId, sourceSha256: "a".repeat(64), audience: "subagent", trust: "confirmed", entries: [{ kind: "note", content: text, concepts: ["owner-said"] }], nearDuplicates: false, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 }).insertedIds[0]!, forget: () => undefined },
    remind: async () => "r-tail", runBb: async () => { throw new Error("bb memory is off"); } });
  const first = await decisions.accept("pref"), second = await decisions.accept("replace");
  return { accepted: { state: first.item.state, targetPrefix: String(first.item.target).split(":")[0], memoryRows: searchMemoryRecords(mem, "P", "always answer in russian", 5, "auto").map((row) => row.id) }, replaced: { state: second.item.state, target: second.item.target, proposals }, storedItem: getItem(db as never, "pref")?.target };
}

async function observeMemoryMaintenance() {
  const host = createFakePluginHost({ pluginId: "lane-pilot" });
  const childOutput = JSON.stringify([{ kind: "core", content: "Durable deployment convention uses managed workspaces", concepts: ["deployment", "workspace"] }, { kind: "note", content: "A claim about v9.9.9 the accepted result never made", concepts: ["version"] }]);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threadId === "tail-pm" ? { role: "pm", lanePilotRunId: "tail-run" } : { role: "memory-maintainer" });
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "tail-memory-child" }));
  host.harness.sdk.stub("providers.list", async () => [{ id: "critic", models: [{ id: "tail-model" }] }]);
  host.harness.sdk.stub("providers.models", async () => ({ models: [{ id: "tail-model" }] }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle" }));
  host.harness.sdk.stub("threads.events.list", async () => [{ type: "turn/started", seq: 1 }, { type: "turn/completed", seq: 2, data: { status: "completed" } }]);
  host.harness.sdk.stub("threads.output", async () => ({ output: childOutput }));
  const db = openDatabase(host.bb), config: PrototypeConfig = { projectId: PROJECT, hostId: "tail-host", pmWorkspacePath: WORKSPACE, writerWorkspacePath: WORKSPACE, pmProviderId: "codex", pmModel: "tail-pm", writerProviderId: "critic", writerModel: "tail-model" };
  savePrototypeConfig(db, config); createRun(db, "tail-run", PROJECT, "bb", WORKSPACE); setRunThread(db, "tail-run", "tail-pm");
  const task: TaskV2 = { schema_version: 2, id: "tail-task", title: "Tail memory task", risk: "low", lane: "writer", project_cwd: WORKSPACE, read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [], depends_on: [], objective: "Write note.txt", acceptance: ["note exists"], verify: "tests", verification: [{ command: "test -f note.txt", cwd: WORKSPACE }] };
  createTask(db, { id: task.id, runId: "tail-run", kind: "bb", contract: task });
  recordStage(db, { runId: "tail-run", taskId: task.id, stageId: "acceptance-receipt", state: "passed", input: "accepted", result: { status: "accepted", produced: ["note.txt"] } });
  for (const [key, value] of Object.entries({ "memory.enabled": true, "memory.maintain": true, "memory.inject": true, "memory.maintain_every": 1, "memory.audience": "subagent", "memory.provider": "critic", "memory.model": "tail-model", "memory.reasoning_effort": "high" })) saveProjectSetting(db, PROJECT, key, value);
  const ctx = createCore(host.bb, db), services = { stageHelperSettings: async () => ({ "memory.enabled": true, "memory.maintain": true, "memory.inject": true, "memory.maintain_every": 1, "memory.audience": "subagent", "memory.provider": "critic", "memory.model": "tail-model", "memory.reasoning_effort": "high" }), memoryConflicts: { detect: () => undefined, sweepMoot: () => undefined }, reconcileStageChild: async () => ({ kind: "not_found" as const }) };
  const result = await createMemoryStage(ctx, services as never).runMemoryMaintenance({ threadId: "tail-pm", projectId: PROJECT, runId: "tail-run", taskId: task.id, timeoutSec: 5 });
  const receipt = listStageReceipts(db, "tail-run", task.id).find((row) => row.stageId === "memory-maintenance"), body = (receipt?.result ?? result) as { stored?: number; recordIds?: string[]; unsupportedDropped?: number; sourceSha256?: string };
  const row = body.recordIds?.[0] ? db.prepare("SELECT id, kind, status, origin_task_id AS task FROM lane_pilot_memory WHERE id=?").get(body.recordIds[0]) : null;
  await host.harness.lifecycle.dispose();
  return { state: receipt?.state ?? result.state, reason: receipt?.reason ?? result.reason, stored: body.stored, unsupportedDropped: body.unsupportedDropped, recordIds: body.recordIds, row, sourceSha256: body.sourceSha256, fts: body.recordIds?.map((id) => (db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_memory_fts WHERE id=?").get(id) as { n: number }).n) };
}

function observeMemoryMiss() {
  const db = memoryDb(); createRun(db, "miss-run", "P", "cli", WORKSPACE); createTask(db, { id: "miss-task", runId: "miss-run", kind: "bb", contract: { title: "Share button on greeting cards", objective: "Add share for cards" } });
  const empty = enrichMemoryContext(db, { projectId: "P", query: "kubernetes ingress certificates", activeCount: 0, now: 1_000 }), active = enrichMemoryContext(db, { projectId: "P", query: "ledger rounding", activeCount: 2, now: 2_000 });
  const rows = db.prepare("SELECT project_id AS projectId, query, at, kind FROM lane_pilot_memory_miss ORDER BY at").all();
  return { empty: { miss: empty.miss, rows }, active: active.miss, rowCount: rows.length, onlyEmpty: rows.every((row: any) => row.kind === "empty") };
}

function observeAmbiguity() {
  const phaseDb = memoryDb(); insertPhase(phaseDb, { id: "ph_a", projectId: "P", pmThreadId: "pm", title: "A", goal: "a", at: 1 }); insertPhase(phaseDb, { id: "ph_b", projectId: "P", pmThreadId: "pm", title: "B", goal: "b", at: 1 }); savePhase(phaseDb, "ph_a", { record: { roadmapRow: "3" }, at: 2 }); savePhase(phaseDb, "ph_b", { record: { roadmapRow: "3" }, at: 3 });
  let phaseError = ""; try { resolvePhaseRef(phaseDb, "P", "3"); } catch (cause) { phaseError = cause instanceof Error ? cause.message : String(cause); }
  const taskDb = memoryDb(); createRun(taskDb, "task-run", "P", "bb", WORKSPACE); createTask(taskDb, { id: "task-amb", runId: "task-run", kind: "bb", contract: {} }); openTaskHome(taskDb, { taskId: "task-amb", projectId: "P", runId: "task-run", basePath: WORKSPACE, hostId: "tail-host" });
  taskDb.prepare("INSERT INTO lane_pilot_task_file(task_id,path,kind,sha256,bytes,producer_json,plugin_version,created_at) VALUES('task-amb','PLAN.md','plan','x',1,'{}','0',1)").run();
  taskDb.prepare("INSERT INTO lane_pilot_task_file(task_id,path,kind,sha256,bytes,producer_json,plugin_version,created_at) VALUES('task-amb','PLAN-2.md','plan','y',1,'{}','0',2)").run();
  const resolved = resolveTaskFile(taskDb, "task-amb", "plan");
  return { phase: { ambiguous: /several live phases/.test(phaseError), error: phaseError }, task: { ambiguous: resolved === null, resolved: resolved?.path ?? null } };
}

type Row = Record<string, unknown>;
const workflow = (name: string) => parseWorkflow(JSON.parse(readFileSync(join(process.cwd(), "workflows", name), "utf8")));
const closeStub = (): Workflow => parseWorkflow({ schemaVersion: 1, id: "lp.close", name: "Close", description: { en: "c", ru: "ц" }, inputs: [{ name: "goals", type: "Goal[]" }, { name: "goal", type: "string" }, { name: "merged_commits", type: "string[]" }, { name: "insights", type: "Finding[]" }], outputs: [{ name: "status", type: "string", required: true }, { name: "staged", type: "int", required: true }, { name: "report_path", type: "string", required: true }], nodes: [{ id: "emit", type: "action", action: "emit", map: { status: "'closed'", staged: "0", report_path: "'r.md'" } }], edges: [{ from: "start", to: "emit" }] });

async function observeMilestoneClose() {
  const checkout = mkdtempSync(join(tmpdir(), "lp-tail-milestone-")), roadmap = join(checkout, ".agents/planning/ROADMAP.md"), requirements = join(checkout, ".agents/planning/REQUIREMENTS.md");
  mkdirSync(dirname(roadmap), { recursive: true }); writeFileSync(roadmap, "# Roadmap: v1\n- [x] 1 one\n"); writeFileSync(requirements, "- REQ-1 export\n");
  const files = new Map<string, string>([[roadmap, readFileSync(roadmap, "utf8")], [requirements, readFileSync(requirements, "utf8")]]), host = createFakePluginHost({ pluginId: "lane-pilot" });
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threadId === "tail-pm" ? { role: "pm", lanePilotRunId: "tail-run" } : { role: "agent" }); host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle" })); host.harness.sdk.stub("threads.events.list", async () => [{ type: "turn/started", seq: 1 }, { type: "turn/completed", seq: 2, data: { status: "completed" } }]);
  host.harness.sdk.stub("files.read", async ({ path }: { path: string }) => files.has(path) ? { content: files.get(path) } : null); host.harness.sdk.stub("files.write", async ({ path, content }: { path: string; content: string }) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); files.set(path, content); return { ok: true }; });
  const db = openDatabase(host.bb); createRun(db, "tail-run", "tail-project", "bb", checkout); setRunThread(db, "tail-run", "tail-pm"); saveProjectSetting(db, "tail-project", "milestone.archive", "on"); saveProjectSetting(db, "tail-project", "retro.living", "on"); saveProjectSetting(db, "tail-project", "milestone.summary", "off");
  const ctx = createCore(host.bb, db), services = { dispatchWriter: async () => ({ runId: "tail-run", taskId: "tail-task", state: "queued" }), stability: { loadParked: async () => [] }, taskUsage } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "tail", runtimeFor: chainRuntimeFor(ctx, services), resolveWorkflow: (id) => id === "lp.close" ? closeStub() : id === "milestone-summary" ? workflow("milestone-summary.json") : null }); registerPureActions(engine); registerReducers(engine); registerChainExecutors(engine, ctx, services, createWorkflowAgents()); registerDispatchExecutors(engine, ctx.bb);
  engine.register("agent", { reentrant: true, run: async ({ nodeId }: { nodeId: string }) => ({ output: nodeId === "retro" ? { handoff: "retro done", insights: [{ id: "INS-aaa11111", title: "one", lens: "technical" }], retro_path: "retro/r.md", metrics: {} } : { handoff: "summary done", summary_path: ".agents/planning/MILESTONE-SUMMARY.md", open_items: [] } }) } as never); engine.register("builtin:jev", { reentrant: true, run: async () => ({ output: { decision: "none", value: {}, unsure_findings: [], settled: 0, escalated: false, handoff: "jev" } }) } as never); engine.register("builtin:human", { reentrant: true, run: async () => ({ output: { answer: "close anyway", answer_kind: "close_anyway" } }) } as never);
  const rt: ChainRuntime = { ctx, services, pmThreadId: "tail-pm", projectId: "tail-project", runId: "tail-run" }, started = engine.start({ workflow: workflow("milestone-close.json"), inputs: { run_id: "tail-run", goal: "Stats export", goals: [] }, runtime: rt, link: { projectId: "tail-project", runId: "tail-run" } }), result = await started.done;
  const snap = engine.snapshot(result.runId), path = (snap?.steps ?? []).filter((step) => step.state === "succeeded").map((step) => step.node_id).filter((id) => !/:(fan|child)$/.test(id)), archiveStep = snap?.steps.find((step) => step.node_id === "archive" && step.state === "succeeded");
  await host.harness.lifecycle.dispose(); return { status: result.status, path, output: result.output, steps: (snap?.steps ?? []).map((step) => ({ node: step.node_id, state: step.state, receipt: step.receipt_json })), archiveStep: archiveStep ? JSON.parse(archiveStep.output_json ?? "{}") : null, roadmap: path.includes("snapshot") && files.has(join(checkout, ".agents/planning/milestones")) };
}

async function section<T>(run: () => T | Promise<T>): Promise<T | { error: string }> { try { return await run(); } catch (cause) { return { error: cause instanceof Error ? cause.message : String(cause) }; } }
async function main() { process.stdout.write(`${JSON.stringify({ n1059: await section(observeLearningDecision), n1060: await section(observeMemoryMaintenance), n1077: await section(observeMemoryMiss), n132: await section(observeAmbiguity), n1621: await section(observeMilestoneClose) })}\n`); }
void main();
