import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, createTask, openDatabase, setAttemptWorkspace } from "../src/rooms/plugin-db";
import { snapshotDryRun } from "../src/rooms/host-worker/host-handlers";
import { writeTaskOutcome } from "../src/rooms/writer/server/attempt-reactions";

it("skips OUTCOME.md after the accepted fixture-readme worktree has been removed", async () => {
  // Hub incident 2026-11-14T05:21:55.571Z: this accepted attempt merged as c5c257231cb8908659df90bc7c153fc2e37ab08d.
  const attemptId = "lpattempt_2d1f2701b318442aa7c77f971099aa72";
  const runId = "lprun_d29e388c340d44b981fcd18233351e38";
  const taskId = "fixture-readme";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const root = await mkdtemp(join(tmpdir(), "outcome-removed-"));
  const workspace = join(root, attemptId);
  const folder = join(workspace, ".agents/plans/items", taskId);
  const writes: string[] = [];
  const logs: string[] = [];
  try {
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "PLAN.md"), "Create fixture/README.md for Lane Pilot guard checks.\n");
    createRun(db, runId, "p", "bb", workspace);
    createTask(db, { id: taskId, runId, kind: "bb", contract: {} });
    createAttempt(db, { id: attemptId, runId, taskId });
    setAttemptWorkspace(db, attemptId, { path: workspace, environmentId: null, decision: {} });
    // Successful merge removes the worktree before emitting the task-scope finished event.
    await rm(workspace, { recursive: true });
    const ctx = {
      db, log: (line: string) => logs.push(line),
      host: { call: async (method: string, input: unknown) => {
        expect(method).toBe("snapshotDryRun");
        return snapshotDryRun(input as never, {} as never);
      } },
      bb: { sdk: { files: {
        // Actual BB listHostPaths contract: a missing root returns a successful empty listing.
        listPaths: async () => ({ paths: [], truncated: false }),
        write: async ({ path, content }: { path: string; content: string }) => {
          writes.push(path);
          await writeFile(path, content);
        },
      } } },
    };
    await writeTaskOutcome(ctx as never, { scope: "task", status: "accepted", attemptId, runId, taskId, config: { hostId: "h" } } as never);
    expect(logs).toEqual([]);
    expect(writes).toEqual([]);
    expect(await readdir(root)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await harness.lifecycle.dispose();
  }
});
