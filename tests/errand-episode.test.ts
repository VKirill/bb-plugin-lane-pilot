import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { openDatabase, saveProjectSetting, type LanePilotDatabase } from "../src/rooms/plugin-db";
import { ERRAND_EPISODE_EXTRACTOR_VERSION, listEpisodes, pendingErrandEpisode, recordErrandEpisode } from "../src/rooms/errands";

/**
 * Errand episodes, phase A (R3): the facts written by code when an errand run ends. The recorder, the pending row of a
 * routed run, the privacy-safe tool trace and the episodes.collect switch are the real ones; the journal rows are
 * inserted directly — the workflow engine's own tests cover the run lifecycle.
 */
const PROJECT = "proj-1";

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  return { db: openDatabase(bb) };
}

function addRun(db: LanePilotDatabase, input: { id: string; workflowId?: string; status?: string; projectId?: string | null; inputs?: Record<string, unknown>; output?: unknown; reason?: string | null }) {
  const now = Date.now();
  db.prepare(`INSERT INTO lane_pilot_wf_run
    (id, idem_key, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, status, reason, inputs_json, output_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(input.id, `key-${input.id}`, input.workflowId ?? "errand", 1, "sha", "{}", input.projectId === undefined ? PROJECT : input.projectId,
      input.status ?? "succeeded", input.reason ?? null, JSON.stringify(input.inputs ?? {}),
      input.output === undefined ? null : JSON.stringify(input.output), now, now);
}

function addSpawn(db: LanePilotDatabase, runId: string, threadId: string) {
  const now = Date.now();
  db.prepare(`INSERT INTO lane_pilot_wf_effect (id, run_id, step_key, effect_key, kind, state, result_json, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(`eff-${runId}`, runId, "work", "spawn", "errand.spawn", "done", JSON.stringify({ threadId }), now, now);
}

const episodes = (db: LanePilotDatabase) =>
  db.prepare("SELECT * FROM lane_pilot_errand_episode ORDER BY run_id").all() as Array<Record<string, unknown>>;

const twoToolCalls = [
  { type: "item/completed", seq: 1, data: { item: { type: "toolCall", server: "bb", tool: "browser", arguments: { url: "https://SECRET-ARG-TEXT.example" }, status: "completed" } } },
  { type: "item/completed", seq: 2, data: { item: { type: "commandExecution", command: "ls -la /secret/path", exitCode: 0, status: "completed" } } },
];

describe("errand episodes", () => {
  it("a succeeded errand run with a thread and two tool calls writes one row whose trace has two entries and no argument text", async () => {
    const { db } = world();
    addRun(db, {
      id: "wfrun-1",
      inputs: { task: "Check the CRM.", skills: ["browser-qa"], model: "claude-opus-4-5", providerId: "claude-code" },
      output: { state: "done", verified: "done_checked", checks: [{ claim: "leads counted", evidence: "page" }] },
    });
    addSpawn(db, "wfrun-1", "thr-1");
    db.prepare("UPDATE lane_pilot_wf_run SET tokens_used=1200, cost_micro_usd=3400 WHERE id='wfrun-1'").run();

    const warns: string[] = [];
    await recordErrandEpisode({ db, runId: "wfrun-1", readEvents: async () => twoToolCalls, warn: (m) => warns.push(m) });
    await recordErrandEpisode({ db, runId: "wfrun-1", readEvents: async () => twoToolCalls, warn: (m) => warns.push(m) });

    expect(warns).toEqual([]);
    const rows = episodes(db);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      run_id: "wfrun-1", extractor_version: ERRAND_EPISODE_EXTRACTOR_VERSION, project_id: PROJECT, workflow_id: "errand",
      status: "succeeded", outcome: "done", verified: JSON.stringify("done_checked"), thread_id: "thr-1",
      model: "claude-opus-4-5", provider_id: "claude-code", skills_offered_json: JSON.stringify(["browser-qa"]),
      enrichment_state: "pending",
    });
    expect(JSON.parse(String(row.checks_json))).toEqual([{ claim: "leads counted", evidence: "page" }]);
    const trace = JSON.parse(String(row.trace_json)) as Array<{ tool: string; argsSha256: string; ok: boolean }>;
    expect(trace).toHaveLength(2);
    expect(trace.map((entry) => entry.tool)).toEqual(["bb/browser", "ls"]);
    expect(trace.every((entry) => /^[0-9a-f]{64}$/.test(entry.argsSha256) && typeof entry.ok === "boolean")).toBe(true);
    expect(JSON.parse(String(row.trace_stats_json))).toMatchObject({ actions: 2 });
    // Privacy: neither the arguments nor the command text land anywhere in the row.
    expect(JSON.stringify(row)).not.toContain("SECRET-ARG-TEXT");
    expect(JSON.stringify(row)).not.toContain("/secret/path");

    const listed = listEpisodes(db, { days: 1 });
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ runId: "wfrun-1", outcome: "done", threadId: "thr-1", tokens: 1200, costUsd: 0.0034, waitMs: 0 });
    expect(listEpisodes(db, { days: 1, projectId: "other" })).toEqual([]);
  });

  it("a failed run records outcome failed, a canceled run canceled, and an old run without verified keeps verified null", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-f", status: "failed", reason: "helper died", output: { state: "failed", reason: "helper died" } });
    addRun(db, { id: "wfrun-c", status: "canceled", reason: "owner stopped" });
    addRun(db, { id: "wfrun-old", status: "succeeded", output: { state: "done" } });

    for (const runId of ["wfrun-f", "wfrun-c", "wfrun-old"]) {
      await recordErrandEpisode({ db, runId });
    }
    const byId = Object.fromEntries(episodes(db).map((row) => [row.run_id, row]));
    expect(byId["wfrun-f"]).toMatchObject({ outcome: "failed", status: "failed" });
    expect(byId["wfrun-c"]).toMatchObject({ outcome: "canceled", status: "canceled" });
    expect(byId["wfrun-old"]).toMatchObject({ outcome: "done", status: "succeeded", verified: null, trace_json: null, trace_stats_json: null });
  });

  it("a routed run gets a pending row at start and the completion fills it under the same key", async () => {
    const { db } = world();
    pendingErrandEpisode(db, { runId: "wfrun-r", projectId: PROJECT, workflowId: "api-recon" });
    expect(episodes(db)).toEqual([expect.objectContaining({ run_id: "wfrun-r", workflow_id: "api-recon", status: "running", outcome: "running", enrichment_state: "pending" })]);

    addRun(db, { id: "wfrun-r", workflowId: "api-recon", inputs: { url: "https://example.com" }, output: { state: "done", verified: "done_unchecked" } });
    await recordErrandEpisode({ db, runId: "wfrun-r" });
    const rows = episodes(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workflow_id: "api-recon", status: "succeeded", outcome: "done", verified: JSON.stringify("done_unchecked") });
  });

  it("a non-errand run without a pending row records nothing", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-x", workflowId: "api-recon", status: "succeeded", output: { state: "done" } });
    await recordErrandEpisode({ db, runId: "wfrun-x" });
    expect(episodes(db)).toEqual([]);
  });

  it("a failing event reader logs one warn line and leaves the run untouched", async () => {
    const { db } = world();
    addRun(db, { id: "wfrun-e", output: { state: "done" } });
    addSpawn(db, "wfrun-e", "thr-9");
    const warns: string[] = [];
    await recordErrandEpisode({ db, runId: "wfrun-e", readEvents: async () => { throw new Error("sdk down"); }, warn: (m) => warns.push(m) });
    expect(warns).toEqual([expect.stringMatching(/^errand_episode_failed:wfrun-e:sdk down$/)]);
    expect(episodes(db)).toEqual([]);
    expect(db.prepare("SELECT status FROM lane_pilot_wf_run WHERE id='wfrun-e'").get()).toEqual({ status: "succeeded" });
  });

  it("episodes.collect = off writes no row, pending or recorded", async () => {
    const { db } = world();
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "episodes.collect", false);
    pendingErrandEpisode(db, { runId: "wfrun-off", projectId: PROJECT, workflowId: "api-recon" });
    addRun(db, { id: "wfrun-off", output: { state: "done" } });
    await recordErrandEpisode({ db, runId: "wfrun-off" });
    expect(episodes(db)).toEqual([]);
  });
});
