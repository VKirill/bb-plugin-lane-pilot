import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createClaudeGuardEnv } from "../../src/rooms/native-agent/claude-guard-launch";
import { resetPlanningHomeChecks } from "../../src/rooms/contracts";
import { createRun, openDatabase, saveProjectSetting, setRunThread } from "../../src/rooms/plugin-db";

describe("[review 1] the guard env cache never carries the planning home", () => {
  it("two projects on one checkout get their own home, and clearing the setting removes it at the next call", async () => {
    resetPlanningHomeChecks();
    const threads: Record<string, { role: string; lanePilotRunId: string }> = {
      "pm-a": { role: "pm", lanePilotRunId: "run-a" },
      "pm-b": { role: "pm", lanePilotRunId: "run-b" },
    };
    const { bb } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: {
        threads: {
          getPluginMetadata: async ({ threadId }: { threadId: string }) => threads[threadId] ?? {},
          get: async () => ({ environmentId: "env-1" }),
        },
        environments: { get: async () => ({ path: "/srv/shared-checkout" }) },
      },
    } as never);
    const db = openDatabase(bb);
    createRun(db, "run-a", "proj-a", "bb", null);
    createRun(db, "run-b", "proj-b", "bb", null);
    setRunThread(db, "run-a", "pm-a");
    setRunThread(db, "run-b", "pm-b");
    saveProjectSetting(db, "proj-a", "project.planning_home", "/plans/a");
    const nativeHost = { call: async (method: string) => (method === "prepareClaudeGuard"
      ? { env: [{ name: "BB_CLAUDE_CODE_EXECUTABLE", value: "/x/claude", reason: "r" }] }
      : { exitCode: 0, stdout: "", stderr: "" }) };
    const envOf = createClaudeGuardEnv({ bb, db, nativeHost } as never);
    const homeOf = (env: Array<{ name: string; value: string }>) => env.find((entry) => entry.name === "LANE_PILOT_PLANNING_HOME")?.value;
    expect(homeOf(await envOf({ threadId: "pm-a", hostId: "h" }))).toBe("/plans/a");
    // Same host, role and checkout path inside the 60 s cache: project B has no home.
    expect(homeOf(await envOf({ threadId: "pm-b", hostId: "h" }))).toBeUndefined();
    saveProjectSetting(db, "proj-b", "project.planning_home", "/plans/b");
    expect(homeOf(await envOf({ threadId: "pm-b", hostId: "h" }))).toBe("/plans/b");
    expect(homeOf(await envOf({ threadId: "pm-a", hostId: "h" }))).toBe("/plans/a");
    db.prepare("DELETE FROM lane_pilot_project_settings WHERE project_id=? AND key=?").run("proj-a", "project.planning_home");
    expect(homeOf(await envOf({ threadId: "pm-a", hostId: "h" }))).toBeUndefined();
    db.close();
  });
});
