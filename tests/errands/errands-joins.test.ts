import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../../src/rooms/plugin-db";
import { errandsDiagnosis } from "../../src/rooms/errands/server";

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
});
