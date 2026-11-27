/** @vitest-environment jsdom */
import { cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { setLocaleOverride } from "@lane-pilot/i18n";
import plugin from "../server";
import { createRun, getRun, openDatabase } from "../src/rooms/plugin-db";
import { buildRunPolicy } from "../src/rooms/tasks";

afterEach(() => { cleanup(); setLocaleOverride(null); });

it("keeps the frozen policy of an open run when project settings change", async () => {
  setLocaleOverride("en");
  const projectId = "n485-project";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const policy = buildRunPolicy({ "ops.pool_size": 4, "ops.verify_pool_size": 2, "writer.max_turns": 100 });
  createRun(db, "n485-run", projectId, "bb", null, "none", policy);
  await plugin(bb);
  for (const [key, value] of [["ops.pool_size", 7], ["ops.verify_pool_size", 3], ["writer.max_turns", 0]] as const) {
    expect(await harness.behavior.callRpc("save_setting", { projectId, key, value, expectedVersion: 0 })).toMatchObject({ ok: true });
  }
  const snapshot = getRun(db, "n485-run")!.run_policy_json;
  expect(JSON.parse(snapshot)).toEqual(policy);
  await harness.behavior.callRpc("get_screen", { projectId });
  expect(getRun(db, "n485-run")!.run_policy_json).toBe(snapshot);
  await harness.lifecycle.dispose();
});


it("does not consume the invalid ceiling warning while previewing settings", async () => {
  const projectId = "n485-warning";
  const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  createRun(db, "n485-warning-run", projectId, "bb", null, "none", buildRunPolicy({}));
  await plugin(bb);
  expect(await harness.behavior.callRpc("save_setting", { projectId, key: "writer.max_turns", value: 987654, expectedVersion: 0 })).toMatchObject({ ok: true });
  await harness.behavior.callRpc("get_screen", { projectId });
  const warnings: string[] = [];
  for (let i = 0; i < 2; i++) {
    const policy = buildRunPolicy({ "writer.max_turns": 987654 }, (line) => warnings.push(line));
    expect(policy.maxTurns).toBeUndefined();
  }
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("writer.max_turns=987654");
  await harness.lifecycle.dispose();
});
