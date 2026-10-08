import { afterEach, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { closeRun, createRun, getActivation, openDatabase, setRunThread } from "../src/database";
import { claimNativeLaneRun, ownedNativePmRun, projectCheckoutIntentPath, resolveNativeDispatchWorkspace, writerWorkspaceForPmInstructions } from "../src/native-run";

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

it("claims one run per native chat without project setup or a project-wide lock", () => {
  const fake = createFakePluginHost({ pluginId: "lane-pilot" });
  cleanup.push(() => fake.harness.lifecycle.dispose());
  const db = openDatabase(fake.bb);
  const first = claimNativeLaneRun({ db, threadId: "thread_a", projectId: "project_unconfigured" });
  expect(first.created).toBe(true);
  setRunThread(db, first.runId, "thread_a");
  const second = claimNativeLaneRun({ db, threadId: "thread_b", projectId: "project_unconfigured" });
  expect(second.created).toBe(true);
  expect(second.runId).not.toBe(first.runId);
  expect(claimNativeLaneRun({ db, threadId: "thread_a", projectId: "project_unconfigured" })).toEqual({ runId: first.runId, created: false });
  expect(getActivation(db, "project_unconfigured")).toBeUndefined();
  closeRun(db, first.runId, "rpc");
  expect(claimNativeLaneRun({ db, threadId: "thread_a", projectId: "project_unconfigured" }).created).toBe(true);
});

it("gives a repeated task id a fresh key and frees paths held by a dead task", async () => {
  const { createTask, createAttempt, freeTaskId, listLiveTasksForRun, saveStageReceipt } = await import("../src/database");
  const fake = createFakePluginHost({ pluginId: "lane-pilot" });
  cleanup.push(() => fake.harness.lifecycle.dispose());
  const db = openDatabase(fake.bb);
  createRun(db, "lprun_r", "project_a", "cli");
  expect(freeTaskId(db, "premium")).toBe("premium");
  createTask(db, { id: "premium", runId: "lprun_r", kind: "bb", contract: { owns_paths: ["src/a.mjs"] } });
  expect(freeTaskId(db, "premium")).toBe("premium.2");
  createTask(db, { id: "live", runId: "lprun_r", kind: "bb", contract: { owns_paths: ["src/b.mjs"] } });
  createTask(db, { id: "stopped", runId: "lprun_r", kind: "bb", contract: { owns_paths: ["src/c.mjs"] } });
  createAttempt(db, { id: "att_1", runId: "lprun_r", taskId: "premium" });
  db.prepare("UPDATE lane_pilot_attempt SET state='blocked' WHERE id='att_1'").run();
  saveStageReceipt(db, { contractVersion: 1, runId: "lprun_r", taskId: "stopped", stageId: "plan-critique", state: "blocked",
    inputSha256: "a".repeat(64), outputSha256: null, attempt: 0, providerId: null, model: null, threadId: null, result: null, reason: "owns_overlap", updatedAt: 1 });
  expect(listLiveTasksForRun(db, "lprun_r").map((task) => task.id)).toEqual(["live"]);
  createTask(db, { id: "empty", runId: "lprun_r", kind: "bb", contract: { owns_paths: ["src/d.mjs"] } });
  createAttempt(db, { id: "att_2", runId: "lprun_r", taskId: "empty" });
  db.prepare("UPDATE lane_pilot_attempt SET state='empty_output' WHERE id='att_2'").run();
  expect(listLiveTasksForRun(db, "lprun_r").map((task) => task.id)).toEqual(["live"]);
  db.prepare("UPDATE lane_pilot_attempt SET state='running' WHERE id='att_2'").run();
  expect(listLiveTasksForRun(db, "lprun_r").map((task) => task.id).sort()).toEqual(["empty", "live"]);
  db.prepare("UPDATE lane_pilot_attempt SET state='accepted' WHERE id='att_2'").run();
  createTask(db, { id: "preflight", runId: "lprun_r", kind: "bb", contract: { owns_paths: ["src/e.mjs"] } });
  saveStageReceipt(db, { contractVersion: 1, runId: "lprun_r", taskId: "preflight", stageId: "pm-read", state: "failed",
    inputSha256: "b".repeat(64), outputSha256: null, attempt: 0, providerId: null, model: null, threadId: null, result: null, reason: "x", updatedAt: 2 });
  // Accepted work is already merged, and a failed preflight never started: neither holds its paths.
  expect(listLiveTasksForRun(db, "lprun_r").map((task) => task.id)).toEqual(["live"]);
});

it("accepts upstream task-v2 context fields a BB writer does not use", async () => {
  const { validateTaskV2 } = await import("../src/rooms/tasks/task-v2");
  const task = {
    schema_version: 2, id: "t1", title: "T", risk: "low", lane: "write", project_cwd: "/p", read_first: [], interfaces: [], invariants: [],
    out_of_scope: [], expected_outputs: ["a.ts"], owns_paths: ["a.ts"], never_touch: [], depends_on: [], objective: "o", acceptance: ["a"],
    verify: "none", verification: [],
  };
  const result = validateTaskV2({ ...task, context_selectors: [{ path: "a.ts", start_line: 1, end_line: 2 }], impact_receipt: "r.json" });
  expect(result.ok).toBe(true);
  expect(validateTaskV2({ ...task, surprise: 1 }).ok).toBe(false);
});

it("keeps section settings on top of the project's and resets a section back to them", async () => {
  const { casUpsertSetting, casResetSettings, listSettingRows, loadProjectSettings, sectionBindingId, getRunSettingsScopes, setRunSettingsScopes } = await import("../src/database");
  const fake = createFakePluginHost({ pluginId: "lane-pilot" });
  cleanup.push(() => fake.harness.lifecycle.dispose());
  const db = openDatabase(fake.bb);
  expect(casUpsertSetting(db, { projectId: "p", key: "adoc.040", value: "auto", expectedVersion: 0 }).ok).toBe(true);
  const section = sectionBindingId("sec_a"), child = sectionBindingId("sec_b");
  expect(casUpsertSetting(db, { projectId: "p", key: "adoc.040", value: "worktree", expectedVersion: 0, bindingId: section }).ok).toBe(true);
  expect(casUpsertSetting(db, { projectId: "p", key: "adoc.042", value: false, expectedVersion: 0, bindingId: child }).ok).toBe(true);
  expect(loadProjectSettings(db, "p")["adoc.040"]).toBe("auto");
  expect(loadProjectSettings(db, "p", [section])).toMatchObject({ "adoc.040": "worktree" });
  expect(loadProjectSettings(db, "p", [section, child])).toMatchObject({ "adoc.040": "worktree", "adoc.042": false });
  const rows = listSettingRows(db, "p", section);
  expect(rows.map((row) => row.key)).toEqual(["adoc.040"]);
  expect(casResetSettings(db, { projectId: "p", keys: ["adoc.040"], expectedVersions: { "adoc.040": 1 }, validationKeys: ["adoc.040"], validatedRows: rows, bindingId: section }).ok).toBe(true);
  expect(loadProjectSettings(db, "p", [section, child])).toMatchObject({ "adoc.040": "auto", "adoc.042": false });
  createRun(db, "lprun_s", "p", "cli");
  expect(getRunSettingsScopes(db, "lprun_s")).toEqual([]);
  setRunSettingsScopes(db, "lprun_s", [section, child]);
  expect(getRunSettingsScopes(db, "lprun_s")).toEqual([section, child]);
});

it("accepts a switch's boolean for a true/false setting", async () => {
  const { validateSettingValue } = await import("../src/rooms/settings/setting-validation");
  expect(validateSettingValue("docs.enabled", true)).toBeNull();
  expect(validateSettingValue("memory.enabled", false)).toBeNull();
  expect(validateSettingValue("docs.enabled", "true")).toBeNull();
  expect(validateSettingValue("docs.enabled", "maybe")).not.toBeNull();
});

it("lets every project inherit the global level and override it per project or section", async () => {
  const { casUpsertSettings, loadProjectSettings, sectionBindingId } = await import("../src/database");
  const { GLOBAL_SETTINGS_PROJECT_ID } = await import("@lane-pilot/settings-catalog");
  const fake = createFakePluginHost({ pluginId: "lane-pilot" });
  cleanup.push(() => fake.harness.lifecycle.dispose());
  const db = openDatabase(fake.bb);
  const writer = (projectId: string, model: string, bindingId = "") => casUpsertSettings(db, { projectId, bindingId, changes: [
    { key: "writer.provider", value: "codex", expectedVersion: 0 },
    { key: "writer.model", value: model, expectedVersion: 0 },
  ] }, { nativeWriterSelection: true }).ok;
  expect(writer(GLOBAL_SETTINGS_PROJECT_ID, "gpt-6-luna")).toBe(true);
  expect(casUpsertSettings(db, { projectId: GLOBAL_SETTINGS_PROJECT_ID, changes: [{ key: "docs.enabled", value: true, expectedVersion: 0 }] }).ok).toBe(true);
  expect(loadProjectSettings(db, "a")).toMatchObject({ "writer.model": "gpt-6-luna", "docs.enabled": true });
  expect(writer("b", "gpt-6-astra")).toBe(true);
  expect(loadProjectSettings(db, "b")).toMatchObject({ "writer.model": "gpt-6-astra", "docs.enabled": true });
  const section = sectionBindingId("sec_a");
  expect(casUpsertSettings(db, { projectId: "a", bindingId: section, changes: [{ key: "docs.enabled", value: false, expectedVersion: 0 }] }).ok).toBe(true);
  expect(loadProjectSettings(db, "a", [section])).toMatchObject({ "writer.model": "gpt-6-luna", "docs.enabled": false });
  expect(loadProjectSettings(db, GLOBAL_SETTINGS_PROJECT_ID)).toEqual({ "writer.provider": "codex", "writer.model": "gpt-6-luna", "docs.enabled": true });
});
