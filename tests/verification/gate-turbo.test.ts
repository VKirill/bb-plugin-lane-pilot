import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { detectGateCommand } from "../../src/rooms/verification/server/gate-detect";
import { IntegrationGateRunner } from "../../src/rooms/verification/server/integration-gate";
import { openDatabase, saveProjectSetting } from "../../src/rooms/storage/database";
import * as hostHandlers from "../../src/rooms/host-worker/host-handlers";
import type { ServerCore } from "../../src/rooms/core/server/core";
import type { Services } from "../../src/rooms/core/server/services";

/**
 * Live 2026-10-09 (SelfyStudio): the gate `npm test` (`turbo run test --concurrency=4`) took the marketing results from turbo's
 * cache; 14 failures surfaced only later. A detected turbo gate now runs with --force; an owner's explicit command is left alone.
 */
const pkg = (body: Record<string, unknown>) => `@@package.json\n${JSON.stringify(body, null, 2)}\n`;

describe("a detected gate that calls turbo bypasses turbo's cache", () => {
  it("npm test -- --force when the test script is one turbo command", () => {
    expect(detectGateCommand(pkg({ scripts: { test: "turbo run test --concurrency=4" } }))).toMatchObject({ command: "npm test -- --force", detail: expect.stringContaining("turbo") });
    expect(detectGateCommand(pkg({ scripts: { test: "turbo test" } }))?.command).toBe("npm test -- --force");
    expect(detectGateCommand(pkg({ scripts: { test: "npx turbo run test --filter=@a/b" } }))?.command).toBe("npm test -- --force");
  });

  it("TURBO_FORCE=true when turbo is one step of a longer script, so --force cannot reach the wrong program", () => {
    expect(detectGateCommand(pkg({ scripts: { test: "turbo run test && node scripts/after.js" } }))?.command).toBe("TURBO_FORCE=true npm test");
  });

  it("is left alone when the script already forces, and for a script without turbo", () => {
    expect(detectGateCommand(pkg({ scripts: { test: "turbo run test --force" } }))?.command).toBe("npm test");
    expect(detectGateCommand(pkg({ scripts: { test: "vitest run" } }))?.command).toBe("npm test");
  });
});

describe("the gate report names the workspaces turbo answered from its cache", () => {
  let dir: string;
  let sent: Array<{ threadId: string; text: string }>;
  let core: ServerCore;
  let db: ReturnType<typeof openDatabase>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lp-gate-turbo-"));
    // An explicit command (the owner's): it prints what turbo prints.
    writeFileSync(join(dir, "gate.js"), [
      "console.log('@acme/marketing:test: cache hit, replaying logs 69a7bad3c312d12e');",
      "console.log('@acme/api:test: cache miss, executing 010fc5c70c1ce43f');",
      "console.log('@acme/api:test:  FAIL  src/a.test.ts > case');",
      "console.log('Cached:    1 cached, 2 total');",
      "process.exit(1);",
    ].join("\n"));
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    db = openDatabase(bb);
    db.prepare(`INSERT INTO lane_pilot_run (id, project_id, pm_thread_id, state, created_at, updated_at) VALUES ('run-1', 'proj-1', 'pm-1', 'running', 0, 0)`).run();
    saveProjectSetting(db, "proj-1", "integration.gate_command", "node gate.js");
    sent = [];
    core = {
      db,
      bb: { sdk: { threads: { send: async (input: { threadId: string; input: Array<{ text: string }> }) => { sent.push({ threadId: input.threadId, text: input.input[0]?.text ?? "" }); } }, files: { write: async () => ({ ok: true }) } }, storage: { kv: { get: async () => null, set: async () => null } } },
      log: () => {},
      host: { call: async (method: string, input: unknown) => (hostHandlers as unknown as Record<string, (input: unknown) => Promise<unknown>>)[method]!(input) },
    } as unknown as ServerCore;
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("puts the cache hits in the PM's message, and keeps the explicit command as typed", async () => {
    db.prepare(`INSERT INTO lane_pilot_task (id, run_id, kind, contract_json, created_at) VALUES ('t2', 'run-1', 'bb', '{}', 0)`).run();
    const runner = new IntegrationGateRunner(core, {} as Services);
    runner.noteMergedTask({ taskId: "t1", commitSha: "sha-1", threadId: "thr-t1", attemptId: "att-1", produced: ["src/one.ts"] });
    runner.noteMergedTask({ taskId: "t2", commitSha: "sha-2", threadId: "thr-t2", attemptId: "att-2", produced: ["src/two.ts"] });

    await runner.maybeRunGate({ runId: "run-1", projectId: "proj-1", pmThreadId: "pm-1", basePath: dir, configHostId: "host-1", trigger: "drain" });

    const pm = sent.find((m) => m.threadId === "pm-1")!.text;
    expect(pm).toContain("`node gate.js`");
    expect(pm).not.toContain("--force");
    expect(pm).toContain("Cache hits");
    expect(pm).toContain("@acme/marketing#test");
    expect(pm).not.toContain("@acme/api#test");
  });
});
