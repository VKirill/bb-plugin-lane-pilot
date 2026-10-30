import { it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { migrations } from "../src/rooms/storage/database";
import { runDraftTest, testCasesOf } from "@lane-pilot/workflow-engine";
it("dump red", async () => {
  const { chainStore } = await import("./workflow/chain-harness");
  const shipped = await chainStore();
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = bb.storage.database();
  bb.storage.migrate(db, migrations);
  for (const item of shipped.list()) {
    if (item.workflow.internal) continue;
    for (const tc of testCasesOf(item.workflow)) {
      const r = await runDraftTest({ db, harnessVersion: "t", resolveWorkflow: shipped.resolve, timeoutMs: 8000 }, item.workflow, tc);
      if (!r.green) console.log("RED", item.workflow.id + "/" + (r as {caseId:string}).caseId, ((r as {failures:string[]}).failures??[]).join(" | ").slice(0, 160));
    }
  }
}, 120_000);
