import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { CRITIQUE_REPEAT_MAX_LINES, CRITIQUE_REPEAT_WINDOW_MS, critiqueRepeatSkip, patchChangedLines } from "../src/rooms/critique/quality-mode";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, saveProjectSetting, saveStageReceipt, transitionAttempt } from "../src/rooms/plugin-db";
import { sha256Hex } from "@lane-pilot/kit";
import { createWriterFinish } from "../src/rooms/writer/server/finish";

const NOW = 1_800_000_000_000;
const approval = (over: Partial<Parameters<typeof critiqueRepeatSkip>[0]["priorApprovals"][number]> = {}) => ({
  taskId: "t0", ownsPaths: ["src/**"], state: "passed", decision: "approve", updatedAt: NOW - 3_600_000, ...over,
});
const skip = (over: Partial<Parameters<typeof critiqueRepeatSkip>[0]> = {}) => critiqueRepeatSkip({
  risk: "low", referenceTestEdits: undefined, changedLines: 10, ownsPaths: ["src/a.ts"],
  priorApprovals: [approval()], now: NOW, ...over,
});

describe("critiqueRepeatSkip", () => {
  it("skips a small low-risk change on files a critic approved within 48 h", () => {
    expect(skip()).toEqual({ reason: "repeat", priorTaskId: "t0" });
    expect(skip({ risk: "medium", changedLines: CRITIQUE_REPEAT_MAX_LINES })).toMatchObject({ reason: "repeat" });
    expect(patchChangedLines({ "a.ts": "@@\n+x\n-y\n+++ b/a.ts\n" })).toBe(2);
  });

  it("never skips a high or critical risk task", () => {
    expect(skip({ risk: "high" })).toBeNull();
    expect(skip({ risk: "critical" })).toBeNull();
  });

  it("never skips a task that edited a reference test or check script", () => {
    expect(skip({ referenceTestEdits: ["tests/a.test.ts"] })).toBeNull();
  });

  it("never skips a diff over the line bound, or one that could not be measured", () => {
    expect(skip({ changedLines: CRITIQUE_REPEAT_MAX_LINES + 1 })).toBeNull();
    expect(skip({ changedLines: null })).toBeNull();
  });

  it("never skips on a prior approval older than 48 h, a non-approval, or non-overlapping paths", () => {
    expect(skip({ priorApprovals: [approval({ updatedAt: NOW - CRITIQUE_REPEAT_WINDOW_MS - 1 })] })).toBeNull();
    expect(skip({ priorApprovals: [approval({ decision: "changes_requested" })] })).toBeNull();
    expect(skip({ priorApprovals: [approval({ state: "blocked" })] })).toBeNull();
    expect(skip({ priorApprovals: [approval({ ownsPaths: ["other/**"] })] })).toBeNull();
    expect(skip({ priorApprovals: [] })).toBeNull();
  });
});

// The finish path: a second small task on the same files gets a `skipped` receipt with a `repeat:` reason and no critic thread.
const config: PrototypeConfig = {
  projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo",
  pmProviderId:"codex", pmModel:"codex-test", writerProviderId:"codex", writerModel:"codex-test",
};
const task = (id: string): TaskV2 => ({
  schema_version:2, id, title:"Write", risk:"low", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:["note.txt"], owns_paths:["note.txt"], never_touch:[], depends_on:[],
  objective:"write", acceptance:["file exists"], verify:"none", verification:[],
});

function world() {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", "/repo");
  createTask(db, { id:"t0", runId:"run", kind:"bb", contract:task("t0") });
  createTask(db, { id:"t1", runId:"run", kind:"bb", contract:task("t1") });
  for (const id of ["t0", "t1"]) {
    createAttempt(db, { id:`a-${id}`, runId:"run", taskId:id });
    transitionAttempt(db, `a-${id}`, "spawn_requested");
    transitionAttempt(db, `a-${id}`, "running", { threadId:`writer-${id}` });
  }
  saveProjectSetting(db, "P", "code_critique.enabled", true);
  // t0's critic already approved the same file an hour ago.
  saveStageReceipt(db, { runId:"run", taskId:"t0", stageId:"code-critique", contractVersion:1, state:"passed",
    inputSha256:"a".repeat(64), outputSha256:"b".repeat(64), attempt:0, providerId:"critic", model:"critic-model",
    threadId:null, reason:null, updatedAt:Date.now() - 3_600_000, result:{ decision:"approve" } });
  const ctx = {
    state:{ disposed:false },
    bb:{ storage:bb.storage, log:{ warn() {}, error() {} },
      sdk:{ threads:{ stop:async () => undefined, events:{ list:async () => [] }, get:async () => ({ status:"idle" }),
          output:async () => ({ text:"done" }) },
        files:{ read:async () => ({ content:"note" }) },
        plugins:{ callRpc:async ({ method }: { method:string }) => method === "files"
          ? { outcome:"available", files:[{ path:"note.txt", revision:"r1" }], initialPatches:[{ path:"note.txt", patch:"@@\n+note\n", truncated:false }] }
          : { outcome:"available", patches:{ "note.txt":{ outcome:"available", patch:{ path:"note.txt", patch:"@@\n+note\n", truncated:false } } } } },
        environments:{ list:async () => [{ id:"env-1" }] } } },
    db, getThreadBounded:async () => ({ status:"idle" }), host:{ call:async () => ({}) },
    isDisposed:() => false, log:() => undefined,
  };
  const finish = createWriterFinish(ctx as never, {
    validateWriterResult:async () => ({ status:"accepted", output:"done", produced:["note.txt"], verification:[] }),
    persistWriterAcceptance:async () => ({ state:"passed" }),
    workspaceDirt:async () => ({ ok:true, snapshots:[{ path:"note.txt", sha256:sha256Hex("note") }] }),
    runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }),
  } as never);
  const run = () => finish.finishWriterAttempt({ projectId:"P", config, task:task("t1"), runId:"run", taskId:"t1",
    attemptId:"a-t1", pmThreadId:"pm", writerThreadId:"writer-t1", dirtBefore:[] });
  return { db, run };
}

describe("writer finish: the repeat skip", () => {
  it("writes a skipped code-critique receipt with a repeat: reason and accepts without a critic", async () => {
    const w = world();
    const result = await w.run();
    expect(result).toMatchObject({ state:"passed" });
    const receipt = listStageReceipts(w.db, "run", "t1").find((row) => row.stageId === "code-critique");
    expect(receipt).toMatchObject({ state:"skipped" });
    expect(receipt?.reason).toBe("repeat:t0");
  });
});
