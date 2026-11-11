import { describe, expect, it, vi } from "vitest";
import { PROBES } from "../../src/rooms/native-agent/server/helper-probe";
import { probeSetupFailed } from "../../src/rooms/capability";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createClaudeGuardEnv } from "../../src/rooms/native-agent/claude-guard-launch";
import { resetPlanningHomeChecks } from "../../src/rooms/contracts";
import plugin from "../../server";
import { createRun, openDatabase, saveProjectSetting, savePrototypeConfig, setRunThread } from "../../src/rooms/plugin-db";
import { buildTaskBoard } from "../../src/rooms/runs/server/task-board";
import { proposeDraft } from "../../src/rooms/tasks/server";

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

describe("[review 2] lane_pilot_propose create:true", () => {
  it("refuses a draft of another chat and a draft proposed after the owner's last message, and creates one proposed before it", async () => {
    const projectId = "proj-c";
    const pmThreadId = "pm-c";
    let ownerAt = 1_000;
    const { bb, harness } = createFakePluginHost({
      pluginId: "lane-pilot",
      sdk: { threads: {
        getPluginMetadata: async ({ threadId }: { threadId: string }) => (threadId === pmThreadId ? { role: "pm", lanePilotRunId: "run-c" } : {}),
        get: async ({ threadId }: { threadId: string }) => ({ id: threadId, status: "idle", projectId }),
        list: async () => [] as never,
        events: { list: async () => [{ seq: 1, type: "client/turn/requested", createdAt: ownerAt, data: { initiator: "user" } }] },
      } },
    } as never);
    const db = openDatabase(bb);
    savePrototypeConfig(db, { projectId, hostId: "host-c", pmWorkspacePath: "/tmp/pm", writerWorkspacePath: "/tmp/w", pmProviderId: "claude-code", pmModel: "m", writerProviderId: "codex", writerModel: "c" });
    createRun(db, "run-c", projectId, "bb", null);
    setRunThread(db, "run-c", pmThreadId);
    await plugin(bb);
    const create = async (draftId: string) => JSON.parse(String(await harness.behavior.callAgentTool("lane_pilot_propose", { draftId, create: true } as never, { threadId: pmThreadId, projectId }))) as { error?: string | { message?: string }; state?: string };
    const text = (answer: { error?: string | { message?: string } }) => typeof answer.error === "string" ? answer.error : answer.error?.message ?? "";
    const foreign = proposeDraft(db, { runId: "run-c", projectId, threadId: "pm-other", contracts: [{ id: "x" }], at: 500 });
    expect(text(await create(foreign.id))).toContain("another chat");
    const sameTurn = proposeDraft(db, { runId: "run-c", projectId, threadId: pmThreadId, contracts: [{ id: "x" }], at: 2_000 });
    expect(text(await create(sameTurn.id))).toContain("«да»");
    expect(db.prepare("SELECT state FROM lane_pilot_task_draft WHERE id=?").get(sameTurn.id)).toEqual({ state: "proposed" });
    // The owner answers: a newer message, the same draft is now creatable (the dispatch itself may fail on this bare world; it is not refused as a same-turn create).
    ownerAt = 3_000;
    const after = await create(sameTurn.id);
    expect(text(after)).not.toContain("«да»");
    expect(text(after)).not.toContain("another chat");
    await harness.lifecycle.dispose();
  }, 30_000);
});

describe("[review 3] a malformed draft row does not take the board down", () => {
  it.each(["null", "{}", '"text"', "{broken"])("contracts_json %s reads as an empty list and the other cards stay", (broken) => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const good = proposeDraft(db, { runId: "run-g", projectId: "proj-g", threadId: "pm-g", kind: "batch", contracts: [{ id: "a" }, { id: "b" }] });
    const bad = proposeDraft(db, { runId: "run-g", projectId: "proj-g", threadId: "pm-g", kind: "batch", contracts: [{ id: "a" }] });
    db.prepare("UPDATE lane_pilot_task_draft SET contracts_json=?, results_json=? WHERE id=?").run(broken, broken, bad.id);
    const cards = buildTaskBoard(db, { projectId: "proj-g", doneSince: 0 }, []).filter((item) => item.kind === "batch");
    expect(cards.map((card) => card.techTitle).sort()).toEqual([good.id, bad.id].sort());
    expect(cards.find((card) => card.techTitle === bad.id)!.title).toBe("Пачка из 0 задач");
    db.close();
  });
});

describe("[review 7] the since window spares proposed and partial drafts", () => {
  it("an old proposed or partial draft stays on the board, an old created one drops out", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const old = Date.now() - 10 * 86_400_000;
    const ids = (["proposed", "partial", "created"] as const).map((state) => {
      const draft = proposeDraft(db, { runId: "run-w", projectId: "proj-w", threadId: "pm-w", kind: "batch", contracts: [{ id: "a" }, { id: "b" }], at: old });
      db.prepare("UPDATE lane_pilot_task_draft SET state=?, updated_at=? WHERE id=?").run(state, old, draft.id);
      return [state, draft.id] as const;
    });
    const states = buildTaskBoard(db, { projectId: "proj-w", doneSince: Date.now() - 86_400_000 }, []).filter((item) => item.kind === "batch").map((item) => item.state).sort();
    expect(states).toEqual(["partial", "proposed"]);
    expect(ids).toHaveLength(3);
    db.close();
  });
});

describe("[review 8] documentary.role: only a successful read of another role is a red cell", () => {
  const check = (PROBES["documentary.role"] as { check: (args: never) => Promise<{ ok: boolean; reason?: string }> }).check;
  const run = (threads: Record<string, unknown>) => check({ bb: { sdk: { threads } }, threadId: "thr", hostId: "h", workspace: "/w", output: "pm-reader" } as never);

  it("a successful read with another role is a real not_supported, not a setup failure", async () => {
    const wrong = await run({ getPluginMetadata: async () => ({ role: "writer" }) });
    expect(wrong.ok).toBe(false);
    expect(wrong.reason).toContain("writer");
    expect(probeSetupFailed(wrong.reason ?? null)).toBe(false);
    expect(await run({ getPluginMetadata: async () => ({ role: "pm-reader" }) })).toEqual({ ok: true });
  });

  it("a missing method, a throw, a timeout and an unreadable shape all end as a probe setup failure", async () => {
    const outcomes = [
      await run({}),
      await run({ getPluginMetadata: async () => { throw new Error("hub down"); } }),
      await run({ getPluginMetadata: () => { throw new Error("sync throw"); } }),
      await run({ getPluginMetadata: async () => null }),
      await run({ getPluginMetadata: async () => "text" }),
      await run({ getPluginMetadata: async () => ({}) }),
    ];
    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(probeSetupFailed(outcome.reason ?? null), outcome.reason).toBe(true);
    }
    vi.useFakeTimers();
    try {
      const pending = run({ getPluginMetadata: () => new Promise(() => undefined) });
      await vi.advanceTimersByTimeAsync(6_000);
      const timedOut = await pending;
      expect(timedOut.ok).toBe(false);
      expect(probeSetupFailed(timedOut.reason ?? null)).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});
