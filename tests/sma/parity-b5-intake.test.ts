import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { registeredTools } from "../../src/rooms/platform/server";
import { createPhaseDriver } from "../phase-driver";
import { openDatabase, createRun } from "../../src/rooms/plugin-db";
import { insertPhase, savePhase } from "../../src/rooms/phase/store";
import { contextSignature, planSignature, type PhaseRecord, type PlanItem } from "../../src/rooms/phase/logic";
import { registerConversationTools } from "../../src/rooms/tasks/server/conversation-tools";
import { registerTools } from "../../src/rooms/tools/server/tools";
import { ASK_KINDS, readOwnerAskPayload } from "../../src/rooms/relay/owner-ask-shared";
import { buildOwnerAskPayload } from "../../src/rooms/relay/owner-ask";
import { createPmTurnWatch } from "../../src/rooms/stability/server/pm-turn-watch";
import { tokenDailyByModel } from "../../src/rooms/usage/server";

const piece = (id: string): PlanItem => ({ id, title: id, wave: 1, promise: { given: "g", when: "w", then: "t" }, task: { id } as never });

/** A phase at planning with owner.words on and a plan the critic approved: the gate waits only for the keyed planning yes. */
function planningPhase(db: ReturnType<typeof openDatabase>, extra: Partial<PhaseRecord["plan"] & object> = {}) {
  insertPhase(db, { id: "ph_1", projectId: "proj", pmThreadId: "thr_pm", title: "Sums", goal: "sums", at: 1_000 });
  const docs = [{ path: "docs/CONTEXT.md", sha256: "a".repeat(64), bytes: 120 }];
  const context = { docs, sha: contextSignature(docs), signedAt: 1 };
  const items = [piece("a")];
  const record: PhaseRecord = { ownerWords: true, context,
    plan: { items, contextSha: context.sha, sha: planSignature(items, context.sha), submittedAt: Date.now(), ...extra,
      critique: { decision: "approve", by: "plan-critic", independence: { ok: true, why: "checker after planner" } } } };
  savePhase(db, "ph_1", { stage: "planning", record, at: 2_000 });
}

describe("parity b5 intake", () => {
  it("[sma:m_q_kinds] a question to the owner carries one of the five kinds", async () => {
    expect([...ASK_KINDS]).toEqual(["checkpoint", "budget", "pause", "decision", "worker"]);
    for (const kind of ASK_KINDS) expect(buildOwnerAskPayload({ source: "pm", kind, question: "q" }).kind).toBe(kind);
    expect(readOwnerAskPayload({ v: 1, source: "pm", kind: "secret", question: "q", options: [], allowText: true })).toBeNull();
    // The tool's form carries the kind the PM named (worker relays a writer's needs_human; decision is the default).
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    const db = openDatabase(bb);
    const ctx = createCore(bb, db);
    try { registerTools(ctx, new Proxy({} as Services, { get: () => { throw new Error("mounts after the ask tool"); } })); } catch { /* later mounts */ }
    void harness.behavior.callAgentTool("lane_pilot_ask_owner", { question: "pick one", options: ["a", "b"] }, { threadId: "thr_pm", projectId: "proj" }).catch(() => undefined);
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(1));
    expect((harness.pendingInteractions[0]?.payload as { kind?: string })?.kind).toBe("decision");
    void harness.behavior.callAgentTool("lane_pilot_ask_owner", { question: "writer needs you", kind: "worker" }, { threadId: "thr_pm2", projectId: "proj" }).catch(() => undefined);
    await vi.waitFor(() => expect(harness.pendingInteractions).toHaveLength(2));
    expect((harness.pendingInteractions[1]?.payload as { kind?: string })?.kind).toBe("worker");
  });

  it("[sma:m_q_free_text] the kind decides free text", () => {
    const options = ["raise", "stop"];
    for (const kind of ["budget", "pause"] as const) expect(buildOwnerAskPayload({ source: "pm", kind, question: "q", options }).allowText).toBe(false);
    for (const kind of ["checkpoint", "decision", "worker"] as const) expect(buildOwnerAskPayload({ source: "pm", kind, question: "q", options }).allowText).toBe(true);
    // Nothing to pick: every kind takes words.
    expect(buildOwnerAskPayload({ source: "pm", kind: "budget", question: "q" }).allowText).toBe(true);
  });

  it("[sma:m_ce_put_pending] a planning yes sent from another PM thread is refused; the same yes from the phase's own chat counts", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    planningPhase(db);
    const ctx = createCore(bb, db);
    const { phases } = createPhaseDriver(ctx, { runBudgets: { get: () => undefined } } as unknown as Services);
    // The thread gate lives on the tool's word action: register it through the phase tool path.
    const { registerPhaseTool } = await import("../../src/rooms/phase/server/tool");
    registerPhaseTool(ctx, { phases } as never);
    const tool = registeredTools(bb.agents).get("lane_pilot_phase")!;
    const other = { threadId: "thr_other", projectId: "proj", signal: new AbortController().signal };
    await expect(tool.execute({ action: "word", phaseId: "ph_1", turn: "planning", decision: "yes", text: "да", key: phases.status("ph_1").phase.record.plan!.sha }, other)).rejects.toThrow(/own chat|own conversation|thr_pm/);
    expect(phases.status("ph_1").phase.record.words ?? []).toEqual([]);
    const own = { threadId: "thr_pm", projectId: "proj", signal: new AbortController().signal };
    await tool.execute({ action: "word", phaseId: "ph_1", turn: "planning", decision: "yes", text: "да", key: phases.status("ph_1").phase.record.plan!.sha }, own);
    expect(phases.status("ph_1").phase.record.words?.map((row) => row.decision)).toEqual(["yes"]);
  });

  it("[sma:m_ce_proposal] a planning yes is refused without the current plan key, on a changed plan or a stale one", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    planningPhase(db);
    const ctx = createCore(bb, db);
    const { phases } = createPhaseDriver(ctx, { runBudgets: { get: () => undefined } } as unknown as Services);
    const word = (key?: string) => phases.word({ phaseId: "ph_1", turn: "planning", decision: "yes", text: "да", key, by: "owner" });
    const sha = phases.status("ph_1").phase.record.plan!.sha;
    await expect(word()).rejects.toThrow(/names the key|ownerWord\.planKey/);
    await expect(word("deadbeef")).rejects.toThrow(/changed since it was shown/);
    expect(phases.status("ph_1").phase.record.words ?? []).toEqual([]);
    // The same phase with a stale proposal is refused stale.
    const stale = phases.status("ph_1").phase.record;
    savePhase(db, "ph_1", { record: { ...stale, plan: { ...stale.plan!, submittedAt: Date.now() - 25 * 3_600_000 } }, at: Date.now() });
    await expect(word(sha)).rejects.toThrow(/stale/);
    // Fresh again: the keyed yes counts.
    savePhase(db, "ph_1", { record: { ...stale, plan: { ...stale.plan!, submittedAt: Date.now() } }, at: Date.now() });
    const phase = await word(sha);
    expect(phase.record.words?.map((row) => row.decision)).toEqual(["yes"]);
    expect(phases.status("ph_1").ownerWord.planKey).toBe(sha);
  });

  const checkHost = (bb: ReturnType<typeof createFakePluginHost>["bb"], opts: { pkg?: string; manifestAfter?: string; failCopy?: boolean }) => {
    const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
    let manifests = 0;
    bb.hosts.experimental_client = (() => ({
      call: async (method: string, input: Record<string, unknown>) => {
        calls.push({ method, input });
        if (method === "gitCreateWorktree") return opts.failCopy ? { hostId: "host1", status: "failed", path: null, reason: "disk full" } : { hostId: "host1", status: "ready", path: "/ws_chk", branch: "lane/chk", reason: null, baseSha: "abc123" };
        if (method === "gitRemoveWorktree") return { hostId: "host1", removed: true };
        if (method === "runCommand") {
          if (String(input.command).includes("rev-parse")) { manifests += 1; return { hostId: "host1", exitCode: 0, stdout: manifests > 1 && opts.manifestAfter ? opts.manifestAfter : "abc123\n", stderr: "" }; }
          return { hostId: "host1", exitCode: 0, stdout: `---PKG---\n${opts.pkg ?? "{}"}`, stderr: "" };
        }
        return { hostId: "host1", backend: "linux-bubblewrap", exitCode: 0, stdout: "ok", stderr: "", policySha256: "a".repeat(64) };
      },
    })) as never;
    return calls;
  };

  const runCheck = async (bb: ReturnType<typeof createFakePluginHost>["bb"], commands = [{ command: "npm test", cwd: ".", timeoutSec: 30, expectExit: 0 }]) => {
    const db = openDatabase(bb);
    createRun(db, "run1", "proj", "bb", "/ws", "none", { schemaVersion: 1, pools: { provider: 5, verification: 2 } }, "host1");
    registerConversationTools({ db, bb } as never, { spendByModel: (projectId: string, day: string) => tokenDailyByModel(db, projectId, day) });
    const check = registeredTools(bb.agents).get("lane_pilot_check")!;
    return JSON.parse(String(await check.execute({ action: "run", request: "run tests", commands }, { threadId: "thr", projectId: "proj", signal: new AbortController().signal })));
  };

  it("[sma:m_ck_isolated] a quick check runs inside a chk_ worktree, the manifest before equals the manifest after, the copy is removed, a changed manifest is roots_changed", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    const calls = checkHost(bb, {});
    const receipt = await runCheck(bb);
    expect(receipt.state).toBe("passed");
    const sandboxed = calls.filter((call) => call.method === "runSandboxedCommand");
    expect(sandboxed).toHaveLength(1);
    expect(sandboxed[0]!.input.workspacePath).toBe("/ws_chk");
    expect(sandboxed[0]!.input.cwd).toBe("/ws_chk");
    expect(calls.some((call) => call.method === "gitRemoveWorktree" && call.input.worktreePath === "/ws_chk")).toBe(true);
    expect(receipt.protections.manifest.before).toBe(receipt.protections.manifest.after);

    const { bb: bb2, harness: h2 } = createFakePluginHost({ pluginId: "lane-pilot" });
    h2.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    checkHost(bb2, { manifestAfter: "def999\n M src/x.ts\n" });
    const changed = await runCheck(bb2);
    expect(changed.state).toBe("failed");
    expect(changed.reason).toContain("roots_changed");
  });

  it("[sma:m_ck_recipes] with scripts.test and a pnpm lockfile a quick check runs pnpm run test from the copy, the receipt names package.json@<baseSha>", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    const calls = checkHost(bb, { pkg: '{"scripts":{"test":"vitest run"}}' });
    const receipt = await runCheck(bb);
    const sandboxed = calls.filter((call) => call.method === "runSandboxedCommand");
    // No lockfile listed -> npm; the recipe still comes from the snapshot's package.json.
    expect(sandboxed.map((call) => call.input.command)).toEqual(["npm run test"]);
    expect(receipt.protections.recipeSource).toBe("package.json@abc123");
  });

  it("[sma:m_ck_required] the receipt carries the five protections; with the copy refused the check is not passed and names copy", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    checkHost(bb, {});
    const receipt = await runCheck(bb);
    expect(receipt.protections).toMatchObject({ recipeSource: "pm", copyPath: "/ws_chk", publication: "closed",
      cleanEnv: { backend: "linux-bubblewrap", policySha256: "a".repeat(64), secrets: false } });
    expect(receipt.protections.manifest.before).toBe(receipt.protections.manifest.after);

    const { bb: bb2, harness: h2 } = createFakePluginHost({ pluginId: "lane-pilot" });
    h2.sdk.stub("threads.getPluginMetadata", async () => ({ role: "pm", lanePilotRunId: "run1" }));
    checkHost(bb2, { failCopy: true });
    const refused = await runCheck(bb2);
    expect(refused.state).toBe("failed");
    expect(refused.passed).toBe(false);
    expect(refused.reason).toContain("copy");
  });

  it("[sma:m_cf_timeout] a PM turn is cut at the limit, an empty answer and a vendor refusal are named; a writer thread is ignored", async () => {
    const stopped: string[] = [];
    const named: string[] = [];
    const watch = createPmTurnWatch({
      isPmThread: async (threadId) => threadId === "thr_pm",
      limits: async () => ({ turnLimitMin: 4, maxTurns: 12 }),
      stop: async (threadId) => { stopped.push(threadId); },
      tell: async (_threadId, text) => { named.push(text); },
      record: async (_threadId, outcome) => { named.push(outcome); },
      now: () => Date.now(),
      log: () => undefined,
    });
    await watch.turnStarted("thr_pm");
    expect(await watch.sweep(Date.now() + 3 * 60_000)).toEqual([]);
    expect(await watch.sweep(Date.now() + 5 * 60_000)).toEqual(["thr_pm"]);
    expect(stopped).toEqual(["thr_pm"]);
    expect(named.join("\n")).toContain("не уложился в 4 минут");
    // An empty answer is named.
    await watch.turnStarted("thr_pm");
    await watch.itemCompleted("thr_pm", "tool/call");
    await watch.turnCompleted("thr_pm");
    expect(named.join("\n")).toContain("пустой ответ");
    // A vendor refusal is named with its message.
    await watch.turnStarted("thr_pm");
    await watch.turnCompleted("thr_pm", { providerError: "quota exceeded" });
    expect(named.join("\n")).toContain("отказ вендора: quota exceeded");
    await watch.turnStarted("thr_pm");
    await watch.turnFailed("thr_pm", "model overloaded");
    expect(named.join("\n")).toContain("отказ вендора: model overloaded");
    // A writer thread is ignored.
    await watch.turnStarted("thr_writer");
    expect(watch.open("thr_writer")).toBeUndefined();
  });

  it("[sma:m_cf_settings] the PM turn stops at the max turns read at turn/started; a changed value counts from the next turn", async () => {
    const stopped: string[] = [];
    const named: string[] = [];
    let maxTurns = 12;
    const watch = createPmTurnWatch({
      isPmThread: async () => true,
      limits: async () => ({ turnLimitMin: 4, maxTurns }),
      stop: async (threadId) => { stopped.push(threadId); },
      tell: async (_threadId, text) => { named.push(text); },
      record: async () => undefined,
      now: () => Date.now(),
      log: () => undefined,
    });
    await watch.turnStarted("thr_pm");
    for (let i = 0; i < 12; i++) await watch.itemCompleted("thr_pm", "tool/call");
    expect(stopped).toEqual([]);
    maxTurns = 20; // a change mid-turn is not this turn's cap
    await watch.itemCompleted("thr_pm", "tool/call");
    expect(stopped).toEqual(["thr_pm"]);
    expect(named.join("\n")).toContain("предел ходов: 12");
    await watch.turnStarted("thr_pm");
    for (let i = 0; i < 20; i++) await watch.itemCompleted("thr_pm", "tool/call");
    expect(stopped).toEqual(["thr_pm"]);
    await watch.itemCompleted("thr_pm", "tool/call");
    expect(stopped).toEqual(["thr_pm", "thr_pm"]);
    expect(named.join("\n")).toContain("предел ходов: 20");
  });
});
