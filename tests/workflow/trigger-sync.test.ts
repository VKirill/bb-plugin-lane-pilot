import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { globalWorkflowDir } from "@lane-pilot/workflow-engine";
import plugin from "../../server";
import { createRun, openDatabase, setRunThread } from "../../src/rooms/plugin-db";
import { createStatusResolver } from "../../src/rooms/storage";
import { definitionSha256, parseWorkflow } from "@lane-pilot/workflow-engine";

const PROJECT = "proj_sync";
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-trigger-sync-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv("HOME", tempDir());
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function scheduledDigest(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: "sync-digest",
    name: { en: "Sync digest", ru: "Сводка" },
    description: { en: "Scheduled digest", ru: "Сводка по расписанию" },
    status: "published",
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "result", type: "string" }],
    nodes: [{ id: "done", type: "action", action: "emit", map: { result: "$inputs.query" } }],
    edges: [{ from: "start", to: "done" }],
    triggers: [{ type: "schedule", cron: "0 9 * * *", timezone: "Europe/Moscow", projectId: PROJECT, inputs: { query: "news" } }],
    test: { id: "smoke", sim: { input: { query: "news" }, expect_path: ["done"], expect_output: { result: "news" } } },
    ...extra,
  };
}

async function waitFor(predicate: () => Promise<boolean> | boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error("timed out waiting for trigger sync");
}

function userSchedules(res: { schedules: Array<Record<string, unknown>> }) {
  return res.schedules.filter((row) => !String(row.createdBy ?? "").startsWith("system:"));
}

describe("workflow trigger sync to schedule board", () => {
  it("syncs published schedule triggers onto the schedule board on plugin ready without calling BB automations", async () => {
    const automationCalls: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        plugins: {
          list: async () => [],
          callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
            automationCalls.push(`${pluginId}.${method}`);
            return { id: "unexpected" };
          },
        },
      } as never,
    });
    harness.sdk.stub("hosts.list", async () => []);
    harness.sdk.stub("projects.list", async () => [{ id: PROJECT, name: "Sync Project" }]);

    const def = scheduledDigest();
    mkdirSync(globalWorkflowDir(), { recursive: true });
    writeFileSync(join(globalWorkflowDir(), "sync-digest.json"), JSON.stringify(def));

    await plugin(bb);
    const db = openDatabase(bb);
    createStatusResolver(db).recordTest("sync-digest", definitionSha256(parseWorkflow(def)), true, [{ caseId: "smoke", green: true, path: ["done"] }]);
    harness.runService("startup-recovery");
    try {
      await waitFor(async () => {
        const res = await harness.behavior.callRpc("schedule_list", { projectId: PROJECT }) as { schedules: Array<Record<string, unknown>> };
        return userSchedules(res).length > 0;
      });
      const list = await harness.behavior.callRpc("schedule_list", { projectId: PROJECT }) as { schedules: Array<Record<string, unknown>> };
      const synced = userSchedules(list);
      expect(synced).toHaveLength(1);
      expect(synced[0]).toMatchObject({
        projectId: PROJECT,
        name: "Lane Pilot: Sync digest",
        task: { kind: "workflow", workflowId: "sync-digest", inputs: { query: "news" } },
        when: { type: "cron", cron: "0 9 * * *", timezone: "Europe/Moscow" },
      });
      expect(automationCalls).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  }, 90_000);

  it("creates, updates, and removes schedule-board rows on draft publish and edit", async () => {
    const automationCalls: string[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        plugins: {
          list: async () => [],
          callRpc: async ({ pluginId, method }: { pluginId: string; method: string }) => {
            automationCalls.push(`${pluginId}.${method}`);
            return { id: "unexpected" };
          },
        },
      } as never,
    });
    harness.sdk.stub("hosts.list", async () => []);
    harness.sdk.stub("projects.list", async () => [{ id: PROJECT, name: "Sync Project" }]);
    harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_pm" ? { role: "pm" } : {}));

    await plugin(bb);
    harness.runService("startup-recovery");
    try {
      const db = openDatabase(bb);
      createRun(db, "lprun_sync", PROJECT, "cli");
      setRunThread(db, "lprun_sync", "thr_pm");

      // Write a workflow file, test & publish it via workflow_draft_* RPCs.
      const base = scheduledDigest({ id: "edited-digest", name: { en: "Edited digest", ru: "Ред. сводка" } });
      mkdirSync(globalWorkflowDir(), { recursive: true });
      writeFileSync(join(globalWorkflowDir(), "edited-digest.json"), JSON.stringify(base));

      const created = await harness.behavior.callRpc("workflow_draft_create", {
        projectId: PROJECT,
        workflowId: "edited-digest",
        mode: "edit",
      }) as { draftId: string };
      expect(created.draftId).toBeTruthy();

      const tested = await harness.behavior.callRpc("workflow_draft_test", { draftId: created.draftId }) as { green: boolean };
      expect(tested.green).toBe(true);

      const published = await harness.behavior.callRpc("workflow_draft_publish", { draftId: created.draftId }) as { published: boolean };
      expect(published.published).toBe(true);

      const afterPublish = await harness.behavior.callRpc("schedule_list", { projectId: PROJECT }) as { schedules: Array<Record<string, unknown>> };
      const publishedRows = userSchedules(afterPublish);
      expect(publishedRows).toHaveLength(1);
      const firstId = publishedRows[0]!.id;
      expect(publishedRows[0]).toMatchObject({
        name: "Lane Pilot: Edited digest",
        when: { type: "cron", cron: "0 9 * * *", timezone: "Europe/Moscow" },
      });

      // Edit the trigger cron and re-publish: updates the same schedule-board row in place.
      await harness.behavior.callRpc("workflow_draft_patch", {
        draftId: created.draftId,
        ops: [{ op: "set_meta", set: { triggers: [{ type: "schedule", cron: "30 11 * * *", timezone: "UTC", projectId: PROJECT, inputs: { query: "ai" } }] } }],
      });
      await harness.behavior.callRpc("workflow_draft_test", { draftId: created.draftId });
      await harness.behavior.callRpc("workflow_draft_publish", { draftId: created.draftId });

      const afterEdit = await harness.behavior.callRpc("schedule_list", { projectId: PROJECT }) as { schedules: Array<Record<string, unknown>> };
      const editedRows = userSchedules(afterEdit);
      expect(editedRows).toHaveLength(1);
      expect(editedRows[0]!.id).toBe(firstId);
      expect(editedRows[0]).toMatchObject({
        when: { type: "cron", cron: "30 11 * * *", timezone: "UTC" },
        task: { kind: "workflow", workflowId: "edited-digest", inputs: { query: "ai" } },
      });

      // Remove the schedule trigger and re-publish: removes the schedule-board row.
      await harness.behavior.callRpc("workflow_draft_patch", {
        draftId: created.draftId,
        ops: [{ op: "set_meta", set: { triggers: [{ type: "manual" }] } }],
      });
      await harness.behavior.callRpc("workflow_draft_test", { draftId: created.draftId });
      await harness.behavior.callRpc("workflow_draft_publish", { draftId: created.draftId });

      const afterRemove = await harness.behavior.callRpc("schedule_list", { projectId: PROJECT }) as { schedules: Array<Record<string, unknown>> };
      expect(userSchedules(afterRemove)).toEqual([]);
      expect(automationCalls).toEqual([]);
    } finally {
      await harness.lifecycle.dispose();
    }
  }, 90_000);
});
