import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { sha256Hex } from "@lane-pilot/kit";
import { describe, expect, it } from "vitest";
import type { PrototypeConfig, TaskV2 } from "../src/rooms/contracts";
import { createAttempt, createRun, createTask, listStageReceipts, openDatabase, saveProjectSetting, saveTaskGitBase, setRunThread, transitionAttempt } from "../src/rooms/plugin-db";
import { createWriterFinish } from "../src/rooms/writer/server/finish";
import { stageHelperSettings } from "../src/rooms/settings/server/stage-settings";

// 0.1.571 live phase drill (ph_e7a06c6925): the plan made the writer commit its produced files, the attempt
// worktree went clean, workspaceDirt saw no rows and every produced hash stayed null — code critique skipped
// with missing_hash and the phase wave's independent_check never passed. Evidence now covers committed files:
// the hash falls back to the sha256 of the bytes files.read returned, and candidatePatches diffs the frozen
// task base instead of only the uncommitted target. Every other evidence failure stays fail-closed.
const APPROVE = JSON.stringify({ decision: "approve", summary: "fine", findings: [] });
const CRITIC_MODELS = ["claude-opus-5-5", "gpt-6.1-sol", "test-model"];
const EFFORTS = ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort }));
const BASE_SHA = "a".repeat(40);
const PRODUCED = "drills/out.md";
// Over MAX_FILE_EXCERPT_BYTES (8 KiB): a committed large file reaches the critic as its diff with empty content.
const CONTENT = `# drill\n${"committed body line\n".repeat(500)}TAIL-MARKER-committed-tail\n`;
const SMALL_CONTENT = "# drill\ncommitted body\n";
const PATCH = "@@ -1,2 +1,2 @@\n # drill\n-old committed line\n+committed body\n";
const PATCH_BIG = `@@ -1 +1 @@\n${"-old committed line\n+new committed line\n".repeat(400)}`;
const PATCH_NEW = "diff --git a/drills/out.md b/drills/out.md\nnew file mode 100644\n--- /dev/null\n+++ b/drills/out.md\n@@ -0,0 +1 @@\n+# drill\n";

const config: PrototypeConfig = {
  projectId:"P", hostId:"h", pmWorkspacePath:"/repo", writerWorkspacePath:"/repo",
  pmProviderId:"codex", pmModel:"codex-test", writerProviderId:"codex", writerModel:"codex-test",
};
const task = (): TaskV2 => ({
  schema_version:2, id:"t1", title:"Write", risk:"medium", lane:"writer", project_cwd:"/repo", read_first:[], interfaces:[], invariants:[],
  out_of_scope:[], expected_outputs:[PRODUCED], owns_paths:[PRODUCED], never_touch:[], depends_on:[],
  objective:"write", acceptance:["file exists"], verify:"none", verification:[],
});

function world(opts: {
  snapshots?: Array<{ path:string; sha256:string | null }>;
  dirtOk?: boolean;
  read?: (path:string) => Promise<{ content:string | null }>;
  gitBase?: boolean;
  patch?: string;
  content?: string;
}) {
  const { bb } = createFakePluginHost({ pluginId:"lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "cli", "/repo");
  setRunThread(db, "run", "pm");
  createTask(db, { id:"t1", runId:"run", kind:"bb", contract:task() });
  createAttempt(db, { id:"a-t1", runId:"run", taskId:"t1" });
  transitionAttempt(db, "a-t1", "spawn_requested");
  transitionAttempt(db, "a-t1", "running", { threadId:"writer-t1" });
  if (opts.gitBase !== false) {
    saveTaskGitBase(db, "t1", { baseRef:"main", baseSha:BASE_SHA, initialHeadSha:BASE_SHA, branch:"lp/t1", compareCommitted:true });
  }
  saveProjectSetting(db, "P", "code_critique.enabled", true);
  saveProjectSetting(db, "P", "code_critique.mode", "gate");
  const files = new Map<string, string>([[`/repo/${PRODUCED}`, opts.content ?? CONTENT]]);
  const spawns: Array<Record<string, unknown>> = [];
  const rpcTargets: unknown[] = [];
  const sdk = {
    threads:{
      stop:async () => undefined,
      events:{ list:async ({ threadId }: { threadId?: string }) => [
        { type:"turn/started", threadId, seq:1 },
        { type:"turn/completed", threadId, seq:2, data:{ status:"completed" } },
      ] },
      get:async ({ threadId }: { threadId?: string } = {}) => ({ id:threadId ?? "pm", projectId:"P", status:"idle" }),
      output:async () => ({ output:APPROVE }),
      spawn:async (input: Record<string, unknown>) => { spawns.push(input); return { id:`crit${spawns.length}` }; },
      send:async () => ({}),
    },
    files:{
      read:async ({ path }: { path:string }) => {
        if (opts.read) return opts.read(path);
        const content = files.get(path);
        return content === undefined ? { content:null } : { content };
      },
      write:async () => ({ outcome:"written" }),
    },
    plugins:{ callRpc:async ({ method, input }: { method:string; input?: { target?: unknown } }) => {
      rpcTargets.push(input?.target);
      return method === "files"
        ? { outcome:"available", files:[{ path:PRODUCED, revision:"r1" }], initialPatches:[{ path:PRODUCED, patch:opts.patch ?? PATCH, truncated:false }] }
        : { outcome:"available", patches:{} };
    } },
    environments:{ list:async () => [{ id:"env-1" }] },
    providers:{
      list:async () => ["claude-code", "codex"].map((id) => ({ id, available:true, capabilities:{ supportsServiceTier:false }, serviceTiers:[] })),
      models:async () => ({ models:CRITIC_MODELS.map((id) => ({ id, model:id, supportedReasoningEfforts:EFFORTS })) }),
    },
  };
  const ctx = {
    state:{ disposed:false },
    bb:{ storage:bb.storage, log:{ warn() {}, error() {}, info() {} }, sdk,
      hosts:{ experimental_client:async () => ({ call:async () => ({}) }) } },
    db, getThreadBounded:async () => ({ status:"idle" }), host:{ call:async () => ({}) },
    isDisposed:() => false, log:() => undefined,
  };
  const finish = createWriterFinish(ctx as never, {
    validateWriterResult:async () => ({ status:"accepted", output:"done", produced:[PRODUCED], verification:[] }),
    persistWriterAcceptance:async () => ({ state:"passed" }),
    workspaceDirt:async () => opts.dirtOk === false ? { ok:false, reason:"git status failed" } : { ok:true, snapshots:opts.snapshots ?? [] },
    stageHelperSettings,
    runBudgetFor:() => ({ snapshot:() => ({ limits:{} }) }),
  } as never);
  const run = () => finish.finishWriterAttempt({ projectId:"P", config, task:task(), runId:"run", taskId:"t1",
    attemptId:"a-t1", pmThreadId:"pm", writerThreadId:"writer-t1", dirtBefore:[] });
  return { db, run, spawns, rpcTargets };
}

const critiqueReceipt = (db: ReturnType<typeof openDatabase>) =>
  listStageReceipts(db, "run", "t1").find((row) => row.stageId === "code-critique");

describe("code critique evidence covers committed produced files", () => {
  it("a committed large modified file keeps its exact diff in the prompt — no baseline hash does not make it new", async () => {
    const w = world({ snapshots:[], gitBase:true });
    const result = await w.run();
    expect(result).toMatchObject({ state:"passed" });
    expect(critiqueReceipt(w.db)).toMatchObject({ state:"passed" });
    expect(w.spawns).toHaveLength(1);
    // The diff came from the frozen task base, not the uncommitted target and not a moved main.
    expect(w.rpcTargets).toContainEqual({ type:"all", mergeBaseBranch:BASE_SHA });
    const prompt = String(w.spawns[0]!.prompt);
    expect(prompt).toContain('status="changed"');
    expect(prompt).toContain("-old committed line");
    // Over the excerpt bound the file travels as its diff only: the body is not inlined.
    expect(prompt).not.toContain("TAIL-MARKER-committed-tail");
  });

  it("a committed change too big for the inline packet points the critic at the frozen base, not HEAD", async () => {
    const w = world({ snapshots:[], gitBase:true, patch:PATCH_BIG });
    const result = await w.run();
    expect(result).toMatchObject({ state:"passed" });
    expect(w.spawns).toHaveLength(1);
    const prompt = String(w.spawns[0]!.prompt);
    expect(prompt).toContain(`diff ${BASE_SHA} -- drills/out.md`);
    expect(prompt).not.toContain("diff HEAD");
  });

  it("a committed new file stays new: its content is shown once and no diff is invented", async () => {
    const w = world({ snapshots:[], gitBase:true, patch:PATCH_NEW, content:SMALL_CONTENT });
    const result = await w.run();
    expect(result).toMatchObject({ state:"passed" });
    expect(w.spawns).toHaveLength(1);
    const prompt = String(w.spawns[0]!.prompt);
    expect(prompt).toContain(`<file path="${PRODUCED}" status="new">`);
    expect(prompt).toContain("committed body");
    expect(prompt).not.toContain("<diff>");
  });

  it("without a recorded committed base the uncommitted target stays", async () => {
    const w = world({ snapshots:[{ path:PRODUCED, sha256:sha256Hex(CONTENT) }], gitBase:false });
    const result = await w.run();
    expect(result).toMatchObject({ state:"passed" });
    expect(w.rpcTargets).toContainEqual({ type:"uncommitted" });
    const types = w.rpcTargets.map((target) => (target as { type?:string } | undefined)?.type).filter(Boolean);
    expect(types.length).toBeGreaterThan(0);
    expect(types.every((type) => type === "uncommitted")).toBe(true);
  });

  it("a snapshot hash that disagrees with the read content stays unknown — the fallback never overwrites a snapshot row", async () => {
    const w = world({ snapshots:[{ path:PRODUCED, sha256:"0".repeat(64) }] });
    const result = await w.run();
    expect(result).toMatchObject({ state:"passed" });
    const receipt = critiqueReceipt(w.db);
    expect(receipt?.state).toBe("skipped");
    expect(receipt?.reason).toContain("code_critique_evidence_unknown");
    expect(w.spawns).toHaveLength(0);
  });

  it("a produced file that cannot be read stays a named hold — the content fallback cannot invent evidence", async () => {
    const w = world({ snapshots:[], read:async (path:string) => {
      if (path === `/repo/${PRODUCED}`) throw new Error("read outage");
      return { content:null };
    } });
    await w.run();
    const receipt = critiqueReceipt(w.db);
    expect(receipt?.state).toBe("blocked");
    expect(receipt?.reason).toContain("code_critique_evidence_unreadable");
    expect(w.spawns).toHaveLength(0);
  });

  it("a failed dirt snapshot keeps every produced hash unknown", async () => {
    const w = world({ dirtOk:false });
    const result = await w.run();
    expect(result).toMatchObject({ state:"passed" });
    const receipt = critiqueReceipt(w.db);
    expect(receipt?.state).toBe("skipped");
    expect(receipt?.reason).toContain("code_critique_evidence_unknown");
    expect(w.spawns).toHaveLength(0);
  });
});
