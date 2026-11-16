import { describe, expect, it } from "vitest";
import type { NodeExecutor, StepContext, Workflow, WorkflowEdge } from "@lane-pilot/workflow-engine";
import { validateWorkflow } from "@lane-pilot/workflow-engine";
import { engineOn, journalDb, ok, rows, wf } from "./engine-helpers";
import { read } from "../../packages/workflow-engine/src/step-read";

/**
 * `ctx.answers.<humanNode>` — the settled outputs of every visit of a named HUMAN node in the current run and scope
 * chain, oldest first: `[{ step_key, scope, visit, output }]`. Needed by spec-phase's score<->ask loop: `ask.answer`
 * resolves latest-visit-only (step-read.ts latestNodeStep), so earlier owner rounds are unreachable without this seam.
 * These are settled step rows visible at read time — a rerun may reset them; this is not immutable history.
 *
 * Contract under test (stage 2 implements; today every positive case fails):
 *  - validation: `ctx.answers.<id>` requires `<id>` to be a human node of this workflow (expr.ts CTX_VARS +
 *    checkRef + validate.ts consumer check); bare `ctx.answers` (no node) and non-human/missing nodes are errors.
 *    engine.start runs preflight -> validateWorkflow (engine-start.ts:39), so an invalid ref never reaches runtime:
 *    authoring rejection is proven by validateWorkflow tests, runtime rejection only via programmatic ctx.resolve.
 *  - runtime: the read is bound against the saved definition's node type (engine.compiled(run).nodes), not a
 *    node-id string filter, so ctx.resolve cannot expose an agent/action node's output.
 *  - shape: engine-owned step_key/scope/visit metadata wraps each output (an output field named `visit` or
 *    `step_key` cannot overwrite provenance); `answer_kind` incl. `timeout` survives verbatim.
 */

type Row = Record<string, unknown>;

const ASK_OUT = [
  { name: "answer", type: "string" },
  { name: "answer_kind", type: "enum", values: ["answered", "timeout"] },
];

const askNode = (out: unknown[] = ASK_OUT) => ({ id: "ask", type: "human", question: "Round?", options: ["a", "b"], out });
const routeNode = () => ({ id: "route", type: "action", action: "ah.route", out: [{ name: "more", type: "boolean" }] });
const sinkNode = () => ({ id: "sink", type: "agent", prompt: "collect the answers", out: [{ name: "ok", type: "boolean" }] });
const doneNode = (map: Row = { collected: "sink.ok" }) => ({ id: "done", type: "action", action: "emit", map });

/** ask -> route -> (ask again while route.more && visits('ask')<2) -> sink(with) -> done. */
const loopGraph = (sinkWith: Row, askOut: unknown[] = ASK_OUT): Workflow => wf({
  inputs: [{ name: "query", type: "string" }],
  outputs: [{ name: "collected", type: "json" }],
  nodes: [askNode(askOut), routeNode(), sinkNode(), doneNode()],
  edges: [
    { from: "start", to: "ask" },
    { from: "ask", to: "route" },
    { from: "route", to: "ask", when: "route.more == true && visits('ask') < 2" },
    { from: "route", to: "sink", with: sinkWith },
    { from: "sink", to: "done" },
  ],
});

/** route -> sink(with); `ask` is declared and wired both ways but route.more is always false — zero ask visits. */
const orphanGraph = (sinkWith: Row): Workflow => wf({
  inputs: [{ name: "query", type: "string" }],
  outputs: [{ name: "collected", type: "json" }],
  nodes: [askNode(), routeNode(), sinkNode(), doneNode()],
  edges: [
    { from: "start", to: "route" },
    { from: "route", to: "ask", when: "route.more == true && visits('ask') < 2" },
    { from: "ask", to: "route" },
    { from: "route", to: "sink", with: sinkWith },
    { from: "sink", to: "done" },
  ],
});

/** src(agent) -> probe(action): the executor programmatically ctx.resolve("ctx.answers.src") — the graph itself
 *  carries no ctx.answers ref, so preflight passes; rejection must happen at the read against the saved definition. */
const resolveGraph = (): Workflow => wf({
  inputs: [{ name: "query", type: "string" }],
  outputs: [{ name: "collected", type: "json" }],
  nodes: [
    { id: "src", type: "agent", prompt: "produce", out: [{ name: "secret", type: "string" }] },
    { id: "probe", type: "action", action: "ah.probe", out: [{ name: "got", type: "string" }] },
    doneNode({ collected: "probe.got" }),
  ],
  edges: [
    { from: "start", to: "src" },
    { from: "src", to: "probe" },
    { from: "probe", to: "done" },
  ],
});

const routeSeq = (seq: boolean[]): NodeExecutor => {
  let calls = 0;
  return ok(() => ({ more: seq[Math.min(calls++, seq.length - 1)] }));
};

const capturingSink = (seen: unknown[]): NodeExecutor => ok((ctx: StepContext) => {
  seen.push(ctx.input.with.answers);
  return { ok: true, handoff: "collected" };
});

const start = async (workflow: Workflow, executors: Record<string, NodeExecutor>) => {
  const db = journalDb();
  const engine = engineOn(db, executors);
  const started = engine.start({ workflow, inputs: { query: "q" } });
  return { db, engine, started, first: await started.done };
};

const answerWaiting = async (engine: ReturnType<typeof engineOn>, runId: string, waiting: Array<{ stepKey: string }>, output: Row) => {
  await engine.resolve(runId, waiting[0]!.stepKey, output);
  return engine.get(runId)!;
};

describe("ctx.answers.<humanNode> runtime transport", () => {
  it("two ask visits: ordered [{step_key,scope,visit,output}] with answer_kind incl. timeout preserved", async () => {
    const seen: unknown[] = [];
    const { engine, first } = await start(loopGraph({ answers: "ctx.answers.ask" }), {
      "ah.route": routeSeq([true, false]), agent: capturingSink(seen),
    });
    expect(first.status).toBe("waiting");
    expect(first.waiting[0]).toMatchObject({ nodeId: "ask" });
    const second = await answerWaiting(engine, first.runId, first.waiting, { answer: "first", answer_kind: "answered" });
    expect(second.status).toBe("waiting");
    expect(second.waiting[0]).toMatchObject({ nodeId: "ask" });
    await answerWaiting(engine, first.runId, second.waiting, { answer: "", answer_kind: "timeout" });
    expect(engine.get(first.runId)).toMatchObject({ status: "succeeded" });
    expect(seen).toHaveLength(1);
    const answers = seen[0] as Row[];
    expect(answers).toHaveLength(2);
    expect(answers[0]).toMatchObject({ step_key: "ask#1", scope: "", visit: 1, output: { answer: "first", answer_kind: "answered" } });
    expect(answers[1]).toMatchObject({ step_key: "ask#2", scope: "", visit: 2, output: { answer: "", answer_kind: "timeout" } });
  });

  it("zero visits of the named human node delivers []", async () => {
    const seen: unknown[] = [];
    const { first } = await start(orphanGraph({ answers: "ctx.answers.ask" }), {
      "ah.route": routeSeq([false]), agent: capturingSink(seen),
    });
    expect(first.status).toBe("succeeded");
    expect(seen).toEqual([[]]);
  });

  it("metadata is engine-owned: output fields named visit/step_key/scope/output cannot overwrite it", async () => {
    const colliding = [...ASK_OUT,
      { name: "visit", type: "number" }, { name: "step_key", type: "string" },
      { name: "scope", type: "string" }, { name: "output", type: "json" }];
    const seen: unknown[] = [];
    const { engine, first } = await start(loopGraph({ answers: "ctx.answers.ask" }, colliding), {
      "ah.route": routeSeq([false]), agent: capturingSink(seen),
    });
    await answerWaiting(engine, first.runId, first.waiting, {
      answer: "c", answer_kind: "answered", visit: 999, step_key: "bogus", scope: "bogus", output: { fake: true },
    });
    expect(engine.get(first.runId)).toMatchObject({ status: "succeeded" });
    const answers = seen[0] as Row[];
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ step_key: "ask#1", scope: "", visit: 1 });
    expect((answers[0]!.output as Row).step_key).toBe("bogus");
    expect((answers[0]!.output as Row).visit).toBe(999);
  });

  it("journal fixture: rows of a foreign run and of a sibling scope never leak into the read", async () => {
    const db = journalDb();
    const seen: unknown[] = [];
    const engine = engineOn(db, { "ah.route": routeSeq([false]), agent: capturingSink(seen) });
    // Journal fixture (clearly marked): settled 'ask' rows that must be invisible — one of another run, one of a sibling scope.
    const now = Date.now();
    const fixture = db.prepare(`INSERT INTO lane_pilot_wf_step(run_id,step_key,origin,node_id,visit,scope,state,input_json,output_json,routed,ended_at,updated_at)
      VALUES (?,?,?,?,?,?,'succeeded','{}',?,1,?,?)`);
    fixture.run("foreign-run", "ask#1", "fx", "ask", 1, "", JSON.stringify({ answer: "foreign", answer_kind: "answered" }), now, now);
    const started = engine.start({ workflow: loopGraph({ answers: "ctx.answers.ask" }), inputs: { query: "q" } });
    const first = await started.done;
    expect(first.status).toBe("waiting");
    fixture.run(first.runId, "ask#77", "fx-sibling", "ask", 77, "siblingbranch", JSON.stringify({ answer: "sibling", answer_kind: "answered" }), now, now);
    await answerWaiting(engine, first.runId, first.waiting, { answer: "mine", answer_kind: "answered" });
    expect(engine.get(first.runId)).toMatchObject({ status: "succeeded" });
    const answers = seen[0] as Row[];
    expect(answers.map((entry) => (entry.output as Row).answer)).toEqual(["mine"]);
    for (const [index, state] of ["failed", "skipped", "canceled", "waiting", "pending"].entries()) {
      const key = `ask#${80 + index}`;
      fixture.run(first.runId, key, key, "ask", 80 + index, "", JSON.stringify({ answer: state }), now, now);
      db.prepare("UPDATE lane_pilot_wf_step SET state=? WHERE run_id=? AND step_key=?").run(state, first.runId, key);
    }
    for (const [index, scope] of ["left", "left/nested", "left/nested/child", "right"].entries()) {
      fixture.run(first.runId, `ask#${90 + index}`, `scope-${index}`, "ask", 90 + index, scope, JSON.stringify({ answer: scope }), now, now);
    }
    db.prepare("UPDATE lane_pilot_wf_step SET scope=? WHERE run_id=? AND node_id='sink'").run("left/nested", first.runId);
    const run = engine.journal.getRun(first.runId)!;
    const sink = engine.journal.steps(first.runId).find((step) => step.node_id === "sink")!;
    const branch = read(engine, run, sink, "ctx.answers.ask") as Array<{ output: { answer: string } }>;
    expect(branch.map((entry) => entry.output.answer)).toEqual(["mine", "left", "left/nested"]);
    expect(read(engine, run, sink, "ctx.answers.ask.length")).toBe(3);
    engine.dispose();
  });

  it("rerun replaces current settled answers instead of retaining an immutable history", async () => {
    const seen: unknown[] = [];
    const { engine, first } = await start(loopGraph({ answers: "ctx.answers.ask" }), {
      "ah.route": routeSeq([false]), agent: capturingSink(seen),
    });
    await answerWaiting(engine, first.runId, first.waiting, { answer: "old", answer_kind: "answered" });
    expect(engine.get(first.runId)?.status).toBe("succeeded");
    expect(await engine.rerunNode(first.runId, "ask")).toMatchObject({ ok: true });
    await engine.idle();
    expect(read(engine, engine.journal.getRun(first.runId)!, null, "ctx.answers.ask")).toEqual([]);
    const waiting = engine.get(first.runId)!;
    await answerWaiting(engine, first.runId, waiting.waiting, { answer: "replacement", answer_kind: "answered" });
    expect(engine.get(first.runId)?.status).toBe("succeeded");
    expect(seen.at(-1)).toEqual([{ step_key: "ask#1", scope: "", visit: 1, output: { answer: "replacement", answer_kind: "answered" } }]);
    engine.dispose();
  });
});

describe("ctx.answers validation", () => {
  /** A VALID parsed workflow is built first (parseWorkflow would reject the bad ref itself); only then is the declared
   *  edge ref mutated to the value under test, so validateWorkflow — not the parser — is what judges it. */
  const validRefGraph = (target: { id: string; node: Row; validRef: string }): Workflow => wf({
    inputs: [{ name: "query", type: "string" }],
    outputs: [{ name: "collected", type: "json" }],
    nodes: [target.node, sinkNode(), doneNode()],
    edges: [
      { from: "start", to: target.id },
      { from: target.id, to: "sink", with: { answers: target.validRef } },
      { from: "sink", to: "done" },
    ],
  });

  const withRef = (workflow: Workflow, ref: string): Workflow => {
    const edge = (workflow.edges as WorkflowEdge[]).find((candidate) => candidate.to === "sink")!;
    (edge.with as Record<string, string>).answers = ref;
    return workflow;
  };

  const answerProblems = (workflow: Workflow) =>
    validateWorkflow(workflow).filter((problem) => problem.level === "error" && problem.message.includes("answers"));

  const humanTarget = { id: "ask", validRef: "ask.answer", node: askNode() };
  const agentTarget = { id: "src", validRef: "src.secret", node: { id: "src", type: "agent", prompt: "p", out: [{ name: "secret", type: "string" }] } };

  it("accepts ctx.answers.<humanNode> on a human node", () => {
    const problems = answerProblems(withRef(validRefGraph(humanTarget), "ctx.answers.ask"));
    expect(problems).toEqual([]);
  });

  it("rejects ctx.answers.<agentNode> — history is for human nodes only", () => {
    const problems = answerProblems(withRef(validRefGraph(agentTarget), "ctx.answers.src"));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => /human/i.test(problem.message))).toBe(true);
  });

  it("rejects ctx.answers.<missingNode>", () => {
    const problems = answerProblems(withRef(validRefGraph(humanTarget), "ctx.answers.ghost"));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => /human|not a node|unknown/i.test(problem.message))).toBe(true);
  });

  it("rejects bare ctx.answers — the path must name a node, no all-nodes dump", () => {
    const problems = answerProblems(withRef(validRefGraph(humanTarget), "ctx.answers"));
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => /human|node|named/i.test(problem.message))).toBe(true);
  });

  it("checks conditions through the same human-only contract and rejects unsupported suffixes", () => {
    for (const [target, expected] of [[humanTarget, false], [agentTarget, true]] as const) {
      const graph = validRefGraph(target);
      graph.edges.find((edge) => edge.to === "sink")!.when = `ctx.answers.${target.id}.length > 0`;
      expect(answerProblems(graph).some((problem) => /human/.test(problem.message))).toBe(expected);
    }
    expect(answerProblems(withRef(validRefGraph(humanTarget), "ctx.answers.ask.secret"))).not.toEqual([]);
  });
});

describe("ctx.answers runtime rejection of non-human nodes", () => {
  it("programmatic ctx.resolve cannot expose an agent node's output as answers — the read itself rejects", async () => {
    // The workflow is fully valid (no ctx.answers ref in the graph); the ref lives only inside the executor, so
    // preflight passes and the rejection must come from the read bound against the saved definition.
    let probeRan = false;
    const probe = ok((ctx: StepContext) => {
      probeRan = true;
      return { got: String(ctx.resolve("ctx.answers.src") ?? "NONE") };
    });
    const db = journalDb();
    const engine = engineOn(db, {
      agent: ok(() => ({ secret: "agent-output", handoff: "produced" })),
      "ah.probe": probe,
    });
    const summary = await engine.start({ workflow: resolveGraph(), inputs: { query: "q" } }).done;
    const runRows = rows<{ status: string; reason: string | null }>(db, "SELECT status, reason FROM lane_pilot_wf_run WHERE id=?", summary.runId);
    const stepRows = rows<{ step_key: string; node_id: string; state: string; error: string | null; output_json: string | null }>(
      db, "SELECT step_key, node_id, state, error, output_json FROM lane_pilot_wf_step WHERE run_id=? ORDER BY rowid", summary.runId);
    const diag = `run=${JSON.stringify(runRows)} steps=${JSON.stringify(stepRows)}`;
    expect(probeRan, `probe never ran — earlier step failed; ${diag}`).toBe(true);
    expect(summary.status, diag).toBe("failed");
    const probeSteps = stepRows.filter((step) => step.node_id === "probe");
    expect(probeSteps.every((step) => step.state !== "succeeded" || !String(step.output_json).includes("agent-output")), diag).toBe(true);
    expect(probeSteps.some((step) => /answers|human/i.test(step.error ?? "")), diag).toBe(true);
  });
});
