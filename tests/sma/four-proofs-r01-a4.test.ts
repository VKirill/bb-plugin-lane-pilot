// Region 1 (Task graph), batch a: the four proofs for the work coming back from the worker's copy (ae_bring_back, ag_host_commit),
// the answer record (ae_answered) and the cut for a correction (ag_redirect_restart). Real git repositories; the kv and the stop are fakes.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it, vi } from "vitest";
import { failureClass } from "../../src/rooms/contracts/failure-class";
import { getAttempt, createAttempt, createRun, createTask, openDatabase, transitionAttempt } from "../../src/rooms/plugin-db";
import { createWriterReassign, reassignedReason, takeReassignRequest } from "../../src/rooms/writer/server/reassign";
import { writerPatchFromOutput } from "../../src/rooms/writer/server/writer-task";
import { integrateWorktree } from "../../src/rooms/verification/git-integrate";
import { git, repo } from "../verification/git-integrate-helpers";
import { contract, observe } from "./r01-world-a";

vi.setConfig({ testTimeout: 120_000 });

describe("[sma:ae_bring_back] the work comes back from the worker's copy into main", () => {
  it("[sma:ae_bring_back] a worktree's change lands in main as one commit the result names, a second hand-in is up-to-date, and a clash leaves main as it was", async () => {
    const { base, worktree } = await repo();
    const a = await worktree("a"), b = await worktree("b");
    await writeFile(join(a, "lib.ts"), "export const x = 1;\n");
    await writeFile(join(b, "lib.ts"), "export const x = 2;\n");
    const merged = await integrateWorktree({ basePath: base, worktreePath: a, message: "task a" });
    expect(merged.status).toBe("merged");
    expect(merged.commit).toBe(git(base, "rev-parse", "HEAD").trim());
    expect(await readFile(join(base, "lib.ts"), "utf8")).toBe("export const x = 1;\n");
    expect((await integrateWorktree({ basePath: base, worktreePath: a, message: "task a" })).status).toBe("up-to-date");
    const clash = await integrateWorktree({ basePath: base, worktreePath: b, message: "task b" });
    expect(clash.status).toBe("conflict");
    expect(clash.commit).toBeNull();
    expect(git(base, "rev-parse", "HEAD").trim()).toBe(merged.commit);
    expect(git(base, "status", "--porcelain").trim()).toBe("");
    observe("n181", { firstStatus: merged.status, namesHead: merged.commit === git(base, "rev-parse", "HEAD").trim(), mainLib: await readFile(join(base, "lib.ts"), "utf8"), second: "up-to-date", clash: clash.status, clashCommit: clash.commit, mainClean: git(base, "status", "--porcelain").trim() });
  });
});

describe("[sma:ag_host_commit] the machine commits the worker's uncommitted edit", () => {
  it("[sma:ag_host_commit] an edit and a new file the writer left uncommitted are committed in its copy under the task's message before they merge; nothing is left uncommitted there", async () => {
    const { base, worktree } = await repo();
    const a = await worktree("a");
    await writeFile(join(a, "server.ts"), "line1 edited\nline2\nline3\n");
    await writeFile(join(a, "fresh.ts"), "export {};\n");
    expect(git(a, "status", "--porcelain").trim()).not.toBe("");
    const merged = await integrateWorktree({ basePath: base, worktreePath: a, message: "t1: the task title\n\nLane-Pilot-Attempt: a1" });
    expect(merged.status).toBe("merged");
    observe("n186", { status: merged.status, leftUncommitted: git(a, "status", "--porcelain").trim(), message: git(a, "log", "-1", "--format=%B").trim(), files: git(a, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort() });
    expect(git(a, "status", "--porcelain").trim()).toBe("");
    expect(git(a, "log", "-1", "--format=%B").trim()).toBe("t1: the task title\n\nLane-Pilot-Attempt: a1");
    expect(git(a, "show", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["fresh.ts", "server.ts"]);
    expect(await readFile(join(base, "fresh.ts"), "utf8")).toBe("export {};\n");
    expect(await readFile(join(base, "server.ts"), "utf8")).toBe("line1 edited\nline2\nline3\n");
  });
});

describe("[sma:ae_answered] an answer work hands in as a record without code", () => {
  it("[sma:ae_answered] a prose answer becomes a one-file patch holding every line of it, a real diff stays as the writer wrote it, an empty answer is no record", () => {
    expect(writerPatchFromOutput("It is the tax file.\nSee src/tax.ts.")).toBe("--- /dev/null\n+++ b/writer-output.txt\n@@ -0,0 +1,2 @@\n+It is the tax file.\n+See src/tax.ts.\n");
    const diff = "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-1\n+2";
    expect(writerPatchFromOutput(`  ${diff}\n`)).toBe(diff);
    expect(writerPatchFromOutput("--- a/x\n+++ b/x")).toBe("--- a/x\n+++ b/x");
    expect(writerPatchFromOutput("  \n ")).toBeNull();
  });
});

describe("[sma:ag_redirect_restart] the turn is cut so the person's word rides the next attempt", () => {
  function world() {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    createTask(db, { id: "t1", runId: "run1", kind: "bb", contract: contract("t1") });
    createAttempt(db, { id: "t1-a1", runId: "run1", taskId: "t1" });
    transitionAttempt(db, "t1-a1", "spawn_requested");
    transitionAttempt(db, "t1-a1", "running", { threadId: "thr_old" });
    const stops: string[] = [];
    const kvStore = new Map<string, unknown>();
    const kv = { get: async (key: string) => kvStore.get(key) ?? null, set: async (key: string, value: unknown) => { kvStore.set(key, value); } };
    const reassign = createWriterReassign({ bb: { storage: { kv }, sdk: { threads: { stop: async ({ threadId }: { threadId: string }) => { stops.push(threadId); } } } }, db } as never);
    return { db, harness, reassign, stops, kv };
  }

  it("[sma:ag_redirect_restart] a running writer is stopped for a redirect: its attempt goes cancel_requested with the reassign code, the request with the PM's words waits for the next writer, and the stop costs no attempt", async () => {
    const w = world();
    const done = await w.reassign.requestReassign({ projectId: "projA", runId: "run1", taskId: "t1", providerId: "codex", model: "codex-test", reason: "use the narrower reading" });
    expect(done).toMatchObject({ ok: true, oldThreadId: "thr_old", oldAttemptNo: 1, providerId: "codex", model: "codex-test" });
    expect(w.stops).toEqual(["thr_old"]);
    expect(w.db.prepare("SELECT state, cancel_code FROM lane_pilot_attempt WHERE id='t1-a1'").get()).toEqual({ state: "cancel_requested", cancel_code: "reassign" });
    expect(await takeReassignRequest(w.kv as never, "t1-a1")).toEqual({ reason: "use the narrower reading", selection: { providerId: "codex", model: "codex-test" } });
    expect(await takeReassignRequest(w.kv as never, "t1-a1")).toBeNull();
    expect(failureClass("canceled", reassignedReason("use the narrower reading"))).toBe("reassign");
    // A task with no running writer is refused and nothing is stopped.
    transitionAttempt(w.db, "t1-a1", "canceled", { reason: "x" });
    expect(await w.reassign.requestReassign({ projectId: "projA", runId: "run1", taskId: "t1" })).toMatchObject({ ok: false, error: "not_reassignable", state: "canceled" });
    expect(w.stops).toEqual(["thr_old"]);
    expect(getAttempt(w.db, "t1-a1")!.state).toBe("canceled");
    await w.harness.lifecycle.dispose();
  });
});
