import { afterEach, describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { recordEmployeeLesson } from "../src/rooms/critique/server";
import { openDatabase } from "../src/rooms/storage/database";
import { withRoleLines } from "../src/rooms/native-agent";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function host(sdk: Record<string, unknown> = {}) {
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot", sdk: sdk as never });
  await plugin(bb);
  cleanup.push(() => harness.lifecycle.dispose());
  const rpc = <T,>(name: string, input: Record<string, unknown> = {}) => harness.behavior.callRpc(name as never, input as never) as Promise<T>;
  return { bb, rpc };
}

describe("withRoleLines", () => {
  it("appends the dated-lines block to the role prompt", () => {
    const compiled = { description: "3D artist", prompt: "You model game assets.", tools: ["Bash"], skills: ["blender-director"] };
    const next = withRoleLines(compiled as never, ["2026-10-30: triangulate on export"]);
    expect(next.prompt).toContain("Lines added to your role");
    expect(next.prompt).toContain("triangulate on export");
    expect(withRoleLines(compiled as never, [])).toEqual(compiled);
  });
});

describe("a lesson lands in a directly called employee chat", () => {
  it("recordEmployeeLesson -> prepare_native_session -> the line is inside agentsJson", async () => {
    const { bb, rpc } = await host();
    const db = openDatabase(bb);
    const { line } = await recordEmployeeLesson(bb.storage.kv, db, { projectId: "proj_direct", role: "3d-artist", line: "triangulate on export" });
    const started = await rpc<{ token: string }>("prepare_native_session", { projectId: "proj_direct", agentId: "3d-artist" });
    const record = await bb.storage.kv.get<{ agentsJson: string }>(`native-selection:${started.token}`);
    const definition = (JSON.parse(record!.agentsJson) as Record<string, Record<string, unknown>>)["3d-artist"]!;
    expect(definition.prompt).toContain("Lines added to your role");
    expect(definition.prompt).toContain(line);

    const other = await rpc<{ token: string }>("prepare_native_session", { projectId: "proj_direct", agentId: "seo-specialist" });
    const otherDef = (JSON.parse((await bb.storage.kv.get<{ agentsJson: string }>(`native-selection:${other.token}`))!.agentsJson) as Record<string, Record<string, unknown>>)["seo-specialist"]!;
    expect(otherDef.prompt).not.toContain("triangulate on export");
  });
});
