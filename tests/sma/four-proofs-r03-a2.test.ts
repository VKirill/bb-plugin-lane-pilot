// Region 3 · Worker, batch a (file 2, isolated: it replaces waitThreadIdle so a stand-in thread answers at once).
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { pauseProbeCheck } from "../../src/rooms/native-agent/server/helper-probe";
import { runCodeCritique } from "../../src/rooms/critique/server/critique-runs";
import { stageHelperSettings } from "../../src/rooms/settings/server/stage-settings";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, saveProjectSetting, setRunThread } from "../../src/rooms/plugin-db";
import { contract } from "./r03-world-a";

vi.mock("@lane-pilot/thread-observe", async (importOriginal) => ({ ...(await importOriginal() as Record<string, unknown>), waitThreadIdle: async () => undefined }));

/** A thread that is stopped in the middle of its long command; after the stop it reports `statusAfterStop`, and answers the follow-up with `answer`. */
function thread(statusAfterStop: string, answer: string | null) {
  const calls: string[] = [];
  let stopped = false;
  const bb = { log: { warn: () => undefined, info: () => undefined }, sdk: { threads: {
    stop: async () => { calls.push("stop"); stopped = true; },
    get: async () => ({ status: stopped ? statusAfterStop : "active" }),
    send: async (input: { input: Array<{ text: string }> }) => { calls.push(`send:${input.input[0]!.text}`); },
    output: async () => { calls.push("output"); return { output: answer }; },
  } } };
  return { bb: bb as never, calls };
}

describe("the pause drill", () => {
  it("[sma:wc_drill] the pause cell passes only when the thread is stopped mid-command, is confirmed out, and the same thread answers RESUMED to a follow-up; each failed step names itself", async () => {
    const good = thread("idle", "RESUMED");
    expect(await pauseProbeCheck(good.bb, "t1", 2_000)).toEqual({ ok: true });
    // the order is the proof: stop first, the follow-up only after the stop was confirmed, the answer read last
    expect(good.calls).toEqual(["stop", "send:Reply with the single word RESUMED. Nothing else.", "output"]);

    const running = thread("active", "RESUMED");
    const notStopped = await pauseProbeCheck(running.bb, "t1", 600);
    expect(notStopped.ok).toBe(false);
    expect(notStopped.reason).toContain("pause:stop: the thread is still running");
    expect(running.calls).toEqual(["stop"]);

    const silent = thread("idle", "I am done with the sleep");
    expect(await pauseProbeCheck(silent.bb, "t1", 2_000)).toEqual({ ok: false, reason: "pause:resume: the same thread never answered RESUMED after the stop" });
    expect(await pauseProbeCheck(thread("idle", null).bb, "t1", 2_000)).toMatchObject({ ok: false });
  });
});

// ---- the critic: an ordinary roster worker launched to judge a candidate ----
const MODELS = ["router9/ag/gemini-3.8-flash-high", "gemini-4-hydrogen", "gpt-6.1-sol", "claude-opus-5-5", "claude-sonnet-5-5", "test-model"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort }));

async function criticWorld(answer: string) {
  const spawns: Array<Record<string, unknown>> = [];
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  harness.sdk.stub("providers.list", async () => ["claude-code", "codex", "opencode2", "acp-antigravity"].map((id) => ({ id, available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] })));
  harness.sdk.stub("providers.models", async () => ({ models: MODELS.map((id) => ({ id, model: id, supportedReasoningEfforts: EFFORTS })) }));
  harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", projectId: "P", parentThreadId: "thr_root", sourceThreadId: "thr_root", lifecycleOwnerThreadId: "thr_root", status: "idle" }));
  harness.sdk.stub("threads.spawn", async (input: Record<string, unknown>) => { spawns.push(input); return { id: `crit${spawns.length}` }; });
  harness.sdk.stub("threads.output", async () => ({ output: answer }));
  harness.sdk.stub("threads.stop", async () => undefined);
  harness.sdk.stub("files.read", async () => ({ content: "export const a = 1;\n", contentEncoding: "utf8" }));
  bb.hosts.experimental_client = (() => ({ call: async () => ({}) })) as never;
  const db = openDatabase(bb);
  createRun(db, "r", "P", "bb", "/repo");
  setRunThread(db, "r", "thr_pm");
  const task = { ...contract("t1"), project_cwd: "/repo", risk: "medium" } as never;
  createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task });
  createAttempt(db, { id: "a1", runId: "r", taskId: "t1" });
  db.prepare("UPDATE lane_pilot_attempt SET workspace_path='/repo', environment_id='env_wt' WHERE id='a1'").run();
  saveProjectSetting(db, "P", "code_critique.enabled", true);
  saveProjectSetting(db, "P", "code_critique.mode", "gate");
  const hash = "d".repeat(64);
  const evidence = { truncated: false, artifactRevisionSha256: hash, evidenceSha256: hash, revisionSha256: hash, produced: ["src/a.ts"], hashes: {}, baselineHashes: {},
    verification: [{ command: "npm test", exitCode: 0 }], files: [{ path: "src/a.ts", diff: "+export const a = 1;", content: "export const a = 1;\n" }],
    packetSha256: hash, outputSha256: hash, ownsPaths: ["src/**"], neverTouch: [] };
  const config = { projectId: "P", hostId: "h1", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "claude-code", pmModel: "claude-opus-5-5", writerProviderId: "claude-code", writerModel: "claude-opus-5-5" } as never;
  const result = await runCodeCritique({ stageHelperSettings, bb, db, projectId: "P", runId: "r", taskId: "t1", config, task, evidence } as never);
  const receipt = listStageReceipts(db, "r", "t1").find((row) => row.stageId === "code-critique");
  await harness.lifecycle.dispose();
  return { result, spawns, receipt };
}

const verdict = (decision: "approve" | "changes_requested") => JSON.stringify({ decision, summary: decision === "approve" ? "fine" : "the guard is missing", findings: decision === "approve" ? [] : [{ id: "f1", severity: "blocking", finding: "no guard", criterion: "acceptance", path: "src/a.ts", line: 1, evidence: "export const a = 1;" }] });

describe("the critic", () => {
  it("[sma:wr_critic] a roster worker is launched on the attempt's own copy to judge the candidate; its approval passes the stage, its blocking finding stops it", async () => {
    const approved = await criticWorld(verdict("approve"));
    expect(approved.spawns.length).toBeGreaterThan(0);
    expect(approved.spawns[0]).toMatchObject({ environment: { type: "reuse", environmentId: "env_wt" }, pluginMetadata: { role: "code-critic", lanePilotRunId: "r", lanePilotTaskId: "t1", stageId: "code-critique", parentPmThreadId: "thr_pm" } });
    expect(approved.result).toMatchObject({ allowed: true, review: "passed" });
    expect(approved.receipt).toMatchObject({ state: "passed", threadId: "crit1" });
    const blocked = await criticWorld(verdict("changes_requested"));
    expect(blocked.result.allowed).toBe(false);
    expect(blocked.receipt).toMatchObject({ state: "blocked" });
  });
});
