import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { migrations } from "../../src/database";
import type { ServerCore } from "../../src/server/core";
import type { Services } from "../../src/server/services";
import { createWorkflowLibrary } from "../../src/server/workflow-library";
import { PIPELINE_RUNS_ATTRIBUTION } from "../../src/workflow/ops-store";
import { runRecords } from "../../src/workflow/run-stats";
import { wf } from "./engine-helpers";

/** Stats per real workflow: the 24 runs of the old per-task pipeline were counted under the chain that took its id. */
const insert = (db: ReturnType<ReturnType<typeof createFakePluginHost>["bb"]["storage"]["database"]>, id: string, workflowId: string, status: string, key: string | null, attempt: string | null, parent: string | null = null, at = 100) =>
  db.prepare("INSERT INTO lane_pilot_wf_run(id,idem_key,workflow_id,workflow_version,workflow_sha256,definition_json,link_attempt_id,parent_run_id,parent_step_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, key, workflowId, 1, "x", JSON.stringify(wf()), attempt, parent, parent ? `s_${id}` : null, status, at, at);

describe("runs of the old per-task pipeline", () => {
  it("move to lp-task-pipeline when the plugin is updated, and the chain that took the id starts with a clean record", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    expect(migrations.at(-1)).toBe(PIPELINE_RUNS_ATTRIBUTION);
    // The database as 0.1.188 left it: the pipeline's runs under the old id next to a real run of the chain.
    bb.storage.migrate(db, migrations.slice(0, -1));
    for (let n = 1; n <= 24; n += 1) insert(db, `old${n}`, "analyze-plan-execute", n % 6 === 0 ? "failed" : "succeeded", `lp-task:att_${n}`, `att_${n}`);
    insert(db, "keyless", "analyze-plan-execute", "succeeded", null, "att_keyless");
    insert(db, "chain", "analyze-plan-execute", "succeeded", "wf:lprun_1:analyze-plan-execute:abc", null, null, 200);
    insert(db, "child", "analyze-plan-execute", "succeeded", null, null, "chain", 210);
    insert(db, "other", "review-fix", "succeeded", "wf:lprun_1:review-fix:abc", null, null, 220);

    const stats = (id: string) => {
      const library = createWorkflowLibrary({ db, log: () => undefined } as unknown as ServerCore, { workflowEngine: {}, docsPlaces: async () => [] } as unknown as Services);
      return library.list({}).then((listing) => listing.workflows.find((row) => row.id === id)!.stats);
    };
    expect(await stats("analyze-plan-execute")).toMatchObject({ runs: 27 });

    bb.storage.migrate(db, migrations);
    expect(await stats("analyze-plan-execute")).toMatchObject({ runs: 2, succeeded: 2, failed: 0, lastRunAt: 210 });
    expect(await stats("lp-task-pipeline")).toMatchObject({ runs: 25, succeeded: 21, failed: 4 });
    expect(await stats("review-fix")).toMatchObject({ runs: 1 });
    // The router's record reads the same attribution.
    expect(runRecords(db).get("analyze-plan-execute")).toEqual({ succeeded: 1, failed: 0, lastRunAt: 200 });
    expect(runRecords(db).get("lp-task-pipeline")).toMatchObject({ succeeded: 21, failed: 4 });
    // Running the update again moves nothing more.
    db.prepare(PIPELINE_RUNS_ATTRIBUTION).run();
    expect(runRecords(db).get("lp-task-pipeline")).toMatchObject({ succeeded: 21, failed: 4 });
  });
});
