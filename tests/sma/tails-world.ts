// The tails batch (SMA parity, the 33 nodes no region batch owns): the observed values of the nodes proved in tests/sma/four-proofs-tails.test.ts and read again,
// unchanged, by the scene probe scripts/lp_drill/scenes/sma_tails_probe.ts. Nothing here imports vitest: each function runs the REAL code of the checkout on a
// fake host, a scratch database or a fixture, with no model, no hub write and nothing outside the machine, and returns what it saw.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../src/rooms/core/server/core";
import { createWriterUpdateTask } from "../../src/rooms/writer/server/update-task";
import { createAttempt, createRun, createTask, openDatabase, saveTaskPlan, setAttemptWorkspace, setRunThread, transitionAttempt, savePrototypeConfig } from "../../src/rooms/plugin-db";
import { CONVEYOR_KEY, conveyorStartLine, conveyorState, setConveyor } from "../../src/rooms/runs/conveyor";
import { intakeByRules } from "../../src/rooms/phase/intake";
import { LANE_PILOT_PM_SESSION } from "../../src/rooms/native-agent/native-agent-overlay";
import { nextAction, type Phase } from "../../src/rooms/phase/logic";
import { installJournal } from "../../src/rooms/phase/server/driver-journal";
import { parseQaVerdict } from "../../src/rooms/qa/server/qa-thread";
import { terminalParity, type ParityLayerSet } from "../../src/rooms/native-agent/terminal-parity";
import { sha256Hex } from "@lane-pilot/kit";
import { chainStore, runSim, type SimResult } from "../workflow/chain-harness";
import { noOptionalPlugins } from "../optional-plugin-stubs";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import type { Services } from "../../server";

type Row = Record<string, unknown>;
const ROOT = join(import.meta.dirname, "../..");

// ---- n480 · the conveyor switch (SMA m_cfg_pipeline_off)
export async function obsConveyor() {
  const store = new Map<string, unknown>();
  const kv = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } };
  const fresh = await conveyorState(kv);
  const off = await setConveyor(kv, false, "  night maintenance  ");
  const again = await setConveyor(kv, false, "a second reason");
  const stored = store.get(CONVEYOR_KEY) as { at?: number; reason?: string | null } | null;
  const line = conveyorStartLine(off);
  const back = await setConveyor(kv, true);
  const kv2 = new Map<string, unknown>();
  const longState = await setConveyor({ get: async (key: string) => kv2.get(key), set: async (key: string, value: unknown) => { kv2.set(key, value); } }, false, "y".repeat(400));
  return { fresh, off: { on: off.on, reason: off.reason, sinceIsIso: typeof off.since === "string" && !Number.isNaN(Date.parse(off.since)) }, sameSinceAndReason: again.since === off.since && again.reason === off.reason,
    stored: { atIsNumber: typeof stored?.at === "number", reason: stored?.reason ?? null }, line: line === null ? null : line.replace(/since \S+/, "since <iso>"), back, longReason: longState.reason?.length ?? 0 };
}

// ---- n557 · «make a batch» (SMA m_ce_batch)
export function obsBatchPhrase() {
  const kindOf = (text: string) => intakeByRules(text);
  return {
    bare: kindOf("make a batch"),
    ru: kindOf("пачка мелких правок по списку"),
    list: kindOf("make a batch of these:\n- fix the footer\n- fix the header\n- rename the button"),
    kinds: ["make a batch", "пачка мелких правок по списку", "make a batch of these:\n- fix the footer\n- fix the header"].map((text) => kindOf(text).kind),
  };
}

// ---- n564 · the hard calls are not the model's (SMA m_cf_hard_calls)
export function obsHardCalls() {
  const guard = (command: string, role: string) => {
    const ran = spawnSync("python3", [join(ROOT, "lane-stack/hooks/guard_shell.py")], {
      input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: "/repo", session_id: "sess-tails", agent_type: role }), encoding: "utf8",
      env: { ...process.env, LANE_PILOT_ROLE: role },
    });
    return `${ran.stdout ?? ""}${ran.stderr ?? ""}`.includes("deny");
  };
  const phase = { id: "ph1", stage: "execution", record: { ownerWords: true, plan: { items: [], sha: "plan" }, execution: { issued: {} }, words: [] } } as unknown as Phase;
  const action = nextAction(phase, new Map());
  return {
    writerDenied: ["git push origin main", "git tag v1.0", "gh release create v1.0"].map((command) => [command, guard(command, "writer")]),
    writerAllowed: guard("git status", "writer"),
    phaseWaits: { key: action.key, mentionsOwner: action.text.includes("owner") },
    pmText: ["money", "deleting", "access"].map((word) => LANE_PILOT_PM_SESSION.includes(word)),
  };
}

// ---- n993 · a word mid-turn reaches the running worker's own session (SMA m_sd_steer)
const HOST = "host_test";
const WS = "/ws";
const config: PrototypeConfig = { projectId: "proj1", hostId: HOST, pmWorkspacePath: WS, writerWorkspacePath: WS, pmProviderId: "p", pmModel: "pm", writerProviderId: "p", writerModel: "wm" };
const taskOf = (id: string): TaskV2 => ({
  schema_version: 2, id, title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WS, read_first: [], interfaces: [], invariants: [],
  out_of_scope: [], expected_outputs: [`src/${id}.ts`], owns_paths: ["src/"], never_touch: [], depends_on: [],
  objective: "do it", acceptance: ["done"], verify: "tests", verification: [{ command: "true", cwd: WS }],
});
export async function obsSteer() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.get", async () => ({ id: "thr_w", status: "idle" }));
  const sent: Array<{ threadId: string; mode?: string; text: string }> = [];
  harness.sdk.stub("threads.send", async (args: { threadId: string; mode?: string; input: Array<{ text: string }> }) => { sent.push({ threadId: args.threadId, mode: args.mode, text: args.input?.[0]?.text ?? "" }); return undefined; });
  harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  harness.sdk.stub("files.read", async () => { throw Object.assign(new Error("file does not exist"), { code: "not_found" }); });
  harness.sdk.stub("files.write", async () => ({}));
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "run1", "proj1", "bb", WS);
  setRunThread(db, "run1", "thr_pm");
  savePrototypeConfig(db, config);
  createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: taskOf("t1") });
  saveTaskPlan(db, "t1", "Plan");
  createAttempt(db, { id: "a1", runId: "run1", taskId: "t1" });
  setAttemptWorkspace(db, "a1", { path: `${WS}/wt`, environmentId: null, decision: {} });
  transitionAttempt(db, "a1", "spawn_requested");
  transitionAttempt(db, "a1", "running", { threadId: "thr_w" });
  const services = { activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined }, ...noOptionalPlugins, startWriterTask: () => undefined, workflowEngine: null } as unknown as Services;
  const { updateTask } = createWriterUpdateTask(ctx, services);
  const input = { projectId: "proj1", runId: "run1", pmThreadId: "thr_pm", taskId: "t1" };
  // The control run: a word the PM keeps for the task, not for the live session, sends nothing to the worker.
  const control = await updateTask({ ...input, note: "keep this for the next attempt", when: "task" });
  const sentAfterControl = sent.length;
  const live = await updateTask({ ...input, note: "use the cached list", when: "now" });
  const attempts = (db.prepare("SELECT count(*) AS n FROM lane_pilot_attempt WHERE task_id = 't1'").get() as { n: number }).n;
  const state = (db.prepare("SELECT state FROM lane_pilot_attempt WHERE id = 'a1'").get() as { state: string }).state;
  return {
    control: { ok: control.ok === true, delivered: (control as Row).delivered ?? null, sent: sentAfterControl },
    live: { ok: live.ok === true, delivered: (live as Row).delivered ?? null, attemptId: (live as Row).attemptId ?? null },
    sent: sent.map((row) => ({ threadId: row.threadId, mode: row.mode, hasWord: row.text.includes("use the cached list"), hasControlWord: row.text.includes("keep this for the next attempt") })),
    attempts, state,
  };
}

// ---- n1224 · what a phase learned goes into the project's memory (SMA k_c_learnings)
export function obsLearnings() {
  const phase = { id: "ph_a", projectId: "proj1", runId: null } as unknown as Phase;
  const stored: Row[] = []; const book: unknown[][] = [];
  const text = "decisions: one road; pattern: gate before wave; surprise: a stale lock";
  const journal = installJournal({ db: undefined, now: () => 1, reactions: { storeMemoryRecord: (record: Row) => { stored.push(record); } }, book: (...args: unknown[]) => { book.push(args.slice(1)); } } as never);
  const ok = journal.writeLesson(phase, text);
  const refusing = installJournal({ db: undefined, now: () => 1, reactions: { storeMemoryRecord: () => { throw new Error("memory budget is full"); } }, book: (...args: unknown[]) => { book.push(args.slice(1)); } } as never);
  const refused = refusing.writeLesson(phase, text);
  const record = stored[0] ?? {};
  return {
    ok, writes: stored.length, projectId: record.projectId, audience: record.audience, origin: record.origin, sourceIsPhaseAndText: record.sourceSha256 === sha256Hex(`ph_a:${text}`),
    entries: record.entries, refused, book,
  };
}

// ---- n1604 · the report of the live check: verdict, cases, a silence is never a pass (SMA k_pl_uiqa)
export function obsUiQa() {
  const fence = (body: unknown) => `I checked the app.\n\`\`\`json\n${JSON.stringify(body)}\n\`\`\``;
  const failed = parseQaVerdict(fence({ verdict: "failed", summary: "the save button reaches no write", cases: [{ case: "save form", viewport: "375", result: "failed", note: "no control reaches the write" }] }));
  const silent = parseQaVerdict(fence({ verdict: "passed", summary: "all fine", cases: [{ case: "open", viewport: "375", result: "passed" }, { case: "save", viewport: "375", result: "blocked", note: "could not run" }] }));
  const bare = parseQaVerdict(fence({ verdict: "passed", summary: "all fine", cases: [] }));
  const passed = parseQaVerdict(fence({ verdict: "passed", summary: "both cases held", cases: [{ case: "open", viewport: "375", result: "passed" }, { case: "save", viewport: "1280", result: "passed" }] }));
  const none = parseQaVerdict("no verdict block here");
  return {
    failed: { verdict: failed.verdict, status: failed.status, summary: failed.summary, cases: failed.cases },
    silent: { verdict: silent.verdict, status: silent.status },
    bare: bare.verdict,
    passed: { verdict: passed.verdict, status: passed.status, summary: passed.summary, cases: passed.cases.length },
    none: { verdict: none.verdict, summary: none.summary },
  };
}

// ---- n1675 · the six parity receipts (SMA k_lib_parity)
export function obsParity() {
  const layers = (over: Partial<ParityLayerSet> = {}): ParityLayerSet => ({ hooks: ["0.1.568"], memory: ["m1", "m2"], rules: ["r1"], skills: ["lane-pilot"], permissions: ["disallowedTools:Write"], model: ["p/m"], ...over });
  const same = terminalParity(layers(), layers());
  const differ = terminalParity(layers({ memory: ["m1", "m3"], skills: [] }), layers({ memory: ["m1", "m2"], skills: ["s9"] }));
  const oneSide = terminalParity(layers({ skills: ["a", "b"] }), layers({ skills: ["a"] })).find((line) => line.layer === "skills");
  const missing = terminalParity(layers({ permissions: null }), layers()).find((line) => line.layer === "permissions");
  return { order: same.map((line) => line.layer), allSame: same.every((line) => line.same === true), sameCount: same[1], memory: differ.find((line) => line.layer === "memory"), skills: differ.find((line) => line.layer === "skills"), oneSide, missing };
}

// ---- n751 · publish: the gate marker first, then the record (SMA m_sh_publish)
const emitted = (result: SimResult) => result.summary.output as Row;
const ranOf = (result: SimResult) => result.steps.filter((step) => step.state === "succeeded").map((step) => step.node_id).filter((id) => !/:(fan|child)$/.test(id));
export async function obsShip() {
  const held = await runSim("ship", { input: { phase_id: "ph_a", review: false }, stubs: { gate: { ok: false, failing: ["integration gate not run"] }, preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "https://x/pr/1" } } });
  const shipped = await runSim("ship", { input: { phase_id: "ph_a", review: false }, stubs: { gate: { ok: true, failing: [] }, preflight: { ready: true, held_by: [] }, open_pr: { pr_url: "https://x/pr/1" }, "lp.post_ship_hooks": { count: 0, files: [] } } });
  return {
    held: { ran: ranOf(held), out: emitted(held), openPrCalls: held.called("open_pr").length },
    shipped: { ran: ranOf(shipped), out: emitted(shipped), openPrCalls: shipped.called("open_pr").length },
  };
}

// ---- n1615 · the research before the roadmap (SMA k_pl_researchdir): the graph's own order and the folder its prompt names
export async function obsResearch() {
  const workflow = (await chainStore()).get("project-start")!.workflow as unknown as { nodes: Array<Row & { id: string }>; edges: Array<{ from: string; to: string }> };
  const node = workflow.nodes.find((candidate) => candidate.id === "research")!;
  const prompt = String(node.prompt);
  const next = (id: string) => workflow.edges.filter((edge) => edge.from === id).map((edge) => edge.to);
  return {
    before: next("ask"), after: next("research"), thenRecap: next("requirements"),
    folder: /\.agents\/planning\/research\//.test(prompt), files: ["STACK.md", "FEATURES.md", "ARCHITECTURE.md", "PITFALLS.md"].filter((name) => prompt.includes(name)),
    neverOverwrites: /never overwritten: merge .*<name>\.new\.md/.test(prompt), role: node.role, skipWhen: node.skip_when, skipOut: node.skip_out,
  };
}
