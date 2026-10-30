import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";
import { pinsPackageVersion } from "../src/rooms/baseline/server/regress";
import { createRun, openDatabase } from "../src/rooms/storage/database";
import { quarantiningRegression } from "../src/rooms/writer/server/start";

// BB-сервис, 2026-10-30: office-viewer's open release check (found 10-23) held every magicseo task touching package.json.
it("a found regression quarantines tasks of its own checkout only", () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "office", "proj", "bb", "/p/plugins/office-viewer");
  createRun(db, "magic", "proj", "bb", "/p/plugins/magicseo");
  for (const [id, run] of [["release-0.8.15", "office"], ["T3.3", "magic"], ["T3.4", "office"]] as const)
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,?,'bb','{}',1)").run(id, run);
  db.prepare(`INSERT INTO lane_pilot_regression(found_at,updated_at,project_id,run_id,task_id,command,kind,state,bisect_status)
    VALUES(1,1,'proj','office','release-0.8.15','npm test','regression','open','found')`).run();
  const files = () => ["package.json", "CHANGELOG.md"];
  expect(quarantiningRegression(db, { projectId:"proj", runId:"magic", taskId:"T3.3", ownsPaths:["package.json"] }, files)).toBeUndefined();
  expect(quarantiningRegression(db, { projectId:"proj", runId:"office", taskId:"T3.4", ownsPaths:["package.json"] }, files)?.taskId).toBe("release-0.8.15");
  expect(quarantiningRegression(db, { projectId:"proj", runId:"office", taskId:"T3.4", ownsPaths:["src/**"] }, files)).toBeUndefined();
});

it("knows a release check pinned on package.json's version in any spelling", () => {
  expect(pinsPackageVersion(`node -e "const p=require('./package.json');if(p.version!=='0.8.15')process.exit(1)" && grep -q '## 0.8.15' CHANGELOG.md`)).toBe(true);
  expect(pinsPackageVersion(`grep -q '"version": "0.8.6"' package.json`)).toBe(true);
  expect(pinsPackageVersion("npm test && cat package.json")).toBe(false);
});
