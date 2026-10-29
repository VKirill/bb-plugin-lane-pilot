import { expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { breakerKey, createProviderBreaker, createRunBudget, runningWriterBudgetStop } from "@lane-pilot/resilience";
import { createWriterSpawn } from "../src/rooms/writer/server/spawn";
import { createAttempt, createRun, createTask, openDatabase, setRunThread } from "../src/rooms/storage/database";

it("A-034 owner presence refusal releases an unused half-open provider trial", async () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const task = { schema_version: 2, id: "t1", title: "Write", risk: "low", lane: "writer", project_cwd: "/repo", read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["note.txt"], owns_paths: ["note.txt"], never_touch: [], depends_on: [], objective: "write", acceptance: ["file exists"], verify: "none", verification: [] };
  createRun(db, "run", "P", "cli", "/repo");
  setRunThread(db, "run", "pm");
  createTask(db, { id: "t1", runId: "run", kind: "bb", contract: task as never });
  createAttempt(db, { id: "a1", runId: "run", taskId: "t1" });
  const key = breakerKey("codex", "fixture");
  const breaker = createProviderBreaker({ failureThreshold: 1, cooldownMs: 10 });
  breaker.record(key, "failure", Date.now() - 1000);
  const ctx = {
    bb: { storage: bb.storage, log: { info() {}, warn() {} }, sdk: { projects: { get: async () => ({ sources: [] }) }, files: { read: async () => ({ content: null }) }, threads: { get: async () => ({ id: "pm", projectId: "P", status: "idle" }) } } },
    db,
    host: { call: async (method: string) => method === "runCommand" ? { hostId: "h", exitCode: 0, stdout: "[]", stderr: "" } : {} },
    effectiveProjectSettings: async () => ({ values: { "jev.LANE_JEV_EFFORT": false, "memory.enabled": false, "adoc.040": "auto" } }),
  };
  const writer = createWriterSpawn(ctx as never, { providerBreaker: breaker, ownerPresence: { holds: () => "owner_present:fixture" }, ruleScan: { chainForRun: async () => [] } } as never);
  try {
    const result = await writer.spawnWriterAttempt({ projectId: "P", runId: "run", taskId: "t1", attemptId: "a1", config: { projectId: "P", hostId: "h", pmWorkspacePath: "/repo", writerWorkspacePath: "/repo", pmProviderId: "codex", pmModel: "fixture", writerProviderId: "codex", writerModel: "fixture" }, task: task as never, plan: "fixture", pmThreadId: "pm" });
    expect(result).toMatchObject({ ok: false, reason: "writer_provider_unavailable:owner_present:fixture" });
    const next = breaker.decide(key, Date.now() + 86400_000);
    expect(next, JSON.stringify(next)).toMatchObject({ allow: true });
  } finally { db.close(); }
});

it("A-035 an attempt overrun must not mask an exhausted wall/token limit of a running writer", () => {
  const b = createRunBudget({ maxAttempts: 1, maxWallMs: 100, maxTokens: 100 }, 0);
  b.noteAttempt();
  b.noteAttempt();
  b.noteTokens("writer", 101);
  const check = b.check(101);
  expect(check).toMatchObject({ ok: false, exceeded: "maxAttempts" });
  expect(!check.ok && check.exhausted).toEqual(["maxAttempts", "maxWallMs", "maxTokens"]);
  expect(runningWriterBudgetStop(check)).not.toBeNull();
});
