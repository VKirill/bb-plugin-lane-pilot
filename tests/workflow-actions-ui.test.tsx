/** @vitest-environment jsdom */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanup, configure, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { setLocaleOverride } from "@lane-pilot/i18n";
import { createWorkflowLibrary } from "../src/rooms/workflow/server/workflow-library";
import { createWorkflowOps } from "../src/rooms/workflow/server/workflow-ops";
import type { ServerCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server/services";
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
async function world(options: { audit?: NonNullable<Parameters<typeof engineOn>[2]>["auditGoals"] } = {}) {
  const db = journalDb();
  const globalDir = await mkdtemp(join(tmpdir(), "lp-wf-actions-"));
  dirs.push(globalDir);
  await writeFile(join(globalDir, "demo.json"), JSON.stringify(demo()));
  trust(db, demo());
  const broken = { write: true };
  const engine = engineOn(db, {
    search: ok(() => ({ items: ["a"], count: 1, kind: "fresh" })),
    write: ok(() => { if (broken.write) throw new Error("telegram down"); return { text: "written" }; }),
  }, { resolveWorkflow: () => null, ...(options.audit ? { auditGoals: options.audit } : {}) });
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
    workflow_preflight: (input: { id: string; projectId?: string }) => ops.preflight(input),
  };
  return { db, engine, rpc, broken };
}

async function mount(rpc: Record<string, unknown>, architectProjectId: string | null = null) {
  await loadPluginApp(() => import("../app"));
  const { WorkflowsScreen } = await import("../src/rooms/workflow/ui/workflows");
  return renderSlot({ component: () => <WorkflowsScreen locale="en" projectId={null} architectProjectId={architectProjectId} /> }, {}, { context: { projectId: null, threadId: null }, rpc: rpc as never });
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

describe("requirements", () => {
  it("shows what is missing and what could not be checked, and where a secret is asked for", async () => {
    const { rpc } = await world();
    const slot = await mount({ ...rpc, workflow_preflight: async () => ({ found: true, ok: false,
      issues: [{ kind: "tool", name: "yt-dlp", level: "missing", message: "yt-dlp is not installed on the machine the run works on." },
        { kind: "secret", name: "TAVILY_API_KEY", level: "missing", message: "TAVILY_API_KEY is not in Env Catalog." },
        { kind: "platform", name: "x", level: "unverified", message: "x: no known way to check a login for it." }],
      envRequests: [{ name: "TAVILY_API_KEY", kind: "secret", purpose: "needed" }], checked: [] }) });
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    fireEvent.click(await slot.findByTestId("wf-check-requires"));
    const result = await slot.findByTestId("wf-requires-missing-yt-dlp");
    expect(result.textContent).toContain("not installed");
    expect(slot.getByTestId("wf-requires-missing-TAVILY_API_KEY")).toBeTruthy();
    expect(slot.getByTestId("wf-requires-unverified-x")).toBeTruthy();
    expect(slot.getByTestId("wf-requires-result").textContent).toContain("masked form");
  });

  it("says everything is there when nothing is missing, and that a tested workflow is not proven yet", async () => {
    const { rpc } = await world();
    const slot = await mount(rpc);
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    fireEvent.click(await slot.findByTestId("wf-check-requires"));
    await waitFor(() => expect(slot.getByTestId("wf-requires-result").textContent).toContain("Everything it needs is there."));
    expect(slot.getByTestId("wf-proven").textContent).toBe("Published");
  });
});

describe("Run", () => {
  it("asks for the inputs, starts the workflow in the project and opens the run in the graph", async () => {
    const { rpc, engine, broken } = await world();
    broken.write = false;
    const calls: Array<Record<string, unknown>> = [];
    const slot = await mount({ ...rpc, workflow_list: rpc.workflow_list, workflow_draft_list: async () => ({ drafts: [] }),
      workflow_run: async (input: Record<string, unknown>) => {
        calls.push(input);
        const started = engine.start({ workflow: wf({ id: "demo" }), inputs: input.inputs as Record<string, unknown>, link: { projectId: "proj_ui" } });
        await started.done;
        return { ok: true, runId: started.runId, created: true, status: "succeeded", notChecked: [] };
      } }, "proj_ui");
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    expect((await slot.findByTestId("wf-run")).textContent).toBe("Run");
    fireEvent.click(slot.getByTestId("wf-run"));
    fireEvent.click(await slot.findByTestId("wf-inputs-submit"));
    expect((await slot.findByRole("alert")).textContent).toContain("query is required");
    fireEvent.change(slot.getByTestId("wf-input-query"), { target: { value: "cats" } });
    fireEvent.click(slot.getByTestId("wf-inputs-submit"));
    await waitFor(() => expect(calls).toEqual([{ id: "demo", projectId: "proj_ui", inputs: { query: "cats" }, source: "manual" }]));
    await waitFor(() => expect(slot.getByTestId("wf-run-summary").textContent).toContain("Succeeded"));
    expect(slot.queryByTestId("wf-run-panel")).toBeNull();
  });

  it("is a first real run for a tested workflow, says why a start was refused, and is not offered for a draft or without a project", async () => {
    const { rpc, db } = await world();
    db.prepare("UPDATE lane_pilot_wf_test SET green=1").run();
    const calls: Array<Record<string, unknown>> = [];
    const refuse = async (input: Record<string, unknown>) => { calls.push(input); return { ok: false, reason: "requirements_missing", message: "x", issues: [{ kind: "tool", name: "ffmpeg", level: "missing" as const, message: "ffmpeg is not installed on the machine the run works on." }] }; };
    const tested = { ...rpc, workflow_run: refuse, workflow_get: async (input: { id: string }) => { const result = await rpc.workflow_get(input as never); return { workflow: { ...result.workflow!, status: "tested" as const } }; } };
    const slot = await mount(tested, "proj_ui");
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    expect((await slot.findByTestId("wf-run")).textContent).toBe("Run for real");
    fireEvent.click(slot.getByTestId("wf-run"));
    expect((await slot.findByTestId("wf-run-panel")).textContent).toContain("really send, post and spend");
    fireEvent.change(slot.getByTestId("wf-input-query"), { target: { value: "cats" } });
    fireEvent.click(slot.getByTestId("wf-inputs-submit"));
    const refused = await slot.findByTestId("wf-run-refused");
    expect(refused.textContent).toContain("something it needs is missing");
    expect(refused.textContent).toContain("ffmpeg is not installed");
    expect(calls[0]).toMatchObject({ liveTrial: true });
    cleanup();

    const noProject = await mount(rpc, null);
    fireEvent.click(await noProject.findByTestId("wf-row-demo"));
    await noProject.findByTestId("wf-dry-run");
    expect(noProject.queryByTestId("wf-run")).toBeNull();
    cleanup();

    const draft = await mount({ ...rpc, workflow_get: async (input: { id: string }) => ({ workflow: { ...(await rpc.workflow_get(input as never)).workflow!, status: "draft" as const } }) }, "proj_ui");
    fireEvent.click(await draft.findByTestId("wf-row-demo"));
    await draft.findByTestId("wf-dry-run");
    expect(draft.queryByTestId("wf-run")).toBeNull();
  });

  it("tells the owner when a schedule has its automation", async () => {
    const { rpc } = await world();
    const withSchedule = async (input: { id: string }) => ({ workflow: { ...(await rpc.workflow_get(input as never)).workflow!, triggers: ["schedule 0 9 * * *"], schedules: [{ projectId: "p", slot: 0, automationId: "auto_1" }] } });
    const slot = await mount({ ...rpc, workflow_get: withSchedule });
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    expect((await slot.findByTestId("wf-schedule")).textContent).toContain("1 BB automation(s)");
  });
});

describe("goals of a run", () => {
  it("shows what the run is for, which goals the audit found met, why one was not, and how the goals changed", async () => {
    const { rpc, engine, broken } = await world({ audit: async () => ({ met: ["g1"], unmet: [{ id: "g2", why: "only two urls were named" }] }) });
    broken.write = false;
    const goals = [{ id: "g1", done_when: "the digest is posted", evidence: "a message id" }, { id: "g2", done_when: "three sources are named", evidence: "three urls", guess: true }];
    const started = engine.start({ workflow: wf({ id: "demo" }), inputs: { query: "q" }, goals });
    expect((await started.done).status).toBe("blocked");
    const slot = await mount(rpc);
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    fireEvent.click(await slot.findByTestId(`wf-history-${started.runId}`));
    const panel = await slot.findByTestId("wf-goals");
    expect(slot.getByTestId("wf-goal-state-g1").textContent).toBe("met");
    expect(slot.getByTestId("wf-goal-state-g2").textContent).toBe("not met");
    expect(slot.getByTestId("wf-goal-g2").textContent).toContain("only two urls were named");
    expect(slot.getByTestId("wf-goal-g2").textContent).toContain("inferred, not confirmed");
    expect(panel.querySelector("[data-testid=wf-goal-change]")).toBeNull();

    expect(engine.amendGoals(started.runId, [goals[0]!], "the owner dropped the sources goal")).toMatchObject({ ok: true, reopened: true });
    await engine.idle();
    await slot.behavior.emitRealtime("lp:-", { kind: "workflow", runId: started.runId });
    await waitFor(() => expect(slot.getByTestId("wf-goal-change").textContent).toContain("the owner dropped the sources goal"));
    expect(slot.queryByTestId("wf-goal-g2")).toBeNull();
    expect(slot.getByTestId("wf-goal-state-g1").textContent).toBe("met");
  });

  it("shows nothing for a run without goals", async () => {
    const { rpc, engine, broken } = await world();
    broken.write = false;
    const started = engine.start({ workflow: wf({ id: "demo" }), inputs: { query: "q" } });
    await started.done;
    const slot = await mount(rpc);
    fireEvent.click(await slot.findByTestId("wf-row-demo"));
    fireEvent.click(await slot.findByTestId(`wf-history-${started.runId}`));
    await waitFor(() => expect(slot.getByTestId("wf-run-summary").textContent).toContain("Succeeded"));
    expect(slot.queryByTestId("wf-goals")).toBeNull();
  });
});
