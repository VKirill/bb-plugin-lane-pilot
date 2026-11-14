// Probe of scenes/sma_r09.py (region 9, Person and window): runs the REAL handlers and functions of THIS checkout (the commit under drill) that the window's
// doors reach, on a scratch database and a fake plugin host, and prints what they returned as one JSON line. It judges nothing: the scene compares every value
// with the card's expected result and prove()s it. No model, no hub write, nothing outside the machine. The screens (jsdom) are not here: the scene runs their tests.
// To add a node: compute its value in a block below, put it on `out`, and read it in the scene.
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, createTask, openDatabase, setRunThread, transitionAttempt } from "../../../src/rooms/plugin-db";
import { recordStage } from "../../../src/rooms/runs/server/stage-records";
import { buildTaskBoard, readTaskCard } from "../../../src/rooms/runs/server/task-board";
import { markUatLine } from "../../../src/rooms/phase/stages";
import { withdrawProblem } from "../../../src/rooms/phase/logic/design";
import { phaseRpc } from "../../../src/rooms/phase/server/rpc";
import { workFilePathError } from "../../../src/rooms/runs/server/work-file";
import { dropMemoryIndexes, memoryWithoutTrace, rebuildMemoryIndexes, storeMemoryRecords } from "../../../packages/memory-core/src";
import { setTaskHeldUntil } from "../../../src/rooms/storage";
import plugin from "../../../server";

const out: Record<string, unknown> = {};

// ---- n764: the conveyor door of the window, through the real plugin's rpc ----
{
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  const call = (params: Record<string, unknown>) => harness.behavior.callRpc("conveyor", params as never) as Promise<{ on: boolean; since: string | null; reason: string | null }>;
  const untouched = await call({});
  const off = await call({ set: "off", reason: " deploy window " });
  const again = await call({ set: "off", reason: "second" });
  const read = await call({});
  const on = await call({ set: "on" });
  out.conveyor = { untouched, off: { on: off.on, reason: off.reason, stamped: typeof off.since === "string" }, sameOnSecondOff: JSON.stringify(again) === JSON.stringify(off), sameOnRead: JSON.stringify(read) === JSON.stringify(off), on };
}

// ---- n772 / n759 / n784: the UAT line, the withdraw gate, the work-file path gate ----
{
  const text = "# UAT\r\n- [ ] 1. a: given g\r\n- [ ] 2. b: x\r\n";
  out.uat = { failed: markUatLine(text, 1, false, "bad"), passed: markUatLine("- [ ] 1. a: g", 1, true), none: markUatLine(text, 9, true) };
  const plan = { items: [{ id: "a" }, { id: "b" }], sha: "s" };
  const phase = (state: string, stage: string, issued: Record<string, string> = {}) => ({ id: "ph1", state, stage, record: { plan, execution: { issued } } }) as never;
  out.withdraw = { open: withdrawProblem(phase("active", "planning"), ["b"]), closed: withdrawProblem(phase("closed", "planning"), ["b"]), design: withdrawProblem(phase("active", "design"), ["b"]),
    unknown: withdrawProblem(phase("active", "planning"), ["zzz"]), issued: withdrawProblem(phase("active", "execution", { a: "a" }), ["a"]) };
  out.paths = Object.fromEntries(["src/app.ts", "../x", "/etc/passwd", ".git/config", "a/.env", "src/keyboard.ts"].map((path) => [path, workFilePathError(path)]));
}

// ---- n776 / n778: the board and the card of a task, on a scratch database ----
{
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "bb"); setRunThread(db, "run", "thr_pm");
  const contract = { id: "t", title: "Fix the form", display_title: "The form saves", kind: "fix", area: "page:form", objective: "Make the form save", acceptance: ["form saves"], owns_paths: ["src/form/**"], expected_outputs: ["src/form/save.ts"], depends_on: [], verification: [{ command: "npm test" }] };
  createTask(db, { id: "t", runId: "run", kind: "bb", contract });
  createAttempt(db, { id: "a1", runId: "run", taskId: "t" });
  for (const state of ["spawn_requested", "running"]) transitionAttempt(db, "a1", state, {});
  recordStage(db, { runId: "run", taskId: "t", stageId: "code-critique" as never, state: "failed" as never, input: "diff", reason: "dead code", threadId: "thr_c" });
  recordStage(db, { runId: "run", taskId: "t", stageId: "plan-critique" as never, state: "passed" as never, input: "plan", threadId: "thr_p" });
  const card = readTaskCard(db, { runId: "run", taskId: "t" })!;
  out.card = { title: card.title, techTitle: card.techTitle, state: card.state, contract: card.contract, stages: card.stages.map((stage) => `${stage.id}:${stage.state}`), pm: card.pmThreadId, missing: readTaskCard(db, { runId: "run", taskId: "nope" }) };
  const heldOf = () => buildTaskBoard(db, { projectId: "P", doneSince: 0 }).find((item) => item.taskId === "t")!;
  const free = heldOf();
  setTaskHeldUntil(db, "t", "run", Date.now() + 60_000);
  const held = heldOf();
  out.board = { column: free.column, free: free.held, held: held.held, title: free.title };
}

// ---- n769 / n770: the memory index rebuild and the lint's no-trace count ----
{
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run1", "P", "bb");
  const budgets = { coreBudget: 9_999, noteBudget: 99_999, indexBudget: 999_999 };
  const [id] = storeMemoryRecords(db, { projectId: "P", sourceSha256: "a".repeat(64), audience: "subagent", trust: "confirmed", entries: [{ kind: "note", content: "The ledger rounds half to even before storing the invoice total.", concepts: ["area"] }], nearDuplicates: false, ...budgets }).insertedIds;
  dropMemoryIndexes(db, "P", id!);
  const rebuilt = rebuildMemoryIndexes(db, "P");
  const again = rebuildMemoryIndexes(db, "P");
  const plant = (rowId: string, origin: string) => db.prepare("INSERT INTO lane_pilot_memory(id,project_id,kind,audience,content,concepts_json,source_sha256,created_at,trust,origin) VALUES(?,'P','note','subagent',?,'[]','',0,'confirmed',?)").run(rowId, `A fact nobody can trace (${rowId}) about nothing at all.`, origin);
  plant("orphan1", "maintainer"); plant("owner1", "owner"); plant("import1", "import");
  out.memory = { rebuilt, again, untraced: memoryWithoutTrace(db, "P").map((row) => row.id) };
}

// ---- n771: each stage action of the phase door reaches its own stage function ----
{
  const seen: string[] = [];
  const log = (name: string, result: unknown = { id: "ph1" }) => () => { seen.push(name); return result; };
  const api = { resolve: (_p: unknown, ref: string) => ({ id: ref }), status: (id: string) => ({ status: id }), open: log("open", { id: "ph_new" }), context: log("context"), plan: log("plan"), planCheck: log("planCheck"), drawing: log("drawing"), goalAudit: log("goalAudit"),
    correct: () => { seen.push("correct"); return { phase: { id: "ph1" } }; }, answer: log("answer"), lessons: log("lessons") } as never;
  const rpc = phaseRpc(api);
  const answers: unknown[] = [];
  for (const action of ["open", "context", "plan", "plan_check", "drawing", "goal_audit", "correct", "answer", "lessons"]) answers.push(await rpc.phase_act({ action, projectId: "p", pmThreadId: "t", phaseId: action === "open" ? null : "ph1", payload: {} } as never));
  out.stages = { seen, answers };
}

console.log(JSON.stringify(out)); // guardian: allow (the probe's one JSON line is its answer to the scene)
