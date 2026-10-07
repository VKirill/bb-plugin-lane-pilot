/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { createAttempt, createRun, createTask, openDatabase, saveStageReceipt, setAttemptWorkspace, transitionAttempt } from "../src/database";
import { createCore } from "../src/server/core";
import { runsRpc } from "../src/server/rpc/runs";
import type { Services } from "../src/server/services";

// The first test imports the whole app; a cold import alone can pass 5 s.
vi.setConfig({ testTimeout: 30_000 });

afterEach(() => cleanup());

const card = {
  runId: "run_1", state: "running", closed: false,
  tasks: [
    { id: "t1", title: "Add the footer", state: "accepted", threadId: "thr_w1", checkLog: null },
    { id: "t2", title: "Fix the header", state: "blocked", threadId: "thr_w2", checkLog: { hostId: "host_1", path: "/work/wt/.agents/plans/items/t2/logs/npm-test.log" } },
  ],
};

async function mount(rpc: Record<string, unknown>, attributes: Record<string, string>, extra: Record<string, unknown> = {}) {
  const app = await loadPluginApp(() => import("../app"));
  const directive = app.messageDirectives.find((row) => row.id === "lane-run");
  if (!directive) throw new Error("the lane-run directive is not registered");
  return renderSlot({ component: directive.component }, { attributes, source: '::lane-run{id="run_1"}', message: { id: "m1", threadId: "thr_pm", turnId: null, projectId: "p" }, openWorkspaceFile: null },
    { rpc: { get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }), ...rpc } as never, ...extra });
}

describe("lane-run message directive", () => {
  it("shows the run's tasks, opens a writer chat and a failed check's log in the file preview", async () => {
    const opened: unknown[] = [];
    const slot = await mount({ get_run_card: () => card }, { id: "run_1" }, { openThreadPanel: (options: unknown) => { opened.push(options); return true; } });
    const root = await slot.findByTestId("run-card");
    expect(root.textContent).toContain("Add the footer");
    expect(root.textContent).toContain("1 of 2 tasks accepted");
    const buttons = root.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    fireEvent.click(buttons[0]!);
    expect(opened[0]).toMatchObject({ params: { threadId: "thr_w1" } });
    fireEvent.click(buttons[2]!);
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({
      method: "experimental_openFilePreview",
      options: { target: { kind: "host", hostId: "host_1", path: "/work/wt/.agents/plans/items/t2/logs/npm-test.log" }, location: null },
    }));
  });

  it("says so when the run is unknown", async () => {
    expect(await (await mount({ get_run_card: () => null }, { id: "nope" })).findByText("This Lane Pilot run is no longer available.")).toBeTruthy();
  }, 60_000);

  it("says so when the directive has no id", async () => {
    expect(await (await mount({ get_run_card: () => card }, {})).findByText("This Lane Pilot run is no longer available.")).toBeTruthy();
  }, 60_000);
});

describe("get_run_card RPC", () => {
  it("answers each task's latest attempt and the check log under that attempt's workspace, and nothing for an unknown run", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const handlers = runsRpc(createCore(bb, db), {} as unknown as Services);
    createRun(db, "run_1", "proj_1", "bb");
    db.prepare("UPDATE lane_pilot_run SET writer_host_id=? WHERE id=?").run("host_1", "run_1");
    createTask(db, { id: "t1", runId: "run_1", kind: "bb", contract: { id: "t1", title: "Add the footer" } });
    createAttempt(db, { id: "a1", runId: "run_1", taskId: "t1" });
    expect(setAttemptWorkspace(db, "a1", { path: "/work/wt/", environmentId: null, decision: {} })).toBe(true);
    transitionAttempt(db, "a1", "blocked", { threadId: "thr_w1" });
    saveStageReceipt(db, { runId: "run_1", taskId: "t1", stageId: "verification", contractVersion: 1, state: "failed", inputSha256: "s", outputSha256: null, attempt: 1,
      providerId: null, model: null, threadId: null, result: { checkLogPath: ".agents/plans/items/t1/logs/npm-test.log" }, reason: null, updatedAt: Date.now() });
    createTask(db, { id: "t2", runId: "run_1", kind: "bb", contract: { id: "t2" } });

    expect(await handlers.get_run_card({ runId: "missing" })).toBeNull();
    const result = await handlers.get_run_card({ runId: "run_1" });
    expect(result).toMatchObject({ runId: "run_1", closed: false });
    expect(result!.tasks).toEqual([
      { id: "t1", title: "Add the footer", state: "blocked", threadId: "thr_w1", checkLog: { hostId: "host_1", path: "/work/wt/.agents/plans/items/t1/logs/npm-test.log" } },
      { id: "t2", title: "t2", state: null, threadId: null, checkLog: null },
    ]);
  });
});
