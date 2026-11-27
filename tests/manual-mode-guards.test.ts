import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse, makeTurnFailedEvent } from "@get-bb/plugin-sdk/testing";
import { EMBED_DIM, pendingVectors, storeMemoryRecords } from "@lane-pilot/memory-core";
import { createDraftStore, parseWorkflow, WorkflowEngine } from "@lane-pilot/workflow-engine";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyDemotion,
  getHypothesis,
  getTrial,
  issueEvolutionReceipt,
  onCanaryRun,
  openTrial,
  queueHypothesis,
  setHypothesisState,
} from "../src/rooms/evolve/server";
import { mountLifecycleEvents } from "../src/rooms/core/server/lifecycle-events";
import {
  mountMemoryEmbeddings,
  mountThreadBlock,
  setEmbedder,
  type Embedder,
} from "../src/rooms/memory/server";
import {
  appendSkillEvolutionEvent,
  createAttempt,
  createRun,
  createTask,
  openDatabase,
  setRunThread,
  transitionAttempt,
} from "../src/rooms/plugin-db";
import { loadBlockedBy } from "../src/rooms/runs/server";
import { mountRelay, relayFor } from "../src/rooms/relay/server";
import { mountUsageSnapshots } from "../src/rooms/usage/server";
import { attachStreamRetry } from "../src/rooms/writer/server";
import { builtinWorkflow, grantOwner, publishEvolutionWorkflowDraft } from "../src/rooms/workflow/server";
import type { ServerCore } from "../src/rooms/contracts/server";

const tempDirs: string[] = [];
const makeTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
};

const disposers: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (disposers.length) await disposers.pop()!();
  setEmbedder(null);
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

const streamError = { category: "stream-disconnected" as const, httpStatusCode: null, providerCode: null };

describe("manual mode server guards", () => {
  it("1. stream retry skips turn.failed while manual and retries when off", async () => {
    let manual = true;
    const retries: string[] = [];
    const logs: string[] = [];
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    disposers.push(() => harness.lifecycle.dispose());

    attachStreamRetry({
      events: bb.events,
      retry: async (args) => {
        retries.push(args.threadId);
        return { ok: true as const, delivery: "sent" as const, attempt: 2, turnRequestId: String(args.turnRequestId ?? "") };
      },
      owned: async () => true,
      manualMode: { on: () => manual },
      info: (m) => logs.push(m),
    });

    await harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({
      threadId: "thr_m1",
      requestId: "creq_1",
      errorInfo: streamError,
    }));
    expect(retries).toEqual([]);
    expect(logs.some((m) => m.includes("stream retry skipped") && m.includes("manual mode"))).toBe(true);

    manual = false;
    await harness.behavior.emitThreadEvent("turn.failed", makeTurnFailedEvent({
      threadId: "thr_m1",
      requestId: "creq_2",
      errorInfo: streamError,
    }));
    expect(retries).toEqual(["thr_m1"]);
  });

  it("2. relay deadlines and native reminders queue and fire nothing while manual, and act when off", async () => {
    let manual = true;
    const sent: Array<{ threadId: string; text: string; sendAt?: unknown }> = [];
    const logs: string[] = [];
    let threadChanged: ((ev: { id?: string; metadata?: Record<string, unknown> }) => void) | undefined;

    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        subscribe: ({ event, callback }: { event: string; callback: (ev: { id?: string; metadata?: Record<string, unknown> }) => void }) => {
          if (event === "thread:changed") threadChanged = callback;
          return () => { threadChanged = undefined; };
        },
        threads: {
          get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", environmentId: null }),
          send: async (args: { threadId: string; sendAt?: number; input: Array<{ text?: string }> }) => {
            sent.push({ threadId: args.threadId, text: args.input[0]?.text ?? "", sendAt: args.sendAt });
            if (args.sendAt !== undefined) return { delivery: "queued", ok: true, queuedMessage: { id: `q_${sent.length}` } };
            return { delivery: "sent", ok: true };
          },
          queuedMessages: { list: async () => [], delete: async () => ({ ok: true }) },
        },
      } as never,
    });
    disposers.push(() => harness.lifecycle.dispose());
    const db = openDatabase(bb);
    const ctx = {
      bb,
      db,
      log: (m: string) => logs.push(m),
      isDisposed: () => false,
      manualMode: { on: () => manual },
    } as unknown as ServerCore;

    const relay = mountRelay(ctx);
    await relay.remind({ projectId: "P", threadId: "pm", note: "check holder", inMinutes: 10, watchThreadId: "holder" });
    expect(sent).toHaveLength(0);
    expect(logs.some((m) => m.includes("reminder skipped") && m.includes("manual mode"))).toBe(true);

    // Pre-seed a watched ask while off? Test threadSettled/sweep directly while manual too.
    manual = false;
    const queued = await relayFor(ctx).remind({ projectId: "P", threadId: "pm", note: "check holder", inMinutes: 10, watchThreadId: "holder" });
    expect(queued.queuedMessageId).toBe("q_1");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.sendAt).toBe(queued.dueAt);

    // Flip manual back on: thread:changed + sweep skip firing.
    manual = true;
    await new Promise((r) => setTimeout(r, 20));
    threadChanged?.({ id: "holder" });
    await new Promise((r) => setTimeout(r, 20));
    expect(await relay.sweep()).toEqual({ fired: 0, settled: 0 });
    expect(sent).toHaveLength(1);

    // Flip manual off: sweep wakes the watched thread.
    manual = false;
    const res = await relay.sweep();
    expect(res.settled).toBe(1);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("finished its turn");
  });

  it("3. interaction.pending keeps blockedBy but skips PM chat notice while manual, and sends when off", async () => {
    const prevSignals = process.env.LANE_PILOT_THREAD_SIGNALS;
    process.env.LANE_PILOT_THREAD_SIGNALS = "1";
    disposers.push(() => {
      if (prevSignals === undefined) delete process.env.LANE_PILOT_THREAD_SIGNALS;
      else process.env.LANE_PILOT_THREAD_SIGNALS = prevSignals;
    });

    let manual = true;
    const sent: Array<{ threadId: string; text: string }> = [];
    const logs: string[] = [];
    const handlers = new Map<string, (payload: unknown) => unknown>();
    const { bb: host, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          send: async (args: { threadId: string; input: Array<{ text?: string }> }) => {
            sent.push({ threadId: args.threadId, text: args.input[0]?.text ?? "" });
            return { delivery: "sent", ok: true };
          },
        },
      } as never,
    });
    disposers.push(() => harness.lifecycle.dispose());
    const db = openDatabase(host);
    const bb = Object.assign(Object.create(host), {
      pluginId: "lane-pilot",
      log: { ...host.log, info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
      events: { on: (name: string, fn: (payload: unknown) => unknown) => { handlers.set(name, fn); } },
    });
    mountLifecycleEvents({
      bb,
      db,
      isDisposed: () => false,
      manualMode: { on: () => manual },
      nativeInstaller: { forget: async () => undefined },
    } as never);

    createRun(db, "run_ip", "P", "cli");
    setRunThread(db, "run_ip", "thr_pm");
    createTask(db, { id: "task_ip", runId: "run_ip", kind: "bb", contract: {} });
    createAttempt(db, { id: "att_ip", runId: "run_ip", taskId: "task_ip" });
    transitionAttempt(db, "att_ip", "spawn_requested");
    transitionAttempt(db, "att_ip", "running", { threadId: "thr_w" });

    await handlers.get("interaction.pending")?.({
      thread: makeThreadResponse({ id: "thr_w" }),
      interaction: { id: "int_manual", threadId: "thr_w", status: "pending", payload: { kind: "approval", reason: "push tag" } },
    });
    expect(sent).toHaveLength(0);
    expect((await loadBlockedBy(host.storage.kv, "att_ip"))?.detail).toContain("int_manual");
    expect(logs.some((m) => m.includes("interaction.pending PM notice") && m.includes("manual mode"))).toBe(true);

    manual = false;
    await handlers.get("interaction.pending")?.({
      thread: makeThreadResponse({ id: "thr_w" }),
      interaction: { id: "int_live", threadId: "thr_w", status: "pending", payload: { kind: "approval", reason: "push tag" } },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.threadId).toBe("thr_pm");
  });

  it("4. thread block contributes nothing while manual and contributes facts when off", async () => {
    let manual = true;
    const logs: string[] = [];
    let contributor: ((arg: { threadId: string; projectId: string }) => string | null) | null = null;
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    disposers.push(() => harness.lifecycle.dispose());
    const db = openDatabase(bb);
    storeMemoryRecords(db, {
      projectId: "P",
      personalBot: "",
      sourceSha256: "a".repeat(64),
      audience: "subagent",
      coreBudget: 99_999,
      noteBudget: 99_999,
      indexBudget: 999_999,
      entries: [{ kind: "core", content: "Keep one server per port.", concepts: ["convention"] }],
    });
    const fakeBb = Object.assign(Object.create(bb), {
      log: { ...bb.log, debug: (m: string) => logs.push(m), info: (m: string) => logs.push(m) },
      agents: {
        ...bb.agents,
        contributeInstructions: (fn: (arg: { threadId: string; projectId: string }) => string | null) => { contributor = fn; },
      },
    });

    mountThreadBlock({ bb: fakeBb, db, manualMode: { on: () => manual } });
    expect(contributor).not.toBeNull();
    expect(contributor!({ projectId: "P", threadId: "thr_plain" })).toBeNull();
    expect(logs.some((m) => m.includes("memory thread block skipped") && m.includes("manual mode"))).toBe(true);

    manual = false;
    expect(contributor!({ projectId: "P", threadId: "thr_plain" })).toContain("Keep one server per port.");
  });

  it("5. memory embeddings skip commit events and startup backfill while manual and run when off", async () => {
    let manual = true;
    let embedCalls = 0;
    const logs: string[] = [];
    const embedder: Embedder = async (texts) => {
      embedCalls += 1;
      const vec = new Float32Array(EMBED_DIM);
      vec[0] = 1;
      return texts.map(() => new Float32Array(vec));
    };
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    disposers.push(() => harness.lifecycle.dispose());
    const db = openDatabase(bb);
    const engine = new WorkflowEngine({ db, harnessVersion: "1.0.0" });
    const fakeBb = Object.assign(Object.create(bb), {
      log: { ...bb.log, info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
    });
    const ctx = {
      bb: fakeBb,
      db,
      isDisposed: () => false,
      manualMode: { on: () => manual },
      log: (m: string) => logs.push(m),
    } as unknown as ServerCore;

    // Seed a stale record before mount so backfillOnReady would run if not manual.
    storeMemoryRecords(db, {
      projectId: "P_emb",
      audience: "subagent",
      sourceSha256: "b".repeat(64),
      coreBudget: 3072,
      noteBudget: 8192,
      indexBudget: 65536,
      entries: [{ kind: "note", content: "Stale vector waiting.", concepts: ["embed"] }],
    });

    const handle = mountMemoryEmbeddings(ctx, { workflowEngine: engine }, { embedder, backfillOnReady: true });
    disposers.push(handle.dispose);
    await new Promise((r) => setTimeout(r, 20));
    expect(embedCalls).toBe(0);
    expect(await handle.backfill()).toEqual({ started: false });

    // Memory write while manual also skips embedding.
    storeMemoryRecords(db, {
      projectId: "P_emb",
      audience: "subagent",
      sourceSha256: "c".repeat(64),
      coreBudget: 3072,
      noteBudget: 8192,
      indexBudget: 65536,
      entries: [{ kind: "note", content: "Second note while manual.", concepts: ["embed"] }],
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(embedCalls).toBe(0);
    expect(pendingVectors(db, 10)).toHaveLength(2);
    expect(logs.some((m) => m.includes("memory.embed-backfill skipped: manual mode"))).toBe(true);
    expect(logs.some((m) => m.includes("memory.embed-commit skipped") && m.includes("manual mode"))).toBe(true);

    manual = false;
    const live = await handle.backfill();
    expect(live.started).toBe(true);
    await engine.idle();
    expect(embedCalls).toBeGreaterThan(0);
    expect(pendingVectors(db, 10)).toHaveLength(0);
  });

  it("6. usage snapshots skip pushing to hosts while manual and push when off", async () => {
    let manual = true;
    const writes: unknown[] = [];
    const logs: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      experimental_callHostRpc: (call) => {
        if (call.method === "writeUsageSnapshot") writes.push(call.input);
        return { ok: true };
      },
      sdk: {
        hosts: {
          list: async () => [{ id: "h1", name: "Host 1", connected: true, status: "connected" }],
        },
      } as never,
    });
    disposers.push(() => harness.lifecycle.dispose());
    const db = openDatabase(bb);
    const fakeBb = Object.assign(Object.create(bb), {
      log: { ...bb.log, info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
    });
    const snapshots = mountUsageSnapshots(
      { bb: fakeBb, db, isDisposed: () => false, manualMode: { on: () => manual }, log: (m: string) => logs.push(m) },
      { readings: async () => ({ measuredAt: "2026-11-28T00:00:00.000Z", windows: [{ label: "five-hour", usedPercent: 25, resetsAt: null, model: null }] }) as never },
    );

    await snapshots.push();
    expect(writes).toHaveLength(0);
    expect(logs.some((m) => m.includes("usage snapshot skipped: manual mode"))).toBe(true);

    manual = false;
    await snapshots.push();
    expect(writes).toHaveLength(1);
  });

  it("7. canary promotion and evolution publish skip while manual (leaving owner grants working) and promote when off", async () => {
    let manual = true;
    const globalDir = makeTempDir("lp-mm-wf-");
    const skillsDir = makeTempDir("lp-mm-skills-");
    const logs: string[] = [];
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    disposers.push(() => harness.lifecycle.dispose());
    const db = openDatabase(bb);

    const wfDef = JSON.parse(JSON.stringify(builtinWorkflow("invoice-send")!)) as Record<string, unknown>;
    const drafts = createDraftStore(db);
    const parsedWf = parseWorkflow(wfDef);
    const draft = drafts.create({
      projectId: "__global__",
      threadId: null,
      scope: "global",
      name: parsedWf.name,
      description: parsedWf.description,
      workflowId: parsedWf.id,
      definition: wfDef,
      metadata: { source: "evolve", hypothesisId: "evh_mm_1" },
    });
    const patched = drafts.patch(
      draft.id,
      [{ op: "update_node", id: "create", set: { provider: "claude-code", model: "claude-haiku-5-5" } }],
      { evolutionGate: true, source: "evolve" },
    );
    expect(patched.ok).toBe(true);
    if (!patched.ok) throw new Error("patch failed");

    appendSkillEvolutionEvent(db, {
      draftId: patched.draft.id,
      draftVersion: patched.draft.version,
      workflowId: "invoice-send",
      skillId: "invoice-skill",
      operator: "add",
      mergeMode: "companion",
      status: "staged",
      candidateFiles: [{ path: "SKILL.md", text: "# Invoice Skill\nUpdated instructions.\n" }],
      beforeFiles: [],
      beforeBundleSha256: null,
      supersededWorkflowIds: [],
    });

    queueHypothesis(db, {
      id: "evh_mm_1",
      workflowId: "invoice-send",
      nodeId: "create",
      armKind: "model",
      variant: { provider: "claude-code", model: "claude-haiku-5-5" },
      graphVersion: 1,
      source: "census",
    });
    setHypothesisState(db, { id: "evh_mm_1", state: "canary", draftId: patched.draft.id });
    const trial = openTrial(db, {
      hypothesisId: "evh_mm_1",
      workflowId: "invoice-send",
      baselineVersion: 1,
      candidateDraftId: patched.draft.id,
      share: 0.2,
      now: 100_000,
    });

    for (let i = 0; i < 20; i += 1) {
      for (const arm of ["old", "new"] as const) {
        const id = `mm_${arm}_${i}`;
        const ok = arm === "new" || i % 2 !== 0;
        db.prepare(
          `INSERT INTO lane_pilot_wf_run
            (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, inputs_json, output_json, cost_micro_usd, created_at, updated_at, arm, trial_id)
           VALUES (?, 'invoice-send', 1, 'sha', ?, 'proj-1', 'succeeded', '{}', ?, ?, ?, ?, ?, ?)`,
        ).run(id, JSON.stringify(wfDef), JSON.stringify({ status: ok ? "sent" : "send_failed" }), arm === "new" ? 500 : 2000, 110_000 + i, 115_000 + i, arm, trial.trialId);
      }
    }

    const core = {
      bb: {
        log: { debug: (m: string) => logs.push(m), info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
        sdk: { projects: { get: async () => ({ id: "__global__", name: "Global" }) }, threads: { get: async () => null }, environments: { get: async () => null } },
      },
      db,
      manualMode: { on: () => manual },
      log: (m: string) => logs.push(m),
      realtime: { notify: () => undefined },
      knownCustomAgentIds: () => null,
      ownedAgents: async () => ({}),
      effectiveProjectSettings: async () => ({ values: {} }),
      secrets: { list: async () => [] },
      host: { call: async () => ({}) },
    } as unknown as ServerCore;

    const publishDraft = (input: { draftId: string; ownerGrant?: boolean }) =>
      publishEvolutionWorkflowDraft(core, { globalDir: () => globalDir, skillsDir: () => skillsDir }, { ...input, ensureTests: true });

    const skippedCanary = await onCanaryRun(
      { db, manualMode: { on: () => manual }, log: (m) => logs.push(m) },
      { publishDraft, now: () => 200_000 },
      { id: "mm_new_19", trial_id: trial.trialId },
    );
    expect(skippedCanary).toEqual({ handled: false, reason: "manual_mode" });
    expect(getTrial(db, trial.trialId)?.state).toBe("open");
    expect(existsSync(join(globalDir, "invoice-send.json"))).toBe(false);
    expect(existsSync(join(skillsDir, "invoice-skill", "SKILL.md"))).toBe(false);

    // Direct draft-evolution publish with an automatic evolution receipt is also refused while manual.
    issueEvolutionReceipt(db, { draftId: patched.draft.id, trialId: trial.trialId, decision: "promote", now: 200_100 });
    const blockedEvo = await publishDraft({ draftId: patched.draft.id });
    expect(blockedEvo.ok).toBe(false);
    expect(blockedEvo.reason).toBe("manual_mode");
    expect(existsSync(join(skillsDir, "invoice-skill", "SKILL.md"))).toBe(false);

    // Turning manual mode off promotes and writes both the workflow and ~/.bb/skills bundle.
    manual = false;
    const promoted = await onCanaryRun(
      { db, manualMode: { on: () => manual }, log: (m) => logs.push(m) },
      { publishDraft, now: () => 210_000 },
      { id: "mm_new_19", trial_id: trial.trialId },
    );
    expect(promoted).toMatchObject({ handled: true, action: "promote", trialId: trial.trialId, version: 2 });
    expect(getHypothesis(db, "evh_mm_1")?.state).toBe("promoted");
    expect(existsSync(join(globalDir, "invoice-send.json"))).toBe(true);
    expect(existsSync(join(skillsDir, "invoice-skill", "SKILL.md"))).toBe(true);

    // An explicit owner grant still publishes even when manual mode is back on.
    manual = true;
    const ownerDraft = drafts.patch(
      patched.draft.id,
      [{ op: "update_node", id: "create", set: { model: "claude-sonnet-5-5" } }],
      { evolutionGate: true, source: "owner" },
    );
    expect(ownerDraft.ok).toBe(true);
    if (!ownerDraft.ok) throw new Error("owner patch failed");
    grantOwner(db, ownerDraft.draft.id, "desk");
    const ownerPub = await publishDraft({ draftId: ownerDraft.draft.id });
    expect(ownerPub.ok).toBe(true);
    expect(ownerPub.version).toBe(3);

    // Fallback demotion also respects manual mode.
    queueHypothesis(db, {
      id: "evh_mm_demote",
      workflowId: "invoice-send",
      nodeId: "create",
      armKind: "form",
      variant: { form: "plan", fallback: "agent" },
      graphVersion: 3,
      source: "fallback",
    });
    const demotedSkipped = await applyDemotion(
      { db, manualMode: { on: () => true }, log: (m) => logs.push(m) },
      { publishDraft, now: () => 220_000 },
      { hypothesisId: "evh_mm_demote" },
    );
    expect(demotedSkipped).toEqual({ ok: false, mode: "manual_mode", reason: "manual_mode" });
  });
});
