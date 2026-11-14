// Probe of scenes/sma_r01_b.py (region 1, batch b): runs the real gate and admission checks of THIS checkout on scratch values and a scratch database and
// prints what they returned as one JSON line. It judges nothing: the scene compares each value with the node card's expected result and prove()s it.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { writerFallbackChain } from "@lane-pilot/models";
import { taskV2Schema, type TaskV2 } from "../../../src/rooms/contracts";
import { classifyWriterOutput, shapeFlags } from "../../../src/rooms/tasks";
import { lintContract, lintReply } from "../../../src/rooms/tasks/server/contract-lint";
import { executionChecklist } from "../../../src/rooms/writer/server/execution-checklist";
import { writerMarkers } from "../../../src/rooms/tasks";
import { reopenWriterStages, recordStage } from "../../../src/rooms/runs/server/stage-records";
import { openDatabase } from "../../../src/rooms/plugin-db";
import { createAttempt, setAttemptHolderThread } from "../../../src/rooms/storage/attempts-store/lifecycle";
import { transitionAttempt } from "../../../src/rooms/storage/attempts-store/transition";
import { createRun } from "../../../src/rooms/storage/runs-store";
import { createTask, saveTaskPlan } from "../../../src/rooms/storage/tasks-store";
import { listStageReceipts } from "../../../src/rooms/storage/stages-store";
import { walkWriterChain, type WriterHoldDeps } from "../../../src/rooms/writer/server/writer-hold";
import { admitTask } from "../../../src/rooms/writer/server/start-admission";
import { forgeToolParameters, mountForge } from "../../../src/rooms/forge/server";
import { registeredTools } from "../../../src/rooms/platform/server/tool-result";
import { designGate, type PhaseRecord } from "../../../src/rooms/phase";
import { buildBubblewrapArgs } from "../../../src/rooms/verification/sandbox";

const root = "/tmp/sma-r01-b";
const base: TaskV2 = {
  schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:sma", id: "sma-task", title: "SMA", risk: "low", lane: "writer", project_cwd: root,
  read_first: ["src/a.ts"], interfaces: ["i"], invariants: ["inv"], out_of_scope: ["out"], expected_outputs: ["src/b.ts"],
  owns_paths: ["src/"], never_touch: [".git/**"], depends_on: [], objective: "change a", acceptance: ["done"],
  verify: "tests", verification: [{ command: "npx vitest run tests/a.test.ts", cwd: root }],
};
const lint = (task: Partial<TaskV2> = {}, input: Record<string, unknown> = {}) =>
  lintContract({ task: { ...base, ...task }, workspacePath: root, hostId: "h", sandboxUnsafe: [], openTasks: [], deadDependencies: [], kinds: new Map([[`${root}/src/a.ts`, "file"]]), ...input } as never);
const codes = (rows: Array<{ code: string }>) => rows.map((row) => row.code);
const scratch = () => {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "proj1", "bb", root);
  for (const id of ["T1", "T2"]) createTask(db, { id, runId: "run1", kind: "bb", contract: {} });
  return { bb, db, harness };
};

async function main() {
  const out: Record<string, unknown> = {};
  // n194: verify none with no checks is accepted from the files; verify tests with no checks is told so.
  const produced = { produced: ["src/b.ts"], contents: { "src/b.ts": "export const n = 1;\n" } };
  out.n194 = [classifyWriterOutput({ ...produced, task: { ...base, verify: "none", verification: [] } }), classifyWriterOutput({ ...produced, task: { ...base, verification: [] } })];
  // n196: the checklist row with every flag.
  out.n196 = executionChecklist({ markers: writerMarkers("work done\nAPPROACH: careful\n"), planFact: { check: { items: [{ item: "handles errors", evidence: null }, { item: "done", evidence: "src/a.ts:1-3" }] } },
    priorReasons: ["verification failed: boom", "verification failed: boom"], produced: ["src/a.ts", "out/x.ts"], ownsPaths: ["src/"], referenceTestEdits: ["tests/old.test.ts"] });
  // n198: a new top-level folder and a test that imports nothing.
  out.n198 = [shapeFlags({ changedPaths: ["newpkg/index.ts", "src/app/a.ts"], baseTopLevel: new Set(["src", "tests"]), newTests: [] }),
    shapeFlags({ changedPaths: ["tests/b.test.ts"], baseTopLevel: new Set(["src", "tests"]), newTests: [{ path: "tests/b.test.ts", imports: [] }] })];
  // n200 / n210: an output the task may not own is refused (class conflict for an unsafe path); an owned one is not.
  out.n200 = [codes(lint({ expected_outputs: ["other/out.ts"] }).errors), codes(lint().errors)];
  const unsafe = lint({ owns_paths: ["../outside"] });
  out.n210 = { codes: codes(unsafe.errors), classes: lintReply("run-1", unsafe.errors).blockingClasses };
  // n214: a drawing of another phase is refused; its own passes.
  out.n214 = [codes(lint({ drawing: ["design/x.png"] }, { confirmedDrawings: [{ paths: ["design/y.png"], sha256: "a" }] }).errors),
    codes(lint({ drawing: ["design/x.png"] }, { confirmedDrawings: [{ paths: ["design/x.png"], sha256: "a" }] }).errors)];
  // n215: a drawing reviewed by its own designer is not ready; by another role it is.
  const record: PhaseRecord = { design: { decision: "needed", why: "screens", drawing: { paths: ["d.png", ".agents/phases/ph/design/UI-SPEC.md"], sha256: "x", designer: "design-lead", feasible: true, reviewer: "design-lead" } } };
  const same = designGate(record);
  record.design!.drawing!.reviewer = "ui-review";
  out.n215 = [same.ok, same.ok ? [] : same.why, designGate(record).ok];
  // n218: the contract schema reads the full task and refuses one without its ownership lists.
  const { owns_paths: _o, ...noOwns } = base;
  out.n218 = [taskV2Schema.safeParse(base).success, taskV2Schema.safeParse(noOwns).success, taskV2Schema.safeParse({ ...base, owns_paths: [] }).success];
  // n219: the sandbox binds only the workspace and its temp writable.
  const args = buildBubblewrapArgs({ workspacePath: "/work/repo", cwd: "/work/repo", tempPath: "/tmp/lp-sma", guardPaths: ["/work/repo/.git"] });
  out.n219 = { writable: args.flatMap((arg, i) => (arg === "--bind" ? [args[i + 1]] : [])), readOnly: args.flatMap((arg, i) => (arg === "--ro-bind" ? [args[i + 1]] : [])) };
  // n205 / n206: the pool of writers and the route.
  const primary = { providerId: "p", model: "m1" };
  out.n205 = writerFallbackChain(primary, [{ providerId: "p", model: "m1", reasoningLevel: "high" }, { providerId: "q", model: "m2", reasoningLevel: "high" }, { providerId: "", model: "x", reasoningLevel: "high" }], { providerId: "q", model: "m2" });
  const NOW = 1_800_000_000_000;
  const deps = (rows: unknown[]) => ({ breaker: { snapshot: () => rows }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true }) as unknown as WriterHoldDeps;
  const chain = [{ providerId: "p", model: "m1" }, { providerId: "q", model: "m2" }, { providerId: "r", model: "m3" }];
  const free = await walkWriterChain(chain, { hostId: "h", settings: {} }, deps([]), NOW);
  const held = await walkWriterChain(chain, { hostId: "h", settings: {} }, deps([{ key: "p/m1", state: "open", openedAt: NOW, failures: 3 }]), NOW);
  out.n206 = { first: free.free?.index, afterHold: held.free?.index, wakeAt: held.wakeAt === null ? null : held.wakeAt - NOW };
  // n204: a parked task restarts at the writer stages, the receipts before the writer stay.
  {
    const { db, harness } = scratch();
    saveTaskPlan(db, "T1", "the plan");
    const stage = (stageId: string, ...states: string[]) => { for (const state of states) recordStage(db, { runId: "run1", taskId: "T1", stageId: stageId as never, state: state as never, input: "the plan", reason: state === "failed" ? "boom" : null }); };
    stage("pm-read", "running", "passed"); stage("writer-agent", "running", "failed"); stage("verification", "running", "blocked"); stage("acceptance-receipt", "skipped");
    reopenWriterStages(db, "run1", "T1", "restart");
    out.n204 = Object.fromEntries(listStageReceipts(db, "run1", "T1").map((row) => [row.stageId, row.state]));
    await harness.lifecycle.dispose();
  }
  // n209: the worker is written on the queued row once; a started row keeps none.
  {
    const { db, harness } = scratch();
    createAttempt(db, { id: "a1", runId: "run1", taskId: "T1" });
    const first = setAttemptHolderThread(db, "a1", "thr_holder"), second = setAttemptHolderThread(db, "a1", "thr_other");
    createAttempt(db, { id: "a2", runId: "run1", taskId: "T2" });
    transitionAttempt(db, "a2", "spawn_requested"); transitionAttempt(db, "a2", "running", { threadId: "thr_w" });
    const late = setAttemptHolderThread(db, "a2", "thr_late");
    const holder = (id: string) => (db.prepare("SELECT holder_thread_id AS h FROM lane_pilot_attempt WHERE id=?").get(id) as { h: string | null }).h;
    out.n209 = { first, second, late, a1: holder("a1"), a2: holder("a2") };
    await harness.lifecycle.dispose();
  }
  // n213: the forge sends the Creator as a task that owns only the one draft folder.
  {
    const { bb: fake, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(fake);
    createRun(db, "runA", "projA", "bb", "/ws", "none", undefined, "host-1");
    const sent: Array<{ task: Record<string, unknown> }> = [];
    const agents = { registerTool: () => undefined };
    const bb = { agents, storage: { kv: { get: async () => undefined, set: async () => undefined } }, sdk: { threads: { getPluginMetadata: async () => ({ role: "pm", lanePilotRunId: "runA" }) } },
      hosts: { experimental_client: () => ({ call: async () => ({ status: "applied" }) }) } };
    mountForge({ db, bb } as never, { dispatchWriter: (async (call: { task: Record<string, unknown> }) => { sent.push(call); return { ok: true }; }) as never, readWriterWorkspaceFile: (async () => ({ content: "" })) as never });
    await registeredTools(agents).get("lane_pilot_forge")!.execute(forgeToolParameters.parse({ action: "draft", kind: "role", name: "fixer", brief: "Fixes one failing check and reports what changed." }) as never, { threadId: "thr_pm", projectId: "projA" } as never);
    const task = sent[0]?.task ?? {};
    out.n213 = { owns: task.owns_paths, outputs: task.expected_outputs, never: task.never_touch };
    await harness.lifecycle.dispose();
  }
  // n220: a task corrected while it waited starts from the stored contract and plan.
  {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run", "P", "bb", "/repo");
    const repoTask = { ...base, id: "t1", project_cwd: "/repo", owns_paths: ["a.txt"], expected_outputs: ["a.txt"], verification: [] };
    createTask(db, { id: "t1", runId: "run", kind: "bb", contract: { ...repoTask, objective: "the corrected objective" } });
    saveTaskPlan(db, "t1", "the corrected plan");
    createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
    const input = { projectId: "P", runId: "run", taskId: "t1", task: { ...repoTask, objective: "the old objective" }, plan: "the old plan", config: {} } as never as Parameters<typeof admitTask>[2];
    const deps2 = { admitted: new Map(), ctx: { db, markCanceledWriterStages: () => undefined, refreshRun: () => undefined } };
    const ok = await admitTask(deps2 as never, { key: "run:t1", attemptId: "a1", writerThreadId: undefined } as never, input);
    out.n220 = { ok, plan: (input as { plan: string }).plan, objective: (input as { task: TaskV2 }).task.objective };
    await harness.lifecycle.dispose();
  }
  console.log(JSON.stringify(out)); // guardian: allow
}

main().then(() => process.exit(0), (error) => { console.error(error); process.exit(1); });
