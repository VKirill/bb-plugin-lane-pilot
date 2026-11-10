import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../server";
import { registeredTools } from "../../src/rooms/platform/server";
import { createPhaseDriver } from "../phase-driver";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";
import { insertPhase, savePhase } from "../../src/rooms/phase/store";
import { contextSignature, planSignature, type PhaseRecord, type PlanItem } from "../../src/rooms/phase/logic";
import { registerTools } from "../../src/rooms/tools/server/tools";
import { ASK_KINDS, readOwnerAskPayload } from "../../src/rooms/relay/owner-ask-shared";
import { buildOwnerAskPayload } from "../../src/rooms/relay/owner-ask";
import { createPmTurnWatch } from "../../src/rooms/stability/server/pm-turn-watch";

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

  it("[sma:m_ce_proposal] a planning yes naming another plan's key is refused; with a term set, so is a stale proposal", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    planningPhase(db);
    const ctx = createCore(bb, db);
    const { phases } = createPhaseDriver(ctx, { runBudgets: { get: () => undefined } } as unknown as Services);
    const word = (key?: string) => phases.word({ phaseId: "ph_1", turn: "planning", decision: "yes", text: "да", key, by: "owner" });
    const sha = phases.status("ph_1").phase.record.plan!.sha;
    await expect(word("deadbeef")).rejects.toThrow(/changed since it was shown/);
    expect(phases.status("ph_1").phase.record.words ?? []).toEqual([]);
    // No term unless the project sets one: a day-old proposal still takes the owner's yes. With the term set it is stale.
    const stale = phases.status("ph_1").phase.record;
    savePhase(db, "ph_1", { record: { ...stale, plan: { ...stale.plan!, submittedAt: Date.now() - 25 * 3_600_000 } }, at: Date.now() });
    saveProjectSetting(db, "proj", "phase.proposal_ttl_hours", 24);
    await expect(word(sha)).rejects.toThrow(/stale/);
    // Fresh again: the keyed yes counts.
    savePhase(db, "ph_1", { record: { ...stale, plan: { ...stale.plan!, submittedAt: Date.now() } }, at: Date.now() });
    const phase = await word(sha);
    expect(phase.record.words?.map((row) => row.decision)).toEqual(["yes"]);
    expect(phases.status("ph_1").ownerWord.planKey).toBe(sha);
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
