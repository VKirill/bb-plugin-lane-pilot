import { expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createAttempt, createRun, createTask, openDatabase, setAttemptWorkspace } from "../../src/rooms/storage/database";
import { createWriterVerify } from "../../src/rooms/writer/server/verify";
import { classifyWriterOutput } from "../../src/rooms/tasks/validate-output";
import type { TaskV2 } from "../../src/rooms/contracts";

const contract = (id: string, owns: string[]): TaskV2 => ({
  schema_version: 2, id, title: id, risk: "medium", lane: "writer", project_cwd: "/w",
  read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["apps/api/checkout/routes.ts"],
  owns_paths: owns, never_touch: ["docs"], depends_on: [], objective: "x", acceptance: ["x"], verify: "none", verification: [],
});

// Live SelfyStudio cards-checkout-cabinet-chips.2 (2026-10-05): the first attempt changed a file no task owned and a file
// a sibling owned; the reason named only the first, the retry restored it, and the second used up the last attempt.
async function validate(changed: string[]) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "run", "P", "bb", "/w");
  const own = contract("chips", ["apps/api/checkout", "apps/marketing/composables"]);
  createTask(db, { id: "chips", runId: "run", kind: "bb", contract: own });
  createTask(db, { id: "retention", runId: "run", kind: "bb", contract: contract("retention", ["apps/api/webhooks"]) });
  for (const [id, task] of [["a1", "chips"], ["a2", "retention"]] as const) {
    createAttempt(db, { id, runId: "run", taskId: task });
    setAttemptWorkspace(db, id, { path: "/w", environmentId: null, decision: {} });
  }
  const ctx = {
    bb: { ...bb, sdk: { ...bb.sdk, threads: { output: async () => ({ output: "done" }) }, files: { read: async () => ({ content: "x" }) } } },
    db, host: { call: vi.fn() }, runPolicyFor: () => ({ pools: { verification: 1 } }),
  };
  const services = { workspaceDirt: async () => ({ ok: true, snapshots: changed.map((path) => ({ path, sha256: "h" })) }) };
  const verify = createWriterVerify(ctx as never, services as never);
  return verify.validateWriterResult({
    config: { hostId: "h", projectId: "P" } as never, projectId: "P", runId: "run", taskId: "chips", attempt: 1,
    task: own, writerThreadId: "thr", attemptId: "a1", dirtBefore: [],
  });
}

it("names a sibling's file together with the file no task owns", async () => {
  const result = await validate(["apps/api/checkout/routes.ts", "apps/api/__tests__/card-checkout.test.ts", "apps/api/webhooks/__tests__/fulfill.test.ts"]);
  expect(result).toMatchObject({ status: "validation_failed",
    reason: "writer changed paths outside owns_paths or inside never_touch: apps/api/__tests__/card-checkout.test.ts, apps/api/webhooks/__tests__/fulfill.test.ts" });
});

it("names every sibling-owned file the writer changed, not only the first", async () => {
  const result = await validate(["apps/api/checkout/routes.ts", "apps/api/webhooks/a.test.ts", "apps/api/webhooks/b.ts"]);
  expect(result).toMatchObject({ status: "validation_failed", reason: "owns_paths rejected apps/api/webhooks/a.test.ts, apps/api/webhooks/b.ts" });
});

it("reports never_touch and owns_paths strays in one reason", () => {
  expect(classifyWriterOutput({ task: contract("t", ["src"]), produced: ["docs/a.md", "lib/b.ts", "lib/c.ts", "src/ok.ts"], contents: {} }))
    .toEqual({ ok: false, state: "validation_failed", reason: "never_touch matched docs/a.md; owns_paths rejected lib/b.ts, lib/c.ts" });
});
