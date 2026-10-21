import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { migrations } from "../src/rooms/storage/database";

describe("the OpenCode v2 settings migration", () => {
  it("moves saved acp-opencode choices to opencode2 and leaves past results alone", () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = bb.storage.database();
    bb.storage.migrate(db, migrations.slice(0, -1));
    const insert = db.prepare("INSERT INTO lane_pilot_project_settings(project_id,binding_id,key,value,version,updated_at) VALUES (?,?,?,?,1,1)");
    insert.run("*", "", "writer.fallback1.provider", JSON.stringify("acp-opencode"));
    insert.run("*", "", "ops.provider_pool", JSON.stringify({ "acp-opencode": 2, codex: 1 }));
    insert.run("p1", "", "writer.lastResult", JSON.stringify({ providerId: "acp-opencode" }));
    insert.run("p1", "", "writer.provider", JSON.stringify("codex"));
    bb.storage.migrate(db, migrations);
    const value = (project: string, key: string) => db.prepare("SELECT value,version FROM lane_pilot_project_settings WHERE project_id=? AND key=?").get(project, key) as { value: string; version: number };
    expect(value("*", "writer.fallback1.provider")).toEqual({ value: JSON.stringify("opencode2"), version: 2 });
    expect(JSON.parse(value("*", "ops.provider_pool").value)).toEqual({ opencode2: 2, codex: 1 });
    expect(value("p1", "writer.lastResult")).toEqual({ value: JSON.stringify({ providerId: "acp-opencode" }), version: 1 });
    expect(value("p1", "writer.provider").version).toBe(1);
  });
});
