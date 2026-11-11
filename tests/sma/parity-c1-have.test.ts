import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { createPhaseDriver } from "../phase-driver";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { walkWriterChain, waitingWriterReason, type WriterHoldDeps } from "../../src/rooms/writer/server/writer-hold";
import { buildBubblewrapArgs, buildSeatbeltProfile } from "../../src/rooms/verification/sandbox";
import { grantCommands } from "../../src/rooms/verification/worker-user";
import { createHelperProbe } from "../../src/rooms/native-agent/server/helper-probe";
import { queryTokenUsage, utcDay } from "../../src/rooms/usage/server/token-usage";
import { moneyHold, spendBook, type DailyRow } from "../../src/rooms/money";
import { CAPABILITIES, DOCUMENTARY_CELLS, capabilityState, documentaryProved, receiptKey } from "../../src/rooms/capability";
import { NATIVE_HOOK_SOURCES } from "../../src/rooms/contracts";
import { createCapabilities, runCapabilityCli } from "../../src/rooms/capability/server";
import { documentaryGateOf } from "../../src/rooms/platform/server/pm-spawn";
import { rpcContract } from "../../src/rooms/contracts";
import plugin from "../../server";
import { effectiveGroup, parseRoleAccess, ROLE_PROFILES, roleAccessFromSettings, roleAccessKey } from "../../src/rooms/contracts/helper-context";
import { stageInit, validationGaps, conclusionText } from "../../src/rooms/phase/stages";
import { issueMessage } from "../../src/rooms/backlog/logic";
import { isAllowedProjectLifePath } from "../../src/rooms/project-life/project-life";
import { proposeTaskWords } from "../../src/rooms/cockpit/ui/screens-work";
import { settingsRpc } from "../../src/rooms/settings/server/rpc/settings";
import { loadPushConfig, savePushConfig } from "../../src/rooms/owner-waiting/push";
import { cockpitRpc } from "../../src/rooms/cockpit";
import { listRuleProposals, upsertLessonProposal } from "@lane-pilot/run-insights";
import { storeMemoryRecords } from "../../packages/memory-core/src";
import { phaseRpc } from "../../src/rooms/phase/server/rpc";
import { listParts, savePhase } from "../../src/rooms/phase/store";
import { blindVerdict, designGate, type PhaseRecord } from "../../src/rooms/phase/logic";
import { saveRunGoal } from "../../src/rooms/run-goal/store";
import { writerBriefSegments } from "../../src/rooms/writer/server/writer-task";
import { parseQaVerdict } from "../../src/rooms/qa/server/qa-thread";
import { failedTasksAllProjects } from "../../src/rooms/storage/attempts-store";
import { parkAttemptWake } from "../../src/rooms/storage/attempts-store";
import {
  createAttempt, createRun, createTask, getAttempt, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread, transitionAttempt,
} from "../../src/rooms/plugin-db";
import { SANDBOX_PROJECT_ID } from "../../src/rooms/contracts";
import type { PrototypeConfig, TaskV2 } from "../../src/rooms/contracts";

// startHelperProbe waits on the thread going idle; the fake host's threads.get is stubbed per test, so the wait is instant.
vi.mock("@lane-pilot/thread-observe", async (importOriginal) => ({ ...(await importOriginal() as Record<string, unknown>), waitThreadIdle: async () => undefined }));

const open = () => { const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" }); return { bb, harness, db: openDatabase(bb) }; };
const workflow = (name: string) => JSON.parse(readFileSync(join(process.cwd(), "workflows", `${name}.json`), "utf8")) as { entry?: string; nodes?: Array<Record<string, any>>; edges?: Array<Record<string, any>>; inputs?: Record<string, unknown> };
const nodes = (name: string) => workflow(name).nodes ?? [];
const node = (name: string, id: string) => nodes(name).find((row) => row.id === id)!;
const contract = (id: string): TaskV2 => ({
  schema_version: 2, id, display_title: `Task ${id}`, kind: "feature", title: `Task ${id}`, risk: "low", lane: "writer", project_cwd: "/ws",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: [`${id}/a.txt`], owns_paths: [`${id}/**`], never_touch: [],
  depends_on: [], objective: `Make ${id}`, acceptance: ["done"], verify: "tests", verification: [{ command: "npm test", cwd: "/ws" }],
});
const holdDeps = (over: Partial<WriterHoldDeps>): WriterHoldDeps => ({
  breaker: { snapshot: () => [] }, presence: undefined, usage: { hold: async () => null }, coreHosts: () => true, log: () => undefined,
  ...over,
}) as unknown as WriterHoldDeps;

function driver(status = "idle") {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const sent: string[] = [];
  harness.sdk.stub("threads.send", async (input: { input: Array<{ text: string }> }) => { sent.push(input.input[0]!.text); return {}; });
  harness.sdk.stub("threads.get", async () => ({ status }));
  harness.sdk.stub("threads.list", async () => []);
  const db = openDatabase(bb);
  createRun(db, "run1", "projA");
  db.prepare("UPDATE lane_pilot_run SET writer_workspace_path='/ws', writer_host_id='h1' WHERE id='run1'").run();
  const ctx = createCore(bb, db);
  const phases = createPhaseDriver(ctx, { runBudgets: { get: () => undefined } } as unknown as Services).phases;
  return { phases, sent, db, bb, harness, ctx };
}

describe("providers, models, accounts", () => {
  it("[sma:m_ac_missing] a chain whose only member has an open breaker parks the attempt queued with waiting_writer:writer_provider_unavailable:breaker_open:…; a chain of only core_unsupported members is refused with that reason named", async () => {
    const now = Date.now();
    const deps = holdDeps({ breaker: { snapshot: () => [{ key: "a/m", state: "open", openedAt: now - 60_000, failures: 3 }] } as never });
    const walk = await walkWriterChain([{ providerId: "a", model: "m" }], { hostId: "h", settings: {} }, deps, now);
    expect(walk.free).toBeUndefined();
    expect(walk.allUnsupported).toBe(false);
    const reason = waitingWriterReason(walk.shortest!.hold);
    expect(reason).toMatch(/^waiting_writer:writer_provider_unavailable:breaker_open:a\/m/);
    const { bb, db, harness } = open();
    createRun(db, "run_w", "projA");
    createTask(db, { id: "tw", runId: "run_w", kind: "bb", contract: contract("tw") });
    createAttempt(db, { id: "att_w", runId: "run_w", taskId: "tw" });
    parkAttemptWake(db, "att_w", reason, walk.wakeAt);
    const parked = getAttempt(db, "att_w")!;
    expect(parked.state).toBe("queued");
    expect(parked.reason).toBe(reason);
    const unsupported = await walkWriterChain([{ providerId: "devin", model: "d" }], { hostId: "h", settings: {} }, holdDeps({ coreHosts: () => false }), now);
    expect(unsupported.free).toBeUndefined();
    expect(unsupported.allUnsupported).toBe(true);
    expect(unsupported.shortest!.hold.reason).toBe("writer_provider_unavailable:core_unsupported:devin");
    transitionAttempt(db, "att_w", "blocked", { reason: unsupported.shortest!.hold.reason });
    expect(getAttempt(db, "att_w")!.reason).toBe("writer_provider_unavailable:core_unsupported:devin");
    await harness.lifecycle.dispose();
  });

  it("[sma:m_ac_copy_worker] a check run as the worker cannot write .git (Seatbelt denies it, bwrap binds it read-only) and the owner keeps inherited rights on what the worker makes", () => {
    const profile = buildSeatbeltProfile("/tmp/lane-work", "/tmp/lane-temp");
    expect(profile).toContain('(deny file-write* (subpath "/tmp/lane-work/.git"))');
    expect(profile).toContain('(deny file-write* (subpath "/tmp/lane-work/.agents"))');
    const args = buildBubblewrapArgs({ workspacePath: "/work", cwd: "/work", tempPath: "/tmp/lp", guardPaths: ["/work/.git", "/work/.agents", "/work/.cls"] });
    expect(args.join(" ")).toContain("--ro-bind /work/.git /work/.git");
    const darwin = grantCommands("darwin", "lp-worker", "owner", "/run/dir");
    expect(darwin.some((step) => step.args.join(" ").includes("+a") && step.args.join(" ").includes("user:owner allow") && step.args.join(" ").includes("file_inherit,directory_inherit"))).toBe(true);
    const linux = grantCommands("linux", "lp-worker", "owner", "/run/dir");
    expect(linux[0]!.args.join(" ")).toContain("d:u:owner:rwX");
  });

  it("[sma:m_ac_probe_ws] startHelperProbe spawns with the sandbox project's placement, policy and writerWorkspacePath — a throwaway tree, never another project's", async () => {
    const { bb, db, harness } = open();
    const config: PrototypeConfig = { projectId: SANDBOX_PROJECT_ID, hostId: "h1", pmWorkspacePath: "/pm", writerWorkspacePath: "/ws/sandbox", pmProviderId: "p", pmModel: "m", writerProviderId: "codex", writerModel: "gpt-6-luna" };
    savePrototypeConfig(db, config);
    createRun(db, "run_s", SANDBOX_PROJECT_ID);
    setRunThread(db, "run_s", "thr_pm_sandbox");
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex", available: true }]);
    harness.sdk.stub("providers.models", async () => ({ models: [{ id: "gpt-6-luna", model: "gpt-6-luna", supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] }));
    const spawned: Array<Record<string, unknown>> = [];
    harness.sdk.stub("threads.spawn", async (args: Record<string, unknown>) => { spawned.push(args); return { id: "thr_probe" }; });
    harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threadId === "thr_pm_sandbox"
      ? { id: threadId, projectId: SANDBOX_PROJECT_ID, status: "idle" }
      : { id: threadId, status: "idle" });
    harness.sdk.stub("threads.output", async () => ({ output: "OK" }));
    harness.sdk.stub("threads.stop", async () => ({}));
    harness.sdk.stub("threads.archive", async () => ({}));
    const result = await createHelperProbe({ bb, db } as never).startHelperProbe(SANDBOX_PROJECT_ID, "run_s", "codex", "gpt-6-luna");
    expect(spawned.length, result.reason ?? "spawned").toBe(1);
    expect(spawned[0]).toMatchObject({
      providerId: "codex",
      environment: { type: "host", hostId: "h1", workspace: { type: "unmanaged", path: "/ws/sandbox" } },
      pluginMetadata: expect.objectContaining({ lanePilotRunId: "run_s", parentPmThreadId: "thr_pm_sandbox", helperProbe: true }),
    });
    await harness.lifecycle.dispose();
  });

  it("[sma:m_mo_usage] a claude-code turn books a token row, the usage report prices it non-null, the money book counts it 0 USD and moneyHold never holds it", async () => {
    const { bb, db, harness } = open();
    const day = utcDay(Date.now());
    db.prepare("INSERT INTO lane_pilot_token_cursor (thread_id, project_id, provider_id, last_seq, last_json, total_json, last_model, last_provider, last_turn_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run("thr_s", "projA", "claude-code", 3, "{}", JSON.stringify({ input: 10, output: 4, cached: 0, total: 14, turns: 2 }), "claude-sonnet-5-5", "claude-code", "turn-2", 1);
    db.prepare("INSERT INTO lane_pilot_token_daily(day,project_id,provider_id,model,input_tokens,output_tokens,cached_tokens,total_tokens,uncached_tokens,cache_read_tokens,cache_write_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(day, "projA", "claude-code", "claude-sonnet-5-5", 10, 4, 0, 14, 10, 0, 0);
    harness.sdk.stub("projects.list", async () => []);
    const usage = await queryTokenUsage({ bb, db }, { range: "7d" });
    const row = usage.byModel.find((m) => m.providerId === "claude-code" && m.model === "claude-sonnet-5-5")!;
    expect(row.total).toBe(14);
    expect(row.costUsd).not.toBeNull();
    const daily: DailyRow = { day, providerId: "claude-code", model: "claude-sonnet-5-5", inputTokens: 10, outputTokens: 4, cachedTokens: 0 };
    const book = spendBook([daily], Date.now());
    expect(book.monthUsd).toBe(0);
    expect(book.byProvider["claude-code"]).toBe(0);
    expect(moneyHold("claude-code", 10_000, 1)).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("[sma:m_pr_required] with capability.documentary_gate unset a provider without receipts is observed, not refused; a red receipt is refused with capability_unproven:<provider>:<cell>", async () => {
    const { bb, db, harness } = open();
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }]);
    harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }]);
    createCapabilities({ db, bb, log: () => undefined, isDisposed: () => false } as never, { startHelperProbe: async () => ({ ok: true }), providerBreaker: { record: () => undefined } } as never);
    const gate = documentaryGateOf(bb)!;
    expect(await gate.deny("codex", "gpt-6-luna", "projA")).toBeNull();
    const { saveReceipt } = await import("../../src/rooms/capability/store");
    const key = receiptKey({ version: "0.1.0", model: "gpt-6-luna", settings: [], hooks: JSON.stringify(NATIVE_HOOK_SOURCES) });
    saveReceipt(db, { providerId: "codex", version: key, capability: "documentary.nested", state: "not_supported", model: "gpt-6-luna", detail: null, at: 1 } as never);
    expect(await gate.deny("codex", "gpt-6-luna", "projA")).toMatch(/^capability_unproven:codex:documentary\./);
    saveProjectSetting(db, "projA", "capability.documentary_gate", "observe");
    expect(await gate.deny("codex", "gpt-6-luna", "projA")).toBeNull();
    await harness.lifecycle.dispose();
  });

  it("[sma:m_pr_doc_cells] documentaryProved holds a provider only when all four documentary cells have a supported receipt for its installed key", () => {
    const receipt = (capability: string, state: "supported" | "not_supported" = "supported") =>
      ({ providerId: "codex", version: "0.1.0", capability, state, model: "gpt-6-luna", detail: null, at: 1 }) as never;
    const versions = new Map([["codex", "0.1.0"], ["opencode2", "1.2.0"]]);
    const all = DOCUMENTARY_CELLS.map((cell) => receipt(cell));
    const receipts = [...all, receipt("answers"), ...DOCUMENTARY_CELLS.slice(0, 3).map((cell) => receipt(cell)), { providerId: "opencode2", version: "1.2.0", capability: "documentary.session_end", state: "not_supported", model: "glm", detail: null, at: 1 } as never];
    const proved = documentaryProved(receipts.filter((row) => (row as { providerId: string }).providerId === "codex" || (row as { providerId: string }).providerId === "opencode2"), versions);
    expect(proved.has("codex")).toBe(true);
    const broken = [...all.slice(0, 3), { providerId: "codex", version: "0.1.0", capability: "documentary.session_end", state: "not_supported", model: "gpt", detail: null, at: 1 } as never, receipt("answers")];
    expect(documentaryProved(broken, versions).has("codex")).toBe(false);
    expect(documentaryProved(all.slice(0, 3), versions).has("codex")).toBe(false);
  });

  it("[sma:m_gt_table] the RPC call table is a frozen closed list — the pinned names match the contract and every one has a registered handler", async () => {
    const pinned: string[] = JSON.parse(readFileSync(join(__dirname, "rpc-c1-have-keys.json"), "utf8"));
    const actual = Object.keys(rpcContract).sort();
    expect(actual).toEqual(pinned);
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    await plugin(bb);
    const registered = new Set(harness.registrations.rpcMethods);
    expect(actual.filter((name) => !registered.has(name))).toEqual([]);
    await harness.lifecycle.dispose();
  });

  it("[sma:m_hs_mcp_toggle] a role's MCP access stores names only — no command, args or URL field is accepted or written", () => {
    const access = parseRoleAccess({ mcpServers: { mode: "allow", names: ["gitnexus", "metamcp", 42, { command: "rm" }], command: "evil", args: ["-rf"], url: "https://x" } });
    expect(access.mcpServers).toEqual({ mode: "allow", names: ["gitnexus", "metamcp"] });
    expect(Object.keys(access.mcpServers!)).toEqual(["mode", "names"]);
    const group = effectiveGroup("writer", "mcpServers", access);
    expect(group.names).toEqual(expect.arrayContaining(["gitnexus", "metamcp"]));
  });
});

describe("daemon front and the window", () => {
  it("[sma:m_pj_planning_home] the phase stages' reads, the backlog issue and the project-log writes all live under .agents/ of the project checkout", () => {
    const phase = { id: "ph_1", stage: "discussion", record: {} };
    for (const stage of ["discussion", "planning", "design", "execution", "verification", "closed"] as const) {
      for (const path of stageInit({ ...phase, stage } as never)) expect(path).toMatch(/^(\.agents\/|DESIGN\.md$)/);
    }
    expect(stageInit({ id: "ph_1", stage: "discussion", record: {} } as never)).toEqual(expect.arrayContaining([".agents/planning/ROADMAP.md", ".agents/planning/REQUIREMENTS.md"]));
    expect(issueMessage({ id: "t1", title: "a backlog item", status: "ready", priority: "high", estimate: 3, dependsOn: [], created: "" })).toContain(".agents/todos/items/t1/");
    expect(isAllowedProjectLifePath(".agents/plans/items/x/PLAN.md")).toBe(true);
    expect(isAllowedProjectLifePath(".agents/PROGRESS.md")).toBe(true);
    expect(isAllowedProjectLifePath("src/app.ts")).toBe(false);
    expect(isAllowedProjectLifePath("/etc/passwd")).toBe(false);
  });

  it("[sma:d_task_suggest] one phrase proposes the task's title, description and promise and nothing is sent (the function has no request channel)", () => {
    const proposal = proposeTaskWords("Кнопка оплаты в корзине, чтобы покупатель видел итог до оплаты. Показать сумму рядом.");
    expect(proposal.title.length).toBeGreaterThan(3);
    expect(proposal.promise.join("\n")).toContain("покупатель видел итог до оплаты");
    expect(proposeTaskWords("Когда покупатель платит, то заказ закрывается").promise[0]).toMatch(/^When .+, then /);
    expect(proposeTaskWords("same phrase")).toEqual(proposeTaskWords("same phrase"));
  });

  it("[sma:m_sw_assign_dialog] a role's saved access with skills allow [x] resolves that list for that role only; other roles keep their own", async () => {
    const { bb, db, harness, ctx } = (() => { const o = open(); return { ...o, ctx: createCore(o.bb, o.db) }; })();
    saveProjectSetting(db, "projA", roleAccessKey("docs-maintainer"), { skills: { mode: "allow", names: ["docs-maintain"] } });
    for (const method of ["plugins.list", "skills.list", "projects.list", "environments.list"]) harness.sdk.stub(method as never, async () => []);
    const api = settingsRpc(ctx, {} as never);
    const view = await api.helper_access_view({ projectId: "projA" });
    const row = (view.roles as Array<{ role: string; groups: { skills: { names: string[] | null } } }>).find((r) => r.role === "docs-maintainer")!;
    expect(row.groups.skills.names).toContain("docs-maintain");
    const other = (view.roles as Array<{ role: string; groups: { skills: { names: string[] | null } } }>).find((r) => r.role === "onboarder")!;
    expect(other.groups.skills.names).toEqual(expect.arrayContaining(ROLE_PROFILES["onboarder"].skills));
    await harness.lifecycle.dispose();
  });

  it("[sma:m_sw_connections] a role's access group saved through the panel is what the next brief resolves; the owner-push switch saved on the board is read back", async () => {
    const { db, harness } = open();
    saveProjectSetting(db, "projA", roleAccessKey("writer"), { skills: { mode: "allow", names: ["writer-practices"] } });
    const settings = { [roleAccessKey("writer")]: { skills: { mode: "allow", names: ["writer-practices"] } } };
    const access = roleAccessFromSettings(settings).writer!;
    expect(effectiveGroup("writer", "skills", access).names).toEqual(["writer-practices"]);
    const saved = savePushConfig(db, { enabled: "off", quiet: "23:00-08:00" });
    expect(saved.enabled).toBe(false);
    expect(loadPushConfig(db)).toMatchObject({ enabled: false, quiet: "23:00-08:00" });
    await harness.lifecycle.dispose();
  });

  it("[sma:sc_memory] the corpus (memory records and cockpit memory), the rule drafts and the phase book each answer for one project", async () => {
    const { bb, db, harness } = open();
    storeMemoryRecords(db, { projectId: "projA", audience: "subagent", sourceSha256: "a".repeat(64), coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999, entries: [{ kind: "note", content: "Deploy port is 9000.", concepts: ["deploy"] }] });
    const rpc = cockpitRpc({ db, bb, log: () => undefined } as never, { front: { actions: async () => [] } } as never);
    createRun(db, "run_m", "projA");
    const mem = await rpc.cockpit_memory({ runId: "run_m", action: "lint" });
    expect(mem.output).toContain("Deploy port is 9000");
    upsertLessonProposal(db, "projA", { rule: "Run npm ci in a writer worktree, never npm install, the lockfile stays untouched" }, 1000);
    expect(listRuleProposals(db, "projA").some((row) => row.rule.includes("npm ci"))).toBe(true);
    const { phases, db: d2, bb: b2, harness: h2 } = driver();
    void db; void bb;
    const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Booked", goal: "keep the book" });
    const got = await phaseRpc(phases).phase_get({ phaseId: ph.id });
    expect(got.book).toContain(`# Phase ${ph.id}: Booked`);
    await harness.lifecycle.dispose();
    await h2.lifecycle.dispose();
  });

  it("[sma:sc_console] phase_control pause then resume moves the phase paused then active, stop_wave holds the wave's queued pieces, phase_act answer settles a parked question", async () => {
    const { phases, db } = driver();
    const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Console", goal: "drive the window" });
    const rpc = phaseRpc(phases);
    await rpc.phase_control({ phaseId: ph.id, action: "pause" } as never);
    expect(phases.status(ph.id).phase.state).toBe("paused");
    await rpc.phase_control({ phaseId: ph.id, action: "resume" } as never);
    expect(phases.status(ph.id).phase.state).toBe("active");
    const withQuestion = { ...phases.status(ph.id).phase.record, questions: [{ id: "q1", text: "go on?", stage: phases.status(ph.id).phase.stage, blocking: true }] } as never;
    savePhase(db, ph.id, { record: withQuestion, at: Date.now() });
    await rpc.phase_act({ action: "answer", phaseId: ph.id, payload: { questionId: "q1", answer: "yes, go on" } } as never);
    const answered = phases.status(ph.id).phase.record.questions!.find((q) => q.id === "q1")!;
    expect(answered.answer).toBe("yes, go on");
    await rpc.phase_control({ phaseId: ph.id, action: "stop_wave" } as never);
    expect(phases.status(ph.id).phase.state).toBe("paused");
    await rpc.phase_control({ phaseId: ph.id, action: "resume" } as never);
    expect(phases.status(ph.id).phase.state).toBe("active");
  });
});

describe("guard tools and memory", () => {
  it("[sma:m_tl_cap_drill] one sweep calls startHelperProbe for pause and every documentary cell and saves a receipt per cell; capabilities --probe returns the same probed list", async () => {
    const { bb, db, harness } = open();
    harness.sdk.stub("providers.list", async () => [{ id: "codex", pluginId: "provider-codex" }]);
    harness.sdk.stub("plugins.list", async () => [{ id: "provider-codex", version: "0.1.0" }]);
    createRun(db, "run_s", SANDBOX_PROJECT_ID);
    setRunThread(db, "run_s", "thr_pm");
    harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", status: "idle", archivedAt: null }));
    const probed: string[] = [];
    const api = createCapabilities({ db, bb, log: () => undefined, isDisposed: () => false } as never, {
      startHelperProbe: async (_p: string, _r: string, _provider: string, _m: string, kind: string) => { probed.push(kind); return { ok: true, reason: null }; },
      providerBreaker: { record: () => undefined },
    } as never).capabilities;
    const first = await api.sweep();
    expect(probed).toEqual(expect.arrayContaining(["pause", ...DOCUMENTARY_CELLS]));
    expect(probed).toHaveLength(CAPABILITIES.length);
    const cli = await runCapabilityCli(api, ["--probe"]);
    const out = JSON.parse(cli.stdout!);
    expect(out.probed).toEqual([]);
    expect(out.table.find((row: { providerId: string }) => row.providerId === "codex").capabilities.pause).toBe("supported");
    await harness.lifecycle.dispose();
  });

  it("[sma:m_tl_bug_sweep] failedTasksAllProjects lists every failed task of every project, one line per task — its latest failed attempt", () => {
    const { db } = open();
    for (const [runId, projectId, taskId] of [["r1", "projA", "t1"], ["r2", "projB", "t2"]] as const) {
      createRun(db, runId, projectId);
      createTask(db, { id: taskId, runId, kind: "bb", contract: contract(taskId) });
    }
    createAttempt(db, { id: "a1", runId: "r1", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "tw1" });
    transitionAttempt(db, "a1", "provider_error", { reason: "boom" });
    createAttempt(db, { id: "a2", runId: "r1", taskId: "t1" });
    transitionAttempt(db, "a2", "spawn_requested");
    transitionAttempt(db, "a2", "blocked", { reason: "still broken" });
    createAttempt(db, { id: "a3", runId: "r2", taskId: "t2" });
    transitionAttempt(db, "a3", "spawn_requested");
    transitionAttempt(db, "a3", "blocked", { reason: "nope" });
    const rows = failedTasksAllProjects(db, 0);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.attemptId).sort()).toEqual(["a2", "a3"]);
    expect(new Set(rows.map((row) => row.projectId))).toEqual(new Set(["projA", "projB"]));
  });

  it("[sma:m_journal] a stored record keeps its trace — origin, origin task and source sha — and a second source appends one verification entry", () => {
    const { db } = open();
    const limits = { audience: "subagent" as const, coreBudget: 99_999, noteBudget: 99_999, indexBudget: 999_999 };
    storeMemoryRecords(db, { projectId: "P", ...limits, origin: "session", trust: "observed", originTaskId: "task_1", sourceSha256: "a".repeat(64), entries: [{ kind: "note", content: "Deploy port is 9000.", concepts: ["deploy"] }] });
    const row = db.prepare("SELECT origin, origin_task_id, source_sha256, verification_json FROM lane_pilot_memory WHERE content=?").get("Deploy port is 9000.") as { origin: string; origin_task_id: string; source_sha256: string; verification_json: string };
    expect(row.origin).toBe("session");
    expect(row.origin_task_id).toBe("task_1");
    expect(row.source_sha256).toBe("a".repeat(64));
    expect(JSON.parse(row.verification_json)).toHaveLength(1);
    storeMemoryRecords(db, { projectId: "P", ...limits, origin: "maintainer", sourceSha256: "b".repeat(64), entries: [{ kind: "note", content: "Deploy port is 9000.", concepts: ["deploy"] }] });
    const again = db.prepare("SELECT verification_json FROM lane_pilot_memory WHERE content=?").get("Deploy port is 9000.") as { verification_json: string };
    const trail = JSON.parse(again.verification_json) as Array<{ by: string; sha: string; at: number }>;
    expect(trail).toHaveLength(2);
    expect(trail[1].sha).toBe("b".repeat(64));
  });
});

describe("phase gates and agent roles", () => {
  it("[sma:k_c_design] with owner.words at its default the design gate waits for the person's word on the drawing, a whole-consent «design» yes settles it, and a reviewer equal to the designer is refused", () => {
    const drawing = { paths: ["d.png", ".agents/phases/ph_1/design/UI-SPEC.md"], sha256: "x", designer: "design-lead", feasible: true, reviewer: "ui-review" };
    const record: PhaseRecord = { ownerWords: true, design: { decision: "needed", why: "", drawing } };
    const held = designGate(record);
    expect(held.ok).toBe(false);
    expect("why" in held && held.why.join(";")).toContain("awaits the owner's word");
    const consented: PhaseRecord = { ...record, words: [{ turn: "design", decision: "yes", text: "ok", by: "owner", at: 1 }] };
    expect(designGate(consented).ok).toBe(true);
    const same: PhaseRecord = { ...consented, design: { decision: "needed", why: "", drawing: { ...drawing, reviewer: "design-lead" } } };
    const refused = designGate(same);
    expect("why" in refused && refused.why.join(";")).toContain("separate role");
  });

  it("[sma:k_c_settingsint] specialist:tavily carries env-catalog plus the tavily skill, and an owner override helper.access.specialist-reviewer changes the resolved list", () => {
    const tavily = ROLE_PROFILES["specialist:tavily"];
    expect(tavily.bbPlugins).toContain("env-catalog");
    expect(tavily.skills).toContain("tavily");
    const before = effectiveGroup("specialist-reviewer", "bbPlugins").names;
    expect(before).not.toContain("env-catalog");
    const access = parseRoleAccess({ bbPlugins: { mode: "allow", names: ["env-catalog"] } });
    const after = effectiveGroup("specialist-reviewer", "bbPlugins", access).names!;
    expect(after).toContain("env-catalog");
    expect(after).toEqual(expect.arrayContaining(["environment-project-checkout", "project-folders"]));
    const fromSettings = roleAccessFromSettings({ [roleAccessKey("specialist-reviewer")]: { bbPlugins: { mode: "allow", names: ["env-catalog"] } } });
    expect(fromSettings["specialist-reviewer"]!.bbPlugins).toEqual({ mode: "allow", names: ["env-catalog"] });
  });

  it("[sma:k_ag_executor] the writer brief says Lane Pilot commits and merges the accepted change (never the writer), and the phase conclusion is a '# Summary' with one line per item", () => {
    const brief = writerBriefSegments(contract("p1")).map((seg) => seg.text).join("\n");
    expect(brief).toContain("Do not commit");
    expect(brief).toContain("Lane Pilot commits and merges your accepted changes");
    const items = [
      { id: "a", title: "A", wave: 1, promise: { given: "g", when: "w", then: "A works" }, task: {} },
      { id: "b", title: "B", wave: 1, promise: { given: "g", when: "w", then: "B works" }, task: {} },
    ] as never[];
    const facts = new Map([["a", { taskId: "task_a", state: "accepted" }], ["b", { taskId: "task_b", state: "accepted" }]]) as never;
    const text = conclusionText({ id: "ph_9", title: "T", goal: "g", record: { plan: { items } } } as never, [], facts);
    expect(text).toContain("# Summary");
    expect(text).toContain("- a (task task_a, accepted): A works");
    expect(text).toContain("- b (task task_b, accepted): B works");
  });

  it("[sma:k_ag_codefixer] review-fix passes first_review.findings to lp.plan in mode gaps and the planned tasks go to lp.build (each merged as its own accepted task)", () => {
    const fix = node("review-fix", "plan_fix");
    expect(fix.workflow).toBe("lp.plan");
    expect(fix.with.mode).toBe("gaps");
    expect(fix.with.gaps).toBe("{{first_review.findings}}");
    const build = node("review-fix", "build_fix");
    expect(build.workflow).toBe("lp.build");
    expect(build.with.tasks).toBe("{{plan_fix.tasks}}");
    const edges = workflow("review-fix").edges!;
    expect(edges.some((edge) => edge.from === "plan_fix" && edge.to === "build_fix")).toBe(true);
    expect(edges.some((edge) => edge.from === "build_fix" && edge.to === "re_review")).toBe(true);
  });

  it("[sma:k_ag_debugger] the investigate node of debug.json records {hypothesis, prediction, observation, verdict} in evidence.ndjson and returns evidence_path", () => {
    const investigate = node("debug", "investigate");
    expect(investigate.prompt).toContain("evidence.ndjson");
    for (const field of ["hypothesis", "prediction", "observation", "verdict"]) expect(investigate.prompt).toContain(field);
    expect(investigate.out.evidence_path).toBe("string");
  });

  it("[sma:k_ag_debugmgr] verify_cause spawns a fresh debug session, an objection loops back to investigate while visits < 3, and the confirmed emit is the compact result", () => {
    expect(node("debug", "verify_cause").session).toBe("new");
    const edges = workflow("debug").edges!;
    expect(edges.some((edge) => edge.from === "verify_cause" && edge.to === "investigate" && /visits\('investigate'\) < 3/.test(edge.when ?? ""))).toBe(true);
    const map = node("debug", "confirmed").map as Record<string, string>;
    for (const key of ["root_cause", "confidence", "affected_files", "fix_direction", "evidence_path"]) expect(map[key]).toBe(`investigate.${key}`);
    expect(map.status).toBe("confirmed");
  });

  it("[sma:k_ag_verifier] the blind verdict step writes a 'verification'/'blind_verdict' part whose text starts with the verdict state, and the phase book shows it", async () => {
    const { phases, db } = driver();
    const ph = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "V", goal: "verdict" });
    savePhase(db, ph.id, { stage: "verification", runId: "run1", record: { ...ph.record, plan: { items: [], sha: "s", contextSha: "c", admittedSha: "s" } } as never, at: 1 });
    saveRunGoal(db, { runId: "run1", projectId: "projA", state: "failed", tasks: 1, headSha: "h", red: [], detail: "check lint of task t1 is red", failureCode: null, at: 1, coverage: { planned: 1, ran: 1, skipped: 0 } });
    await phases.tick();
    const parts = listParts(db, ph.id);
    const verdictPart = parts.find((part) => part.section === "verification" && part.kind === "blind_verdict")!;
    expect(verdictPart.text.startsWith("failed")).toBe(true);
    expect(verdictPart.text).toContain("check lint of task t1 is red");
    const got = await phaseRpc(phases).phase_get({ phaseId: ph.id });
    expect(got.book).toContain("## 6. Verification");
    expect(got.book).toContain("blind_verdict");
  });

  it("[sma:k_ag_integration] a blind verdict over a failed run-goal check returns failed with the red check in the detail — earlier accepted work run together finds a broken link", () => {
    const items = [{ id: "a", title: "A", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: {} }] as never[];
    const facts = new Map([["a", { taskId: "ta", state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed" }]]) as never;
    const verdict = blindVerdict(items, facts, { state: "failed", detail: "check npm test of task t9 is red on the candidate", headSha: "h" }, 5);
    expect(verdict.state).toBe("failed");
    expect(verdict.detail).toContain("check npm test of task t9 is red");
  });

  it("[sma:k_ag_nyquist] test-gen takes the auditor's named gaps and writes tests only in test paths; validationGaps flags a piece whose every check only tests existence", () => {
    const tg = workflow("test-gen");
    expect(tg.inputs).toHaveProperty("gaps");
    const write = node("test-gen", "write_tests");
    expect(write.type).toBe("lp-task");
    expect(write.contract_template).toContain("owns_paths only test directories");
    expect(write.contract_template).toContain("never_touch source files");
    const gaps = validationGaps([{ id: "p1", title: "t", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { verification: [{ command: "test -f out.txt" }, { command: "ls dist" }] } }] as never[]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("p1");
    expect(validationGaps([{ id: "p2", title: "t", wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { verification: [{ command: "npm test" }, { command: "test -f out.txt" }] } }] as never[])).toHaveLength(0);
  });

  it("[sma:k_ag_uiqa] a 'pass' verdict with one case blocked is blocked; no verdict block at all is blocked with browser_qa_thread_returned_no_verdict", () => {
    const blocked = parseQaVerdict("done\n```json\n{\"verdict\":\"passed\",\"summary\":\"looks fine\",\"cases\":[{\"case\":\"c1\",\"viewport\":\"1280\",\"result\":\"blocked\",\"note\":\"button not reachable\"}]}\n```");
    expect(blocked.verdict).toBe("blocked");
    const none = parseQaVerdict("the page looks fine to me");
    expect(none.verdict).toBe("blocked");
    expect(none.summary).toBe("browser_qa_thread_returned_no_verdict");
    const passed = parseQaVerdict("```json\n{\"verdict\":\"passed\",\"summary\":\"all good\",\"cases\":[{\"case\":\"c1\",\"viewport\":\"1280\",\"result\":\"passed\"}]}\n```");
    expect(passed.verdict).toBe("passed");
  });
});
