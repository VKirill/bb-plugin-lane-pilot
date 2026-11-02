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

// 2026-11-02: a fix task that names the rows it fixes is not held by them; every other row still holds it.
it("a task naming rows in fixes_regressions is not held by those rows", () => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "office", "proj", "bb", "/p/plugins/office-viewer");
  for (const id of ["release-0.8.15", "fix-editor"])
    db.prepare("INSERT INTO lane_pilot_task(id,run_id,kind,contract_json,created_at) VALUES(?,?,'bb','{}',1)").run(id, "office");
  for (const command of ["check a", "check b"])
    db.prepare(`INSERT INTO lane_pilot_regression(found_at,updated_at,project_id,run_id,task_id,command,kind,state,bisect_status)
      VALUES(1,1,'proj','office','release-0.8.15',?,'regression','open','found')`).run(command);
  const files = () => ["editor.html"];
  const task = { projectId: "proj", runId: "office", taskId: "fix-editor", ownsPaths: ["editor.html"] };
  expect(quarantiningRegression(db, task, files)?.id).toBe(1);
  expect(quarantiningRegression(db, { ...task, fixesRegressions: [99] }, files)?.id).toBe(1);
  expect(quarantiningRegression(db, { ...task, fixesRegressions: [1] }, files)?.id).toBe(2);
  expect(quarantiningRegression(db, { ...task, fixesRegressions: [1, 2] }, files)).toBeUndefined();
});

it("the task-v2 contract takes optional fixes_regressions row ids", () => {
  // The worktree's own schema file (the workspace package resolves to the main checkout in tests).
  return import("../packages/contracts/src/schemas").then(({ taskV2Schema }) => {
    const base = { schema_version: 2, id: "t", title: "T", risk: "low", lane: "core", project_cwd: "/ws",
      read_first: [], interfaces: [], invariants: [], out_of_scope: [], expected_outputs: ["src/o.ts"], owns_paths: ["src/**"],
      never_touch: [], depends_on: [], objective: "o", acceptance: ["ok"], verify: "none", verification: [] };
    expect(taskV2Schema.safeParse({ ...base, fixes_regressions: [1, 2] }).success).toBe(true);
    expect(taskV2Schema.safeParse({ ...base, fixes_regressions: ["1"] }).success).toBe(false);
  });
});

it("knows a release check pinned on package.json's version in any spelling", () => {
  expect(pinsPackageVersion(`node -e "const p=require('./package.json');if(p.version!=='0.8.15')process.exit(1)" && grep -q '## 0.8.15' CHANGELOG.md`)).toBe(true);
  expect(pinsPackageVersion(`grep -q '"version": "0.8.6"' package.json`)).toBe(true);
  expect(pinsPackageVersion("npm test && cat package.json")).toBe(false);
});
