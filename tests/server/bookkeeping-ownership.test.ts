import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, createTask, openDatabase, saveProjectSetting, setAttemptWorkspace } from "../../src/rooms/storage/database";
import { createWriterVerify } from "../../src/server/writer/verify";
import type { TaskV2 } from "../../src/contracts";

const contract = (id: string, owns: string[]): TaskV2 => ({
  schema_version: 2, id, title: id, risk: "medium", lane: "writer", project_cwd: "/w",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/a.ts"],
  owns_paths: owns, never_touch: [], depends_on: [], objective: "x", acceptance: ["x"], verify: "none", verification: [],
});

// Hooks and sibling agents write bookkeeping into the checkout while a writer works (≈60 owns_paths rejections in two
// weeks); only a file the contract does not own and that is not bookkeeping may fail the attempt.
async function validate(changed: string[], setting?: string[]) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "bb", "/w");
  const own = contract("t", ["src"]);
  createTask(db, { id: "t", runId: "run", kind: "bb", contract: own });
  createAttempt(db, { id: "a1", runId: "run", taskId: "t" });
  setAttemptWorkspace(db, "a1", { path: "/w", environmentId: null, decision: {} });
  if (setting) saveProjectSetting(db, "P", "bookkeeping.paths", setting);
  const ctx = {
    bb: { ...bb, sdk: { ...bb.sdk, threads: { output: async () => ({ output: "done" }) }, files: { read: async () => ({ content: "x" }) } } },
    db, host: { call: vi.fn() }, runPolicyFor: () => ({ pools: { verification: 1 } }),
  };
  const services = { workspaceDirt: async () => ({ ok: true, snapshots: changed.map((path) => ({ path, sha256: "h" })) }) };
  return createWriterVerify(ctx as never, services as never).validateWriterResult({
    config: { hostId: "h", projectId: "P" } as never, projectId: "P", runId: "run", taskId: "t", attempt: 1,
    task: own, writerThreadId: "thr", attemptId: "a1", dirtBefore: [],
  });
}

const bookkeeping = [
  ".agents/PROGRESS.md", ".agents/memory/episodes/2026-10-07/e1.json", ".agents/runs/lprun_1/receipt.json",
  ".agents/reports/r.md", ".bb/chats/thr_1/notes/a.md", "notes/lock/writer.lock",
];

it("never rejects bookkeeping files a hook wrote beside the writer's own change", async () => {
  const result = await validate(["src/a.ts", ...bookkeeping]);
  expect(result.reason ?? "").not.toMatch(/owns_paths/);
  expect(result.produced).toEqual(["src/a.ts"]);
});

it("still rejects a real file outside owns_paths, naming only it", async () => {
  const result = await validate(["src/a.ts", "lib/other.ts", ...bookkeeping]);
  expect(result).toMatchObject({ status: "validation_failed", reason: "writer changed paths outside owns_paths or inside never_touch: lib/other.ts" });
});

it("treats the paths of the project's bookkeeping.paths setting as bookkeeping too", async () => {
  const plain = await validate(["src/a.ts", "tmp/scratch/x.log"]);
  expect(plain).toMatchObject({ status: "validation_failed", reason: expect.stringContaining("tmp/scratch/x.log") });
  const extended = await validate(["src/a.ts", "tmp/scratch/x.log"], ["tmp/scratch/**"]);
  expect(extended.reason ?? "").not.toMatch(/owns_paths/);
});
