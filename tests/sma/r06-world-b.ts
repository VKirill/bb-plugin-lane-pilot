// Region 6 (Conversation and intake), batch b: the scratch worlds the node tests (tests/sma/four-proofs-r06-b.test.ts) and the scene probe
// (scripts/lp_drill/scenes/sma_r06_b_probe.ts) share. Every function runs the REAL code of this checkout on a fake host, a scratch database,
// a temp folder or stand-in tools: no model, no hub write, nothing outside the machine. It returns what it saw as plain values; the callers judge.
// No vitest import: the probe loads this file outside vitest.
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { backlogBoard, backlogMatches, issueMessage, parseTodoMeta, type TodoMeta } from "../../src/rooms/backlog/logic";
import { backlogReadCommand, parseBacklogOutput } from "../../src/rooms/backlog";
import { BACKLOG_MARK } from "../../src/rooms/backlog/logic";
import { createBacklog } from "../../src/rooms/backlog/server/scanner";
import { createCore } from "../../src/rooms/core/server/core";
import { closeBacklogItem, gateRun, runCommand } from "../../src/rooms/host-worker/host-handlers";
import { registeredTools } from "../../src/rooms/platform/server";
import { ToolError } from "../../src/rooms/contracts/server";
import { createActivation } from "../../src/rooms/native-agent/server/activation";
import { createPmTurnWatch, mountPmTurnWatch, PM_TURN_OUTCOME_PREFIX } from "../../src/rooms/stability/server/pm-turn-watch";
import { createWriterDispatch } from "../../src/rooms/writer/server/dispatch";
import { registerConversationTools } from "../../src/rooms/tasks/server/conversation-tools";
import { registerTools } from "../../src/rooms/tools/server/tools";
import { bindBacklogIssued, registerQueueTool } from "../../src/rooms/tasks/server/queue-tool";
import { backlogIssuedTo } from "../../src/rooms/backlog";
import { lintContract } from "../../src/rooms/tasks/server/contract-lint";
import { validateTaskV2 } from "../../src/rooms/tasks/task-v2";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread, transitionAttempt } from "../../src/rooms/plugin-db";
import { pmBoardBlock } from "../../src/rooms/learning/pm-rules";
import { rubricLine } from "../../src/rooms/phase/stages";
import { syncTokenUsage, queryTokenUsage, tokenCursorRow, utcDay } from "../../src/rooms/usage/server/token-usage";
import { listOpenAttempts, listStageReceipts } from "../../src/rooms/plugin-db";
import { buildOwnerAskPayload } from "../../src/rooms/relay/owner-ask";
import { ASK_KINDS, readOwnerAskPayload } from "../../src/rooms/relay/owner-ask-shared";
import { createPhaseDriver } from "../phase-driver";
import { savePhase } from "../../src/rooms/phase/store";
import { appendTaskQa, noteTaskQa } from "../../src/rooms/writer/server/reopen-attempt";
import { appendTaskQaHome, bbTaskFileIo, writeDispatchHome } from "../../src/rooms/writer/server/task-home";
import { renderTaskManifest, resolveTaskFile } from "../../src/rooms/storage";
import { laneQueueOf } from "../../src/rooms/tasks";
import { proposeTaskWords, taskWords } from "../../src/rooms/cockpit/ui/screens-work";
import { boundaryLineOf } from "../../src/rooms/native-agent/ui/composer-boundary";
import { runDraftTest, testCasesOf } from "@lane-pilot/workflow-engine";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import type { Services } from "../../server";
import type { PlanItem } from "../../src/rooms/phase/logic";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";
import { taskV2Schema } from "../../src/rooms/contracts";

const callCtx = (threadId = "thr", projectId = "proj") => ({ threadId, projectId, signal: new AbortController().signal });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

// ---------------------------------------------------------------------------------------------------------------------------------
// The backlog (n576-n586, n594): the rules on items, the scanner on a fake host, the close on a temp folder.

const todo = (id: string, extra: string): TodoMeta => parseTodoMeta(`id: ${id}\ntitle: "Item ${id}"\ncreated: 2026-10-0${id.slice(-1)}T00:00:00Z\n${extra}\n`)!;

/** n578-n583 and n594: the board's sorting of ready lines, the message of an issued line, the match of a phrase with open lines. */
export function observeBacklogRules() {
  const board = backlogBoard([
    todo("1", "status: ready\npriority: high\nestimate: 13"),
    todo("2", "status: ready\npriority: high"),
    todo("3", "status: ready\npriority: high\nestimate: 14"),
    todo("4", "status: ready\npriority: low\nestimate: 2\ndepends_on: [9]"),
    todo("5", "status: ready\npriority: low\nestimate: 2\ndepends_on: [6]"),
    todo("6", "status: done\nestimate: 1"),
    todo("7", "status: open\nestimate: 1"),
  ]);
  const ids = (rows: TodoMeta[]) => rows.map((row) => row.id);
  const order = backlogBoard([
    todo("1", "status: ready\npriority: low\nestimate: 1"),
    todo("2", "status: ready\npriority: high\nestimate: 8"),
    todo("3", "status: ready\npriority: high\nestimate: 2"),
    todo("4", "status: ready\npriority: medium\nestimate: 5"),
  ]);
  const first = board.issuable[0]!;
  const todos = [
    parseTodoMeta("id: csv-export\ntitle: Экспорт отчётов в CSV ломается\nstatus: ready\n")!,
    parseTodoMeta("id: logo\ntitle: Новый логотип\nstatus: open\n")!,
    parseTodoMeta("id: old\ntitle: Экспорт отчётов в CSV давно\nstatus: done\n")!,
  ];
  return {
    issuable: ids(board.issuable), needsEstimate: ids(board.needsEstimate), decompose: ids(board.decompose), blocked: ids(board.blocked),
    order: ids(order.issuable),
    message: issueMessage(first), homeMessage: issueMessage(first, "/home/owner/plans"),
    matches: ids(backlogMatches("починить экспорт CSV в отчётах", todos)), noMatch: ids(backlogMatches("совсем другое дело", todos)),
  };
}

/** n577: only the lines under the backlog marker are read, and a broken output never throws. */
export function observeParse() {
  const marked = `${BACKLOG_MARK} .agents/todos/items/a/meta.yaml\nid: a\ntitle: A\nstatus: ready\nestimate: 3\n`;
  const two = `${marked}\n${BACKLOG_MARK} .agents/todos/items/b/meta.yaml\nid: b\ntitle: B\nstatus: open\n`;
  let thrown = false;
  let junk: TodoMeta[] = [];
  try { junk = parseBacklogOutput("noise\nnot a heading\n<<<boom\u0000"); } catch { thrown = true; }
  return {
    junk: junk.map((row) => row.id), thrown,
    noId: parseBacklogOutput(`${BACKLOG_MARK} x/meta.yaml\ntitle: no id\n`).length,
    // a leak before the marker would be read as an item, whatever it looks like
    afterNoise: parseBacklogOutput(`noise\nid: leak\ntitle: L\nstatus: ready\nestimate: 1\n${marked}`).map((row) => row.id),
    two: parseBacklogOutput(two).map((row) => `${row.id}:${row.status}`),
    command: backlogReadCommand,
  };
}

const git = (cwd: string, ...args: string[]) => execSync(`git ${args.map((arg) => JSON.stringify(arg)).join(" ")}`, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });
function tempRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, "init", "-q");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init");
  return dir;
}
const put = (root: string, path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
const CONFIG = (projectId: string, root: string): PrototypeConfig => ({ projectId, hostId: "local", pmWorkspacePath: root, writerWorkspacePath: root, pmProviderId: "pm-prov", pmModel: "pm-model", writerProviderId: "wr-prov", writerModel: "wr-model" });

/** n576: the board fetches before it reads and tells how old and how far behind the data is. */
export async function observeScan() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  savePrototypeConfig(db, CONFIG("p1", "/w"));
  const calls: string[] = [];
  const make = (reply: (command: string) => { exitCode: number; stdout: string }) => createBacklog({ db, bb: bb as never, isDisposed: () => false, log: () => undefined,
    host: { call: async (_method: string, input: { command?: string }) => { calls.push(input.command ?? ""); return { ...reply(input.command ?? ""), stderr: "" }; } } as never } as never).backlog;
  const meta = "id: x1\ntitle: Door\nstatus: ready\nestimate: 2\ncreated: 2026-11-01\n";
  const before = Date.now();
  const board = await make((command) => command.includes("git fetch") ? { exitCode: 0, stdout: "3" } : { exitCode: 0, stdout: `${BACKLOG_MARK} .agents/todos/items/x1/meta.yaml\n${meta}` }).board("p1");
  const fetchFirst = calls.findIndex((c) => c.includes("git fetch")) === 0 && calls[1]!.includes("meta.yaml");
  const failing = await make((command) => command.includes("git fetch") ? { exitCode: 1, stdout: "" } : { exitCode: 0, stdout: `${BACKLOG_MARK} .agents/todos/items/x1/meta.yaml\n${meta}` }).board("p1");
  return { fetchFirst, fetched: board.fetched, behind: board.behind, issuable: board.issuable.map((row) => row.id), readAtFresh: Date.parse(board.readAt ?? "") >= before - 1000,
    failedFetched: failing.fetched, failedBehind: failing.behind, failedStillRead: failing.issuable.map((row) => row.id) };
}

/** n584: a project scans only when its interval has passed since the last scan; the scan writes that time. */
export async function observeCadence() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const now = Date.now();
  createRun(db, "run1", "projA", "cli");
  db.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run1'").run();
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm" }));
  const api = createBacklog({ db, bb, host: { call: async () => ({ exitCode: 0, stdout: "", stderr: "" }) }, isDisposed: () => false, log: () => undefined } as never).backlog;
  saveProjectSetting(db, "projA", "backlog.scan_minutes", 120);
  await bb.storage.kv.set("backlog:last-scan:projA", now - 60 * 60_000 as never);
  const young = (await api.scan(now))[0]!;
  const keptStamp = await bb.storage.kv.get("backlog:last-scan:projA");
  await bb.storage.kv.set("backlog:last-scan:projA", now - 121 * 60_000 as never);
  const old = (await api.scan(now))[0]!;
  const newStamp = await bb.storage.kv.get("backlog:last-scan:projA");
  saveProjectSetting(db, "projA", "backlog.scan_minutes", 60);
  await bb.storage.kv.set("backlog:last-scan:projA", now - 61 * 60_000 as never);
  const hour = (await api.scan(now))[0]!;
  await bb.storage.kv.set("backlog:last-scan:projA", now - 59 * 60_000 as never);
  const underHour = (await api.scan(now))[0]!;
  return { youngScanned: young.scanned, keptStamp: keptStamp === now - 60 * 60_000, oldScanned: old.scanned, newStamp: newStamp === now, hourScanned: hour.scanned, underHourScanned: underHour.scanned };
}

/** n585: the todo items are read where the project's planning lives (project.planning_home), the code tree when none is set; the issued message names that home. */
export async function observePlanningHome() {
  const meta = (id: string) => `id: ${id}\ntitle: Task ${id}\nstatus: ready\npriority: medium\nestimate: 2\ncreated: 2026-11-01\n`;
  const run = async (withHome: boolean) => {
    const checkout = tempRepo("r06b-checkout-");
    const home = tempRepo("r06b-home-");
    put(checkout, ".agents/todos/items/in-checkout/meta.yaml", meta("in-checkout"));
    put(home, ".agents/todos/items/in-home/meta.yaml", meta("in-home"));
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    savePrototypeConfig(db, CONFIG("p1", checkout));
    if (withHome) saveProjectSetting(db, "p1", "project.planning_home", home);
    const bases: string[] = [];
    const handlers: Record<string, (input: never) => Promise<unknown>> = { gateRun: gateRun as never, runCommand: runCommand as never };
    const host = { call: async (method: string, input: { basePath?: string }) => { if (method === "gateRun") bases.push(String(input.basePath)); return handlers[method]!(input as never); } };
    const api = createBacklog({ db, bb: bb as never, isDisposed: () => false, log: () => undefined, host } as never).backlog;
    const board = await api.board("p1");
    return { ids: board.issuable.map((row) => row.id), readFrom: bases.at(-1) === home ? "home" : bases.at(-1) === checkout ? "checkout" : bases.at(-1) };
  };
  const plain = await run(false);
  const set = await run(true);
  const first = backlogBoard([todo("1", "status: ready\nestimate: 2")]).issuable[0]!;
  return { plain, set, message: issueMessage(first, "/home/owner/plans"), plainMessage: issueMessage(first, null) };
}

/** n586: one status line becomes done and the other lines stay; an accepted task of the run closes the line it was issued for, nothing else does. */
export async function observeClose() {
  const root = mkdtempSync(join(tmpdir(), "r06b-close-"));
  const dir = join(root, ".agents", "todos", "items", "t-door");
  const file = join(dir, "meta.yaml");
  const close = (id: string) => closeBacklogItem({ requestedHostId: "h", projectCwd: root, id }, {} as never);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, "id: t-door\nstatus: open\nestimate: 2\n");
  const first = await close("t-door");
  const after = readFileSync(file, "utf8");
  const again = await close("t-door");
  writeFileSync(file, "status: open\nstatus: blocked\n");
  const two = await close("t-door");
  const twoText = readFileSync(file, "utf8");
  const missing = await close("missing");

  // The queue tool's side: only an accepted task of the run closes the line, and not a line issued to another PM.
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  let closed = 0;
  bb.hosts.experimental_client = (() => ({ call: async () => { closed += 1; return { status: "closed" }; } })) as never;
  const db = openDatabase(bb);
  createRun(db, "run1", "proj", "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host1");
  createTask(db, { id: "task-done", runId: "run1", kind: "bb", contract: {} });
  createAttempt(db, { id: "a-done", runId: "run1", taskId: "task-done" });
  transitionAttempt(db, "a-done", "accepted");
  createTask(db, { id: "task-queued", runId: "run1", kind: "bb", contract: {} });
  createAttempt(db, { id: "a-queued", runId: "run1", taskId: "task-queued" });
  transitionAttempt(db, "a-queued", "queued");
  db.prepare("INSERT INTO lane_pilot_backlog_issue(project_id,todo_id,pm_thread_id,estimate,issued_at) VALUES (?,?,?,?,?)").run("proj", "t-own", "thr_pm", "5", 1);
  db.prepare("INSERT INTO lane_pilot_backlog_issue(project_id,todo_id,pm_thread_id,estimate,issued_at) VALUES (?,?,?,?,?)").run("proj", "t-other", "thr_other_pm", "5", 1);
  bindBacklogIssued(db, (projectId, todoId) => backlogIssuedTo(db, projectId, todoId));
  registerQueueTool({ db, bb } as never, { answer: () => undefined } as never);
  const queue = registeredTools(bb.agents).get("lane_pilot_queue")!;
  const call = async (input: Record<string, unknown>): Promise<string> => {
    try { await (queue.execute as (i: unknown, c: unknown) => Promise<unknown>)(input, callCtx("thr_pm", "proj")); return "closed"; } catch (cause) { return String((cause as { code?: string }).code); }
  };
  const queued = await call({ action: "close_backlog", id: "t-own", taskId: "task-queued" });
  const other = await call({ action: "close_backlog", id: "t-other", taskId: "task-done" });
  const closedBefore = closed;
  const own = await call({ action: "close_backlog", id: "t-own", taskId: "task-done" });
  await harness.lifecycle.dispose();
  return { first: first.status, after, again: again.status, two: two.status, twoText, missing: missing.status, queued, other, closedBefore, own, closedAfter: closed };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Conversation (n559-n575).

export { observeHandOver } from "./r06-world";

const WORKSPACE = "/ws";
const taskOf = (id: string, extra: Record<string, unknown> = {}): TaskV2 => ({
  schema_version: 2, id, display_title: `Task ${id}`, kind: "feature", title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: WORKSPACE,
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [],
  depends_on: [], objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: WORKSPACE }], ...extra,
}) as TaskV2;

/** n562: a task contract is shape-checked before any task row exists: the missing field, then the lint's own findings by code. */
export function observeValidate() {
  const bad = { ...taskOf("bad1") } as Record<string, unknown>;
  delete bad.owns_paths;
  const refused = validateTaskV2(bad);
  const lintOf = (task: TaskV2) => lintContract({ task, workspacePath: WORKSPACE, hostId: "h", sandboxUnsafe: [], openTasks: [], deadDependencies: [], kinds: new Map() });
  const outside = lintOf(taskOf("bad2", { expected_outputs: ["outside/x.ts"] }));
  const inside = lintOf(taskOf("good1"));
  const never = lintOf(taskOf("bad3", { never_touch: ["bad3/secret/**"], expected_outputs: ["bad3/secret/x.ts"] }));
  const good = validateTaskV2(taskOf("good1"));
  return {
    missingRefused: !refused.ok, missingErrors: refused.ok ? [] : refused.errors.filter((line) => line.startsWith("owns_paths")), goodOk: good.ok,
    outsideCodes: outside.errors.map((row) => row.code), insideCodes: inside.errors.map((row) => row.code), neverCodes: never.errors.map((row) => row.code),
    outsideMessage: outside.errors[0]?.message.slice(0, 60) ?? "",
  };
}

/** n563: a PM turn's spend is booked under the PM thread's own id (one cursor row, the daily book) and takes no seat: no attempt, no receipt. */
export async function observeSpendBooked() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  harness.sdk.stub("threads.list", async () => [{ id: "thr_pm", projectId: "projA", providerId: "prov" }]);
  harness.sdk.stub("threads.events.list", async () => [
    { type: "thread/tokenUsage/updated", seq: 1, createdAt: Date.now(), tokenUsage: { total: { totalTokens: 14, inputTokens: 10, outputTokens: 4 }, last: { totalTokens: 14, inputTokens: 10, outputTokens: 4 } } },
  ]);
  await syncTokenUsage({ bb: bb as never, db }, { sinceDays: 1 });
  const row = tokenCursorRow(db, "thr_pm");
  const cursors = (db.prepare("SELECT thread_id FROM lane_pilot_token_cursor").all() as Array<{ thread_id: string }>).map((r) => r.thread_id);
  const daily = db.prepare("SELECT project_id, total_tokens FROM lane_pilot_token_daily").all() as Array<{ project_id: string; total_tokens: number }>;
  return { cursors, cursorTotal: row ? (JSON.parse(row.total_json) as { total: number }).total : null, daily, attempts: listOpenAttempts(db).length, receipts: listStageReceipts(db, "run1", "x").length };
}

/** n575: the spend lands under the model the turn really ran on, and a mismatch with the chosen model is named. */
export async function observeSpendModel() {
  const now = Date.now();
  const last = { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14 };
  const run = async (fallback: boolean) => {
    const events: Array<Record<string, unknown>> = [];
    if (fallback) events.push({ seq: 1, createdAt: now, type: "provider/modelFallback", data: { fallbackModel: "sonnet", originalModel: "opus" } });
    else events.push({ seq: 1, createdAt: now, type: "client/turn/requested", data: { model: "opus" } });
    events.push({ seq: 2, createdAt: now, type: "thread/tokenUsage/updated", data: { tokenUsage: { last, total: last } } });
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: {
      projects: { list: async () => [{ id: "proj_a", name: "A" }] },
      threads: { list: async () => [{ id: "thr_a", projectId: "proj_a", providerId: "claude-code" }],
        events: { list: async (args: { afterSeq?: string; types?: readonly string[] }) => {
          const after = args.afterSeq ? Number(args.afterSeq) : 0;
          const allowed = new Set(args.types ?? []);
          return events.filter((event) => (event.seq as number) > after && (!allowed.size || allowed.has(event.type as string)));
        } } },
    } as never });
    const db = openDatabase(bb);
    await syncTokenUsage({ bb: bb as never, db }, { sinceDays: 1 });
    const booked = await queryTokenUsage({ bb: bb as never, db }, { range: "7d" });
    return { models: booked.byModel.map((row) => `${row.model}:${row.total}`), day: booked.series.find((row) => row.day === utcDay(now))?.models.map((row) => row.model) ?? [], mismatches: booked.mismatches.map((row) => `${row.chosen}->${row.actual}:${row.tokens}`) };
  };
  return { fallback: await run(true), plain: await run(false) };
}

/** n565 / n566 / n571: what the PM activation spawns — the configured PM provider with explicit inputs, the compiled profile before launch, never from a writer thread. */
export async function observeActivation() {
  const harnessOf = (withCapability: boolean) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const spawns: Array<Record<string, unknown>> = [];
    harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threadId === "thr_w" ? { role: "writer" } : { role: "user" });
    harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
    harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => { spawns.push(input); return { id: "pm-main" }; });
    if (withCapability) Object.assign(bb.agents as object, { experimental_vkCompiledMainAgent: () => ({ persist: true, bridgeAgentOptions: true, requiredMarker: true, snapshotDigest: true, providerIds: ["claude-code"] }) });
    const ctx = createCore(bb, openDatabase(bb));
    (ctx.host as { call: unknown }).call = async (method: string) => method === "detect" ? { workspace: { path: WORKSPACE, present: true } } : {};
    savePrototypeConfig(ctx.db, CONFIG("proj1", WORKSPACE));
    return { ctx, spawns, db: ctx.db };
  };
  const services = { resumeOrphans: async () => [] } as never;
  const plain = harnessOf(false);
  const out = await createActivation(plain.ctx, services).activate("proj1", null, "bb");
  const row = plain.db.prepare("SELECT pm_thread_id, kind FROM lane_pilot_run WHERE id=?").get((out as { runId: string }).runId) as { pm_thread_id: string; kind: string };
  const fromUser = harnessOf(false);
  const userOk = await createActivation(fromUser.ctx, services).activate("proj1", "thr_user", "bb").then(() => true, () => false);
  const fromWriter = harnessOf(false);
  const writerError = await createActivation(fromWriter.ctx, services).activate("proj1", "thr_w", "bb").then(() => "no error", (cause: Error) => cause.message);
  const compiled = harnessOf(true);
  saveProjectSetting(compiled.db, "proj1", "main.agent", "dev-orchestrator");
  await createActivation(compiled.ctx, services).activate("proj1", null, "bb");
  const bound = compiled.spawns[0]?.experimental_vkCompiledMainAgent as { tools?: unknown } | undefined;
  const missing = harnessOf(false);
  saveProjectSetting(missing.db, "proj1", "main.agent", "dev-orchestrator");
  const runsBefore = (missing.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_run").get() as { n: number }).n;
  const missingError = await createActivation(missing.ctx, services).activate("proj1", null, "bb").then(() => "no error", (cause: Error) => cause.message);
  const runsAfter = (missing.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_run").get() as { n: number }).n;
  return {
    threadId: out.threadId, spawnProvider: plain.spawns[0]?.providerId, spawnModel: plain.spawns[0]?.model, sources: plain.spawns[0]?.executionInputSources,
    metadata: plain.spawns[0]?.pluginMetadata, pmRow: row, userOk, writerError, writerSpawns: fromWriter.spawns.length,
    boundTools: JSON.stringify(bound?.tools ?? null).includes("lane_pilot_dispatch_writer"), boundPersist: (compiled.spawns[0]?.experimental_vkCompiledMainAgent as { id?: string } | undefined)?.id ?? null,
    plainHasBinding: plain.spawns[0]?.experimental_vkCompiledMainAgent !== undefined,
    missingError: /compiled_main_agent_unsupported/.test(missingError), missingSpawns: missing.spawns.length, runsBefore, runsAfter,
  };
}

/** n567 / n574: the PM turn watch under the project's own limits (pm.turn_limit_min, pm.max_turns): read at turn/started, so a change counts from the next turn. */
export async function observeTurnWatch() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  harness.sdk.stub("threads.send" as never, async () => ({}));
  const stopped: string[] = [];
  harness.sdk.stub("threads.stop" as never, async (input: { threadId: string }) => { stopped.push(input.threadId); return { ok: true }; });
  createRun(db, "run1", "projA");
  setRunThread(db, "run1", "thr_pm");
  const handlers = new Map<string, (payload: unknown) => unknown>();
  const hosted = Object.assign(Object.create(bb), { pluginId: "lane-pilot", events: { on: (name: string, handler: (payload: unknown) => unknown) => { handlers.set(name, handler); } } });
  const ctx = createCore(hosted, db);
  const watch = mountPmTurnWatch(ctx as never)!;
  const emit = (type: string, threadId: string, item?: string) => handlers.get("experimental_thread.events")!({ thread: { id: threadId }, event: { type, ...(item ? { item: { type: item } } : {}) } });
  const outcome = async (thread: string) => ((await bb.storage.kv.get(`${PM_TURN_OUTCOME_PREFIX}${thread}`)) as { outcome?: string } | null)?.outcome ?? null;

  // The cap: 3 tool items pass, the 4th cuts the turn and names the cap.
  saveProjectSetting(db, "projA", "pm.max_turns", 3);
  await emit("turn/started", "thr_pm");
  for (let i = 0; i < 3; i++) await emit("item/completed", "thr_pm", "tool/call");
  const stoppedAtThree = [...stopped];
  await emit("item/completed", "thr_pm", "tool/call");
  const cutAtFour = { stopped: [...stopped], outcome: await outcome("thr_pm") };

  // A changed limit mid-turn is not this turn's cap; the next turn takes it.
  stopped.length = 0;
  await emit("turn/started", "thr_pm");
  saveProjectSetting(db, "projA", "pm.max_turns", 5);
  for (let i = 0; i < 4; i++) await emit("item/completed", "thr_pm", "tool/call");
  const sameTurn = [...stopped];
  await emit("item/completed", "thr_pm", "tool/call");
  const sameTurnAtFive = [...stopped];
  await emit("item/completed", "thr_pm", "tool/call");
  const sameTurnAtSix = [...stopped];
  await emit("turn/completed", "thr_pm");

  // The next turn takes the new cap 5: five pass, the sixth cuts.
  stopped.length = 0;
  await emit("turn/started", "thr_pm");
  for (let i = 0; i < 5; i++) await emit("item/completed", "thr_pm", "tool/call");
  const nextAtFive = [...stopped];
  await emit("item/completed", "thr_pm", "tool/call");
  const nextAtSix = { stopped: [...stopped], outcome: await outcome("thr_pm") };

  // A writer thread (no PM run) is ignored.
  await emit("turn/started", "thr_writer");
  const writerOpen = watch.open("thr_writer");

  // The time limit and the named outcomes, on the watch's own clock.
  const named: string[] = [];
  let clock = 1_000_000;
  const timed = createPmTurnWatch({ isPmThread: async (threadId) => threadId === "thr_pm", limits: async () => ({ turnLimitMin: 4, maxTurns: 0 }), stop: async (threadId) => { stopped.push(`timed:${threadId}`); },
    tell: async () => undefined, record: async (_threadId, text) => { named.push(text); }, now: () => clock, log: () => undefined });
  stopped.length = 0;
  await timed.turnStarted("thr_pm");
  clock += 3 * 60_000;
  const at3 = await timed.sweep(clock);
  clock += 2 * 60_000;
  const at5 = await timed.sweep(clock);
  await timed.turnStarted("thr_pm");
  await timed.itemCompleted("thr_pm", "tool/call");
  await timed.turnCompleted("thr_pm");
  await timed.turnStarted("thr_pm");
  await timed.turnCompleted("thr_pm", { providerError: "quota exceeded" });
  await timed.turnStarted("thr_pm");
  await timed.turnFailed("thr_pm", "model overloaded");
  await timed.turnStarted("thr_pm");
  await timed.itemCompleted("thr_pm", "assistant/message");
  const before = named.length;
  await timed.turnCompleted("thr_pm");
  for (const handler of handlers.values()) void handler;
  return { stoppedAtThree, cutAtFour, sameTurn, sameTurnAtFive, sameTurnAtSix, nextAtFive, nextAtSix, writerOpen: writerOpen === undefined, at3, at5, timedStops: [...stopped], named, spoke: named.length === before };
}

/** n568: the board that rides a resumed PM session: tasks with their states, the live phase with its stage rubric. */
export async function observeBoardBlock() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run_b", "proj_b", "bb", "/w");
  createTask(db, { id: "t1", runId: "run_b", kind: "bb", contract: {} });
  createTask(db, { id: "t2", runId: "run_b", kind: "bb", contract: {} });
  createAttempt(db, { id: "a1", runId: "run_b", taskId: "t1" });
  transitionAttempt(db, "a1", "accepted");
  const block = pmBoardBlock(db as never, "run_b");
  const none = pmBoardBlock(db as never, "run_none");
  const withPhase = await (async () => {
    const { bb: bb2, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.get" as never, async () => ({ status: "idle" }));
    const db2 = openDatabase(bb2);
    createRun(db2, "run_p", "proj_p", "bb", "/w");
    db2.prepare("UPDATE lane_pilot_run SET pm_thread_id='thr_pm' WHERE id='run_p'").run();
    const { phases } = createPhaseDriver(createCore(bb2, db2), { runBudgets: { get: () => undefined } } as unknown as Services);
    const opened = await phases.open({ projectId: "proj_p", pmThreadId: "thr_pm", title: "Sums", goal: "skip empty cells" });
    return { block: pmBoardBlock(db2 as never, "run_p"), rubric: rubricLine(opened.stage), stage: opened.stage, id: opened.id };
  })();
  // The rows come newest first and two tasks made in the same millisecond have no fixed order: compare the set.
  const tasks = (block ?? "").split("\n").find((line) => line.startsWith("Tasks: "))?.slice(7).split("; ").sort() ?? [];
  return { block, tasks, none, withPhase };
}

/** n569: the PM reads project files only through the granted reader: a path outside the workspace is refused before any host read; the root is the run's own. */
export async function observeRead() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threadId === "thr_pm" ? { role: "pm", lanePilotRunId: "run_read" } : { role: "writer", lanePilotRunId: "run_read" });
  const db = openDatabase(bb);
  createRun(db, "run_read", "proj", "bb", "/work/proj", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host_read");
  setRunThread(db, "run_read", "thr_pm");
  const core = createCore(bb, db);
  const calls: Array<Record<string, unknown>> = [];
  (core as unknown as { host: { call: (method: string, input: Record<string, unknown>) => Promise<unknown> } }).host = { call: async (_method, input) => { calls.push(input); return { hostId: "host_read", content: "file" }; } };
  const { readWriterWorkspaceFile } = createWriterDispatch(core, {} as never);
  const read = (path: string, threadId = "thr_pm", projectId = "proj") => readWriterWorkspaceFile({ threadId, projectId, path, offset: 0, maxLines: 40 }).then(() => "read", (cause: Error) => cause.message);
  const errors = { absolute: await read("/etc/passwd"), up: await read("../outside"), upDeep: await read("src/../../outside"), nul: await read("a\0b") };
  const callsAfterRefusals = calls.length;
  const ok = await read("src/door.ts");
  const writer = await read("src/door.ts", "thr_writer");
  const otherProject = await read("src/door.ts", "thr_pm", "other");
  return { errors, callsAfterRefusals, ok, firstCall: calls[0] ?? null, writer, otherProject, callsTotal: calls.length };
}

/** n570: the board observation reads only the caller's own run. */
export async function observeBoardScope() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  createRun(db, "runA", "projA");
  createRun(db, "runB", "projA");
  createTask(db, { id: "ta", runId: "runA", kind: "bb", contract: { title: "alpha" } });
  createTask(db, { id: "tb", runId: "runB", kind: "bb", contract: { title: "beta" } });
  registerConversationTools(ctx as never, { spendByModel: () => [] });
  const tool = registeredTools(bb.agents).get("lane_pilot_facts")!;
  harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => threadId === "thr_a" ? { lanePilotRunId: "runA" } : threadId === "thr_b" ? { lanePilotRunId: "runB" } : {});
  const ask = async (threadId: string) => JSON.parse(String(await tool.execute({ question: "что с задачами" }, callCtx(threadId, "projA")))) as { kind: string; runId: string | null; tasks: Array<{ taskId: string }>; counts: unknown };
  const a = await ask("thr_a");
  const b = await ask("thr_b");
  const none = await ask("thr_none");
  return { aRun: a.runId, aTasks: a.tasks.map((row) => row.taskId), bRun: b.runId, bTasks: b.tasks.map((row) => row.taskId), noneTasks: none.tasks.map((row) => row.taskId), kind: a.kind };
}

/** n589 / n591: the five kinds of a stop to the owner and what each does to free text. */
export function observeAskKinds() {
  const options = ["raise", "stop"];
  const kinds = [...ASK_KINDS];
  const allow = Object.fromEntries(kinds.map((kind) => [kind, buildOwnerAskPayload({ source: "pm", kind, question: "q", options }).allowText]));
  const carried = kinds.map((kind) => buildOwnerAskPayload({ source: "pm", kind, question: "q" }).kind);
  const noOptions = Object.fromEntries(kinds.map((kind) => [kind, buildOwnerAskPayload({ source: "pm", kind, question: "q" }).allowText]));
  const stored = readOwnerAskPayload({ v: 1, source: "pm", question: "q", options: [], allowText: true });
  const unknownKind = readOwnerAskPayload({ v: 1, source: "pm", kind: "secret", question: "q", options: [], allowText: true });
  return { kinds, carried, allow, noOptions, defaultKind: stored?.kind ?? null, unknownKind };
}

/** n590: a secret-shaped answer never reaches the writer's thread or a file. */
export async function observeSecret() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input.map((part) => part.text).join("\n")); return {}; });
  harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
  harness.sdk.stub("files.write", async () => { throw new Error("a secret must not be written"); });
  const db = openDatabase(bb);
  const ctx = createCore(bb, db);
  try { registerTools(ctx, new Proxy({} as Services, { get: () => { throw new Error("mounts after the answer tool"); } })); } catch { /* later mounts */ }
  const tool = registeredTools(bb.agents).get("lane_pilot_answer_writer")!;
  const secrets = [`sk-${"a".repeat(20)}`, `ghp_${"B".repeat(24)}`, "-----BEGIN RSA PRIVATE KEY-----"];
  const outcomes: string[] = [];
  for (const answer of secrets) {
    outcomes.push(await Promise.resolve(tool.execute({ taskId: "T1", answer }, callCtx("thr", "proj"))).then(() => "sent", (cause: unknown) => cause instanceof ToolError ? cause.code : String(cause)));
  }
  const sentBeforePlain = sent.join("\n");
  const plain = await Promise.resolve(tool.execute({ taskId: "T1", answer: "use port 3000" }, callCtx("thr", "proj"))).then(() => "sent", (cause: unknown) => String(cause));
  return { outcomes, leaked: secrets.some((secret) => sentBeforePlain.includes(secret)), sentBeforePlain, plain, sentAfter: sent.join("\n").includes("use port 3000") };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Questions (n587, n588) and the phase's plan (n595).

function phaseWorld(hostRpc?: (call: { method: string; input: Record<string, unknown> }) => Promise<unknown>) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", ...(hostRpc ? { experimental_callHostRpc: hostRpc as never } : {}) });
  harness.sdk.stub("threads.send", async () => ({}));
  harness.sdk.stub("threads.get", async () => ({ status: "idle" }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET writer_workspace_path='/ws', writer_host_id='h1', pm_thread_id='thr_pm' WHERE id='run1'").run();
  const ctx = createCore(bb, db);
  const services = { runBudgets: { get: () => undefined }, readWriterWorkspaceFile: async ({ path }: { path: string }) => ({ sha256: sha(path), sizeBytes: 120, content: `# ${path}` }) };
  const phases = createPhaseDriver(ctx, services as never).phases;
  return { phases, db, ctx };
}

/** n587: a question to the owner and its answer land in the phase folder's BOOK.md, written to the project through the host. */
export async function observeBook() {
  const writes: Array<{ path: string; content: string }> = [];
  const { phases, db } = phaseWorld(async (call) => {
    const edits = (call.input.edits ?? []) as Array<{ path: string; content: string }>;
    if (call.method === "writePhaseBook") { writes.push(...edits); return { status: "applied", writes: edits.map((row) => ({ path: row.path, status: "applied", afterSha256: sha(row.content) })) }; }
    return {};
  });
  const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Q", goal: "q" });
  savePhase(db, ph.id, { runId: "run1", state: "active", record: ph.record, at: 2 } as never);
  phases.question({ phaseId: ph.id, text: "which locale?", blocking: false, by: "pm" });
  await phases.tick();
  const afterQuestion = writes.at(-1)?.content ?? "";
  phases.answer({ phaseId: ph.id, questionId: "q1", answer: "ru", by: "owner" });
  await phases.tick();
  const last = writes.at(-1);
  const status = phases.status(ph.id).phase.record.questions ?? [];
  return { id: ph.id, path: last?.path ?? null, afterQuestion, book: last?.content ?? "", answered: status.map((row) => `${row.id}:${row.answer}:${row.answeredBy}`) };
}

/** n588: the question file of a worker parked mid-execution: an open entry in the attempt's QA.md of the task home, the answer appended under it. */
export async function observeParkedQa() {
  const { bb: host } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(host);
  const BASE = "/srv/proj";
  createRun(db, "lprun_q", "proj", "bb", BASE);
  const files = new Map<string, string>();
  const bb = { log: { warn: () => undefined, info: () => undefined }, sdk: { files: {
    read: async ({ path }: { path: string }) => (files.has(path) ? { content: files.get(path) } : null),
    write: async ({ path, content }: { path: string; content: string }) => { files.set(path, content); },
  } } };
  const io = bbTaskFileIo(bb as never, "h1", BASE);
  const contract = taskV2Schema.parse(taskOf("t-qa", { project_cwd: BASE }));
  createTask(db, { id: "t-qa", runId: "lprun_q", kind: "bb", contract });
  await writeDispatchHome(db, io, { taskId: "t-qa", projectId: "proj", runId: "lprun_q", basePath: BASE, hostId: "h1", task: contract, plan: "do it" });
  createAttempt(db, { id: "att1", runId: "lprun_q", taskId: "t-qa" });
  const ctx = { bb, db } as never;
  const home1 = await appendTaskQaHome(ctx, { taskId: "t-qa", attemptId: "att1", question: "which locale?" });
  const qa = () => files.get(`${BASE}/.agents/tasks/t-qa/attempts/att1/QA.md`) ?? "";
  const open = qa();
  await appendTaskQaHome(ctx, { taskId: "t-qa", attemptId: "att1", question: "which locale?", answer: "ru" });
  const answered = qa();
  // A task without a home keeps the old layout: noteTaskQa writes the task folder's QA.md instead.
  const old = new Map<string, string>();
  const oldBb = { log: { warn: () => undefined }, sdk: { files: { read: async () => null, write: async ({ path, content }: { path: string; content: string }) => { old.set(path, content); } } } };
  await noteTaskQa({ bb: oldBb, db } as never, { hostId: "h1", workspacePath: BASE, taskId: "t-old", question: "which port?" });
  await appendTaskQa(oldBb as never, { hostId: "h1", workspacePath: BASE, taskId: "t-old2", question: "which port?" });
  return { home1, open, answered, oldPaths: [...old.keys()].map((path) => path.replace(BASE, "")), oldText: [...old.values()].join("\n---\n") };
}

const piece = (id: string, deps: string[], kind = "code"): PlanItem => ({
  id, title: id, wave: 0 as never, promise: { given: "the repository", when: "the piece lands", then: `${id} is done` },
  task: { id, title: `Piece ${id}`, objective: `do ${id}`, kind, owns_paths: [`src/${id}.ts`], verification: [{ command: `npm test -- ${id}` }], acceptance: [`${id} works`], depends_on: deps } as never,
});

/** n595: pieces, links and a lane from one plan: the waves are computed from depends_on, a cycle gets none, each piece's kind gives its lane. */
export async function observePlan() {
  const { phases } = phaseWorld();
  const open = async (title: string) => {
    const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title, goal: title });
    return phases.context({ phaseId: opened.id, docs: [".agents/phases/CONTEXT.md"], risks: { value: "v", usability: "none", feasibility: "none", viability: "none" }, appetite: "one day", noGos: ["none"] });
  };
  const shape = { objective: "the goal", premortem: ["r1", "r2", "r3"] };
  const chain = await open("chain");
  const planned = phases.plan({ phaseId: chain.id, items: [piece("c", ["b"]), piece("a", []), piece("b", ["a"]), piece("d", [], "docs"), piece("e", ["a"], "check")], ...shape, by: "pm" });
  const items = planned.record.plan!.items;
  const waves = Object.fromEntries(items.map((item) => [item.id, item.wave]));
  const lanes = Object.fromEntries(items.map((item) => [item.id, laneQueueOf(String((item.task as { kind?: string }).kind))]));
  const cyc = await open("cycle");
  const cyclic = phases.plan({ phaseId: cyc.id, items: [piece("x", ["y"]), piece("y", ["x"]), piece("z", [])], ...shape, by: "pm" });
  const cycWaves = Object.fromEntries(cyclic.record.plan!.items.map((item) => [item.id, item.wave]));
  return { waves, lanes, cycWaves, sha: planned.record.plan!.sha };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The words of a new task (n592) and the boundary line (n561).

/** n592: a phrase becomes a proposed title, description and promise by fixed rules (a dictionary, no model); and the task standard's hint on a title. */
export function observeWords() {
  const long = "Очень длинное название задачи, которое явно не помещается в шестьдесят знаков и обязано быть сокращено";
  return {
    full: proposeTaskWords("Кнопка оплаты в корзине, чтобы покупатель видел итог до оплаты"),
    whenThen: proposeTaskWords("Когда покупатель платит, то заказ закрывается"),
    path: proposeTaskWords("Починить src/api/export.ts экспорт отчётов. Второй кусок"),
    lines: proposeTaskWords("Сделать вход\nпользователь видит имя"),
    longTitle: proposeTaskWords(long).title.length,
    hints: [taskWords(""), taskWords("src/a.ts меняется"), taskWords("Кнопка в корзине"), taskWords(long)],
  };
}

/** n561: the line under a PM chat's input follows the project's owner.words; other threads show nothing. */
export function observeBoundary() {
  return { pmOn: boundaryLineOf("pm", "on"), pmRisky: boundaryLineOf("pm", "risky"), pmSensitive: boundaryLineOf("pm", "sensitive"), pmUnset: boundaryLineOf("pm", undefined), pmOff: boundaryLineOf("pm", "off"),
    writer: boundaryLineOf("writer", "on"), helper: boundaryLineOf("helper", "sensitive"), none: boundaryLineOf(null, "on") };
}

/** n593: the clarification graph on its own test case through the real engine: one analyst reads, the questions come out, nothing is written and no task is made. */
export async function observeClarify() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const workflow = builtinWorkflow("lp.clarify")!;
  const cases = testCasesOf(workflow as never);
  const result = await runDraftTest({ db: db as never, harnessVersion: "t" }, workflow as never, cases[0]!);
  const nodes = workflow.nodes as Array<Record<string, unknown>>;
  return {
    id: workflow.id, status: (workflow as { status?: string }).status, nodes: nodes.map((node) => `${node.id}:${node.type}:${String(node.role ?? node.action ?? "")}`),
    green: result.green, runStatus: result.status, path: result.path, output: result.output, stubbed: result.stubbed.map((row) => `${row.node}:${row.type}`),
    writesOrTasks: nodes.filter((node) => node.type === "lp-task" || /^fs\.|write/.test(String(node.action ?? ""))).length,
  };
}
