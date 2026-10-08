import { afterEach, expect, it } from "vitest";
import { createFakePluginHost, makePluginAgentConfigurationContext } from "@get-bb/plugin-sdk/testing";
import plugin from "../server";
import { createRun, openDatabase, savePrototypeConfig, setRunThread } from "../src/database";
import { finalizeNativeLaneBinding } from "../src/native-run";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function setup() {
  const fake = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(fake.bb);
  savePrototypeConfig(db, {
    projectId: "project-test",
    hostId: "host-test",
    pmWorkspacePath: "/tmp/pm",
    writerWorkspacePath: "/tmp/writer-stale",
    pmProviderId: "claude-code",
    pmModel: "claude",
    writerProviderId: "codex",
    writerModel: "codex-test",
  });
  await plugin(fake.bb);
  cleanup.push(() => fake.harness.lifecycle.dispose());
  return { ...fake, db };
}

it("exposes PM tools for a user-origin native chat with a matching cli run and uses the frozen path", async () => {
  const fake = await setup();
  createRun(fake.db, "lprun_native", "project-test", "cli");
  setRunThread(fake.db, "lprun_native", "thread-test");
  expect(finalizeNativeLaneBinding({
    db: fake.db,
    runId: "lprun_native",
    hostId: "host-test",
    workspacePath: "/checkout/actual",
    environmentId: "environment-test",
  })).toBe(true);
  for (const origin of [
    { kind: null, pluginId: null },
    { kind: null, pluginId: "user" },
  ] as const) {
    const configured = await fake.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({
        origin,
        pluginMetadata: { role: "pm", lanePilotRunId: "lprun_native" },
        environment: { id: "environment-test", path: "/checkout/actual" },
      }),
    );
    expect(configured.tools.map((tool) => tool.name)).toContain("lane_pilot_dispatch_writer");
    expect(configured.instructions).toContain("writer workspace=/checkout/actual");
    expect(configured.instructions).not.toContain("/tmp/writer-stale");
  }
});

it("waits for attach when a matching native run is still unbound", async () => {
  const fake = await setup();
  createRun(fake.db, "lprun_wait", "project-test", "cli");
  setRunThread(fake.db, "lprun_wait", "thread-test");
  const configured = await fake.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      origin: { kind: null, pluginId: null },
      pluginMetadata: { role: "pm", lanePilotRunId: "lprun_wait" },
      environment: { id: "", path: "" },
    }),
  );
  expect(configured.tools.map((tool) => tool.name)).toContain("lane_pilot_read");
  expect(configured.instructions).toContain("waiting for the native environment");
});

it("keeps the old origin gate and does not treat a foreign user chat as PM", async () => {
  const fake = await setup();
  const user = await fake.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      origin: { kind: null, pluginId: null },
      pluginMetadata: { role: "pm", lanePilotRunId: "lprun_missing" },
    }),
  );
  expect(user.tools).toEqual([]);
  const spawned = await fake.harness.behavior.resolveAgentConfiguration(
    makePluginAgentConfigurationContext({
      origin: { kind: null, pluginId: "lane-pilot" },
      pluginMetadata: { role: "pm", lanePilotRunId: "run-x" },
    }),
  );
  expect(spawned.tools.map((tool) => tool.name)).toContain("lane_pilot_dispatch_writer");
  expect(spawned.instructions).toContain("writer workspace=/tmp/writer-stale");
});
