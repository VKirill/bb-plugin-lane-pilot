/** @vitest-environment jsdom */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "../i18n";
import { createWorkflowLibrary } from "../src/server/workflow-library";
import { createWorkflowOps } from "../src/server/workflow-ops";
import type { ServerCore } from "../src/server/core";
import type { Services } from "../src/server/services";
import { engineOn, journalDb, ok, trust, wf } from "./workflow/engine-helpers";
import { workflow } from "./workflow/fixtures";

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 10_000 });

beforeAll(() => {
  class Matrix { m22 = 1; m41 = 0; m42 = 0; constructor(_init?: string) {} }
  vi.stubGlobal("DOMMatrixReadOnly", Matrix);
});
afterEach(() => { cleanup(); setLocaleOverride(null); });
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

const demo = () => workflow({ id: "demo", name: "Demo chain", status: "published" });

/** The real library, ops and engine over a journal; the second step of the chain fails until `broken.write` is cleared. */
async function world() {
  const db = journalDb();
  const globalDir = await mkdtemp(join(tmpdir(), "lp-wf-actions-"));
  dirs.push(globalDir);
  await writeFile(join(globalDir, "demo.json"), JSON.stringify(demo()));
  trust(db, demo());
  const broken = { write: true };
  const engine = engineOn(db, {
    search: ok(() => ({ items: ["a"], count: 1, kind: "fresh" })),
    write: ok(() => { if (broken.write) throw new Error("telegram down"); return { text: "written" }; }),
  }, { resolveWorkflow: () => null });
  const ctx = { db, log: () => undefined, host: { call: async () => ({ hostId: "h", files: [] }) } } as unknown as ServerCore;
  const services = { workflowEngine: engine, docsPlaces: async () => [] } as unknown as Services;
  const lib = createWorkflowLibrary(ctx, services, { globalDir });
  const ops = createWorkflowOps(ctx, services, lib);
  const rpc = {
    get_preferences: () => ({ locale: "en", preference: "en", lastProjectId: null }),
    workflow_list: (input: { projectId?: string }) => lib.list(input),
    workflow_get: (input: { id: string; projectId?: string }) => lib.get(input),
    workflow_run_snapshot: (input: { runId: string }) => lib.runSnapshot(input),
    workflow_runs: (input: { id: string; projectId?: string; limit?: number; before?: number }) => ops.runs({ limit: 20, ...input }),
    workflow_rerun_node: (input: { runId: string; nodeId: string }) => ops.rerunNode(input),
    workflow_dry_run: (input: { id: string; projectId?: string; input?: Record<string, unknown> }) => ops.dryRun({ input: {}, ...input }),
    workflow_run_tests: (input: { id: string; projectId?: string }) => ops.runTests(input),
  };
  return { db, engine, rpc, broken };
}

async function mount(rpc: Record<string, unknown>) {
  await loadPluginApp(() => import("../app"));
  const { WorkflowsScreen } = await import("../src/ui/workflows");
  return renderSlot({ component: () => <WorkflowsScreen locale="en" projectId={null} /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
}

describe("run history", () => {
  it("lists the runs of the workflow and opens one in the graph when picked", async () => {
    const { rpc, engine, db, broken } = await world();
    broken.write = false;
    const first = engine.start({ workflow: wf({ id: "demo" }), inputs: { query: "q" } });
    await first.done;
    // Twenty-one more runs make a second page.
    const def = JSON.stringify(wf({ id: "demo" }));
    for (let at = 1; at <= 21; at += 1) {
      db.prepare("INSERT INTO lane_pilot_wf_run(id,workflow_id,workflow_version,workflow_sha256,definition_json,status,created_at,updated_at,steps_used) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(`old${at}`, "demo", 1, "x", def, "succeeded", at, at, 2);
    }
    const slot = await mount(rpc);
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    await slot.findByTestId(`wf-history-${first.runId}`);
    expect(slot.getByTestId("wf-history-old21")).toBeTruthy();
    expect(slot.queryByTestId("wf-history-old1")).toBeNull();
    fireEvent.click(slot.getByTestId("wf-history-more"));
    await slot.findByTestId("wf-history-old1");
    expect(slot.queryByTestId("wf-history-more")).toBeNull();
    fireEvent.click(slot.getByTestId(`wf-history-${first.runId}`));
    await waitFor(() => expect(slot.getByTestId("wf-run-summary").textContent).toContain("Succeeded"));
  });
});

describe("re-running a node from the node panel", () => {
  it("offers it on a finished run, runs the node again and shows the new result", async () => {
    const { rpc, engine, broken } = await world();
    const started = engine.start({ workflow: wf({ id: "demo" }), inputs: { query: "q" } });
    expect((await started.done).status).toBe("failed");
    const slot = await mount(rpc);
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    fireEvent.click(await slot.findByTestId(`wf-history-${started.runId}`));
    await waitFor(() => expect(slot.getByTestId("wf-node-write").getAttribute("data-status")).toBe("failed"));
    fireEvent.click(slot.getByTestId("wf-node-write"));
    const button = await slot.findByTestId("wf-rerun-node");
    broken.write = false;
    fireEvent.click(button);
    await waitFor(() => expect(engine.get(started.runId)?.status).toBe("succeeded"));
    await slot.behavior.emitRealtime("lp:-", { kind: "workflow", runId: started.runId });
    await waitFor(() => expect(slot.getByTestId("wf-node-write").getAttribute("data-status")).toBe("done"));
    expect(slot.getByTestId("wf-run-summary").textContent).toContain("Succeeded");
  });

  it("says why when the run is still going", async () => {
    const { rpc, engine } = await world();
    const started = engine.start({ workflow: wf({ id: "demo" }), inputs: { query: "q" } });
    await started.done;
    const slot = await mount({ ...rpc, workflow_rerun_node: async () => ({ ok: false, reason: "run_active" }) });
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    fireEvent.click(await slot.findByTestId(`wf-history-${started.runId}`));
    await waitFor(() => expect(slot.getByTestId("wf-node-search").getAttribute("data-status")).toBe("done"));
    fireEvent.click(slot.getByTestId("wf-node-search"));
    fireEvent.click(await slot.findByTestId("wf-rerun-node"));
    expect((await slot.findByTestId("wf-rerun-error")).textContent).toContain("the run is still going");
  });
});

describe("dry run and tests", () => {
  it("asks for the inputs, runs on stubs and shows the path and what was stubbed", async () => {
    const { rpc, engine } = await world();
    const slot = await mount(rpc);
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    fireEvent.click(await slot.findByTestId("wf-dry-run"));
    fireEvent.click(await slot.findByTestId("wf-inputs-submit"));
    expect((await slot.findByRole("alert")).textContent).toContain("query is required");
    fireEvent.change(slot.getByTestId("wf-input-query"), { target: { value: "cats" } });
    fireEvent.click(slot.getByTestId("wf-inputs-submit"));
    const result = await slot.findByTestId("wf-trial-result");
    expect(result.textContent).toContain("search > write");
    expect(result.textContent).toContain("search (action: search)");
    expect(slot.getByTestId("wf-trial-green").textContent).toBe("Green");
    // Nothing real ran: the live engine has no run of the workflow.
    expect(engine.inFlight()).toEqual([]);
    fireEvent.click(slot.getByTestId("wf-trial-open-run"));
    await waitFor(() => expect(slot.getByTestId("wf-run-summary").textContent).toContain("Succeeded"));
  });

  it("runs the tests and says what the workflow counts as now", async () => {
    const { rpc } = await world();
    const slot = await mount(rpc);
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    fireEvent.click(await slot.findByTestId("wf-run-tests"));
    const result = await slot.findByTestId("wf-tests-result");
    await waitFor(() => expect(result.textContent).toContain("Tests: Green. The workflow now counts as Published."));
  });
});
