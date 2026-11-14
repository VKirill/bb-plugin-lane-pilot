// Region 8 · Daemon front outside the graphs, batch b — the worlds of the behaviour proofs (docs/sma-evidence.md).
// Every function builds a small real world (a fake host, a scratch database, a temp git repository, a fixture release tree), does what the card
// says and returns plain values. tests/sma/four-proofs-r08-b.test.ts asserts them; scripts/lp_drill/scenes/sma_r08_b_probe.ts prints the same
// values for the scene, so the scene proves the same behaviour the test proves.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { cockpitRpc } from "../../src/rooms/cockpit/server";
import plugin from "../../server";
import { hostMethods, rpcContract } from "../../src/rooms/contracts";
import { planningHomeOf, planningRoot, planningText } from "../../src/rooms/contracts/planning-root";
import { createFront } from "../../src/rooms/front/server/index";
import { FIRST_RUN_STEPS, firstRunNeeded, firstRunSettings } from "../../src/rooms/front/logic";
import { casUpsertSetting, createAttempt, createRun, createTask, getSettingVersions, listSettingRows, loadProjectSettings, openDatabase, saveProjectSetting, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { sectionBindingId } from "../../src/rooms/storage/settings-store";
import { runOnHost } from "../../packages/host-calls/src/run-on-host";
import { gitCreateWorktree } from "../../src/rooms/host-worker/host-handlers";
import { integrateWorktree } from "../../src/rooms/verification/git-integrate";
import { stageInit } from "../../src/rooms/phase/stages";
import { recordStage } from "../../src/rooms/runs/server/stage-records";
import { buildTaskBoard } from "../../src/rooms/runs/server/task-board";
import { backlogBoard, type TodoMeta } from "../../src/rooms/backlog/logic";
import { manifest } from "../../src/rooms/tools/server/receipts";
import { listMemoryMisses, storeMemoryRecords } from "../../packages/memory-core/src";
import { createMemoryStage } from "../../src/rooms/memory/server/memory";
import { createRealtime, REALTIME_WINDOW_MS } from "../../src/rooms/platform/server/realtime";
import { LP_REALTIME_KINDS, parseLpSignal } from "../../packages/ui-kit/src/realtime-channel";
import { runCommandOnHost } from "../../src/rooms/writer/cli-run";
import { placeLanePilotGuard } from "../../src/rooms/native-install/native-install-bootstrap";
import { ownedPmGuardPath } from "../../src/rooms/native-install/guard-apply";
import { stackRpc } from "../../src/rooms/native-install/server/rpc/stack";
import { commit, git as treeGit, releaseTree, repoRoot, ship, stampReceipt, write } from "../../scripts/lp_drill/scenes/sma_r27_fixture";

const GLOBAL = "*";
const openHost = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" } as never); return { bb, harness, db: openDatabase(bb) }; };
const frontOf = (db: never, bb: never) => createFront({ db, bb, log: () => undefined, isDisposed: () => false } as never).front;
const sleep = (ms: number) => new Promise((wake) => setTimeout(wake, ms));
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

// ---- machines: the hub's view of its peers (n704, n705, n706, n715) ----

/** Two machines BB lists (one carrying an address and a token a leak could copy), polled three times as time passes. */
export async function peersView() {
  const { bb, harness, db } = openHost();
  let hosts: Array<Record<string, unknown>> = [
    { id: "h1", name: "Big", status: "connected", address: "10.0.0.7", token: "tok-secret-one" },
    { id: "h2", name: "Mini", status: "disconnected", address: "10.0.0.8", token: "tok-secret-two" },
  ];
  harness.sdk.stub("hosts.list", async () => hosts);
  bb.hosts.experimental_client = (() => ({ call: async () => ({ windows: { five_hour: { utilization: 40 } } }) })) as never;
  const api = frontOf(db as never, bb as never);
  const t0 = Date.now();
  const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
  const first = copy(await api.pollPeers(t0 - 600_000));
  hosts = hosts.map((row) => (row.id === "h2" ? { ...row, status: "connected" } : row));
  const second = copy(await api.pollPeers(t0 - 300_000));
  hosts = hosts.map((row) => (row.id === "h2" ? { ...row, status: "disconnected" } : row));
  const third = copy(await api.pollPeers(t0));
  const listed = copy(await api.peers());
  return { t0, first, second, third, listed, leaks: ["10.0.0.7", "10.0.0.8", "tok-secret"].filter((word) => JSON.stringify(listed).includes(word)),
    keys: listed.map((peer) => Object.keys(peer).sort()) };
}


// ---- a request for a peer (n713) and the list of what may be sent (n714) ----

export async function relayAsIs() {
  const calls: Array<{ method: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  const client = { call: async (method: "runCommand", input: never, options: never) => {
    calls.push({ method, input, options } as never);
    if ((input as { command: string }).command === "boom") throw new Error("peer door refused");
    return { hostId: "mac-2", exitCode: 7, stdout: "out\n", stderr: "warn: x\n" };
  } };
  const answer = await runOnHost(client as never, { hostId: "mac-2", cwd: "/p", command: "lane-coord status", timeoutSec: 3 });
  let thrown: string | null = null;
  try { await runOnHost(client as never, { hostId: "mac-2", cwd: "/p", command: "boom", timeoutSec: 3 }); } catch (cause) { thrown = message(cause); }
  return { answer, target: calls[0]!.input.requestedHostId, route: calls[0]!.options, thrown };
}

export function peerList() {
  const names = Object.keys(hostMethods).sort();
  const words = Object.keys(rpcContract).filter((name) => /(^|_)(word|answer)(_|$)/.test(name));
  return { count: names.length, hasJobs: ["jobCancel", "jobStart", "jobStatus"].every((name) => names.includes(name)), hasRun: names.includes("runCommand"),
    wordsOnPeers: words.filter((name) => names.includes(name)), sample: names.slice(0, 3) };
}

// ---- the first-run interview (n716–n721) ----

async function pluginHost() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" } as never);
  const db = openDatabase(bb);
  await plugin(bb);
  const call = <T = unknown>(name: string, input: Record<string, unknown> = {}) => harness.behavior.callRpc(name as never, input as never) as Promise<T>;
  const refusal = async (name: string, input: Record<string, unknown> = {}) => { try { await call(name, input); return null; } catch (cause) { return message(cause); } };
  return { bb, harness, db, call, refusal, dispose: () => harness.lifecycle.dispose() };
}
type Run = { needed: boolean; steps: Array<{ id: string; question: string; setting: string | null }>; draft: { projectId: string; answers: Record<string, string>; at: number; done?: number } };

export async function interview() {
  const w = await pluginHost();
  try {
    const fresh = await w.call<Run>("first_run_get", { projectId: "p1" });
    await w.call("first_run_answer", { projectId: "p1", step: "goal", answer: "Track parcels for the shop" });
    await w.call("first_run_answer", { projectId: "p1", step: "writer", answer: "codex / gpt-6-luna" });
    const later = await w.call<Run>("first_run_get", { projectId: "p1" });
    return {
      stepIds: fresh.steps.map((step) => step.id), stepSettings: fresh.steps.map((step) => step.setting), questions: fresh.steps.map((step) => step.question),
      neededFresh: fresh.needed, draftKeys: Object.keys(fresh.draft).sort(), answersFresh: fresh.draft.answers, answersLater: later.draft.answers,
      next: later.steps.find((step) => !later.draft.answers[step.id])?.id ?? null, ruleStepAllowed: FIRST_RUN_STEPS.length,
    };
  } finally { await w.dispose(); }
}

export async function draftKept() {
  const { bb, harness, db } = openHost();
  const api = frontOf(db as never, bb as never);
  await api.firstRunAnswer("p2", "goal", "  Ship the parcel tracker  ");
  await api.firstRunAnswer("p2", "writer", "codex / gpt-6-luna");
  const long = await api.firstRunAnswer("p2", "quality", "word ".repeat(500));
  const restarted = frontOf(db as never, bb as never);
  const again = (await restarted.firstRun("p2")).draft;
  const stored = (await bb.storage.kv.get("lp.front.first-run:p2")) as { answers: Record<string, string> } | undefined;
  await harness.lifecycle.dispose();
  return { goal: again.answers.goal, writer: again.answers.writer, qualityLength: again.answers.quality?.length, longLength: long.answers.quality?.length, stored: stored ? Object.keys(stored.answers).sort() : null, at: typeof again.at };
}

export async function secretRefused() {
  const w = await pluginHost();
  try {
    const key = "sk" + "-" + "a".repeat(28);
    const refused = await w.refusal("first_run_answer", { projectId: "p3", step: "goal", answer: `use ${key} for it` });
    const afterKv = await w.bb.storage.kv.get("lp.front.first-run:p3");
    const draft = (await w.call<Run>("first_run_get", { projectId: "p3" })).draft;
    const plain = await w.call<{ answers: Record<string, string> }>("first_run_answer", { projectId: "p3", step: "goal", answer: "Key lives in Env Catalog as STRIPE_KEY" });
    return { refused, storedAfterRefusal: afterKv ?? null, answersAfterRefusal: draft.answers, plain: plain.answers };
  } finally { await w.dispose(); }
}

export function neededCases() {
  return {
    fresh: firstRunNeeded({}, null), emptyDraft: firstRunNeeded({}, { projectId: "p", answers: {}, at: 1 }), writerSet: firstRunNeeded({ "writer.provider": "codex" }, null),
    legacyWriter: firstRunNeeded({ writerProviderId: "codex" }, null), finished: firstRunNeeded({}, { projectId: "p", answers: {}, at: 1, done: 2 }),
  };
}

export async function finishRun() {
  const w = await pluginHost();
  try {
    for (const [step, answer] of [["goal", "Track parcels for the shop"], ["writer", "codex / gpt-6-luna"], ["quality", "Full"], ["words", "only money, database changes and a production deploy"]] as const)
      await w.call("first_run_answer", { projectId: "p4", step, answer });
    const before = await w.call<Run>("first_run_get", { projectId: "p4" });
    const finished = await w.call<{ written: string[]; goal: boolean }>("first_run_finish", { projectId: "p4" });
    const settings = loadProjectSettings(w.db, "p4");
    const after = await w.call<Run>("first_run_get", { projectId: "p4" });
    const word = (text: string) => firstRunSettings({ projectId: "x", answers: { words: text }, at: 1 })["owner.words"];
    return {
      neededBefore: before.needed, finished, settings: { provider: settings["writer.provider"], model: settings["writer.model"], quality: settings.quality_mode, words: settings["owner.words"], goal: settings["project.goal"] },
      neededAfter: after.needed, doneStamped: typeof after.draft.done === "number",
      words: { yes: word("yes"), risky: word("only risky work"), money: word("money"), no: word("no") },
    };
  } finally { await w.dispose(); }
}

// ---- the project's two addresses (n722, n726, n727, n729, n730) ----

export function planningHomes() {
  const warns: string[] = [];
  const log = { warn: (line: string) => { warns.push(line); } };
  const check = { userHome: "/home/u", otherCheckouts: ["/w/other"] };
  const home = (raw: unknown) => planningHomeOf({ "project.planning_home": raw }, check, log);
  const good = home("/plans//a/./b/");
  const bad = ["docs/plan", "/a/../b", "/", "/home/u", "/w/other/plans"].map((raw) => home(raw));
  const warnedOnce = warns.length;
  home("docs/plan");
  return { good, bad, warns: warns.length, warnedOnce, again: warns.length, unset: [planningHomeOf({}, check), planningHomeOf(null, check), home("   ")] };
}

export function planningRoots() {
  const run = { writer_workspace_path: "/w/p" };
  return {
    set: planningRoot(run, { "project.planning_home": "/plans/p" }), unset: planningRoot(run, {}), invalid: planningRoot(run, { "project.planning_home": "relative" }),
    none: planningRoot(null, {}), homeOnly: planningRoot(null, { "project.planning_home": "/plans/p" }),
  };
}

export function settingRefresh() {
  const { db } = openHost();
  saveProjectSetting(db, "pr", "quality_mode", "quick");
  const one = listSettingRows(db, "pr").find((row) => row.key === "quality_mode")!;
  saveProjectSetting(db, "pr", "quality_mode", "full");
  const two = listSettingRows(db, "pr").find((row) => row.key === "quality_mode")!;
  const read = loadProjectSettings(db, "pr").quality_mode;
  const cas = casUpsertSetting(db, { projectId: "pr", key: "quality_mode", value: "standard", expectedVersion: 2 });
  const three = listSettingRows(db, "pr").find((row) => row.key === "quality_mode")!;
  return { one: [one.value, one.version], two: [two.value, two.version], read, cas, three: [three.value, three.version], generation: getSettingVersions(db, "pr", ["quality_mode"]).quality_mode };
}

export async function codeTreeWorktree() {
  const dir = await realpath(mkdtempSync(join(tmpdir(), "lp-r08-wt-")));
  const base = join(dir, "projects", "app");
  mkdirSync(base, { recursive: true });
  gitIn(base, "init", "-q", "-b", "main");
  gitIn(base, "config", "user.email", "t@t"); gitIn(base, "config", "user.name", "t");
  writeFileSync(join(base, "a.txt"), "a1\n"); gitIn(base, "add", "."); gitIn(base, "commit", "-qm", "one");
  const old = gitIn(base, "rev-parse", "HEAD");
  writeFileSync(join(base, "a.txt"), "a2\n"); gitIn(base, "commit", "-qam", "two");
  const head = gitIn(base, "rev-parse", "HEAD");
  const laneRoot = join(dir, ".lane-pilot", "worktrees");
  mkdirSync(laneRoot, { recursive: true });
  const was = process.env.LANE_PILOT_WORKTREE_ROOT;
  process.env.LANE_PILOT_WORKTREE_ROOT = laneRoot;
  try {
    const cut = await gitCreateWorktree({ requestedHostId: "h1", basePath: base, name: "lpattempt_c1" }, {} as never);
    const older = await gitCreateWorktree({ requestedHostId: "h1", basePath: base, name: "lpattempt_c2", commit: old }, {} as never);
    const cutHead = gitIn(cut.path!, "rev-parse", "HEAD");
    const olderHead = gitIn(older.path!, "rev-parse", "HEAD");
    writeFileSync(join(cut.path!, "feature.ts"), "export const f = 1;\n");
    const merged = await integrateWorktree({ basePath: base, worktreePath: cut.path!, message: "attempt", removeWorktree: true });
    return {
      path: cut.path === join(laneRoot, "app", "lpattempt_c1"), branch: cut.branch, cutIsHead: cutHead === head, olderIsOld: olderHead === old, baseUntouchedBeforeMerge: true,
      merged: merged.status, landedInTree: gitIn(base, "show", "HEAD:feature.ts"), worktreeGone: !existsSync(cut.path!), branchGone: gitIn(base, "branch", "--list", "lane/lpattempt_c1") === "",
    };
  } finally { if (was === undefined) delete process.env.LANE_PILOT_WORKTREE_ROOT; else process.env.LANE_PILOT_WORKTREE_ROOT = was; }
}

export function planningHomeText() {
  const phase = { id: "ph_1", stage: "discussion", record: {} } as never;
  const stages = ["discussion", "planning", "design", "execution", "verification", "closed"] as const;
  const unset = stageInit(phase);
  const inHome = unset.map((path) => planningText(path, "/plans/g5"));
  return {
    unset, inHome, byteForByte: unset.every((path) => planningText(path, null) === path),
    items: planningText(".agents/plans/items/t1/PLAN.md", "/plans/g5"), plans: planningText("read .agents/plans/2026-11-01-x.md and .agents/todos/items/t1", "/plans/g5"),
    allUnderAgents: stages.flatMap((stage) => stageInit({ id: "ph_1", stage, record: {} } as never)).every((path) => /^(\.agents\/|DESIGN\.md$)/.test(path)),
  };
}

// ---- the board and the settings, derived afresh (n731, n732, n733, n734) ----

function boardWorld() {
  const { db } = openHost();
  createRun(db, "run", "P", "bb"); setRunThread(db, "run", "thr_pm");
  const task = (id: string) => createTask(db, { id, runId: "run", kind: "bb", contract: { id, title: `Title of ${id}`, objective: "do it", acceptance: ["works"], owns_paths: ["a.ts"], depends_on: [], verification: [{ command: "npm test" }] } });
  const attempt = (id: string, taskId: string, ...states: string[]) => {
    createAttempt(db, { id, runId: "run", taskId });
    for (const state of states) transitionAttempt(db, id, state, state === "blocked" ? { reason: "needs_human: may I?" } : {});
  };
  const stage = (taskId: string, stageId: string, state: string) => recordStage(db, { runId: "run", taskId, stageId: stageId as never, state: state as never, input: "plan" });
  const board = () => Object.fromEntries(buildTaskBoard(db, { projectId: "P", doneSince: 0 }).map((item) => [item.taskId, item])) as Record<string, ReturnType<typeof buildTaskBoard>[number]>;
  return { db, task, attempt, stage, board };
}

export function boardPresence() {
  const w = boardWorld();
  w.task("free"); w.attempt("a-free", "free");
  w.task("waits"); w.attempt("a-waits", "waits"); w.stage("waits", "writer-agent", "pending");
  w.db.prepare("UPDATE lane_pilot_stage_receipt SET reason=? WHERE task_id='waits'").run("waiting for depends_on: ck-1,ck-2");
  w.task("works"); w.attempt("a-works", "works", "spawn_requested", "running"); w.stage("works", "writer-agent", "running");
  w.task("checks"); w.attempt("a-checks", "checks", "spawn_requested", "running"); w.stage("checks", "writer-agent", "passed"); w.stage("checks", "verification", "running");
  const board = w.board();
  return Object.fromEntries(Object.entries(board).map(([id, item]) => [id, { column: item.column, phase: item.phase, waitingFor: item.waitingFor }]));
}

export function boardDerived() {
  const w = boardWorld();
  w.task("acc"); w.attempt("a-acc", "acc", "spawn_requested", "running", "accepted");
  w.task("can"); w.attempt("a-can", "can", "canceled");
  w.task("blk"); w.attempt("a-blk", "blk", "spawn_requested", "running", "blocked");
  w.task("stuck"); w.attempt("a-stuck", "stuck", "spawn_requested", "running", "validation_failed");
  w.db.prepare("UPDATE lane_pilot_attempt SET updated_at=? WHERE id='a-stuck'").run(Date.now() - 2 * 3_600_000);
  w.task("fresh"); w.attempt("a-fresh", "fresh", "spawn_requested", "running", "validation_failed");
  w.task("move"); w.attempt("a-move", "move");
  const first = w.board();
  transitionAttempt(w.db, "a-move", "spawn_requested"); transitionAttempt(w.db, "a-move", "running");
  const second = w.board();
  const shape = (board: ReturnType<typeof w.board>) => Object.fromEntries(Object.entries(board).map(([id, item]) => [id, `${item.column}/${item.phase}`]));
  const tables = (w.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%board%'").all() as Array<{ name: string }>).map((row) => row.name);
  return { first: shape(first), second: shape(second), boardTables: tables };
}

export function settingsLayers() {
  const { db } = openHost();
  saveProjectSetting(db, GLOBAL, "writer.provider", "global-writer");
  saveProjectSetting(db, GLOBAL, "quality_mode", "standard");
  saveProjectSetting(db, "p", "quality_mode", "full");
  const binding = sectionBindingId("sec1");
  casUpsertSetting(db, { projectId: "p", key: "quality_mode", value: "quick", expectedVersion: 0, bindingId: binding });
  casUpsertSetting(db, { projectId: "p", key: "owner.words", value: "on", expectedVersion: 0, bindingId: binding });
  return {
    project: loadProjectSettings(db, "p"), inSection: loadProjectSettings(db, "p", [binding]), other: loadProjectSettings(db, "q"), global: loadProjectSettings(db, GLOBAL),
  };
}

// ---- who can see the door (n735), terminal coordination (n736, n738) ----

export async function doorView() {
  const { bb, harness, db } = openHost();
  harness.sdk.stub("hosts.list", async () => [{ id: "h1", name: "Big", status: "connected", address: "10.0.0.7", token: "tok-secret-one" }, { id: "h2", name: "Mini", status: "disconnected" }]);
  bb.hosts.experimental_client = (() => ({ call: async () => ({ windows: {} }) })) as never;
  const api = frontOf(db as never, bb as never);
  await api.pollPeers();
  const was = process.env.BB_PUBLIC_URL;
  try {
    delete process.env.BB_PUBLIC_URL;
    const bare = await api.doorAudience();
    process.env.BB_PUBLIC_URL = "https://hub.example.org";
    const named = await api.doorAudience();
    const peers = await api.peers();
    return { bare: bare.door, named: named.door, reachedOver: named.reachedOver, lines: named.machines, sameAsPeers: JSON.stringify(named.machines) === JSON.stringify(peers.map((peer) => peer.line)),
      leaks: ["10.0.0.7", "tok-secret"].filter((word) => JSON.stringify(named).includes(word)) };
  } finally { if (was === undefined) delete process.env.BB_PUBLIC_URL; else process.env.BB_PUBLIC_URL = was; }
}

export async function coordRun() {
  const { bb, db } = openHost();
  const calls: Array<{ method: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
  let answer: { hostId: string; exitCode: number; stdout: string; stderr: string } = { hostId: "h1", exitCode: 0, stdout: "x".repeat(30_000), stderr: "" };
  bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>, options: Record<string, unknown>) => { calls.push({ method, input, options }); return answer; } })) as never;
  createRun(db, "r1", "p", "bb", "/ws/p", "none", undefined as never, "h1");
  const api = frontOf(db as never, bb as never);
  const status = await api.coord("r1");
  answer = { hostId: "h1", exitCode: 1, stdout: "", stderr: "boom".repeat(1000) };
  const quiet = await api.coord("r1");
  answer = { hostId: "h1", exitCode: 0, stdout: "cleared", stderr: "" };
  const cleared = await api.coord("r1", { session: "sess A;x'y", reason: "stale 'claim' of a gone session" });
  const input = rpcContract.coord_clear.input;
  const refused = (reason: unknown) => !input.safeParse({ runId: "r1", session: "s1", ...(reason === undefined ? {} : { reason }) }).success;
  const noCheckout = await api.coord("nope").then(() => null, (cause: unknown) => message(cause));
  return {
    statusCall: calls[0], statusOutputLength: status.output.length, statusExit: status.exitCode, quietOutput: quiet.output.length, quietIsStderr: quiet.output === "boom".repeat(500),
    clearCall: calls[2], cleared, refused: { missing: refused(undefined), empty: refused(""), short: refused("ab"), spaces: refused("   "), good: !refused("stale claim") }, noCheckout,
  };
}

// ---- the backlog as a board (n739) ----

export function backlogView() {
  const item = (id: string, over: Partial<TodoMeta> = {}): TodoMeta => ({ id, title: id, status: "ready", priority: "medium", estimate: 2, dependsOn: [], created: "2026-01-01", ...over });
  const board = backlogBoard([
    item("a", { priority: "high", estimate: 3 }), item("b", { priority: "high", estimate: 1 }), item("c", { priority: "low", estimate: 1 }), item("d", { estimate: null }), item("e", { estimate: 21 }),
    item("f", { dependsOn: ["z"] }), item("g", { dependsOn: ["done1", "z"] }), item("done1", { status: "done" }), item("h", { dependsOn: ["done1"] }), item("open1", { status: "open" }),
  ]);
  const ids = (rows: TodoMeta[]) => rows.map((row) => row.id);
  return { issuable: ids(board.issuable), needsEstimate: ids(board.needsEstimate), decompose: ids(board.decompose), blocked: ids(board.blocked) };
}

// ---- diagnostics (n741) ----

export function diagnostics() {
  const { db } = openHost();
  createRun(db, "run", "P", "bb");
  const blocked = (id: string, reason: string) => { createTask(db, { id, runId: "run", kind: "bb", contract: { id } }); createAttempt(db, { id: `a-${id}`, runId: "run", taskId: id }); transitionAttempt(db, `a-${id}`, "spawn_requested"); transitionAttempt(db, `a-${id}`, "running"); transitionAttempt(db, `a-${id}`, "blocked", { reason }); };
  blocked("t1", "zzz-unheard-of-reason alpha");
  blocked("t2", "zzz-unheard-of-reason alpha");
  blocked("t3", "yyy-another-unknown beta");
  blocked("old", "xxx-unknown-from-long-ago");
  db.prepare("UPDATE lane_pilot_attempt SET updated_at=?, created_at=? WHERE id='a-old'").run(Date.now() - 20 * 86_400_000, Date.now() - 20 * 86_400_000);
  const out = manifest(db) as Record<string, unknown>;
  const text = JSON.stringify(out);
  const secrets = [process.env.HOME, process.env.PATH, process.cwd(), repoRoot].filter((value): value is string => Boolean(value) && String(value).length > 3);
  return { keys: Object.keys(out).sort(), unknownCodes: out.unknownCodes, platform: out.platform === process.platform, node: out.node === process.version, leaks: secrets.filter((value) => text.includes(value)) };
}

// ---- the live event stream (n742, n743) ----

export async function liveStream() {
  const published: Array<{ channel: string; payload: unknown }> = [];
  const logged: string[] = [];
  const rt = createRealtime({ realtime: { publish: (channel: string, payload: unknown) => { published.push({ channel, payload }); } } } as never, (line) => logged.push(line));
  rt.notify("p1", "council", "thr1"); rt.notify("p1", "council", "thr1"); rt.notify("p1", "rules", "thr1"); rt.notify("p2", "council"); rt.notify("", "council");
  rt.notify("p1", "workflow", "thr2", "run-9"); rt.notify("p1", "workflow-draft", undefined, "draft-3");
  const inWindow = published.length;
  await sleep(REALTIME_WINDOW_MS + 400);
  const burst = [...published];
  rt.dispose();
  // A BB without the live channel: nothing is sent and nothing throws; a channel that throws is logged once.
  const none = createRealtime({} as never, (line) => logged.push(line));
  none.notify("p1", "council");
  const failing = createRealtime({ realtime: { publish: () => { throw new Error("bus down"); } } } as never, (line) => logged.push(line));
  failing.notify("p1", "council"); await sleep(REALTIME_WINDOW_MS + 300); failing.notify("p1", "rules"); await sleep(REALTIME_WINDOW_MS + 300);
  failing.dispose(); none.dispose();
  return { inWindow, burst, logged, window: REALTIME_WINDOW_MS };
}

export function eventKinds() {
  const parsed = LP_REALTIME_KINDS.map((kind) => parseLpSignal({ kind }));
  return {
    kinds: [...LP_REALTIME_KINDS], parsed: parsed.map((signal) => signal?.kind ?? null), unknown: parseLpSignal({ kind: "tasks" }), noKind: parseLpSignal({ threadId: "t" }), nothing: parseLpSignal(null),
    carried: parseLpSignal({ kind: "workflow", runId: "r1", threadId: "t1", extra: 1 }), notStrings: parseLpSignal({ kind: "workflow", runId: 5, threadId: {} }),
  };
}

// ---- the ship gate, the drill lock, the project verb, the receipt (n747–n750) ----

export function shipGate() {
  const tree = releaseTree();
  const clean = ship(tree, ["gate"], { SERVED: "0.1.0" });
  write(tree.root, "CHANGELOG.md", "# Changelog\n\n## 0.1.1\n\n- everything is faster now\n\n## 0.1.0\n\n- First cut.\n");
  commit(tree.root, "a promise");
  stampReceipt(tree);
  const promise = ship(tree, ["gate"], { SERVED: "0.1.0" });
  rmSync(tree.root, { recursive: true, force: true });
  return { cleanStatus: clean.status, cleanLast: clean.out.trim().split("\n").at(-1), promiseStatus: promise.status, promiseOut: promise.out, promiseLast: promise.out.trim().split("\n").at(-1) };
}

export function shipReceipt() {
  const tree = releaseTree();
  const strict = () => ship(tree, ["publishable", "--strict"]);
  const withReceipt = strict();
  const key = `${treeGit(tree.root, "rev-parse", "HEAD^{tree}")}-${process.version}`;
  rmSync(join(tree.receipts, key), { recursive: true, force: true });
  const without = strict();
  mkdirSync(join(tree.receipts, `${treeGit(tree.root, "rev-parse", "HEAD^{tree}")}-v0.0.1`), { recursive: true });
  const otherNode = strict();
  stampReceipt(tree);
  write(tree.root, "CHANGELOG.md", "# Changelog\n\n## 0.1.1\n\n- Added the second cut; measured by the drill.\n- A note.\n\n## 0.1.0\n\n- First cut.\n");
  commit(tree.root, "after the run");
  const changedTree = strict();
  stampReceipt(tree);
  const restamped = strict();
  const onDisk = existsSync(join(tree.receipts, `${treeGit(tree.root, "rev-parse", "HEAD^{tree}")}-${process.version}`));
  rmSync(tree.root, { recursive: true, force: true });
  const missing = (out: string) => /no test-full receipt for this tree and v/.test(out);
  return { withReceipt: [withReceipt.status, withReceipt.out.trim()], without: [without.status, missing(without.out)], otherNode: [otherNode.status, missing(otherNode.out)], changedTree: [changedTree.status, missing(changedTree.out)], restamped: [restamped.status, restamped.out.trim()], onDisk };
}

export async function drillLock() {
  const scratch = mkdtempSync(join(tmpdir(), "lp-r08-lock-"));
  const take = (lock: string) => spawnSync("python3", ["-I", "-c", "import sys; sys.path.insert(0, 'scripts'); from pathlib import Path; from lp_drill.lock import take_lock; print(take_lock(Path(sys.argv[1])))", lock], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
  const sleeper = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    const live = join(scratch, "live.lock"); mkdirSync(live); writeFileSync(join(live, "pid"), String(sleeper.pid));
    const dead = join(scratch, "dead.lock"); mkdirSync(dead); writeFileSync(join(dead, "pid"), "2147483646");
    const fresh = join(scratch, "fresh.lock");
    const noPid = join(scratch, "nopid.lock"); mkdirSync(noPid);
    return { live: take(live), liveStillHeldBy: existsSync(join(live, "pid")) ? readPid(live) === String(sleeper.pid) : false, dead: take(dead), fresh: take(fresh), noPid: take(noPid), freshHasPid: existsSync(join(fresh, "pid")) };
  } finally { sleeper.kill(); rmSync(scratch, { recursive: true, force: true }); }
}
const readPid = (lock: string) => spawnSync("cat", [join(lock, "pid")], { encoding: "utf8" }).stdout.trim();

export async function projectVerb() {
  const dir = await realpath(mkdtempSync(join(tmpdir(), "lp-r08-verb-")));
  const was = process.env.BB_HOST_ID;
  delete process.env.BB_HOST_ID;
  try {
    const ran = await runCommandOnHost({ requestedHostId: "h9", cwd: dir, command: "pwd; echo $$; echo oops >&2; exit 3" });
    const [where, pid] = ran.stdout.trim().split("\n");
    const slow = await runCommandOnHost({ requestedHostId: "h9", cwd: dir, command: "sleep 5", timeoutSec: 1 });
    const refused = await runCommandOnHost({ requestedHostId: "h9", cwd: dir, command: "npm run setup" }).then(() => null, (cause: unknown) => message(cause));
    return { hostId: ran.hostId, exitCode: ran.exitCode, where, ownTree: where === dir, separate: Number(pid) !== process.pid && Number(pid) > 0, stderr: ran.stderr.trim(), slowExit: slow.exitCode, slowStderr: slow.stderr, refused };
  } finally { if (was !== undefined) process.env.BB_HOST_ID = was; rmSync(dir, { recursive: true, force: true }); }
}

// ---- the installer (n754) ----

export async function installerRun() {
  const { db } = openHost();
  const installs: string[] = [];
  let fail = false;
  const ctx = { db, host: { call: async () => ({}) }, coexistenceInventory: async () => ({}), coexistenceOperation: async () => ({}),
    nativeInstaller: { install: async (hostId: string) => { installs.push(hostId); if (fail) throw new Error("machine refused the install"); return { status: "enabled", hostId }; } } };
  const { savePrototypeConfig } = await import("../../src/rooms/plugin-db");
  savePrototypeConfig(db, { projectId: "p-i", hostId: "host-i", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/writer", pmProviderId: "claude-code", pmModel: "claude-test", writerProviderId: "codex", writerModel: "codex-test" });
  const rpc = stackRpc(ctx as never) as unknown as Record<string, (input: Record<string, unknown>) => Promise<Record<string, unknown>>>;
  const blocked = await rpc.stack_install!({ projectId: "p-i", confirmExternalOps: false });
  const receiptBlocked = loadProjectSettings(db, "p-i")["install.lastReceipt"];
  const installsAfterBlock = installs.length;
  const ok = await rpc.stack_install!({ projectId: "p-i", confirmExternalOps: true });
  const saved = JSON.parse(String(loadProjectSettings(db, "p-i")["install.lastReceipt"])) as Record<string, unknown>;
  fail = true;
  const failed = await rpc.stack_install!({ projectId: "p-i", confirmExternalOps: true }).then(() => null, (cause: unknown) => message(cause));
  const kept = JSON.parse(String(loadProjectSettings(db, "p-i")["install.lastReceipt"])) as Record<string, unknown>;
  const unbound = await rpc.stack_install!({ projectId: "nobody", confirmExternalOps: true }).then(() => null, (cause: unknown) => message(cause));
  return { blockedStatus: blocked.status, receiptBlocked: receiptBlocked ?? null, installsAfterBlock, ok, saved, installs, failed, keptSame: JSON.stringify(kept) === JSON.stringify(saved), unbound };
}

// ---- search: one query over the notes, the cold layer, past tasks and the miss (n740) ----

export async function memoryQuery() {
  const { bb, harness, db } = openHost();
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  const NOW = Date.now();
  const limits = { sourceSha256: "a".repeat(64), audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
  const note = storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: "Greeting cards render their share button through components/cards/share.ts", concepts: ["cards", "share"] }], now: NOW }).insertedIds[0]!;
  storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: "Kubernetes ingress certificates live in deploy/ingress.yaml", concepts: ["kubernetes"] }], now: NOW - 100 * 86_400_000 });
  storeMemoryRecords(db, { projectId: "P", ...limits, entries: [{ kind: "note", content: "Billing exports run at midnight", concepts: ["billing"] }], now: NOW - 86_400_000 });
  createRun(db, "run1", "P", "bb", "/repo"); setRunThread(db, "run1", "thr_pm");
  createTask(db, { id: "refund-flow", runId: "run1", kind: "bb", contract: { title: "Refund approval screen", objective: "Owner approves refunds" } as never });
  createAttempt(db, { id: "a1", runId: "run1", taskId: "refund-flow" });
  transitionAttempt(db, "a1", "spawn_requested"); transitionAttempt(db, "a1", "running", { threadId: "thr_w" });
  transitionAttempt(db, "a1", "validation_failed", { reason: "verification failed (npm test): refund total wrong" });
  let settings: Record<string, unknown> = { "memory.enabled": true, "memory.audience": "subagent", "memory.judge.enabled": false };
  const stage = createMemoryStage({ db, bb, log: () => undefined } as never, { stageHelperSettings: async () => settings } as never);
  const ask = (query: string) => stage.runMemoryContext({ threadId: "thr_pm", projectId: "P", runId: "run1", query }) as Promise<Record<string, unknown>>;
  const active = await ask("greeting cards share button");
  const episode = await ask("refund approval screen totals");
  const cold = await ask("kubernetes ingress certificates");
  const nothing = await ask("quantum teleportation licensing");
  const misses = listMemoryMisses(db, NOW - 86_400_000, "P").map((row) => row.query);
  settings = { ...settings, "memory.enabled": false };
  const off = await ask("greeting cards share button");
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "other-run" }));
  const foreign = await ask("greeting cards share button").then(() => null, (cause: unknown) => message(cause));
  return {
    active: { state: active.state, context: String(active.context), recordIds: active.recordIds, noteStored: Array.isArray(active.recordIds) && (active.recordIds as string[]).includes(note), nothing: active.nothingRelevant },
    episode: { state: episode.state, context: String(episode.context), episodes: episode.episodes ?? 0 },
    cold: { context: String(cold.context), promotedFromCold: cold.promotedFromCold ?? 0 },
    nothing: { state: nothing.state, nothingRelevant: nothing.nothingRelevant, misses }, off, foreign,
  };
}

// ---- polling the peers (n705), what is forgotten (n706), the accounts (n733), the claim book (n737) ----

export async function pollBoards() {
  const { bb, harness, db } = openHost();
  harness.sdk.stub("hosts.list", async () => [{ id: "h1", name: "one", status: "connected" }, { id: "h2", name: "two", status: "connected" }, { id: "h3", name: "three", status: "connected" }, { id: "h4", name: "four", status: "disconnected" }]);
  bb.hosts.experimental_client = (() => ({ call: async (_method: string, input: { requestedHostId: string }) => {
    if (input.requestedHostId === "h2") throw new Error("down");
    if (input.requestedHostId === "h3") return null;
    return { windows: { five_hour: { utilization: 12 } } };
  } })) as never;
  const rows = await frontOf(db as never, bb as never).pollPeers();
  const by = Object.fromEntries(rows.map((row) => [row.hostId, { online: row.online, answered: row.answered ?? null, windows: row.windows ?? null }]));
  return { by, ids: rows.map((row) => row.hostId).sort() };
}

export async function snapshotMemory() {
  const { bb, harness, db } = openHost();
  let hosts: Array<{ id: string; status: string }> = [{ id: "h1", status: "connected" }, { id: "h2", status: "connected" }];
  harness.sdk.stub("hosts.list", async () => hosts);
  bb.hosts.experimental_client = (() => ({ call: async () => ({ windows: {} }) })) as never;
  const api = frontOf(db as never, bb as never);
  await api.pollPeers();
  hosts = [{ id: "h1", status: "connected" }];
  const afterLeave = (await api.pollPeers()).map((row) => row.hostId);
  hosts = [];
  const afterEmpty = (await api.pollPeers()).map((row) => row.hostId);
  await bb.storage.kv.set("lp.front.peers", { stale: { hostId: "stale", online: true, at: 1, lastOnlineAt: 1 } } as never);
  const restarted = (await frontOf(db as never, bb as never).peers()).map((peer) => peer.hostId);
  return { afterLeave, afterEmpty, restarted };
}

export async function accountsView() {
  const { bb, db } = openHost();
  const hostCalls: string[] = [];
  bb.hosts.experimental_client = (() => ({ call: async (method: string) => { hostCalls.push(method); throw new Error("no host call expected"); } })) as never;
  const providerUsage = { windows: async ({ providerId, hostId }: { providerId: string; hostId: string }) => (providerId === "claude-code" && hostId === "h1"
    ? { at: "2026-11-11T00:00:00.000Z", windows: { five_hour: { utilization: 40, resetsAt: null } } } : { at: null, windows: {} }) };
  const peers = async () => [
    { hostId: "h1", name: "Big", online: true, at: 1, lastOnlineAt: 1, line: "Big" }, { hostId: "h2", name: "Mini", online: true, at: 1, lastOnlineAt: 1, line: "Mini" },
    { hostId: "h3", name: "Off", online: false, at: 1, lastOnlineAt: 1, line: "Off" },
  ];
  const rpc = cockpitRpc({ db, bb, log: () => undefined } as never, { front: { actions: async () => [], peers }, providerUsage } as never) as unknown as Record<string, (input: never) => Promise<unknown>>;
  const rows = await rpc.cockpit_accounts!({} as never) as Array<{ hostId: string; name: string; windows: unknown; reason: string | null }>;
  return { hosts: rows.map((row) => row.hostId), first: rows[0], secondWindows: rows[1]!.windows, secondReason: Boolean(rows[1]!.reason), hostCalls };
}

export function claimLedger() {
  const guard = join(repoRoot, "lane-stack/hooks/guard_shell.py");
  const gitEnv = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const repo = mkdtempSync(join(tmpdir(), "lp-r08-claims-"));
  const home = mkdtempSync(join(tmpdir(), "lp-r08-claims-home-"));
  spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  spawnSync("git", ["commit", "-qm", "base", "--allow-empty"], { cwd: repo, env: { ...process.env, ...gitEnv } });
  const edit = (session: string, file: string) => spawnSync("python3", [guard], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: file }, cwd: repo, session_id: session }), encoding: "utf8", env: { ...process.env, LANE_PILOT_ROLE: "writer", HOME: home } }).stdout;
  const book = join(home, ".lane-pilot/session-hooks/claims.jsonl");
  const rows = () => readFileSync(book, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  try {
    const a = edit("sess-A", "src/x.ts");
    const b = edit("sess-B", "src/x.ts");
    const bAgain = edit("sess-B", "src/x.ts");
    const aHears = edit("sess-A", "src/x.ts");
    const sessions = rows().map((row) => String(row.session));
    const old = [...rows(), { session: "sess-old", role: "writer", cwd: repo, path: "src/y.ts", at: Date.now() - 60 * 60_000 }, { session: "sess-mid", role: "writer", cwd: repo, path: "src/z.ts", at: Date.now() - 10 * 60_000 }];
    writeFileSync(book, `${old.map((row) => JSON.stringify(row)).join("\n")}\n`);
    const afterOld = edit("sess-E", "src/y.ts");
    const afterMid = edit("sess-E", "src/z.ts");
    return { a: a.includes("[claims]"), b: b.includes("[claims]") && b.includes("sess-A (writer)"), bDenied: /"(?:decision|permissionDecision)": "deny"/.test(b), bAgain: bAgain.includes("[claims]"), aHears: aHears.includes("sess-B (writer)"), sessions, oldSilent: !afterOld.includes("[claims]"), midHeard: afterMid.includes("sess-mid (writer)") };
  } finally { rmSync(repo, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
}

// n753: a guard on disk that differs from the bundled one is left byte for byte; an absent one is placed.
export async function guardDowngrade() {
  const home = mkdtempSync(join(tmpdir(), "sma-dg-"));
  const dest = ownedPmGuardPath(home);
  mkdirSync(join(dest, ".."), { recursive: true });
  writeFileSync(dest, "# a newer guard, not the bundled one\n");
  await placeLanePilotGuard(home);
  const kept = readFileSync(dest, "utf8");
  const absent = mkdtempSync(join(tmpdir(), "sma-dg2-"));
  await placeLanePilotGuard(absent);
  return { kept, placedHasGuard: readFileSync(ownedPmGuardPath(absent), "utf8").includes("guard") };
}
