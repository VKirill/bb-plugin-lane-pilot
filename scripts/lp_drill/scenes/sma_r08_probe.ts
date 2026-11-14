// Probe of scenes/sma_r08.py (region 8, the daemon front outside the graphs): runs the REAL functions of THIS checkout (the commit under drill) on a fake
// plugin host, a scratch database and a fixture window folder, and prints what they returned as one JSON line. It judges nothing: the scene compares
// every value with the card's expected result and prove()s it. No model, no hub write, nothing outside the machine.
// Add a node: add its section below (the real call, the raw values), then its prove() line in the scene.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../../../server";
import { hostMethods, rpcContract } from "../../../src/rooms/contracts";
import { createFront } from "../../../src/rooms/front/server/index";
import { HELPER_ROOTS, helperDraft, parseHelper } from "../../../src/rooms/front/logic";
import { createRun, openDatabase } from "../../../src/rooms/plugin-db";
import { createTaskReconcile } from "../../../src/rooms/runs/server/task-reconcile";
import { conveyorState, setConveyor } from "../../../src/rooms/runs/conveyor";
import { timeRpcHandlers } from "../../../src/rooms/core/server/rpc-timing";
import { LEGACY_TABS, resolveTab, TAB_IDS } from "../../../src/rooms/pages/tabs-model";
import { runOnHost } from "../../../packages/host-calls/src/run-on-host";
import { skillPickedLine } from "../../../src/rooms/writer/server/writer-task";
import { ROLE_PROFILES, parseRoleAccess, roleProfilePolicy } from "../../../src/rooms/contracts/helper-context";
import { isReservedAgentId, isStockProfileId, MAIN_AGENT_PROFILE_IDS } from "../../../src/rooms/contracts/native-agent-static";
import { writerSwitchedOff } from "../../../packages/models/src/model-profiles";
import { attemptMetrics } from "../../../src/rooms/usage/server/attempt-metrics";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const out: Record<string, unknown> = {};
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

// ---- the door: n674 table, n675 match, n682 journal ----
{
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  const call = (name: string, input: Record<string, unknown> = {}) => harness.behavior.callRpc(name as never, input as never) as Promise<unknown>;
  const refusal = async (name: string, input: Record<string, unknown> = {}) => { try { await call(name, input); return null; } catch (cause) { return message(cause); } };
  const pinned: string[] = JSON.parse(readFileSync(join(ROOT, "tests/sma/rpc-c1-have-keys.json"), "utf8"));
  const names = Object.keys(rpcContract).sort();
  const registered = new Set(harness.registrations.rpcMethods);
  out.table = { same: JSON.stringify(names) === JSON.stringify(pinned), count: names.length, unregistered: names.filter((name) => !registered.has(name)) };
  out.match = {
    unknown: await refusal("no_such_door"), noId: await refusal("halt_run", {}), emptyId: await refusal("halt_run", { runId: "" }),
    stray: await refusal("halt_run", { runId: "r1", stray: 1 }), good: await call("conveyor"),
  };
  const linesOf = async () => ((await bb.storage.kv.get("lp.front.actions")) as unknown[] | undefined)?.length ?? 0;
  const beforeRead = await linesOf();
  await call("list_agents");
  const afterRead = await linesOf();
  await call("conveyor", { set: "off", reason: "secret-looking reason" });
  const lines = (await bb.storage.kv.get("lp.front.actions")) as Array<{ at: number; action: string; keys: string[] }>;
  out.journal = { beforeRead, afterRead, lines: lines.map((line) => ({ action: line.action, keys: line.keys, timed: typeof line.at === "number" })), leaksValue: JSON.stringify(lines).includes("secret-looking reason") };

  // ---- n689 roster read, n691 stock, n697 conveyor through the door ----
  const stock = (await call("list_agents")) as { agents: Array<{ id: string; custom: boolean }> };
  const created = await call("create_agent", { id: "context-lead", displayName: "Context", description: "Keeps context.", prompt: "You keep the context in order.", skills: ["lane-memory"], mcpServers: ["gitnexus"], model: "claude-opus-5-5", effort: "high" });
  const all = ((await call("list_agents")) as { agents: Array<{ id: string; custom: boolean; skills?: string[]; mcpServers?: string[] }> }).agents;
  const own = ((await call("list_agents", { custom: true })) as { agents: Array<{ id: string }> }).agents;
  out.read = { stockOrder: JSON.stringify(stock.agents.map((row) => row.id)) === JSON.stringify([...MAIN_AGENT_PROFILE_IDS]), stockNotCustom: stock.agents.every((row) => !row.custom), created, order: all.map((row) => row.id).slice(-2), last: all.at(-1), own: own.map((row) => row.id) };
  const reserved = await call("create_agent", { id: "copy-lead", displayName: "Mine", description: "d", prompt: "You are mine, long enough to be a prompt." });
  out.stock = {
    allStock: MAIN_AGENT_PROFILE_IDS.every((id) => isStockProfileId(id)), custom: isStockProfileId("context-lead"), reservedStock: isReservedAgentId("copy-lead"), reservedCustom: isReservedAgentId("context-lead"),
    reserved, kept: ((await call("list_agents")) as { agents: Array<{ id: string; custom: boolean }> }).agents.filter((row) => row.id === "copy-lead").map((row) => row.custom),
  };
  await call("conveyor", { set: "on" });
  const doorOff = await call("conveyor", { set: "off", reason: "night" });
  const doorRead = await call("conveyor");
  const doorOn = await call("conveyor", { set: "on" });
  await harness.lifecycle.dispose();
  out.conveyorDoor = { doorOff, doorRead, doorOn };
}

// ---- n683 a door threw, named ----
{
  const logged: string[] = [];
  let clock = 0;
  const handlers = timeRpcHandlers({
    broken: async () => { throw new Error("disk gone"); },
    refused: async () => { throw Object.assign(new Error("the owner gate"), { refused: true }); },
    fine: async () => ({ ok: true }),
  }, (line) => logged.push(line), () => (clock += 40));
  const errors: string[] = [];
  for (const name of ["broken", "refused"] as const) { try { await handlers[name](); } catch (cause) { errors.push(message(cause)); } }
  out.threw = { logged, errors, fine: await handlers.fine() };
}

// ---- n684 / n685 the window ships with the plugin ----
{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { bb: Record<string, string>; scripts: Record<string, string> };
  out.windowDir = { app: pkg.bb.app, server: pkg.bb.server, host: pkg.bb.host, appExists: existsSync(join(ROOT, pkg.bb.app!)), definesApp: readFileSync(join(ROOT, pkg.bb.app!), "utf8").includes("definePluginApp("), build: pkg.scripts.build };
}

// ---- n686 the old page ----
out.legacy = { table: LEGACY_TABS, resolved: Object.fromEntries(Object.keys(LEGACY_TABS).map((id) => [id, resolveTab(id)])), current: TAB_IDS.map((id) => resolveTab(id).tab === id), unknown: resolveTab("roster") };

// ---- n687 / n688 the peer ----
{
  const calls: unknown[] = [];
  const client = { call: async (method: string, input: unknown, options: unknown) => { calls.push({ method, input, options }); return { hostId: "mac-2", exitCode: 0, stdout: "ok", stderr: "" }; } };
  const answer = await runOnHost(client as never, { hostId: "mac-2", cwd: "/work/p", command: "lane-coord status", timeoutSec: 20 });
  await runOnHost(client as never, { hostId: "hub", cwd: "/x", command: "true", timeoutSec: 1, timeoutMs: 777 });
  out.proxy = { answer, calls };
  const words = Object.keys(rpcContract).filter((name) => /(^|_)(word|answer)(_|$)/.test(name)).sort();
  const peers = Object.keys(hostMethods);
  out.proxyRefuse = { words, peerCount: peers.length, overlap: words.filter((name) => peers.includes(name)), wordNamed: peers.filter((name) => /word/i.test(name)) };
}

// ---- n690 the toggle, n692 skills, n695 / n696 connections ----
out.toggle = {
  byKey: writerSwitchedOff({ "writer.models_off": ["glm-flash"] }, "opencode2", "zai-coding-plan/glm-5.3-flash"),
  byPair: writerSwitchedOff({ "writer.models_off": ["codex/gpt-6-luna"] }, "codex", "gpt-6-luna"),
  byModel: writerSwitchedOff({ "writer.models_off": ["some-unprofiled-model"] }, "p", "some-unprofiled-model"),
  other: writerSwitchedOff({ "writer.models_off": ["glm-flash"] }, "claude-code", "claude-haiku-5-5"),
  none: writerSwitchedOff({}, "codex", "gpt-6-luna"),
};
out.skillLine = {
  picked: skillPickedLine({ skills: ["lp-writer", "modern-web-guidance"] }), role: skillPickedLine({}),
};
{
  const names = (policy: ReturnType<typeof roleProfilePolicy>) => policy.mcpServers?.names ?? [];
  out.mcpRegistry = {
    writer: ROLE_PROFILES.writer.mcpServers, debuggerRole: ROLE_PROFILES.debugger.mcpServers, critic: ROLE_PROFILES["plan-critic"].mcpServers,
    writerHasGraph: names(roleProfilePolicy("writer")).includes("gitnexus"), writerHasMeta: names(roleProfilePolicy("writer")).includes("metamcp"), criticHasGraph: names(roleProfilePolicy("plan-critic")).includes("gitnexus"),
    owned: names(roleProfilePolicy("writer", { mcpServers: { mode: "allow", names: ["metamcp"] } })), all: roleProfilePolicy("writer", { mcpServers: { mode: "all" } }).mcpServers ?? null,
  };
  const access = parseRoleAccess({ mcpServers: { mode: "allow", names: ["gitnexus", "metamcp", 42, { command: "rm" }], command: "evil", args: ["-rf"], url: "https://x" } });
  out.mcpToggle = { stored: access.mcpServers, keys: Object.keys(access.mcpServers!) };
}

// ---- n697 the conveyor switch on a store ----
{
  const store = new Map<string, unknown>();
  const kv = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } };
  const fresh = await conveyorState(kv);
  const off = await setConveyor(kv, false, "  deploy window  ");
  const read = await conveyorState(kv);
  const again = await setConveyor(kv, false, "another reason");
  const on = await setConveyor(kv, true);
  out.conveyor = { fresh, off, read, againSame: JSON.stringify(again) === JSON.stringify(off), on };
}

// ---- n698 the worker totals ----
{
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const DAY = 86_400_000, NOW = 100 * DAY;
  createRun(db, "run", "proj", "bb", "/repo");
  const task = (id: string) => db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,'run','bb','{}',?)").run(id, NOW - 5000);
  const attempt = (id: string, taskId: string, no: number, state: string, at: number) =>
    db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,thread_id,state,attempt_no,created_at,updated_at) VALUES(?,'run',?,NULL,?,?,?,?)").run(id, taskId, state, no, at, at + 120_000);
  for (const id of ["done-a", "done-b", "stuck", "blocked", "old"]) task(id);
  attempt("a1", "done-a", 1, "accepted", NOW - 2 * DAY); attempt("a2", "done-b", 1, "failed", NOW - 3 * DAY); attempt("a3", "done-b", 2, "accepted", NOW - 2 * DAY);
  attempt("a4", "stuck", 1, "running", NOW - DAY); attempt("a6", "blocked", 1, "blocked", NOW - DAY); attempt("a5", "old", 1, "accepted", NOW - 40 * DAY);
  const report = attemptMetrics(db as never, { projectId: "proj", days: 30, now: NOW });
  out.workerStats = {
    attempts: report.attempts.map((row) => `${row.attemptId}:${row.state}`).sort(), total: report.summary.attempts, perAccepted: report.summary.attemptsPerAcceptedTask,
    doneSeconds: report.attempts.find((row) => row.attemptId === "a1")!.seconds, runningSeconds: report.attempts.find((row) => row.attemptId === "a4")!.seconds,
  };
}

// ---- n678 finish decisions on entry ----
{
  const world = (failResume = false) => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const order: string[] = [];
    const services = {
      activeWriterTasks: new Set<string>(), docsPlaces: async () => [],
      resumeOrphans: async () => { order.push("resume"); if (failResume) throw new Error("resume broke"); return { resumed: [], finished: [], skipped: [] }; },
      recheckCancels: async () => { order.push("recheck-cancels"); },
      stability: { reconcileScanOpen: undefined, adoptBlockedByFaults: async () => { order.push("park"); }, sweep: async () => { order.push("parked-sweep"); } },
      recoverMergeIntents: async (opts: { graceMs: number }) => { order.push(`merge-intents:${opts.graceMs}`); },
      startAfterAcceptance: () => undefined,
      workflowEngine: { resume: async () => { order.push("wf-resume"); }, poll: async () => { order.push("wf-poll"); } },
    };
    return { order, reconcile: createTaskReconcile({ bb, db, log: () => undefined, isDisposed: () => false } as never, services as never) };
  };
  const startup = world();
  await startup.reconcile.reconcileTasks({ phase: "startup", afterResume: () => { startup.order.push("after-resume"); } });
  const periodic = world();
  await periodic.reconcile.reconcileTasks({ phase: "periodic" });
  const broken = world(true);
  await broken.reconcile.reconcileTasks({ phase: "startup" });
  out.reconcile = { startup: startup.order, periodic: periodic.order, broken: broken.order };
}

// ---- n699–n702 bring your own helpers ----
{
  const PAGES = [
    { path: ".claude/agents/yard.md", content: "---\nname: yard\ndescription: A yard agent.\n---\n\nKeep the yard tidy.\n" },
    { path: ".claude/skills/pick/SKILL.md", content: "---\nname: pick\ndescription: Use when picking.\n---\n\nDo the pick.\n" },
    { path: ".opencode/agent/scout.md", content: "---\ndescription: Scouts the repo.\n---\n\nLook around.\n" },
    { path: ".codex/agents/ranger.toml", content: 'name = "ranger"\ndescription = "A codex ranger."\ninstructions = """Walk the trail."""\n' },
    { path: ".claude/agents/no-front-matter.md", content: "just text, no front matter" },
    { path: ".claude/other/readme.md", content: "---\nname: readme\n---\nnot a helper root" },
  ];
  const world = (writeStatus: (n: number) => string | Error = () => "applied") => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    let writes = 0;
    bb.hosts.experimental_client = (() => ({ call: async (method: string, input: Record<string, unknown>) => {
      calls.push({ method, input });
      if (method === "listDocsPages") return { pages: PAGES };
      const outcome = writeStatus(++writes);
      if (outcome instanceof Error) throw outcome;
      return { status: outcome };
    } })) as never;
    createRun(db, "r1", "p1", "bb", "/ws", "none", undefined as never, "h1");
    return { api: createFront({ db, bb, log: () => undefined, isDisposed: () => false } as never).front, calls };
  };
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  {
    const { api, calls } = world();
    const found = await api.helpers("r1");
    out.scan = { rootsMatch: JSON.stringify((calls[0]!.input as { roots: string[] }).roots) === JSON.stringify([...HELPER_ROOTS]), host: calls[0]!.input.requestedHostId, skipOversized: calls[0]!.input.skipOversized, found: found.map((row) => `${row.format}:${row.kind}:${row.name}`) };
    out.formats = {
      claude: parseHelper(PAGES[0]!.path, PAGES[0]!.content), opencode: parseHelper(".opencode/agents/scout.md", PAGES[2]!.content), opencodeSkill: parseHelper(".opencode/skill/deep/SKILL.md", "---\ndescription: Deep.\n---\n\nGo deep.\n"),
      codex: parseHelper(PAGES[3]!.path, PAGES[3]!.content), noFront: parseHelper(".claude/agents/x.md", "no front matter"), foreign: parseHelper(".cursor/agents/x.md", "---\nname: x\n---\nbody"),
    };
  }
  {
    const { api, calls } = world();
    const results = await api.importHelpers("r1", ["yard", "pick"]);
    const writes = calls.filter((call) => call.method === "writeForgeDraft").map((call) => call.input as { edits: Array<{ path: string; expectedSha256: unknown; content: string }>; previewSha256: string });
    out.enroll = {
      results, paths: writes.map((write) => write.edits[0]!.path), cas: writes.map((write) => write.edits[0]!.expectedSha256), previewOk: writes.map((write) => write.previewSha256 === sha(JSON.stringify(write.edits))),
      roleHasModel: writes[0]!.edits[0]!.content.includes("model: sonnet\ntools: Read, Grep, Glob, Bash\n"), skillHasModel: writes[1]!.edits[0]!.content.includes("model:"), roleSource: writes[0]!.edits[0]!.content.includes("<!-- imported from .claude/agents/yard.md (claude) -->"),
    };
  }
  {
    const slug = (name: string) => helperDraft({ source: ".claude/agents/x.md", name, description: "", body: "b", format: "claude", kind: "agent" }).match(/^name: (.+)$/m)![1];
    const { api, calls } = world((n) => (n === 1 ? "applied" : n === 2 ? "conflict" : new Error("host offline")));
    const first = await api.importHelpers("r1", ["yard"]);
    const second = await api.importHelpers("r1", ["yard"]);
    const third = await api.importHelpers("r1", ["yard"]);
    out.slug = {
      slugs: [slug("My Helper_X!"), slug("--Edge Case--"), slug("a".repeat(80)).length], first, second, third,
      allCas: calls.filter((entry) => entry.method === "writeForgeDraft").every((call) => (call.input.edits as Array<{ expectedSha256: unknown }>)[0]!.expectedSha256 === null),
    };
  }
}

process.stdout.write(`${JSON.stringify(out)}\n`);
