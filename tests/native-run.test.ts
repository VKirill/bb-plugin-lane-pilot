import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createRun, openDatabase, setRunThread } from "../src/database";
import { ownedNativePmRun, projectCheckoutIntentPath, resolveNativeDispatchWorkspace, writerWorkspaceForPmInstructions } from "../src/native-run";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

it("reads the selected project-checkout path and ignores a missing environment", () => {
  const intent = {
    kind: "provider" as const,
    environmentProviderId: "project-checkout",
    machine: { type: "existing" as const, hostId: "host_a" },
    inputs: { path: "/checkout/selected" },
  };
  expect(projectCheckoutIntentPath(intent)).toBe("/checkout/selected");
  expect(resolveNativeDispatchWorkspace({
    host: { id: "host_a" },
    environment: null,
    environmentIntent: intent,
  })).toEqual({
    phase: "ready",
    hostId: "host_a",
    workspacePath: "/checkout/selected",
    environmentId: null,
  });
});

it("defers samepath project-checkout until provision attaches the real path", () => {
  const intent = {
    kind: "provider" as const,
    environmentProviderId: "project-checkout",
    machine: { type: "existing" as const, hostId: "host_a" },
    inputs: {},
  };
  expect(projectCheckoutIntentPath(intent)).toBeNull();
  expect(resolveNativeDispatchWorkspace({
    host: { id: "host_a" },
    environment: null,
    environmentIntent: intent,
  })).toEqual({ phase: "pending", hostId: "host_a" });
});

it("accepts only a cli run that owns this thread and project", () => {
  const fake = createFakePluginHost({ pluginId: "lane-pilot" });
  cleanup.push(() => fake.harness.lifecycle.dispose());
  const db = openDatabase(fake.bb);
  createRun(db, "lprun_own", "project_a", "cli");
  setRunThread(db, "lprun_own", "thread_a");
  expect(ownedNativePmRun(db, { runId: "lprun_own", threadId: "thread_a", projectId: "project_a", role: "pm" })?.id).toBe("lprun_own");
  expect(ownedNativePmRun(db, { runId: "lprun_own", threadId: "thread_other", projectId: "project_a", role: "pm" })).toBeNull();
  expect(ownedNativePmRun(db, { runId: "lprun_own", threadId: "thread_a", projectId: "project_other", role: "pm" })).toBeNull();
  expect(ownedNativePmRun(db, { runId: "lprun_own", threadId: "thread_a", projectId: "project_a", role: "writer" })).toBeNull();
  expect(writerWorkspaceForPmInstructions({ writer_workspace_path: "/checkout/actual" }, "/tmp/stale")).toBe("/checkout/actual");
  expect(writerWorkspaceForPmInstructions({ writer_workspace_path: null }, "/tmp/stale")).toBe("/tmp/stale");
});
