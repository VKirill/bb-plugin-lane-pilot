import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/plugin-db";
import { errandsDiagnosis } from "../../src/rooms/errands/diagnosis";
import { pendingEpisodes } from "../../src/rooms/errands/episode-enrich";
import { listEpisodes } from "../../src/rooms/errands/episodes";

const NOW = Date.now();
const DAY = 86_400_000;

function world() {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const run = (id: string, opts: { ago?: number; reason?: string | null; workflowId?: string } = {}) => {
    const at = NOW - (opts.ago ?? DAY);
    db.prepare(`INSERT INTO lane_pilot_wf_run (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, link_run_id, status, reason, inputs_json, output_json, tokens_used, cost_micro_usd, created_at, updated_at)
      VALUES (?, ?, 1, 'sha', '{}', 'proj_e', NULL, 'succeeded', ?, '{}', '{}', 0, 0, ?, ?)`)
      .run(id, opts.workflowId ?? "errand", opts.reason ?? "ok", at, at);
  };
  const episode = (runId: string, opts: { createdAgo?: number; updatedAgo?: number; enrichment?: string } = {}) => {
    const created = NOW - (opts.createdAgo ?? DAY);
    db.prepare(`INSERT INTO lane_pilot_errand_episode (run_id, extractor_version, project_id, workflow_id, status, outcome, enrichment_state, created_at, updated_at)
      VALUES (?, 1, 'proj_e', 'errand', 'succeeded', 'done', ?, ?, ?)`)
      .run(runId, opts.enrichment ?? "done", created, NOW - (opts.updatedAgo ?? DAY));
  };
  return { db, run, episode };
}

describe("errand episode joins keep the filter and the limit inside the owner query", () => {
  it("the diagnosis window applies to episode-linked runs too: a 40-day-old routed run is not in a 7-day diagnosis", () => {
    const { db, run, episode } = world();
    run("old", { ago: 40 * DAY }); episode("old");
    run("new", { ago: DAY }); episode("new");
    const d = errandsDiagnosis(db, { days: 7 });
    expect(d.runs).toBe(1);
  });

  it("an episode whose run is gone does not take a batch slot: the sweep still gets a full page of live episodes", () => {
    const { db, run, episode } = world();
    episode("ghost", { createdAgo: 11 * DAY }); // oldest, no wf_run row
    for (let i = 0; i < 10; i++) { run(`live${i}`); episode(`live${i}`, { enrichment: "pending" }); }
    const batch = pendingEpisodes(db, NOW, 10);
    expect(batch).toHaveLength(10);
    expect(batch.every((row) => row.reason === "ok")).toBe(true);
    expect(batch.some((row) => row.runId === "ghost")).toBe(false);
  });

  it("the episode list fills its page after the join: one orphan among the newest 501 still yields 500", () => {
    const { db, run, episode } = world();
    for (let i = 0; i < 500; i++) { run(`r${i}`); episode(`r${i}`, { updatedAgo: (500 - i) * 1000 }); }
    episode("orphan", { updatedAgo: 0 }); // newest of all, no wf_run row
    const rows = listEpisodes(db, { days: 30 });
    expect(rows).toHaveLength(500);
    expect(rows.some((row) => row.runId === "orphan")).toBe(false);
  });
});
