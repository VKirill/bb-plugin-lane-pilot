// Region 8 · Daemon front outside the graphs, batch a — the behaviour proofs of the map nodes n674–n702 (docs/sma-evidence.md).
// Each test checks the result a card names (what was answered, written or refused), not that a function was called.
// The window half (n684) is in four-proofs-r08-a2.test.tsx (it needs jsdom).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import plugin from "../../server";
import { hostMethods, rpcContract } from "../../src/rooms/contracts";
import { createFront } from "../../src/rooms/front/server/index";
import { HELPER_ROOTS, helperDraft, parseHelper } from "../../src/rooms/front/logic";
import { createRun, openDatabase } from "../../src/rooms/plugin-db";
import { createTaskReconcile } from "../../src/rooms/runs/server/task-reconcile";
import { conveyorState, setConveyor } from "../../src/rooms/runs/conveyor";
import { timeRpcHandlers } from "../../src/rooms/core/server/rpc-timing";
import { LEGACY_TABS, resolveTab, TAB_IDS } from "../../src/rooms/pages/tabs-model";
import { runOnHost } from "../../packages/host-calls/src/run-on-host";
import { skillPickedLine } from "../../src/rooms/writer/server/writer-task";
import { ROLE_PROFILES, roleProfilePolicy } from "../../src/rooms/contracts/helper-context";
import { isReservedAgentId, isStockProfileId, MAIN_AGENT_PROFILE_IDS } from "../../src/rooms/contracts/native-agent-static";
import { attemptMetrics } from "../../src/rooms/usage/server/attempt-metrics";

const ROOT = join(__dirname, "../..");
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function host() {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  await plugin(bb);
  cleanup.push(() => harness.lifecycle.dispose());
  const call = <T = unknown>(name: string, input: Record<string, unknown> = {}) => harness.behavior.callRpc(name as never, input as never) as Promise<T>;
  const refusal = async (name: string, input: Record<string, unknown> = {}) => { try { await call(name, input); return null; } catch (cause) { return (cause as Error).message; } };
  return { bb, harness, call, refusal };
}
const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };

describe("the door: table, match, journal, named failure (n674, n675, n682, n683)", () => {
  it("[sma:m_gt_match] a call is matched to the table by its name and its input by shape: an unknown name, an empty id and a stray field are refused, a well-formed call reaches its handler", async () => {
    const { call, refusal } = await host();
    expect(await refusal("no_such_door")).toBe('plugin "lane-pilot" has no rpc method "no_such_door"');
    expect(await refusal("halt_run", {})).toBe("rpc input validation failed");
    expect(await refusal("halt_run", { runId: "" })).toBe("rpc input validation failed");
    expect(await refusal("halt_run", { runId: "r1", stray: 1 })).toBe("rpc input validation failed");
    // a well-formed call is not refused by the table: it reaches the handler and answers
    expect(await call("conveyor")).toEqual({ on: true, since: null, reason: null });
  });

  it("[sma:m_gt_within_door] a call that changes something leaves one line (name, argument keys, time) and never its values; a read leaves none", async () => {
    const { bb, call } = await host();
    const before = Date.now();
    await call("list_agents");
    expect(await bb.storage.kv.get("lp.front.actions")).toBeUndefined();
    await call("conveyor", { set: "off", reason: "secret-looking reason" });
    const lines = (await bb.storage.kv.get("lp.front.actions")) as Array<{ at: number; action: string; keys: string[] }>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({ at: expect.any(Number), action: "conveyor", keys: ["set", "reason"] });
    expect(lines[0]!.at).toBeGreaterThanOrEqual(before);
    expect(JSON.stringify(lines)).not.toContain("secret-looking reason");
  });

  it("[sma:m_gt_threw] a handler that threw is named in the log with its elapsed time and the word failed, a refusal is not called failed, the caller still gets the original error", async () => {
    const logged: string[] = [];
    let clock = 0;
    const handlers = timeRpcHandlers({
      broken: async (_input: never) => { throw new Error("disk gone"); },
      refused: async (_input: never) => { throw Object.assign(new Error("the owner gate"), { refused: true }); },
      fine: async (_input: never) => ({ ok: true }),
    }, (line) => logged.push(line), () => (clock += 40));
    await expect(handlers.broken(undefined as never)).rejects.toThrow("disk gone");
    await expect(handlers.refused(undefined as never)).rejects.toThrow("the owner gate");
    expect(await handlers.fine(undefined as never)).toEqual({ ok: true });
    expect(logged).toEqual(["rpc broken 40 ms failed", "rpc refused 40 ms refused", "rpc fine 40 ms"]);
  });
});

describe("the window folder and the old page (n685, n686)", () => {
  it("[sma:m_gt_static_dir] the plugin's window is built from the one app entry the package names, and the package builds with bb plugin build", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { bb: Record<string, string>; scripts: Record<string, string> };
    expect(pkg.bb.app).toBe("./app.tsx");
    expect(existsSync(join(ROOT, pkg.bb.app!))).toBe(true);
    expect(readFileSync(join(ROOT, pkg.bb.app!), "utf8")).toContain("definePluginApp(");
    expect(pkg.bb.server).toBe("./server.ts");
    expect(pkg.bb.host).toBe("./host.ts");
    expect(pkg.scripts.build).toBe("bb plugin build");
  });

  it("[sma:m_gt_roster_html] the old page's links lead on to the new tabs: every pre-regroup id resolves to its tab and segment, a current id stays, an unknown one lands on the overview", () => {
    expect(LEGACY_TABS).toEqual({
      settings: { tab: "work" }, checks: { tab: "work" }, council: { tab: "team" }, access: { tab: "team" },
      memory: { tab: "knowledge", segment: "memory" }, passport: { tab: "knowledge", segment: "passport" }, rules: { tab: "knowledge", segment: "rules" },
      anamnesis: { tab: "knowledge", segment: "anamnesis" }, workflows: { tab: "automation", segment: "workflows" }, schedule: { tab: "automation", segment: "schedule" },
      monitor: { tab: "runs", segment: "board" }, service: { tab: "runs", segment: "service" },
    });
    for (const [old, target] of Object.entries(LEGACY_TABS)) expect(resolveTab(old), old).toEqual(target);
    for (const id of TAB_IDS) expect(resolveTab(id)).toEqual({ tab: id });
    expect(resolveTab("roster")).toEqual({ tab: "overview" });
  });
});

describe("the peer: which machine, and what never reaches it (n687, n688)", () => {
  it("[sma:m_gt_proxy] an action for another machine goes to that machine: its id is both in the command's input and the call's target, with the transport time on top of the command's own limit; the own machine is the one named", async () => {
    const calls: Array<{ method: string; input: Record<string, unknown>; options: Record<string, unknown> }> = [];
    const client = { call: async (method: "runCommand", input: never, options: never) => { calls.push({ method, input, options } as never); return { hostId: "mac-2", exitCode: 0, stdout: "ok", stderr: "" }; } };
    const answer = await runOnHost(client as never, { hostId: "mac-2", cwd: "/work/p", command: "lane-coord status", timeoutSec: 20 });
    expect(answer).toEqual({ hostId: "mac-2", exitCode: 0, stdout: "ok", stderr: "" });
    expect(calls).toEqual([{ method: "runCommand", input: { requestedHostId: "mac-2", command: "lane-coord status", cwd: "/work/p", timeoutSec: 20 }, options: { hostId: "mac-2", timeoutMs: 25_000 } }]);
    await runOnHost(client as never, { hostId: "hub", cwd: "/x", command: "true", timeoutSec: 1, timeoutMs: 777 });
    expect(calls[1]!.options).toEqual({ hostId: "hub", timeoutMs: 777 });
  });

  it("[sma:m_gt_proxy_refuse] the owner's word is only a hub call: no host (peer) method carries a word's name, and every word call of the hub is absent from the peers' closed list", () => {
    const words = Object.keys(rpcContract).filter((name) => /(^|_)(word|answer)(_|$)/.test(name));
    expect(words.sort()).toEqual(["first_run_answer", "task_word", "workflow_answer"]);
    const peerMethods = Object.keys(hostMethods);
    expect(peerMethods.length).toBeGreaterThan(40);
    for (const name of words) expect(peerMethods, name).not.toContain(name);
    expect(peerMethods.filter((name) => /word/i.test(name))).toEqual([]);
  });
});

describe("the roster: workers, the stock team, skills, connections, the switch (n689–n698)", () => {
  it("[sma:m_hs_read] the roster read lists the stock team first in the product's order and then the owner's own, which carry their skills and connections; the custom filter shows only the owner's", async () => {
    const { call } = await host();
    const stock = await call<{ agents: Array<{ id: string; custom: boolean }> }>("list_agents");
    expect(stock.agents.map((row) => row.id)).toEqual([...MAIN_AGENT_PROFILE_IDS]);
    expect(stock.agents.every((row) => row.custom === false)).toBe(true);
    await call("create_agent", { id: "context-lead", displayName: "Context", description: "Keeps context.", prompt: "You keep the context in order.", skills: ["lane-memory"], mcpServers: ["gitnexus"], model: "claude-opus-5-5", effort: "high" });
    const all = (await call<{ agents: Array<{ id: string; custom: boolean; skills?: string[]; mcpServers?: string[] }> }>("list_agents")).agents;
    expect(all.map((row) => row.id)).toEqual([...MAIN_AGENT_PROFILE_IDS, "context-lead"]);
    expect(all.at(-1)).toMatchObject({ id: "context-lead", custom: true, skills: ["lane-memory"], mcpServers: ["gitnexus"] });
    const own = (await call<{ agents: Array<{ id: string }> }>("list_agents", { custom: true })).agents;
    expect(own.map((row) => row.id)).toEqual(["context-lead"]);
  });

  it("[sma:m_hs_stock] the product's stock roles are one closed set: a stock id is recognised, a custom id is not, and an owner cannot create an agent under a stock name", async () => {
    expect(MAIN_AGENT_PROFILE_IDS.every((id) => isStockProfileId(id))).toBe(true);
    expect(isStockProfileId("context-lead")).toBe(false);
    expect(isReservedAgentId("copy-lead")).toBe(true);
    expect(isReservedAgentId("context-lead")).toBe(false);
    const { call } = await host();
    expect(await call("create_agent", { id: "copy-lead", displayName: "Mine", description: "d", prompt: "You are mine, long enough to be a prompt." })).toMatchObject({ ok: false, id: "copy-lead", error: "agent_id_reserved" });
    const kept = (await call<{ agents: Array<{ id: string; custom: boolean }> }>("list_agents")).agents.filter((row) => row.id === "copy-lead");
    expect(kept).toEqual([expect.objectContaining({ id: "copy-lead", custom: false })]);
  });

  it("[sma:m_hs_skill_assign] a worker's skill list becomes the one line its session opens with: the picked skills named, or the role's own with the note that Lane Pilot picked more", () => {
    expect(skillPickedLine({ skills: ["lp-writer", "modern-web-guidance"] })).toBe("Your skills for this task: lp-writer, modern-web-guidance.");
    expect(skillPickedLine({})).toBe("Your skills for this task: lp-writer, karpathy-guidelines, and the skills Lane Pilot picked for this task.");
    expect(skillPickedLine({ skills: [] })).toBe("Your skills for this task: lp-writer, karpathy-guidelines, and the skills Lane Pilot picked for this task.");
  });

  it("[sma:m_hs_mcp_registry] which connections a role gets is set by its profile: the writer and the debugger get the code graph, a one-shot critic none, and the owner's allow list replaces the profile (the mandatory ones stay)", () => {
    expect(ROLE_PROFILES.writer.mcpServers).toEqual(["gitnexus"]);
    expect(ROLE_PROFILES.debugger.mcpServers).toEqual(["gitnexus"]);
    expect(ROLE_PROFILES["plan-critic"].mcpServers).toEqual([]);
    const names = (policy: ReturnType<typeof roleProfilePolicy>) => policy.mcpServers?.names ?? [];
    expect(names(roleProfilePolicy("writer"))).toContain("gitnexus");
    expect(names(roleProfilePolicy("writer"))).not.toContain("metamcp");
    expect(names(roleProfilePolicy("plan-critic"))).not.toContain("gitnexus");
    const owned = roleProfilePolicy("writer", { mcpServers: { mode: "allow", names: ["metamcp"] } });
    expect(names(owned)).toContain("metamcp");
    expect(names(owned)).not.toContain("gitnexus");
    expect(roleProfilePolicy("writer", { mcpServers: { mode: "all" } }).mcpServers).toBeUndefined();
  });

  it("[sma:m_hs_pipeline] the conveyor switch is written to the store and read back at once: off keeps the first moment and a trimmed reason, off again changes nothing, on clears it", async () => {
    const store = new Map<string, unknown>();
    const kv = { get: async (key: string) => store.get(key), set: async (key: string, value: unknown) => { store.set(key, value); } };
    expect(await conveyorState(kv)).toEqual({ on: true, since: null, reason: null });
    const off = await setConveyor(kv, false, "  deploy window  ");
    expect(off).toMatchObject({ on: false, reason: "deploy window" });
    expect(off.since).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(await conveyorState(kv)).toEqual(off);
    expect(await setConveyor(kv, false, "another reason")).toEqual(off);
    expect(await setConveyor(kv, true)).toEqual({ on: true, since: null, reason: null });
    expect(await conveyorState(kv)).toEqual({ on: true, since: null, reason: null });
    // through the door: the same flag, and a second host instance over the same store sees it
    const { call } = await host();
    expect(await call("conveyor", { set: "off", reason: "night" })).toMatchObject({ on: false, reason: "night" });
    expect(await call("conveyor")).toMatchObject({ on: false, reason: "night" });
    expect(await call("conveyor", { set: "on" })).toEqual({ on: true, since: null, reason: null });
  });

  it("[sma:m_hs_worker_stats] the worker totals are counted from the ledger's attempts in the window: done and not done separately, an attempt older than the window left out, attempts per accepted task", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const DAY = 86_400_000;
    const NOW = 100 * DAY;
    createRun(db, "run", "proj", "bb", "/repo");
    const task = (id: string) => db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,'run','bb','{}',?)").run(id, NOW - 5000);
    const attempt = (id: string, taskId: string, no: number, state: string, at: number) =>
      db.prepare("INSERT INTO lane_pilot_attempt(id,run_id,task_id,thread_id,state,attempt_no,created_at,updated_at) VALUES(?,'run',?,NULL,?,?,?,?)").run(id, taskId, state, no, at, at + 120_000);
    for (const id of ["done-a", "done-b", "stuck", "blocked", "old"]) task(id);
    attempt("a1", "done-a", 1, "accepted", NOW - 2 * DAY);
    attempt("a2", "done-b", 1, "failed", NOW - 3 * DAY);
    attempt("a3", "done-b", 2, "accepted", NOW - 2 * DAY);
    attempt("a4", "stuck", 1, "running", NOW - DAY);
    attempt("a6", "blocked", 1, "blocked", NOW - DAY);
    attempt("a5", "old", 1, "accepted", NOW - 40 * DAY);
    const report = attemptMetrics(db as never, { projectId: "proj", days: 30, now: NOW });
    expect(report.attempts.map((row) => `${row.attemptId}:${row.state}`).sort()).toEqual(["a1:accepted", "a2:failed", "a3:accepted", "a4:running", "a6:blocked"]);
    expect(report.summary.attempts).toBe(5);
    expect(report.summary.attemptsPerAcceptedTask).toBe(2.5);
    expect(report.attempts.find((row) => row.attemptId === "a1")!.seconds).toBe(120);
    expect(report.attempts.find((row) => row.attemptId === "a4")!.seconds).toBeNull();
    const week = attemptMetrics(db as never, { projectId: "proj", days: 7, now: NOW });
    expect(week.summary.attempts).toBe(5);
    expect(attemptMetrics(db as never, { projectId: "proj", days: 1, now: NOW - DAY + 1000 }).summary.attempts).toBe(2);
  });
});

describe("finish decisions on entry (n678)", () => {
  const world = (failResume = false) => {
    const { bb, db } = open();
    const order: string[] = [];
    const services = {
      activeWriterTasks: new Set<string>(),
      docsPlaces: async () => [],
      resumeOrphans: async () => { order.push("resume"); if (failResume) throw new Error("resume broke"); return { resumed: [], finished: [], skipped: [] }; },
      recheckCancels: async () => { order.push("recheck-cancels"); },
      stability: { reconcileScanOpen: undefined, adoptBlockedByFaults: async () => { order.push("park"); }, sweep: async () => { order.push("parked-sweep"); } },
      recoverMergeIntents: async (opts: { graceMs: number }) => { order.push(`merge-intents:${opts.graceMs}`); },
      startAfterAcceptance: () => undefined,
      workflowEngine: { resume: async () => { order.push("wf-resume"); }, poll: async () => { order.push("wf-poll"); } },
    };
    const reconcile = createTaskReconcile({ bb, db, log: () => undefined, isDisposed: () => false } as never, services as never);
    return { order, reconcile };
  };

  it("[sma:m_gt_reconcile_on_open] on entry the pending decisions are finished in the card's order (merge intents with no grace, resume, the caller's sweeps, parking, the parked sweep, workflow runs); the periodic pass keeps a grace and re-checks cancels instead of resuming; one step failing stops no later one", async () => {
    const startup = world();
    await startup.reconcile.reconcileTasks({ phase: "startup", afterResume: () => { startup.order.push("after-resume"); } });
    expect(startup.order).toEqual(["merge-intents:0", "resume", "after-resume", "park", "parked-sweep", "wf-resume", "wf-poll"]);
    const periodic = world();
    await periodic.reconcile.reconcileTasks({ phase: "periodic" });
    expect(periodic.order).toEqual(["merge-intents:120000", "recheck-cancels", "park", "parked-sweep", "wf-resume", "wf-poll"]);
    const broken = world(true);
    await broken.reconcile.reconcileTasks({ phase: "startup" });
    expect(broken.order).toEqual(["merge-intents:0", "resume", "park", "parked-sweep", "wf-resume", "wf-poll"]);
  });
});

describe("bring your own helpers (n699–n702)", () => {
  const front = (db: never, bb: never) => createFront({ db, bb, log: () => undefined, isDisposed: () => false } as never).front;
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const PAGES = [
    { path: ".claude/agents/yard.md", content: "---\nname: yard\ndescription: A yard agent.\n---\n\nKeep the yard tidy.\n" },
    { path: ".claude/skills/pick/SKILL.md", content: "---\nname: pick\ndescription: Use when picking.\n---\n\nDo the pick.\n" },
    { path: ".opencode/agent/scout.md", content: "---\ndescription: Scouts the repo.\n---\n\nLook around.\n" },
    { path: ".codex/agents/ranger.toml", content: 'name = "ranger"\ndescription = "A codex ranger."\ninstructions = """Walk the trail."""\n' },
    { path: ".claude/agents/no-front-matter.md", content: "just text, no front matter" },
    { path: ".claude/other/readme.md", content: "---\nname: readme\n---\nnot a helper root" },
  ];
  const world = (writeStatus: (n: number) => string | Error = () => "applied") => {
    const { bb, db } = open();
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
    return { api: front(db as never, bb as never), calls };
  };

  it("[sma:m_im_scan] the scan asks the run's machine for the other tools' agent and skill folders and lists what parses: agents and skills of Claude Code, OpenCode and Codex, nothing from a file without front matter or outside the roots", async () => {
    const { api, calls } = world();
    const found = await api.helpers("r1");
    expect(calls[0]).toMatchObject({ method: "listDocsPages", input: { requestedHostId: "h1", projectCwd: "/ws", roots: [...HELPER_ROOTS], skipOversized: true } });
    expect(found.map((row) => `${row.format}:${row.kind}:${row.name}`)).toEqual(["claude:agent:yard", "claude:skill:pick", "opencode:agent:scout", "codex:agent:ranger"]);
    expect(found.find((row) => row.name === "pick")).toMatchObject({ source: ".claude/skills/pick/SKILL.md", description: "Use when picking.", body: "Do the pick." });
  });

  it("[sma:m_im_formats] each tool's format is read by its own parser: Claude Code and OpenCode by front matter (the name falling back to the file or folder), Codex agents by their TOML name, description and instructions", () => {
    expect(parseHelper(".claude/agents/yard.md", PAGES[0]!.content)).toEqual({ source: ".claude/agents/yard.md", name: "yard", description: "A yard agent.", body: "Keep the yard tidy.", format: "claude", kind: "agent" });
    expect(parseHelper(".opencode/agents/scout.md", PAGES[2]!.content)).toEqual({ source: ".opencode/agents/scout.md", name: "scout", description: "Scouts the repo.", body: "Look around.", format: "opencode", kind: "agent" });
    expect(parseHelper(".opencode/skill/deep/SKILL.md", "---\ndescription: Deep.\n---\n\nGo deep.\n")).toMatchObject({ format: "opencode", kind: "skill", name: "deep" });
    expect(parseHelper(".codex/agents/ranger.toml", PAGES[3]!.content)).toEqual({ source: ".codex/agents/ranger.toml", name: "ranger", description: "A codex ranger.", body: "Walk the trail.", format: "codex", kind: "agent" });
    expect(parseHelper(".codex/agents/plain.toml", 'description = "no name"\n')).toMatchObject({ name: "plain", format: "codex" });
    expect(parseHelper(".claude/agents/x.md", "no front matter")).toBeNull();
    expect(parseHelper(".cursor/agents/x.md", "---\nname: x\n---\nbody")).toBeNull();
  });

  it("[sma:m_im_enroll] each chosen helper becomes a draft in its kind's forge folder, written only if absent, previewed by the hash of exactly those edits; a helper not chosen is not written", async () => {
    const { api, calls } = world();
    const results = await api.importHelpers("r1", ["yard", "pick"]);
    expect(results).toEqual([{ name: "yard", status: "applied" }, { name: "pick", status: "applied" }]);
    const writes = calls.filter((call) => call.method === "writeForgeDraft").map((call) => call.input as { requestedHostId: string; projectCwd: string; previewSha256: string; edits: Array<{ path: string; expectedSha256: null; content: string }> });
    expect(writes.map((write) => write.edits[0]!.path)).toEqual([".agents/forge/roles/yard/yard.md", ".agents/forge/skills/pick/SKILL.md"]);
    for (const write of writes) {
      expect(write).toMatchObject({ requestedHostId: "h1", projectCwd: "/ws" });
      expect(write.edits).toHaveLength(1);
      expect(write.edits[0]!.expectedSha256).toBeNull();
      expect(write.previewSha256).toBe(sha(JSON.stringify(write.edits)));
    }
    expect(writes[0]!.edits[0]!.content).toBe('---\nname: yard\ndescription: "A yard agent."\nmodel: sonnet\ntools: Read, Grep, Glob, Bash\n---\n\nKeep the yard tidy.\n\n<!-- imported from .claude/agents/yard.md (claude) -->\n');
    expect(writes[1]!.edits[0]!.content).toBe('---\nname: pick\ndescription: "Use when picking."\n---\n\nDo the pick.\n\n<!-- imported from .claude/skills/pick/SKILL.md (claude) -->\n');
    expect(calls.filter((call) => call.method === "writeForgeDraft")).toHaveLength(2);
  });

  it("[sma:m_im_slug] a name is made safe and never overwrites: the draft name is a lowercase slug of at most 47 characters, a clash is the named «kept» result with the existing draft untouched, a failed write is named too", async () => {
    const draft = (name: string) => helperDraft({ source: ".claude/agents/x.md", name, description: "", body: "b", format: "claude", kind: "agent" }).match(/^name: (.+)$/m)![1];
    expect(draft("My Helper_X!")).toBe("my-helper-x");
    expect(draft("--Edge Case--")).toBe("edge-case");
    expect(draft("a".repeat(80))).toBe("a".repeat(47));
    const { api, calls } = world((n) => (n === 1 ? "applied" : n === 2 ? "conflict" : new Error("host offline")));
    const first = await api.importHelpers("r1", ["yard"]);
    const second = await api.importHelpers("r1", ["yard"]);
    const third = await api.importHelpers("r1", ["yard"]);
    expect(first).toEqual([{ name: "yard", status: "applied" }]);
    expect(second).toEqual([{ name: "yard", status: "kept: a draft with this name exists" }]);
    expect(third).toEqual([{ name: "yard", status: "failed: host offline" }]);
    for (const call of calls.filter((entry) => entry.method === "writeForgeDraft")) expect((call.input.edits as Array<{ expectedSha256: unknown }>)[0]!.expectedSha256).toBeNull();
  });
});
