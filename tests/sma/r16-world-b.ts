// Region 16 (slash commands and workflows), batch b: the execute-phase tail, the todo/note/seed commands, verify-work, lessons and graduation (n1174 … n1204).
// The scratch world the node tests and the scene probe (scripts/lp_drill/scenes/sma_r16_b_probe.ts) share. Each `observeB.<smaId>()` runs the REAL code of the node on a
// scratch database, a fake host whose file store is a map, a temp checkout or the real workflow engine with fake executors, and returns plain data. No vitest import:
// the probe loads this file under vite-node. No model, no hub, nothing outside the machine. Batch a's observations are in r16-world.ts (not edited here).
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { CRITIC_RUBRIC, WorkflowEngine, parseWorkflow, registerPureActions, registerReducers } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { createPhaseDriver } from "../phase-driver";
import {
  acceptanceLines, blindVerdict, lessonsNeeded, nextAction, pieceLines, planSignature, waveLines, wavePieceLines, type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";
import { autoDue, autoInputs } from "../../src/rooms/phase/server/auto-stages";
import { buildsScreens, markRoadmap, markUatLine, nextRoadmapRow, parkRoadmapRow, rubricLine, stageInit, templateFill, uatState, uatText } from "../../src/rooms/phase/stages";
import { getPhase, listParts, savePhase } from "../../src/rooms/phase/store";
import { candidatePath } from "../../src/rooms/phase/server/candidate";
import { recordStage } from "../../src/rooms/runs/server";
import { advisoryFeedback, codeCritiqueStops, parseCodeCritiqueSettings } from "../../src/rooms/critique/code-critique";
import { backlogBoard, backlogMatches, backlogReadCommand, issueMessage, parseBacklogOutput, parseTodoMeta } from "../../src/rooms/backlog/logic";
import { promotionWhy } from "../../src/rooms/rule-forms/promotion";
import { sessionMemoryRpc } from "../../src/rooms/memory/server/session-memory";
import { acceptRuleProposal, adoptRuleProposal, deleteMemoryRecord, rejectRuleProposal, retireAdoptedRule } from "../../src/rooms/self-repair/server";
import { runCommand } from "../../src/rooms/host-worker/host-handlers";
import { saveProjectSetting } from "../../src/rooms/storage";
import { createWorkflowAgents } from "../../src/rooms/workflow/server/workflow-agent";
import { chainRuntimeFor, registerChainExecutors } from "../../src/rooms/workflow/server/workflow-executors";
import { registerDispatchExecutors, taskUsage } from "../../src/rooms/writer/server";
import type { ChainRuntime } from "../../src/rooms/contracts/server";
import type { ServerCore } from "../../src/rooms/contracts/server";
import { createAttempt, createRun, createTask, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { runSim } from "../workflow/chain-harness";
import { D, PH, dep, fact, item, phase, uiItem } from "./r16-world";

const ids = (items: readonly PlanItem[]) => items.map((row) => row.id);
const OFF = { branch: "phase/test", trees: {}, off: "no phase branch in this test" };
const planRec = (items: PlanItem[], over: Record<string, unknown> = {}) => ({ items, contextSha: "ctx", sha: planSignature(items, "ctx"), admittedSha: planSignature(items, "ctx"), critique: { decision: "approve", by: "c", independence: { ok: true, why: "" } }, objective: "o", premortem: ["a", "b", "c"], ...over });

// ---------------------------------------------------------------- the phase driver on a fake host that records what the PM is told
function phaseWorldB() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const messages: string[] = [];
  harness.sdk.stub("threads.send", async (args: { input?: Array<{ text?: string }> }) => { messages.push(String(args.input?.[0]?.text ?? "")); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
  harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("threads.stop", async () => ({}));
  harness.sdk.stub("threads.listRunning" as never, async () => []);
  const texts = new Map<string, string>();
  const commits: Array<{ paths: string[]; message: string }> = [];
  const sent: Array<Record<string, unknown>> = [];
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
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { sent.push(input.task); createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task as never }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async () => null }, rollback: { noteStopped: async () => ({ recorded: true }) },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  return { phases, db, texts, commits, messages, sent };
}
type WorldB = ReturnType<typeof phaseWorldB>;

async function openedB(w: WorldB, record: Record<string, unknown>, stage: Phase["stage"]) {
  const made = await w.phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  savePhase(w.db, made.id, { stage, state: "active", runId: "run1", record: { ...made.record, ...record } as never, at: 2 });
  return made.id;
}

const ROADMAP = "# Map\n\n## Milestone v1\n\n- [ ] 1.1 Hud — build it\n- [ ] 1.2 Menu — the menu\n\n## Backlog\n\n- [ ] 999.1 Later — parked\n";
async function closedPhase(over: Record<string, unknown>, roadmap = ROADMAP, state?: string) {
  const w = phaseWorldB();
  const id = await openedB(w, { roadmapRow: "1.1", ...over }, "closed");
  savePhase(w.db, id, { record: { ...getPhase(w.db, id)!.record, bookWritten: { seq: 0, sha256: "", at: 1 } }, at: Date.now() });
  w.texts.set(".agents/planning/ROADMAP.md", roadmap);
  if (state !== undefined) w.texts.set(".agents/planning/STATE.md", state);
  await w.phases.tick();
  return { w, id };
}

// ---------------------------------------------------------------- a phase with a candidate branch (the machine's regression pass on the candidate tree)
const SHA = (n: number) => String(n).repeat(40).slice(0, 40);
const hud: PlanItem = { id: "hud", title: "Hud", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id: "hud", project_cwd: "/repo", owns_paths: ["src/**"], verification: [{ command: "npm test", cwd: "/repo/app" }], acceptance: ["the bar stays centred"] } };
async function candidateRun(state: "green" | "red") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle", environmentId: "env_pm" }));
  harness.sdk.stub("threads.list", async () => []);
  harness.sdk.stub("environments.get", async () => ({ path: "/repo", hostId: "h" }));
  const written = new Map<string, string>();
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
    if (method === "runCommand") return { exitCode: 0, stdout: `${SHA(1)}\n`, stderr: "" };
    if (method === "gitSyncWorktree") return { status: "up-to-date", head: SHA(1), reason: null, conflicts: [] };
    if (method === "writePhaseBook") { for (const edit of (input.edits ?? []) as Array<{ path: string; content: string }>) written.set(edit.path, edit.content); return { status: "applied", writes: ((input.edits ?? []) as Array<{ path: string; content: string }>).map((edit) => ({ path: edit.path, status: "applied", afterSha256: sha256Hex(edit.content) })) }; }
    return {};
  } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "projA", "bb", "/repo");
  db.prepare("UPDATE lane_pilot_run SET writer_host_id='h', pm_thread_id='thr_pm' WHERE id='run1'").run();
  const regressions: Array<Record<string, unknown>> = [];
  const services = {
    runBudgets: { get: () => undefined },
    dispatchWriter: async (input: { task: Record<string, unknown> }) => { createTask(db, { id: String(input.task.id), runId: "run1", kind: "bb", contract: input.task as never }); return { taskId: input.task.id, runId: "run1" }; },
    regression: { run: async (input: Record<string, unknown>) => { regressions.push(input); return { projects: [{ projectId: "projA", head: SHA(1), tasks: [{ taskId: "hud", checks: [{ command: "npm test", state }] }], findings: [] }] }; } },
    runGoal: { check: async () => { throw new Error("the run's goal check reads main, not the candidate"); } },
    readWriterWorkspaceFile: async ({ path }: { path: string }) => { const content = written.get(path); return content === undefined ? null : { sha256: sha256Hex(content), sizeBytes: content.length, content }; },
  } as unknown as Services;
  const phases = createPhaseDriver(createCore(bb, db), services).phases;
  const made = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Hud", goal: "hud" });
  const sha = planSignature([hud], "ctx");
  savePhase(db, made.id, { stage: "execution", runId: "run1", record: { ...made.record, waveReview: false, plan: { items: [hud], contextSha: "ctx", sha, admittedSha: sha } } as never, at: 2 });
  await phases.drive(phases.list({ live: true })[0]!);
  createAttempt(db, { id: "att1", runId: "run1", taskId: "hud" });
  db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att1'").run();
  for (const stageId of ["verification", "plan-fact", "code-critique"] as const) recordStage(db, { runId: "run1", taskId: "hud", stageId, state: "passed", attempt: 1, input: stageId });
  const after = await phases.drive(phases.list({ live: true })[0]!);
  return { regressions, after, tree: candidatePath("/repo", made.id) };
}

// ---------------------------------------------------------------- lessons: a finished retrospective in the journal, the owner's word on the lesson draft
const ANALYSIS = "The plan missed the empty-cell case; a check per promise would have caught it.";
async function lessonWorld(ownerWords: boolean) {
  const before = process.env.LANE_PILOT_OWNER_WORDS_DEFAULT;
  process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = ownerWords ? "on" : "off";
  try {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.send" as never, async () => ({}));
    harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    db.prepare("UPDATE lane_pilot_run SET pm_thread_id=? WHERE id=?").run("thr_pm", "run1");
    const services = { runBudgets: { get: () => undefined }, readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: sha256Hex(path), sizeBytes: 120, content: `# ${path}` }) };
    const { phases } = createPhaseDriver(createCore(bb, db), services as never);
    const made = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Sums", goal: "sums skip empty cells" });
    return { db, phases, id: made.id, record: made.record };
  } finally { if (before === undefined) delete process.env.LANE_PILOT_OWNER_WORDS_DEFAULT; else process.env.LANE_PILOT_OWNER_WORDS_DEFAULT = before; }
}
function seedRetro(db: Parameters<typeof savePhase>[0], runId: string, opts: { handoff?: string; author?: string; reviewer?: string; badHash?: boolean } = {}) {
  db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,project_id,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)").run(runId, "retrospective", 1, "sha", "{}", "projA", "succeeded", 1, 1);
  const input = JSON.stringify({ with: {}, via: { mode: "artifact", fromStep: "retro#1", fromThreadId: opts.author ?? "thr_retro", handoff: opts.handoff ?? ANALYSIS } });
  const receipt = JSON.stringify({ executor: "agent", inputSha256: opts.badHash ? sha256Hex("other") : sha256Hex(input), threadId: opts.reviewer ?? "thr_stage" });
  db.prepare("INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,state,input_json,receipt_json,started_at,ended_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(runId, "stage#1", "stage#1", "stage", 1, "succeeded", input, receipt, 1, 2, 2);
  return sha256Hex(input);
}
const memoryRows = (db: Parameters<typeof savePhase>[0]) => (db.prepare("SELECT content, origin FROM lane_pilot_memory WHERE project_id='projA'").all() as Array<{ content: string; origin: string }>).map((row) => [row.origin, row.content]);
async function atLessons(ownerWords: boolean) {
  const f = await lessonWorld(ownerWords);
  savePhase(f.db, f.id, { stage: "lessons", record: { ...f.record, lessons: { needed: true, why: "a return" }, ...(ownerWords ? { ownerWords: true } : {}) } as never, at: 2 });
  return f;
}

// ---------------------------------------------------------------- the real workflow engine writing into a temp checkout (todo-add, note-add)
async function workflowWorld() {
  const PROJECT = "r16b-project", PM = "r16b-pm", RUN = "r16b-run";
  const checkout = mkdtempSync(join(tmpdir(), "lp-r16b-"));
  execFileSync("git", ["init", "-q"], { cwd: checkout });
  writeFileSync(join(checkout, "README.md"), "hello\n");
  const writes: Array<{ path: string; content: string }> = [];
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
      files: { write: async (args: unknown) => { const input = args as { path: string; content: string }; mkdirSync(dirname(input.path), { recursive: true }); writeFileSync(input.path, input.content); writes.push(input); return { ok: true }; } },
    } as never,
  });
  const db = openDatabase(bb);
  createRun(db, RUN, PROJECT, "bb", checkout, "none", undefined, "local");
  setRunThread(db, RUN, PM);
  const ctx = createCore(bb, db);
  const services = { dispatchWriter: async () => ({ runId: RUN, taskId: "t", state: "queued" }), stability: { loadParked: async () => [] }, taskUsage } as unknown as Services;
  const engine = new WorkflowEngine({ db, harnessVersion: "test", runtimeFor: chainRuntimeFor(ctx, services), resolveWorkflow: () => null });
  registerPureActions(engine); registerReducers(engine);
  registerChainExecutors(engine, ctx, services, createWorkflowAgents());
  registerDispatchExecutors(engine, ctx.bb);
  const rt: ChainRuntime = { ctx, services, pmThreadId: PM, projectId: PROJECT, runId: RUN };
  const wf = (name: string): Workflow => parseWorkflow(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "workflows", name), "utf8")));
  const answers = (by: Record<string, Record<string, unknown>>) => engine.register("agent", { reentrant: true, run: async (ctx2: { nodeId: string }) => ({ output: { handoff: `${ctx2.nodeId} done`, ...(by[ctx2.nodeId] ?? {}) } }) } as never);
  const start = (name: string, inputs: Record<string, unknown>) => engine.start({ workflow: wf(name), inputs, runtime: rt, link: { projectId: PROJECT, runId: RUN } }).done;
  return { checkout, writes, start, answers, set: (key: string, value: string) => saveProjectSetting(db, PROJECT, key, value), dispose: () => harness.lifecycle.dispose() };
}

const today = () => new Date().toISOString().slice(0, 10);
const TODOS = (dirRoot: string) => { try { return readdirSync(join(dirRoot, ".agents/todos/items")).sort(); } catch { return []; } };

export const observeB = {
  /** n1174: wave pieces go in parallel — every ready piece of a wave in one pass, up to the issue cap, and the next pass goes on from where the phase stands. */
  async k_we_waves() {
    const run = async (cap?: number) => {
      const w = phaseWorldB();
      const items = [item("a"), item("b"), item("c")];
      const id = await openedB(w, { candidate: OFF, ...(cap !== undefined ? { issueCap: cap } : {}), plan: planRec(items) }, "execution");
      await w.phases.drive(getPhase(w.db, id)!);
      const first = w.sent.map((task) => String(task.id));
      await w.phases.drive(getPhase(w.db, id)!);
      return { first, second: w.sent.map((task) => String(task.id)), issued: Object.keys(getPhase(w.db, id)!.record.execution?.issued ?? {}) };
    };
    return { open: await run(), capped: await run(2) };
  },

  /** n1175: a run without subagents works one piece at a time (phase.subagents off). */
  async k_we_inline() {
    const run = async (subagents: boolean) => {
      const w = phaseWorldB();
      const items = [item("a"), item("b"), item("c")];
      const id = await openedB(w, { candidate: OFF, subagents, plan: planRec(items) }, "execution");
      await w.phases.drive(getPhase(w.db, id)!);
      const first = w.sent.map((task) => String(task.id));
      await w.phases.drive(getPhase(w.db, id)!);
      return { first, second: w.sent.map((task) => String(task.id)) };
    };
    return { inline: await run(false), withSubagents: await run(true) };
  },

  /** n1176: how many pieces of the wave hold each acceptance line and which pieces break it. */
  k_we_aggregate() {
    const pieces = [item("p1"), item("p2")];
    const facts = new Map<string, TaskFact>([["p1", fact("t1")], ["p2", fact("t2", { codeCritique: "blocked" })]]);
    const all = new Map<string, TaskFact>([["p1", fact("t1")], ["p2", fact("t2")]]);
    const lines = (map: ReadonlyMap<string, TaskFact>) => waveLines(pieces, map).map((line) => [line.id, line.ok, line.detail]);
    return { held: lines(all), broken: lines(facts), perPiece: Object.keys(wavePieceLines(pieces, facts)), brokenPiece: wavePieceLines(pieces, facts).p2!.filter((line) => !line.ok).map((line) => line.id) };
  },

  /** n1177: the code critic stops a task in gate mode on any change request; in advisory mode only on a block or a blocking finding on a rubric criterion, the rest is advice. */
  k_we_codereview() {
    const code = CRITIC_RUBRIC.code[0]!;
    const finding = (severity: string, criterion: string) => ({ severity, criterion, finding: `the ${criterion} note` });
    const asked = (...findings: Array<ReturnType<typeof finding>>) => ({ decision: "changes_requested", findings });
    const both = (result: { status?: string; decision: string; findings: Array<ReturnType<typeof finding>> }) => [codeCritiqueStops("gate", result), codeCritiqueStops("advisory", result)];
    return {
      approved: both({ decision: "approve", findings: [] }),
      adviceOnly: both(asked(finding("minor", code))),
      blockingRubric: both(asked(finding("blocking", code))),
      blockingOther: both(asked(finding("blocking", "style"))),
      blockStatus: both({ status: "block", decision: "approve", findings: [] }),
      feedback: advisoryFeedback({ findings: [finding("minor", "style"), finding("blocking", code)] }),
      noAdvice: advisoryFeedback({ findings: [finding("blocking", code)] }),
      defaultMode: parseCodeCritiqueSettings({ "code_critique.enabled": true }).mode,
      advisoryMode: parseCodeCritiqueSettings({ "code_critique.enabled": true, "code_critique.mode": "advisory" }).mode,
    };
  },

  /** n1178: before the phase's goal is checked, the regression pass of the earlier work runs in full on the candidate's tree, and a red check fails the verdict. */
  async k_we_regression() {
    const green = await candidateRun("green");
    const red = await candidateRun("red");
    return { call: green.regressions[0], greenTree: green.tree, green: { stage: green.after.stage, verdict: green.after.record.verification?.verdict?.state }, red: { verdict: red.after.record.verification?.verdict?.state, detail: red.after.record.verification?.verdict?.detail ?? "" } };
  },

  /** n1179: visible work owes a passed live check, taken on the same candidate the acceptance decides on. */
  k_we_verify() {
    const ui = uiItem("p1");
    const qa = (browserQa: TaskFact["browserQa"], possible: boolean) => pieceLines(ui, fact("t1", { browserQa, qaPlanned: false }), undefined, possible).find((line) => line.id === "qa_read")!.ok;
    const verdict = { state: "passed" as const, detail: "ok", mainSha: "h", at: 1, inputSha: "i" };
    const accept = (head: string) => {
      const ph = phase({ liveCheck: true, plan: planRec([ui]), ownerWords: false, candidate: { branch: "phase/x", trees: { "/r": { path: "/r/t", startSha: "s" } }, verified: { "/r": "v1" } }, verification: { verdict, live: { state: "passed" as const, head, at: 2 } } } as never, "acceptance");
      const line = acceptanceLines(ph, new Map([["p1", fact("t1")]]), { mainSha: "v1", openDeferrals: 0 }).find((row) => row.id === "qa_read")!;
      return [line.ok, line.detail];
    };
    return { skipped: qa("skipped", true), passed: qa("passed", true), notOwed: qa("skipped", false), onOtherHead: accept("v0"), onSameHead: accept("v1") };
  },

  /** n1180: the live interface check comes after the blind verdict and before the goal audit, only where a piece built screens and the check is on. */
  k_we_uiqa() {
    const verdict = { state: "passed" as const, detail: "ok", mainSha: "h", at: 1, inputSha: "i" };
    const at = (record: Record<string, unknown>) => autoDue(phase({ plan: planRec([uiItem("p1")]), ...record } as never, "verification"))?.kind ?? null;
    return {
      withUi: at({ liveCheck: true, verification: { verdict } }),
      checkOff: at({ verification: { verdict } }),
      taken: at({ liveCheck: true, verification: { verdict, live: { state: "passed", head: "h", at: 2 } } }),
      noScreens: autoDue(phase({ liveCheck: true, plan: planRec([item("p1")]), verification: { verdict } } as never, "verification"))?.kind ?? null,
      beforeVerdict: autoDue(phase({ liveCheck: true, plan: planRec([uiItem("p1")]) } as never, "verification"))?.kind ?? null,
    };
  },

  /** n1181: the closed phase's row in the roadmap gets its [x] and the rest of the roadmap stays as it was. */
  async k_we_roadmap() {
    const { w } = await closedPhase({});
    const done = w.texts.get(".agents/planning/ROADMAP.md") ?? "";
    return { rows: done.split("\n").filter((row) => row.startsWith("- [")), parked: done.endsWith("- [ ] 999.1 Later — parked\n"), pure: markRoadmap(ROADMAP, "1.2").split("\n").filter((row) => row.startsWith("- [")), unknown: markRoadmap(ROADMAP, "7.7") === ROADMAP };
  },

  /** n1182: the lesson draft waits for the owner; his yes puts it into the project's memory, his no leaves it out. */
  async k_we_learnings() {
    const run = async (decision: "yes" | "no") => {
      const { db, phases, id } = await atLessons(true);
      seedRetro(db, "wf_read");
      const closed = phases.lessons({ phaseId: id, analysis: ANALYSIS, reviewRun: "wf_read" });
      const staged = [closed.record.lessons?.draft?.state, memoryRows(db).length];
      const settled = await phases.word({ phaseId: id, turn: "lesson", decision, text: "ok", by: "owner via screen" });
      return { staged, after: [settled.record.lessons?.draft?.state, memoryRows(db)] };
    };
    const yes = await run("yes"), no = await run("no");
    return { yes, no };
  },

  /** n1183: after a closed phase the next open roadmap row is told to the PM (the parked backlog rows are not), or opened at once in autonomous mode; a failed verdict is replanned instead. */
  async k_we_next() {
    const told = await closedPhase({});
    const message = told.w.messages.find((text) => text.includes("Next on the roadmap")) ?? "";
    const auto = await closedPhase({ autonomous: true });
    const verdict = { state: "failed" as const, detail: "check red", mainSha: "h", at: 1, inputSha: "i" };
    return {
      told: message.slice(message.indexOf("Next on the roadmap")).split(". Open it")[0],
      autoOpened: listParts(auto.w.db, auto.id).filter((part) => part.kind === "transition").map((part) => part.text.replace(/ph_[0-9a-f]+/, "<id>")),
      autoPhases: auto.w.phases.list({ live: true }).filter((row) => row.id !== auto.id).map((row) => [row.title, row.record.roadmapRow]),
      rows: [nextRoadmapRow(ROADMAP), nextRoadmapRow(markRoadmap(ROADMAP, "1.1"))?.n, nextRoadmapRow("- [x] 1.1 A\n\n## Backlog\n\n- [ ] 999.1 Later\n- [ ] 999.2 Later\n"), nextRoadmapRow("## Notes\n\n- [ ] 999.1 A real phase\n")?.n],
      gaps: autoDue(phase({ verification: { verdict } } as never, "verification"))?.kind ?? null,
    };
  },

  /** n1184: a thought becomes a structured todo under .agents/todos/items that the backlog scanner reads as it is. */
  async k_c_addtodo() {
    const t = await workflowWorld();
    try {
      t.answers({ shape: { title: "Fix flaky test", body: "the flaky payments test", priority: "high", line: "todo added" } });
      const done = await t.start("todo-add.json", { thought: "fix the flaky payments test", estimate: 3 });
      const folders = TODOS(t.checkout);
      const meta = folders.map((folder) => parseTodoMeta(readFileSync(join(t.checkout, ".agents/todos/items", folder, "meta.yaml"), "utf8")));
      return { status: done.status, folders: folders.map((folder) => folder.replace(today(), "<day>").replace(String(done.output?.todo_id), "<run>")), meta: meta[0], readme: folders.length ? readFileSync(join(t.checkout, ".agents/todos/items", folders[0]!, "README.md"), "utf8") : null,
        output: { status: done.output?.status, line: done.output?.line, idIsFolder: folders[0] === `${today()}-${String(done.output?.todo_id)}` }, board: backlogBoard(meta.flatMap((row) => (row ? [row] : []))).issuable.map((row) => row.id === done.output?.todo_id) };
    } finally { await t.dispose(); }
  },

  /** n1185: a note is one write and one confirmation line, no questions. */
  async k_c_note() {
    const t = await workflowWorld();
    try {
      const done = await t.start("note-add.json", { text: "deploy is manual" });
      const notes = t.writes.filter((write) => write.path.includes(".agents/todos/notes/"));
      return { status: done.status, output: { status: done.output?.status, confirmation: done.output?.confirmation }, notes: notes.length, file: notes[0]?.path.replace(/.*\.agents\/todos\/notes\/[^/]*\//, ""), body: notes[0]?.content.replace(/created: \d{4}-\d{2}-\d{2}/, "created: <day>"), path: String(done.output?.note_path ?? "").includes(".agents/todos/notes/") };
    } finally { await t.dispose(); }
  },

  /** n1186: an idea for later is a todo with a status, a priority and the conditions to come back (depends_on, an estimate); the backlog scan keeps it off the board until they hold. */
  k_c_seed() {
    const meta = (id: string, over: Record<string, string> = {}) => parseTodoMeta(Object.entries({ id, title: `seed ${id}`, status: "ready", priority: "high", estimate: "3", depends_on: "[]", created: "2026-11-01", ...over }).map(([key, value]) => `${key}: ${value}`).join("\n"))!;
    const base = meta("base", { status: "done" }), later = meta("later", { depends_on: "[base]" }), waits = meta("waits", { depends_on: "[base, missing]" }), idea = meta("idea", { status: "idea" });
    const text = "id: x1  # the id\ntitle: \"Try the cache\"\nstatus: ready\npriority: low\nestimate: 5\ndepends_on: [a, b]\ncreated: 2026-11-02\n";
    return { parsed: parseTodoMeta(text), noId: parseTodoMeta("title: no id\n"), board: (() => { const board = backlogBoard([base, later, waits, idea]); return { issuable: ids(board.issuable as never), blocked: ids(board.blocked as never) }; })() };
  },

  /** n1187: an item goes into the roadmap's parking lot with the next 999 number; the machine never opens it as the next phase. */
  k_c_backlog() {
    const first = parkRoadmapRow("# Map\n\n- [ ] 1.1 Hud — build it\n", "Later idea", "do it after the hud");
    const second = parkRoadmapRow(first.text, "Another", "x");
    const hostile = parkRoadmapRow(first.text, "# Evil\n- [ ] 1.9 injected", "line one\n## Backlog2");
    return { first: [first.n, first.text.split("\n").filter((row) => row.startsWith("- [") || row.startsWith("## "))], second: [second.n, second.text.split("\n").filter((row) => row.startsWith("- ["))],
      hostile: hostile.text.split("\n").filter((row) => row.includes("999.2")), next: nextRoadmapRow(second.text)?.n ?? null };
  },

  /** n1188: the todo list ordered for a pick — the most urgent small job first — with the PM's order to act on the picked item. */
  k_c_checktodos() {
    const todo = (id: string, over: Partial<ReturnType<typeof parseTodoMeta> & object> = {}) => ({ id, title: `todo ${id}`, status: "ready", priority: "medium", estimate: 3, dependsOn: [], created: "2026-11-01", ...over }) as NonNullable<ReturnType<typeof parseTodoMeta>>;
    const board = backlogBoard([todo("low-small", { priority: "low", estimate: 1 }), todo("high-big", { priority: "high", estimate: 8 }), todo("high-small", { priority: "high", estimate: 2 }), todo("mid", {}), todo("none", { estimate: null }), todo("huge", { estimate: 21 })]);
    return { order: ids(board.issuable as never), needsEstimate: ids(board.needsEstimate as never), decompose: ids(board.decompose as never), order1: issueMessage(board.issuable[0]!) };
  },

  /** n1189: the idea list is read-only and shows what is still open: only ready items sit on the board, a done one is never offered, the read command only prints. */
  k_c_listseeds() {
    const todo = (id: string, status: string, title = `todo ${id}`) => ({ id, title, status, priority: "medium", estimate: 3, dependsOn: [], created: "2026-11-01" });
    const items = [todo("r", "ready"), todo("d", "done"), todo("i", "idea"), todo("p", "parked")];
    const board = backlogBoard(items);
    const parsed = parseBacklogOutput(["__lp_todo__ .agents/todos/items/a/meta.yaml", "id: a\ntitle: One\nstatus: ready\nestimate: 2\n", "", "__lp_todo__ .agents/todos/items/b/meta.yaml", "id: b\ntitle: Two\nstatus: idea\n"].join("\n"));
    return { board: [ids(board.issuable as never), ids(board.needsEstimate as never), ids(board.blocked as never)], like: ids(backlogMatches("cache layer rework", [todo("x", "idea", "Rework the cache layer"), todo("y", "done", "Rework the cache layer")]) as never),
      parsed: parsed.map((row) => [row.id, row.status]), readOnly: !/[>]|\brm\b|\bmv\b|\btee\b|\bsed\b/.test(backlogReadCommand.replace(/\$f"; echo/g, "")) && backlogReadCommand.includes("cat \"$f\"") };
  },

  /** n1190: a thread of context across sessions — a note written by one session is found by another, from any machine, and a secret is refused at the door. */
  async k_c_thread() {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { projects: { list: async () => [{ id: "P" }, { id: "Q" }] } } as never });
    const db = openDatabase(bb);
    const services = { insights: { acceptRuleProposal, adoptRuleProposal, deleteMemoryRecord, rejectRuleProposal, retireAdoptedRule }, memoryConflicts: { detect: () => undefined }, docsPlaces: async (projectId: string) => projectId === "P"
      ? [{ hostId: "ovh", path: "/home/u/apps/selfy", scopes: [] }, { hostId: "ovh", path: "/home/u/apps/selfy/apps/bot", scopes: ["section:bot"] }] : [{ hostId: "mini", path: "/Users/k/Documents/BB", scopes: [] }] } as unknown as Services;
    const rpc = sessionMemoryRpc({ bb, db, log: () => undefined } as unknown as ServerCore, services);
    const where = async (hostId: string, path: string) => rpc.session_memory_project({ hostId, path });
    const written = await rpc.session_memory_write({ projectId: "P", kind: "note", content: "The reports page lives in components/reports and reads the daily table.", concepts: ["reports"], source: "cli mini" });
    const found = await rpc.session_memory_search({ projectId: "P", query: "reports page daily table" });
    const other = await rpc.session_memory_search({ projectId: "Q", query: "reports page daily table" });
    const secret = await rpc.session_memory_write({ projectId: "P", kind: "core", content: `token ghp_${"a".repeat(30)}`, concepts: ["x"] });
    return { where: [await where("ovh", "/home/u/apps/selfy/apps/bot/src"), await where("ovh", "/home/u/apps/selfy"), await where("mini", "/home/u/apps/selfy")], written: written.stored, found: found.records.map((row) => row.content), other: other.records.length, secret: [secret.stored, /credential/.test(String(secret.reason))] };
  },

  /** n1192: the acceptance session's document — one numbered line per promise, answered by number, the other lines byte-equal; read back it says what is passed, failed and open. */
  k_c_verify() {
    const items = [item("p1"), item("p2"), item("p3")];
    const ph = { id: PH, title: "Sum", goal: "sums", record: { plan: planRec(items) } } as unknown as Pick<Phase, "id" | "title" | "goal" | "record">;
    const text = uatText(ph);
    const marked = markUatLine(markUatLine(text, 2, true, "works")!, 3, false, "the total is wrong")!;
    const changed = marked.split("\n").filter((row, index) => row !== text.split("\n")[index]);
    return { head: text.split("\n").slice(0, 5), lines: text.split("\n").filter((row) => row.startsWith("- [")), changed, state: uatState(marked), none: markUatLine(text, 9, true), fresh: uatState(text),
      candidate: uatText({ ...ph, record: { ...ph.record, candidate: { branch: "phase/x", trees: { "/r": { path: "/r/t", startSha: "s" } }, verified: { "/r": "abcdef1234567890" } } } } as never).split("\n")[4] };
  },

  /** n1193: the goal-backward check — the verdict is decided by code from the receipts and the run's goal check, names what is not proved, and the document lists each piece's checks. */
  k_c_verifyphase() {
    const items = [item("p1"), item("p2")];
    const proved = new Map([["p1", fact("t1")], ["p2", fact("t2")]]);
    const goal = { state: "passed", headSha: "h1" };
    const at = (facts: Map<string, TaskFact>, runGoal: { state: string; detail?: string | null; headSha?: string | null } | null) => { const v = blindVerdict(items, facts, runGoal, 5); return [v.state, v.detail]; };
    return { passed: at(proved, goal), unproved: at(new Map([["p1", fact("t1")], ["p2", fact("t2", { planFact: "failed" })]]), goal), noGoal: at(proved, null), goalFailed: at(proved, { state: "failed", detail: "npm test red" }),
      running: at(proved, { state: "running" }), same: blindVerdict(items, proved, goal, 5).inputSha === blindVerdict(items, proved, goal, 9).inputSha,
      document: templateFill("VERIFICATION", { id: PH, title: "Sum", goal: "sums", record: { plan: planRec(items) } } as never, proved).split("\n").slice(0, 4) };
  },

  /** n1194: where phase.diagnose is on, a failed verdict goes to the debuggers, one per gap (six at most), and the diagnoses come back together. */
  async k_c_diagnose() {
    const verdict = { state: "failed" as const, detail: "check p1 red", mainSha: "h", at: 1, inputSha: "sha1" };
    const failed = phase({ diagnose: true, verification: { verdict } } as never, "verification");
    const run = async (n: number) => runSim("debug", { input: { mode: "from_failures", symptom: Array.from({ length: n }, (_, i) => `check c${i} red`) }, stubs: { diagnose: { status: "confirmed", root_cause: "c", confidence: 80, fix_direction: "f" } } });
    const two = await run(2), seven = await run(7);
    const count = (r: Awaited<ReturnType<typeof run>>) => ((r.summary.output as { diagnoses: unknown[] }).diagnoses ?? []).length;
    return { due: autoDue(failed)?.kind ?? null, off: autoDue(phase({ verification: { verdict } } as never, "verification"))?.kind ?? null, two: [r2path(two), count(two)], seven: [r2path(seven), count(seven)] };
  },

  /** n1195: a closed phase finishes its paperwork once: SUMMARY.md, the roadmap row, STATE's phase and stage, one commit, then it is closed for good. */
  async k_c_transition() {
    const { w, id } = await closedPhase({}, ROADMAP, "---\nphase: 0\nstage: verification\n---\n\nnotes kept\n");
    const live = getPhase(w.db, id)!;
    const state = w.texts.get(".agents/planning/STATE.md") ?? "";
    const summary = w.texts.get(`.agents/phases/${id}/SUMMARY.md`) ?? "";
    return { state: live.state, closed: !!live.record.closedDocs, summary: summary.split("\n")[0]?.replace(id, "<id>") ?? "", stateHas: [/^phase: "1\.1"$/m.test(state), /^stage: "closed"$/m.test(state), state.includes(`last_phase: "${id}"`), state.includes("notes kept")],
      committed: w.commits.map((commit) => commit.paths.map((path) => path.replace(id, "<id>")).sort()), message: w.commits[0]?.message.replace(id, "<id>"), booked: listParts(w.db, id).filter((part) => part.kind === "concluded").length };
  },

  /** n1196: lessons graduate into rules by recurrence, never by a person's command: a rule seen three times (or decided by the owner, or confirmed on trial) is a candidate. */
  k_c_graduation() {
    const rule = (over: Record<string, unknown> = {}) => ({ state: "accepted", form: "check", mechanizedBy: null, occurrences: 1, decidedBy: "night", trialState: "running", rule: "Never edit files outside owns_paths", ...over }) as never;
    return { twice: promotionWhy(rule({ occurrences: 2 })), thrice: promotionWhy(rule({ occurrences: 3 })), owner: promotionWhy(rule({ decidedBy: "owner" })), confirmed: promotionWhy(rule({ trialState: "confirmed" })), proposed: promotionWhy(rule({ occurrences: 5, state: "proposed" })),
      held: promotionWhy(rule({ occurrences: 5, mechanizedBy: "guard" })), notAMechanism: promotionWhy(rule({ occurrences: 5, form: "prose" })) };
  },

  /** n1197: the lessons stage takes a reviewed analysis only at the lessons stage; it is kept with its author, reviewer and the hash the reviewer read, and the phase closes. */
  async k_c_lessons() {
    const f = await atLessons(false);
    const early = await lessonWorld(false);
    const refused = (() => { try { early.phases.lessons({ phaseId: early.id, analysis: ANALYSIS, reviewRun: "wf_read" }); return "taken"; } catch (cause) { return cause instanceof Error ? cause.message : String(cause); } })();
    const measured = seedRetro(f.db, "wf_read");
    const closed = f.phases.lessons({ phaseId: f.id, analysis: ANALYSIS, reviewRun: "wf_read" });
    return { early: refused.replace(early.id, "<id>"), stage: closed.stage, lessons: { ...closed.record.lessons, at: undefined, hashIsMeasured: closed.record.lessons?.reviewedHash === measured, reviewedHash: undefined }, book: listParts(f.db, f.id).filter((part) => part.kind === "analysis").map((part) => part.text.replace(/input [0-9a-f]{12}/, "input <sha>")) };
  },

  /** n1198: a lesson is owed for a reason that can be checked — returns, failed attempts or failed verdicts — never invented for a clean phase. */
  k_wl_rubric() {
    return { clean: lessonsNeeded({ returns: 0, failedAttempts: 0, verdictFailures: 0 }), troubled: lessonsNeeded({ returns: 2, failedAttempts: 1, verdictFailures: 0 }), verdict: lessonsNeeded({ returns: 0, failedAttempts: 0, verdictFailures: 3 }), rubric: rubricLine("lessons") };
  },

  /** n1199: the order of the lessons work — the author's analysis is proven read by an independent reviewer session, the bytes it saw are kept. */
  async k_wl_order() {
    const f = await atLessons(false);
    const taken = (run: string) => { try { f.phases.lessons({ phaseId: f.id, analysis: ANALYSIS, reviewRun: run }); return "taken"; } catch (cause) { return cause instanceof Error ? String((cause as { why?: string[] }).why?.[0] ?? cause.message).replace(/workflow run \S+ /, "run ") : String(cause); } };
    seedRetro(f.db, "wf_self", { reviewer: "thr_retro" });
    seedRetro(f.db, "wf_other", { handoff: "Another analysis the reviewer read." });
    seedRetro(f.db, "wf_forged", { badHash: true });
    const measured = seedRetro(f.db, "wf_read");
    const refusals = { missing: taken("wf_none"), self: taken("wf_self"), other: taken("wf_other"), forged: taken("wf_forged") };
    const closed = f.phases.lessons({ phaseId: f.id, analysis: ANALYSIS, reviewRun: "wf_read" });
    return { refusals, author: closed.record.lessons?.author, reviewer: closed.record.lessons?.reviewer, bytesKept: closed.record.lessons?.reviewedHash === measured, analysis: closed.record.lessons?.analysis === ANALYSIS };
  },

  /** n1200: the session never writes the memory itself — the daemon writes the conclusion: straight into the project's memory, or as a draft waiting for the owner's word. */
  async k_wl_write() {
    const direct = await atLessons(false);
    seedRetro(direct.db, "wf_read");
    const closed = direct.phases.lessons({ phaseId: direct.id, analysis: ANALYSIS, reviewRun: "wf_read" });
    const drafted = await atLessons(true);
    seedRetro(drafted.db, "wf_read");
    const staged = drafted.phases.lessons({ phaseId: drafted.id, analysis: ANALYSIS, reviewRun: "wf_read" });
    return { direct: { stage: closed.stage, draft: closed.record.lessons?.draft ?? null, memory: memoryRows(direct.db) }, drafted: { draft: staged.record.lessons?.draft?.state, memory: memoryRows(drafted.db).length, text: staged.record.lessons?.draft?.text } };
  },

  /** n1201: the verification stage's rubric — the blind verdict comes from code and receipts, a writer's own report is not in it. */
  k_wv_rubric() {
    const items = [item("p1")];
    const claim = { ...fact("t1", { planFact: null, verification: null, codeCritique: null }), selfReport: "all done, tests pass" } as TaskFact;
    const verdict = blindVerdict(items, new Map([["p1", claim]]), { state: "passed" }, 1);
    return { rubric: rubricLine("verification"), selfReport: [verdict.state, verdict.detail], proved: blindVerdict(items, new Map([["p1", fact("t1")]]), { state: "passed" }, 1).state };
  },

  /** n1202: what the verification reads before it starts, in one list: the spec, the validation and the drawing's contract only. */
  k_wv_init() {
    const rec = { design: { decision: "needed", why: "", drawing: { paths: [`${D}/UI-SPEC.md`, `${D}/kit.png`], sha256: "s", designer: "d", feasible: true } }, context: { docs: [{ path: "c.md", sha256: "x" }], sha: "c", signedAt: 1 } } as unknown as PhaseRecord;
    return { verification: stageInit({ id: PH, stage: "verification", record: rec }), plain: stageInit({ id: PH, stage: "verification", record: {} as PhaseRecord }) };
  },

  /** n1203: is an acceptance session open — the lines of UAT.md by state; an open session goes on from its first unanswered line. */
  k_wv_active() {
    const text = ["# UAT — phase ph_x: Sum", "", "- [x] 1. p1: given g, when w, then t1", "- [!] 2. p2: given g, when w, then t2 — wrong", "- [ ] 3. p3: given g, when w, then t3", "- [ ] 4. p4: given g, when w, then t4"].join("\n");
    const state = uatState(text);
    return { state, next: state.open[0], none: uatState("# UAT\n\nNo lines yet.\n"), crlf: uatState("- [x] 1. a\r\n- [ ] 2. b\r\n") };
  },

  /** n1204: the automatic interface check — started for a phase that built screens (a piece owning a UI file), given the pieces' address and flows; a backend phase has none. */
  k_wv_autoui() {
    const visible = uiItem("v1", { task: { ...uiItem("v1").task, qa_url: "http://127.0.0.1:5173/", qa_dev_server: "npm run dev" } });
    const backend = item("b1");
    const css = item("s1", { task: { ...item("s1").task, owns_paths: ["src/styles/app.css"] } });
    const page = item("g1", { task: { ...item("g1").task, owns_paths: ["web/pages/home.ts"] } });
    const verdict = { state: "passed" as const, detail: "ok", mainSha: "h", at: 1, inputSha: "i" };
    const mixed = phase({ liveCheck: true, plan: planRec([visible, backend]), verification: { verdict } } as never, "verification");
    const inputs = autoInputs(mixed, { kind: "live" }) as { url: string; urls: string[]; flows: string[]; dev_server: string };
    return { builds: [buildsScreens(visible), buildsScreens(backend), buildsScreens(css), buildsScreens(page)], due: autoDue(mixed)?.kind ?? null, inputs, backendOnly: autoDue(phase({ liveCheck: true, plan: planRec([backend]), verification: { verdict } } as never, "verification"))?.kind ?? null,
      noAnswer: nextAction(mixed, new Map()).key };
  },
};

const r2path = (r: { path: string[] }) => r.path.join(" ");
