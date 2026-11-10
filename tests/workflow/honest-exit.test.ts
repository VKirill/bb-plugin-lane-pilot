import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { engineOwnsOutcome, outputFields, parseAgentOutput, parseWorkflow } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, ok, rows, wf } from "./engine-helpers";

// The hand-off standard (docs/guide/handoff.md): an agent says itself whether the step's result exists. Before it, a step whose
// agent could not do the work still had to fill every declared field, and the graph went on with the invented values.
const flow = (out: Array<Record<string, unknown>> = [{ name: "text", type: "string" }], extra: Record<string, unknown> = {}) => wf({
  nodes: [{ id: "search", type: "action", action: "search", output: [{ name: "items", type: "array" }] }, { id: "write", type: "agent", prompt: "Write.", output: out, ...extra }],
  edges: [{ from: "start", to: "search", with: { query: "input.query" } }, { from: "search", to: "write", with: { items: "search.items" } }, { from: "write", to: "end", with: { result: "write.handoff" } }],
});
const search = ok(() => ({ items: ["a"] }));
const run = (answer: Record<string, unknown>, workflow = flow()) => {
  const db = journalDb();
  let calls = 0;
  const engine = engineOn(db, { search, agent: ok(() => { calls += 1; return answer; }) });
  return engine.start({ workflow, inputs: { query: "q" } }).done.then((summary) => ({ summary, db, calls: () => calls }));
};

describe("the agent's own outcome", () => {
  it("is asked of every agent step, and a step that routes on a worker state of its own keeps that one", () => {
    const names = (workflow: ReturnType<typeof flow>) => (outputFields(workflow, workflow.nodes[1]!) as Array<{ name: string }>).map((field) => field.name);
    expect(names(flow())).toEqual(["text", "handoff", "outcome", "blocker"]);
    expect(names(flow([{ name: "status", type: "enum", values: ["done", "blocked"] }]))).toEqual(["status", "handoff"]);
    expect(names(flow([{ name: "status", type: "enum", values: ["pass", "rework", "block"] }]))).toEqual(["status", "handoff", "outcome", "blocker"]);
  });

  it("the shipped graphs: 24 agent nodes route on a blocked status of their own, every other one gets the engine's outcome", () => {
    let own = 0, engine = 0;
    for (const file of readdirSync(join(__dirname, "../../workflows")).filter((name) => name.endsWith(".json"))) {
      const workflow = parseWorkflow(JSON.parse(readFileSync(join(__dirname, "../../workflows", file), "utf8")));
      for (const node of workflow.nodes) {
        if (node.type !== "agent") continue;
        if ((outputFields(workflow, node) as Array<{ name: string }>).some((field) => field.name === "outcome" && engineOwnsOutcome(node))) engine += 1; else own += 1;
      }
    }
    expect({ own, engine }).toEqual({ own: 24, engine: 241 });
  });

  it("done, partial and no outcome at all (an executor that builds its output in code) leave the step succeeded", async () => {
    for (const outcome of ["done", "partial", undefined]) {
      const { summary, db } = await run({ text: "t", handoff: "wrote it", ...(outcome ? { outcome } : {}) });
      expect(summary.status).toBe("succeeded");
      const receipt = JSON.parse(rows<{ receipt_json: string }>(db, "SELECT receipt_json FROM lane_pilot_wf_step WHERE node_id='write'")[0]!.receipt_json);
      expect(receipt.outcome).toBe(outcome);
    }
  });

  it("blocked stops the run with what the agent needs, without the other fields and without another attempt", async () => {
    const { summary, calls } = await run({ outcome: "blocked", handoff: "read the config, no key", blocker: { needs: "the API key of the shop", from: "owner", fallback: "draft without prices" } },
      flow([{ name: "text", type: "string" }], { maxAttempts: 3 }));
    expect(summary).toMatchObject({ status: "failed", reason: "agent_blocked:write", error: "write: needs the API key of the shop from owner", failedNode: "write" });
    expect(calls()).toBe(1);
  });

  it("failed stops the run with the agent's own words", async () => {
    const { summary } = await run({ outcome: "failed", handoff: "the repository has no such module" });
    expect(summary).toMatchObject({ status: "failed", reason: "agent_failed:write", error: "write: the repository has no such module" });
  });

  it("an exit still owes the handoff, and a done answer still owes every field", async () => {
    expect((await run({ outcome: "failed" })).summary.reason).toBe("handoff_missing:write");
    expect((await run({ outcome: "done", handoff: "h" })).summary.reason).toBe("output_invalid:write");
  });

  it("a graph that declares the outcome routes on it itself, and its contract does not ask a blocked agent for an artifact", async () => {
    const own = wf({
      nodes: [{ id: "search", type: "action", action: "search", output: [{ name: "items", type: "array" }] },
        { id: "write", type: "agent", prompt: "Write.", output: [{ name: "text", type: "string" }, { name: "outcome", type: "enum", values: ["done", "blocked"] }], gates: ["write.text != ''"] }],
      edges: [{ from: "start", to: "search", with: { query: "input.query" } }, { from: "search", to: "write", with: { items: "search.items" } },
        { from: "write", to: "end", with: { result: "write.handoff" } }],
    });
    const { summary } = await run({ outcome: "blocked", handoff: "waiting for the owner" }, own);
    expect(summary).toMatchObject({ status: "succeeded", output: { result: "waiting for the owner" } });
  });

  it("the answer reader keeps the outcome and the blocker", () => {
    const fields = outputFields(flow(), flow().nodes[1]!) as never;
    expect(parseAgentOutput('I looked.\n```json\n{"outcome":"blocked","handoff":"h","blocker":{"needs":"x","from":"pm"}}\n```', fields)).toEqual({ outcome: "blocked", handoff: "h", blocker: { needs: "x", from: "pm" } });
  });
});
