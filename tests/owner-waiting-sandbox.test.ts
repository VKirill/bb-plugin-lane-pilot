import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { openDatabase } from "../src/rooms/storage/database";
import { collectOwnerWaiting, postOwnerItem, setSandboxProjects } from "../src/rooms/owner-waiting";

// Live 2026-10-27: the drill's sandbox posted «Drill route … loop ran out of tries» and a drill writer's colour question to the owner, with a push.
describe("the owner's list and the drill's sandbox", () => {
  it("takes no item of a sandbox project, and shows no sandbox row written before, while a real project's item comes through", () => {
    const db = openDatabase(createFakePluginHost({ pluginId: "lane-pilot" }).bb);
    setSandboxProjects(["proj_sandbox_nogit"]);
    expect(postOwnerItem(db, { key: "drill:1", source: "writer", kind: "product_decision", projectId: "proj_sandbox_nogit", what: "which colour?", why: "drill" })).toEqual({ created: false });
    expect(postOwnerItem(db, { key: "drill:2", source: "wall", kind: "loop_exhausted", projectId: "proj_3tb652jpsi", what: "Drill route", why: "drill" })).toEqual({ created: false });
    db.prepare("INSERT INTO lane_pilot_owner_item(key,source,kind,project_id,what,why,evidence_json,actions_json,wake,state,created_at) VALUES('old','wall','loop','proj_3tb652jpsi','old drill row','x','[]','[]',1,'open',1)").run();
    expect(postOwnerItem(db, { key: "real:1", source: "writer", kind: "product_decision", projectId: "proj_real", what: "real question", why: "the owner decides" })).toEqual({ created: true });
    const keys = collectOwnerWaiting(db).items.map((item) => item.key);
    expect(keys).toContain("real:1");
    expect(keys).not.toContain("old");
    expect(keys.some((key) => key.startsWith("drill:"))).toBe(false);
  });
});
