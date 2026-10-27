import { describe, expect, it } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { WorkflowEngine, parseWorkflow } from "@lane-pilot/workflow-engine";
import { HARNESS_VERSION } from "../src/rooms/storage";
import { createAttempt, createRun, openDatabase, saveProjectSetting } from "../src/rooms/storage/database";
import { QA_HOST_KEY } from "../src/rooms/qa/qa-host";
import { builtinWorkflow } from "../src/rooms/workflow/builtin";
import { recordStage } from "../src/rooms/runs/server";
import { registerBrowserExecutors, runBrowserQaGraph, runBrowserStep } from "../src/rooms/qa/server/browser-graphs";
import { registerPureActions } from "@lane-pilot/workflow-engine";

type Call = { method: string; input: Record<string, unknown> };

/** A plugin context with only what the browser executors read: the database, the host, the log. */
function setup(hostReply: (call: Call) => unknown = () => ({ hostId: "host_mini", exitCode: 0, status: "done", url: "https://x.test/after", actions: 3, title: "After", text: "page text", log: "ok" })) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
  const db = openDatabase(bb);
  const calls: Call[] = [];
  const infos: string[] = [];
  const host = { call: async (method: string, input: Record<string, unknown>) => { const call = { method, input }; calls.push(call); return hostReply(call); } };
  const ctx = { db, host, bb: { log: { info: (message: string) => infos.push(message) } }, isDisposed: () => false } as never;
  const qaCalls: Array<Record<string, unknown>> = [];
  const services = { runBrowserQa: async (args: Record<string, unknown>) => { qaCalls.push(args); return qaReply(args); } } as { runBrowserQa: (args: Record<string, unknown>) => Promise<Record<string, unknown>> };
  let qaReply: (args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>> = (args) => ({ runId: args.runId, taskId: args.taskId, state: "passed" });
  const newEngine = () => {
    const engine = new WorkflowEngine({ db, harnessVersion: HARNESS_VERSION, resolveWorkflow: (id, version) => builtinWorkflow(id, version) });
    registerPureActions(engine);
    registerBrowserExecutors(engine, ctx, services as never);
    return engine;
  };
  const engine = newEngine();
  saveProjectSetting(db, "proj", QA_HOST_KEY, "host_mini");
  return { db, ctx, calls, infos, engine, newEngine, qaCalls, services, setQa: (fn: typeof qaReply) => { qaReply = fn; } };
}

const stepInput = { projectId: "proj", runId: null, pmThreadId: null, url: "https://x.test/", goal: "Read the title", changes: false, authorized: false, timeoutSec: 60 };

describe("browser.goal and the graph browser-step", () => {
  it("both graphs are starter graphs: the router never offers them and run_workflow refuses them", () => {
    expect(builtinWorkflow("browser-step")).toMatchObject({ startedBy: "lane_pilot_browser", status: "published" });
    expect(builtinWorkflow("lp.browser-qa")).toMatchObject({ startedBy: "lane_pilot_browser_qa", status: "published" });
  });

  it("answers with the shape lane_pilot_browser always had: host fields, then the fenced text last", async () => {
    const t = setup();
    const reply = JSON.parse(await runBrowserStep(t.ctx, stepInput)) as Record<string, unknown>;
    expect(Object.keys(reply)).toEqual(["hostId", "exitCode", "status", "url", "actions", "title", "log", "text"]);
    expect(reply).toMatchObject({ hostId: "host_mini", exitCode: 0, status: "done", url: "https://x.test/after", actions: 3, title: "After", log: "ok" });
    expect(String(reply.text)).toContain('<outside_data source="browser">');
    expect(String(reply.text)).toContain("page text");
    // The host got the call as before: a read-only goal carries the suffix, the timeout is timeoutSec + 30.
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toEqual({ method: "browserGoal", input: { requestedHostId: "host_mini", url: "https://x.test/", goal: "Read the title\nRead-only: do not submit, change, delete, pay or publish anything.", timeoutSec: 60 } });
    expect(t.db.prepare("SELECT workflow_id, status FROM lane_pilot_wf_run").all()).toEqual([{ workflow_id: "browser-step", status: "succeeded" }]);
  });

  it("keeps nulls from an older launcher as null, and a changing goal goes to the host as written", async () => {
    const t = setup(() => ({ hostId: "host_mini", exitCode: 0, status: "blocked", url: null, actions: null, title: null, text: null, log: "" }));
    const reply = JSON.parse(await runBrowserStep(t.ctx, { ...stepInput, changes: true, authorized: true, goal: "Press Save" })) as Record<string, unknown>;
    expect(reply).toEqual({ hostId: "host_mini", exitCode: 0, status: "blocked", url: null, actions: null, title: null, log: "", text: null });
    expect(t.calls[0]!.input.goal).toBe("Press Save");
  });

  it("refuses a change without the owner's word and a project with no browser machine, and starts no run", async () => {
    const t = setup();
    expect(JSON.parse(await runBrowserStep(t.ctx, { ...stepInput, changes: true }))).toEqual({ status: "refused", reason: "changes_need_owner_authorization: ask the owner, then pass authorized=true" });
    expect(JSON.parse(await runBrowserStep(t.ctx, { ...stepInput, projectId: "other" }))).toMatchObject({ status: "refused", reason: expect.stringContaining("no_browser_machine") });
    expect(t.calls).toEqual([]);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_wf_run").get()).toEqual({ n: 0 });
  });

  it("a failing host call fails the run and the tool throws the host's message", async () => {
    const t = setup(() => { throw new Error("host_mini is unreachable"); });
    await expect(runBrowserStep(t.ctx, stepInput)).rejects.toThrow("host_mini is unreachable");
    expect(t.db.prepare("SELECT status FROM lane_pilot_wf_run").all()).toEqual([{ status: "failed" }]);
  });

  it("browser.goal works as a node of any graph", async () => {
    const t = setup();
    const graph = parseWorkflow({
      id: "my-check", name: "My check", description: { en: "reads a page", ru: "читает страницу" }, status: "published",
      inputs: { page: { type: "string", required: true } }, outputs: { title: "string?", status: "string" },
      nodes: [
        { id: "look", type: "action", action: "browser.goal", rule: "code: one browser goal", url: "{{$inputs.page}}", goal: "Read the title", changes: false, authorized: false, timeout_sec: 30,
          out: { status: "string", title: "string?", text: "string?", url: "string?", actions: "int?", hostId: "string?", exitCode: "int?", log: "string?", reason: "string?" } },
        { id: "done", type: "action", action: "emit", map: { title: "look.title", status: "look.status" } },
      ],
      edges: [{ from: "start", to: "look" }, { from: "look", to: "done" }],
    });
    const started = t.engine.start({ workflow: graph, inputs: { page: "https://a.test/" }, runtime: { ctx: t.ctx, services: t.services, pmThreadId: null, projectId: "proj", runId: null } as never });
    const summary = await started.done;
    expect(summary).toMatchObject({ status: "succeeded", output: { title: "After", status: "done" } });
    expect(t.calls[0]!.input).toMatchObject({ url: "https://a.test/", timeoutSec: 30 });
  });
});

describe("lp.browser-qa", () => {
  const qaInput = { pmThreadId: "pm", projectId: "proj", runId: "lprun_1", taskId: "task-1", url: "http://127.0.0.1:5173/", cases: ["Open home"], envClass: "local", viewports: "375", authorized: false };

  it("hands runBrowserQa the arguments of the tool and answers with its reply untouched", async () => {
    const t = setup();
    const full = { runId: "lprun_1", taskId: "task-1", state: "failed", link: "@thread:thr_qa", stage: { stageId: "browser-qa", state: "failed" }, result: { verdict: "failed" }, reason: "case 1 failed" };
    t.setQa(() => full);
    expect(await runBrowserQaGraph(t.ctx, { ...qaInput, devServer: "npm run dev" })).toEqual(full);
    expect(t.qaCalls).toEqual([{ threadId: "pm", projectId: "proj", runId: "lprun_1", taskId: "task-1", url: "http://127.0.0.1:5173/", cases: ["Open home"], envClass: "local", viewports: "375", authorized: false, devServer: "npm run dev" }]);
    // The tool still gets the verdict, but a red one leaves the graph run red: a task's pipeline and the wall see it.
    expect(t.db.prepare("SELECT workflow_id, status, reason, link_run_id, link_task_id FROM lane_pilot_wf_run").all()).toEqual([{ workflow_id: "lp.browser-qa", status: "failed", reason: "step_failed:verdict", link_run_id: "lprun_1", link_task_id: "task-1" }]);
  });

  it("a passed or skipped check leaves the run succeeded", async () => {
    for (const state of ["passed", "skipped"]) {
      const t = setup();
      t.setQa((args) => ({ runId: args.runId, taskId: args.taskId, state }));
      expect(await runBrowserQaGraph(t.ctx, qaInput)).toMatchObject({ state });
      expect(t.db.prepare("SELECT status FROM lane_pilot_wf_run").all()).toEqual([{ status: "succeeded" }]);
    }
  });

  it("answers a blocked call (a login that cannot be served) as runBrowserQa did, with no receipt written by the graph", async () => {
    const t = setup();
    const blocked = { runId: "lprun_1", taskId: "task-1", state: "blocked", reason: "waiting_secret:SHOP_QA", next: "Nothing was started.", fix: ["env_request SHOP_QA"] };
    t.setQa(() => blocked);
    expect(await runBrowserQaGraph(t.ctx, qaInput)).toEqual(blocked);
    expect(t.db.prepare("SELECT COUNT(*) AS n FROM lane_pilot_stage_receipt").get()).toEqual({ n: 0 });
    expect(t.db.prepare("SELECT status FROM lane_pilot_wf_run").all()).toEqual([{ status: "failed" }]);
  });

  it("a call that does not fit throws runBrowserQa's own message and leaves the run failed: no check was done", async () => {
    const t = setup();
    t.setQa(() => { throw new Error("runId does not belong to this Lane Pilot PM thread"); });
    await expect(runBrowserQaGraph(t.ctx, qaInput)).rejects.toThrow("runId does not belong to this Lane Pilot PM thread");
    expect(t.db.prepare("SELECT status FROM lane_pilot_wf_run").all()).toEqual([{ status: "failed" }]);
  });

  it("a check still running waits on its receipt and, after a reload, ends from the receipt the adopter writes", async () => {
    const t = setup();
    createRun(t.db, "lprun_1", "proj", "bb");
    t.db.prepare("INSERT INTO lane_pilot_task(id, run_id, kind, contract_json, created_at) VALUES ('task-1','lprun_1','bb','{}',1)").run();
    const input = JSON.stringify({ url: "x" });
    const stage = { runId: "lprun_1", taskId: "task-1", stageId: "browser-qa" as const, input };
    recordStage(t.db, { ...stage, state: "pending" });
    recordStage(t.db, { ...stage, state: "running" });
    t.setQa(() => ({ runId: "lprun_1", taskId: "task-1", state: "running", reason: "browser_qa_already_dispatched" }));
    // The tool gets the running reply at once (as a second call always did) and the run waits.
    expect(await runBrowserQaGraph(t.ctx, qaInput)).toMatchObject({ state: "running", reason: "browser_qa_already_dispatched" });
    const run = t.db.prepare("SELECT id, status FROM lane_pilot_wf_run").get() as { id: string; status: string };
    expect(run.status).toBe("waiting");

    // A reload: a new engine on the same database. Nothing final yet: it keeps waiting.
    const reloaded = t.newEngine();
    expect(await reloaded.poll()).toBe(0);
    expect(reloaded.get(run.id)?.status).toBe("waiting");

    // The adopter (resumeBrowserQaThreads) writes the verdict; the next poll settles the step and the run closes with the receipt's own words.
    recordStage(t.db, { ...stage, state: "passed", result: { verdict: "passed", link: "@thread:thr_qa" } });
    expect(await reloaded.poll()).toBe(1);
    const done = reloaded.get(run.id)!;
    expect(done.status).toBe("succeeded");
    expect(done.output).toMatchObject({ state: "passed", reply: { runId: "lprun_1", taskId: "task-1", state: "passed", link: "@thread:thr_qa", result: { verdict: "passed" }, stage: { stageId: "browser-qa", state: "passed" } } });
  });
});

describe("lp.qa-gate", () => {
  const plainTask = {
    schema_version: 2, display_title: "Тестовая задача", kind: "feature", area: "feature:task-1", id: "task-1", title: "Write a fixture", risk: "low", lane: "writer", project_cwd: "/work/p", read_first: ["README.md L1-L2"],
    interfaces: ["note.txt exists"], invariants: ["Only write note.txt"], out_of_scope: ["Plugin source"], expected_outputs: ["note.txt"], owns_paths: ["note.txt"],
    never_touch: [".git/**"], depends_on: [], objective: "Write note.txt", acceptance: ["note.txt is present"], verify: "tests",
    verification: [{ command: "test -f note.txt", cwd: "/work/p", timeout_sec: 30 }],
  };
  const contract = { ...plainTask, qa_cases: ["Open home"], qa_url: "http://127.0.0.1:5173/" };
  const gateGraph = parseWorkflow({
    id: "gate-only", name: "Gate only", description: { en: "the gate of the task pipeline", ru: "ворота конвейера задачи" }, status: "published",
    inputs: {}, outputs: { run: "bool", url: "string?" },
    nodes: [
      { id: "gate", type: "decision", uses: "lp.qa-gate", out: { run: "bool", run_id: "string?", task_id: "string?", url: "string?", cases: "string[]?", env_class: "string?", dev_server: "string?" } },
      { id: "done", type: "action", action: "emit", map: { run: "gate.run", url: "gate.url" } },
    ],
    edges: [{ from: "start", to: "gate" }, { from: "gate", to: "done" }],
  });

  /** An accepted task with qa_cases and qa_url and, unless said otherwise, no acceptance receipt yet. */
  function accepted(options: { contract?: Record<string, unknown>; state?: string } = {}) {
    const t = setup();
    createRun(t.db, "lprun_1", "proj", "bb");
    t.db.prepare("INSERT INTO lane_pilot_task(id, run_id, kind, contract_json, created_at) VALUES ('task-1','lprun_1','bb',?,1)").run(JSON.stringify(options.contract ?? contract));
    createAttempt(t.db, { id: "att-1", runId: "lprun_1", taskId: "task-1" });
    t.db.prepare("UPDATE lane_pilot_attempt SET state=? WHERE id='att-1'").run(options.state ?? "accepted");
    const receipt = () => recordStage(t.db, { runId: "lprun_1", taskId: "task-1", stageId: "acceptance-receipt", state: "passed", input: "x" });
    const start = (engine = t.engine) => engine.start({ workflow: gateGraph, inputs: {}, link: { projectId: "proj", runId: "lprun_1", taskId: "task-1" } });
    return { ...t, receipt, start };
  }

  it("a passed receipt that is already there: the check is due, at once", async () => {
    const t = accepted();
    t.receipt();
    expect(await t.start().done).toMatchObject({ status: "succeeded", output: { run: true, url: "http://127.0.0.1:5173/" } });
  });

  it("no qa_cases and qa_url, or a task that did not end accepted: no check, at once", async () => {
    const plain = accepted({ contract: plainTask });
    expect(await plain.start().done).toMatchObject({ status: "succeeded", output: { run: false } });
    const rejected = accepted({ state: "rejected" });
    expect(await rejected.start().done).toMatchObject({ status: "succeeded", output: { run: false } });
  });

  it("a receipt that comes late is waited for, across a reload, and the check is then due exactly once", async () => {
    const t = accepted();
    const summary = await t.start().done;
    // Not skipped: the run waits on the receipt.
    expect(summary).toMatchObject({ status: "waiting" });
    expect(summary.waiting[0]).toMatchObject({ nodeId: "gate", await: { kind: "qa-receipt" } });
    const reloaded = t.newEngine();
    expect(await reloaded.poll()).toBe(0);
    expect(reloaded.get(summary.runId)?.status).toBe("waiting");
    t.receipt();
    expect(await reloaded.poll()).toBe(1);
    expect(reloaded.get(summary.runId)).toMatchObject({ status: "succeeded", output: { run: true, url: "http://127.0.0.1:5173/" } });
    expect(await reloaded.poll()).toBe(0);
  });

  it("a receipt that never comes ends the step failed with the reason, never as «no check»", async () => {
    const t = accepted();
    const summary = await t.start().done;
    const old = JSON.stringify({ kind: "qa-receipt", detail: { runId: "lprun_1", taskId: "task-1", attemptId: "att-1", startedAt: Date.now() - 31 * 60_000 }, partial: null });
    t.db.prepare("UPDATE lane_pilot_wf_step SET await_json=? WHERE run_id=? AND node_id='gate'").run(old, summary.runId);
    expect(await t.engine.poll()).toBe(1);
    expect(t.engine.get(summary.runId)).toMatchObject({ status: "failed", reason: "step_failed:gate", error: expect.stringContaining("qa_receipt_missing") });
    expect(t.engine.get(summary.runId)?.output).not.toMatchObject({ run: false });
  });
});
