import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../../src/rooms/plugin-db";
import { createAttempt, createRun, createTask, getAttempt, transitionAttempt } from "../../src/rooms/storage";
import { recordTaskWord } from "../../src/rooms/tasks/server";
import { sha256Hex } from "@lane-pilot/kit";
import type { TaskV2 } from "../../src/rooms/contracts";

const CRITIC_MODELS = ["claude-opus-5-5", "gpt-6.1-sol", "test-model"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort }));

export async function observeTestEditHold(paddingLines = 0, readFault?: "changed" | "stalled" | "failed", inPlace = false) {
  const { createWriterFinish } = await import("../../src/rooms/writer/server/services/finish");
  const { createCore } = await import("../../src/rooms/core/server/core");
  const { stageHelperSettings } = await import("../../src/rooms/settings/server/services/stage-settings");
  const { saveProjectSetting, setRunThread } = await import("../../src/rooms/storage");
  const { allowTestEditsOf, testEditHoldOf } = await import("../../src/rooms/tasks/server");
  const padding = "// preceding test content\n".repeat(paddingLines);
  const before = padding + "it(\"works\", () => {\n  expect(sum([1, 2])).toBe(3);\n});\n";
  const after = padding + "it(\"works\", () => {\n  expect(sum([1, 2])).toBeTruthy();\n});\n";
  const run = async (words: "on" | "off", allowAfter?: string) => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const answer = JSON.stringify({ status: "pass", summary: "the change reads fine", evidence: "read tests/sum.test.ts and its diff", findings: [] });
    harness.sdk.stub("providers.list", async () => ["claude-code", "codex"].map((id) => ({ id, available: true, capabilities: { supportsServiceTier: false }, serviceTiers: [] })));
    harness.sdk.stub("providers.models", async () => ({ models: CRITIC_MODELS.map((id) => ({ id, model: id, supportedReasoningEfforts: EFFORTS })) }));
    harness.sdk.stub("threads.get", async () => ({ id: "thr_pm", projectId: "P", parentThreadId: "thr_root", sourceThreadId: "thr_root", lifecycleOwnerThreadId: "thr_root", status: "idle" }));
    harness.sdk.stub("threads.spawn", async () => ({ id: "crit1" }));
    harness.sdk.stub("threads.events.list", async ({ threadId }: { threadId: string }) => [{ type: "turn/started", threadId, seq: 1 }, { type: "turn/completed", threadId, seq: 2, data: { status: "completed" } }]);
    harness.sdk.stub("threads.output", async () => ({ output: answer, text: "done" }));
    harness.sdk.stub("threads.stop", async () => undefined);
    harness.sdk.stub("threads.send", async () => ({}));
    harness.sdk.stub("files.read", async () => ({ content: after, contentEncoding: "utf8" }));
    harness.sdk.stub("plugins.callRpc", async ({ method }: { method: string }) => method === "fileSide"
      ? { outcome: "available", file: { path: "tests/sum.test.ts", content: before, contentEncoding: "utf8", sizeBytes: Buffer.byteLength(before) } }
      : method === "files"
      ? { outcome: "available", files: [{ path: "tests/sum.test.ts", revision: "r1", changeKind: "modified" }], initialPatches: [{ path: "tests/sum.test.ts", patch: "@@\n+x\n", truncated: false }] }
      : { outcome: "available", patches: { "tests/sum.test.ts": { outcome: "available", patch: { path: "tests/sum.test.ts", patch: "@@\n+x\n", truncated: false } } } });
    harness.sdk.stub("environments.list", async () => [{ id: "env-1" }]);
    const hostCalls: string[] = [];
    bb.hosts.experimental_client = (() => ({ call: async (method: string, input: { projectCwd?: string; relativePath?: string; offset?: number; maxLines?: number }) => {
      hostCalls.push(`${method}:${input.projectCwd ?? ""}:${input.relativePath ?? ""}`);
      if (method === "readBoundedFile") {
        const content = (inPlace || input.projectCwd === "/wt") ? after : before;
        const lines = content.split("\n"), offset = input.offset ?? 0;
        const end = Math.min(lines.length, offset + (input.maxLines ?? 400));
        if (offset && readFault === "failed") throw new Error("next page unavailable");
        return { content: lines.slice(offset, end).join("\n"), lineEnd: readFault === "stalled" ? offset : end,
          truncated: end < lines.length, sha256: sha256Hex(offset && readFault === "changed" ? `${content}changed` : content) };
      }
      return {};
    } })) as never;
    const task: TaskV2 = {
      schema_version: 2, id: "t1", title: "Task t1", risk: "low", lane: "writer", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [],
      out_of_scope: [], expected_outputs: ["tests/sum.test.ts"], owns_paths: ["src/**", "tests/**"], never_touch: [], depends_on: [],
      objective: "Make t1", acceptance: ["done"], verify: "none", verification: [],
    };
    createRun(db, "r", "P", "bb", "/repo");
    setRunThread(db, "r", "thr_pm");
    createTask(db, { id: "t1", runId: "r", kind: "bb", contract: task });
    createAttempt(db, { id: "a1", runId: "r", taskId: "t1" });
    transitionAttempt(db, "a1", "spawn_requested");
    transitionAttempt(db, "a1", "running", { threadId: "writer-1" });
    db.prepare("UPDATE lane_pilot_attempt SET workspace_path=?, environment_id='env_wt' WHERE id='a1'").run(inPlace ? "/repo" : "/wt");
    saveProjectSetting(db, "P", "owner.words", words);
    saveProjectSetting(db, "P", "code_critique.enabled", true);
    saveProjectSetting(db, "P", "code_critique.mode", "gate");
    const config = { projectId: "P", hostId: "h1", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "claude-code", pmModel: "claude-opus-5-5", writerProviderId: "claude-code", writerModel: "claude-opus-5-5" } as never;
    const ctx = createCore(bb, db);
    await recordTaskWord(bb.storage.kv as never, "r", "t1", "no", "not now");
    if (allowAfter) await allowTestEditsOf(bb.storage.kv as never, "a1", [{ path: "tests/sum.test.ts", afterSha256: sha256Hex(allowAfter) }]);
    const finish = createWriterFinish(ctx as never, {
      stageHelperSettings, activeWriterTasks: new Set<string>(), providerBreaker: { record: () => undefined },
      validateWriterResult: async () => ({ status: "accepted", output: "done", produced: ["tests/sum.test.ts"], verification: [] }),
      persistWriterAcceptance: async () => ({ state: "passed" }),
      workspaceDirt: async () => ({ ok: true, snapshots: [] }),
      runBudgetFor: () => ({ snapshot: () => ({ limits: {} }) }),
      taskWords: { ask: () => undefined },
    } as never);
    try {
      const result = await finish.finishWriterAttempt({ projectId: "P", config, task, runId: "r", taskId: "t1", attemptId: "a1", pmThreadId: "thr_pm", writerThreadId: "writer-1", dirtBefore: [] } as never);
      const attempt = getAttempt(db, "a1")!;
      const held = await testEditHoldOf(bb.storage.kv as never, "a1");
      return { status: result.status, reason: result.reason as string | undefined, state: attempt.state, held, barrierWriterStatus: attempt.barrier?.reason ?? null, hostCalls };
    } finally { await harness.lifecycle.dispose(); }
  };
  return { afterSha: sha256Hex(after), asked: await run("on"), notAsked: await run("off"), allowed: await run("on", after), otherEdit: await run("on", `${after}// more\n`) };
}
