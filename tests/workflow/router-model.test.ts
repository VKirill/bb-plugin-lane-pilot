import { describe, expect, it } from "vitest";
import { validateWorkflow } from "@lane-pilot/workflow-engine";
import { builtinWorkflow } from "../../src/rooms/workflow/builtin";
import { createRouterModel, registerRouterExecutor } from "../../src/rooms/workflow/server/workflow-router-model";
import { maybeNotifyWorkflowRun } from "../../src/rooms/workflow/server/pm-notice";
import { nightWorld } from "../night-graphs/world";

/**
 * The router's model step is a run of the built-in graph `lp.route`: the helper it starts carries the id of a real run and step of the journal, not a made-up
 * one (Astra's recheck of .341, F6: `route-<runId>` was counted as «inside a graph» by the daily coverage line).
 */
const answer = { choice: "code-review", confidence: 82, pattern: "review then fix", rejected: [{ id: "debug", reason: "no failing run" }, { nope: 1 }], questions: ["Which branch?", 7], handoff: "chose code-review" };
const CARD = { id: "code-review", name: "Code review", description: "d", examples: [], not_for: [], inputs: [], score: 0.9, rules: [] };

function setup(reply: (request: Record<string, any>) => Record<string, unknown> | Error = () => answer) {
  const w = nightWorld();
  const requests: Array<Record<string, any>> = [];
  registerRouterExecutor(w.engine, {
    run: async (request: Record<string, any>) => {
      requests.push(request);
      const out = reply(request);
      if (out instanceof Error) throw out;
      return { threadId: "thr-route", output: out, text: "", usage: { tokens: 120, costUsd: 0.01 } };
    },
  } as never);
  const rt = { ctx: w.ctx, services: w.services, pmThreadId: "thr-pm", projectId: "proj-1", runId: "lprun_1" } as never;
  const ask = (intent = "Review and fix the login", context?: string) => createRouterModel(rt, w.engine)({ intent, ...(context ? { context } : {}), candidates: [CARD] } as never);
  return { w, requests, ask };
}

describe("the router's model step as a graph", () => {
  it("lp.route is a built-in starter graph (offered to no one) that passes the validator", () => {
    const route = builtinWorkflow("lp.route")!;
    expect(route).toMatchObject({ id: "lp.route", startedBy: "lane_pilot_route", status: "published" });
    expect(route.nodes.find((node) => node.id === "route")).toMatchObject({ type: "agent", uses: "lp.route", role: "pm-reader" });
    expect(validateWorkflow(route).filter((problem) => problem.level === "error")).toEqual([]);
  });

  it("the helper is asked under the id of a real run and a real step, and the answer is the run's output", async () => {
    const { w, requests, ask } = setup();
    const out = await ask("Review and fix the login", "the repo is fresh");
    expect(out).toEqual({ choice: "code-review", confidence: 82, pattern: "review then fix", rejected: [{ id: "debug", reason: "no failing run" }], questions: ["Which branch?"] });
    const [run] = w.runs("lp.route");
    expect(run).toMatchObject({ status: "succeeded", workflow_id: "lp.route" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ workflowRunId: run!.id, workflowId: "lp.route", nodeId: "route", role: "pm-reader" });
    expect(requests[0]!.workflowRunId).not.toMatch(/^route-/);
    const step = w.db.prepare("SELECT state FROM lane_pilot_wf_step WHERE run_id=? AND step_key=?").get(requests[0]!.workflowRunId, requests[0]!.stepKey) as { state: string } | undefined;
    expect(step).toBeDefined();
    // The helper's spend is the run's.
    expect(w.db.prepare("SELECT tokens_used FROM lane_pilot_wf_run WHERE id=?").get(run!.id)).toMatchObject({ tokens_used: 120 });
  });

  it("asking the same question again finds the run; a run that failed is replaced by the next numbered one", async () => {
    let fail = true;
    const { w, requests, ask } = setup(() => (fail ? new Error("provider down") : answer));
    await expect(ask()).rejects.toThrow(/provider down/);
    expect(w.runs("lp.route").map((row) => row.status)).toEqual(["failed"]);
    fail = false;
    expect(await ask()).toMatchObject({ choice: "code-review" });
    expect(w.runs("lp.route").map((row) => row.status)).toEqual(["failed", "succeeded"]);
    await ask();
    expect(w.runs("lp.route")).toHaveLength(2);
    expect(requests).toHaveLength(2);
  });

  it("the run's end tells no one: no PM notice and no line on the owner's list", async () => {
    const { w, ask } = setup(() => new Error("provider down"));
    await expect(ask()).rejects.toThrow();
    const row = w.db.prepare("SELECT id, workflow_id, idem_key, parent_run_id, status, reason, link_run_id FROM lane_pilot_wf_run WHERE workflow_id='lp.route'").get() as never;
    const sent: unknown[] = [];
    const notified = await maybeNotifyWorkflowRun({ bb: { sdk: { threads: { send: async (m: unknown) => { sent.push(m); } } }, storage: { kv: { get: async () => null, set: async () => undefined } } } as never, log: () => undefined, run: row, pmThreadId: "thr-pm", startedBySchedule: false });
    expect(notified).toBe(false);
    expect(sent).toEqual([]);
  });
});
