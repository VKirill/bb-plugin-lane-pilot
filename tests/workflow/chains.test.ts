import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { NodeExecutor, StepContext } from "@lane-pilot/workflow-engine";
import { lowerWorkflow } from "@lane-pilot/workflow-engine";
import type { Workflow } from "@lane-pilot/workflow-engine";
import { loadWorkflowStore } from "@lane-pilot/workflow-engine";
import type { WorkflowStore } from "@lane-pilot/workflow-engine";
import { loadWorkflow, validateWorkflow } from "@lane-pilot/workflow-engine";
import { BUILTIN_SOURCES } from "../../src/rooms/workflow/builtin";
import { engineOn, journalDb, ok, rows, stepStates, wf } from "./engine-helpers";

/**
 * Chains of the chains spec (workflow-chains-spec.md) converted to JSON with the spec's own spelling: lp.analyze, lp.plan,
 * lp.build, lp.review, lp.close (the internal fragments) and analyze-plan-execute, review-fix, x-to-telegram-digest. Two edits
 * to the spec text, both defects the validator found: review-fix passed a `note` input lp.review does not have, and the join of
 * x-to-telegram-digest names its reducer (`uses`), which the default reducer cannot be for counts.
 */
const dir = join(__dirname, "../../workflows");
const load = (): Promise<WorkflowStore> => loadWorkflowStore({ builtin: BUILTIN_SOURCES });

describe("chains of the spec in JSON", () => {
  it("all load and validate against each other", async () => {
    const store = await load();
    expect(store.problems.map((item) => [item.source, item.problems.filter((problem) => problem.level === "error").map((problem) => problem.message)])).toEqual([]);
    expect(store.list().map((item) => item.workflow.id)).toEqual(expect.arrayContaining(["analyze-plan-execute", "lp.analyze", "lp.build", "lp.close", "lp.plan", "lp.review", "review-fix", "x-to-telegram-digest"]));
  });

  it("carries what the spec asked of the schema", async () => {
    const store = await load();
    const get = (id: string) => store.get(id)!.workflow;
    expect(get("lp.build").internal).toBe(true);
    expect(get("review-fix").not_for).toContain("code-review");
    expect(get("x-to-telegram-digest")).toMatchObject({ triggers: [{ type: "chat" }, { type: "schedule" }, { type: "manual" }], budget: { maxCostUsd: 3, maxWallSeconds: 3600, maxSteps: 30 }, guards: { maxFanOut: 4 } });
    // Skipping by quality mode and by condition, with a typed output for the skipped node.
    const analyze = get("analyze-plan-execute").nodes.find((node) => node.id === "qa")!;
    expect(analyze).toMatchObject({ applicable_modes: ["full"], skip_when: "!plan.has_ui", skip_out: { status: "pass" } });
    // The value of a node input by quality mode.
    const call = get("analyze-plan-execute").nodes.find((node) => node.id === "analyze")!;
    expect((call as { with: Record<string, unknown> }).with.depth).toEqual({ by_mode: { quick: "quick", standard: "standard", full: "deep" } });
    // for_each: a list by input, a filter with where, a table by mode.
    const review = get("lp.review").nodes;
    expect(review.find((node) => node.id === "confirm")).toMatchObject({ for_each: "dims.findings where severity in [critical, high]", join: { policy: "majority" }, child: { votes: 3 } });
    expect(get("x-to-telegram-digest").nodes.find((node) => node.id === "score")).toMatchObject({ for_each: "dedupe.items", batch_size: 10, max_fan_out: 4 });
    // visits() and $inputs and $mode in conditions.
    const whens = get("analyze-plan-execute").edges.map((edge) => edge.when).filter((when): when is string => typeof when === "string");
    expect(whens.some((when) => when.includes("visits('replan_failed') == 0"))).toBe(true);
    expect(whens.some((when) => when.includes("$inputs.wants_roadmap"))).toBe(true);
    expect(get("lp.analyze").edges.some((edge) => typeof edge.when === "string" && edge.when.includes("$mode == 'full'"))).toBe(true);
  });

  it("lowers the all-in-one parallel to a fan-out, a branch body and a join that keeps the node's id", async () => {
    const store = await load();
    const lowered = lowerWorkflow(store.get("x-to-telegram-digest")!.workflow, store.resolve);
    const ids = lowered.nodes.map((node) => node.id);
    expect(ids).toEqual(expect.arrayContaining(["score:fan", "score:child", "score"]));
    expect(lowered.nodes.find((node) => node.id === "score")).toMatchObject({ type: "join", parallel: "score:fan", uses: "reduce.x-to-telegram-digest.score" });
    expect(lowered.edges).toContainEqual(expect.objectContaining({ from: "dedupe", to: "score:fan" }));
    expect(lowered.edges).toContainEqual(expect.objectContaining({ from: "score", to: "summarize" }));
    expect(lowered.edges).toContainEqual(expect.objectContaining({ from: "$start", to: "collect" }));
    // An emit node ends the workflow: an edge to the exit carries the workflow outputs it gives.
    const sent = lowered.edges.find((edge) => edge.from === "sent" && edge.to === "$end")!;
    expect(Object.keys(sent.with ?? {}).sort()).toEqual(["archive_path", "items_count", "kept_count", "message_id", "status", "summary_md", "thin"]);
  });

  it("finds the defects of a chain at save time: a skipped node others read, an unknown field, an enum value it can never hold", async () => {
    const store = await load();
    const base = JSON.parse(JSON.stringify(store.get("x-to-telegram-digest")!.workflow)) as Workflow;
    const edit = (change: (workflow: Workflow) => void) => {
      const copy = JSON.parse(JSON.stringify(base)) as Workflow;
      change(copy);
      return validateWorkflow(copy, { resolve: store.resolve }).filter((problem) => problem.level === "error").map((problem) => problem.code);
    };
    expect(edit(() => undefined)).toEqual([]);
    expect(edit((workflow) => { delete (workflow.nodes.find((node) => node.id === "approve_send") as { skip_out?: unknown }).skip_out; })).toContain("skip_out_missing");
    expect(edit((workflow) => { workflow.edges.find((edge) => edge.from === "collect" && edge.to === "ask_blocked")!.when = "collect.state == 'blocked'"; })).toContain("condition_field");
    expect(edit((workflow) => { workflow.edges.find((edge) => edge.from === "collect" && edge.to === "ask_blocked")!.when = "collect.status == 'missing'"; })).toContain("condition_value");
    expect(edit((workflow) => { workflow.edges.find((edge) => edge.from === "collect" && edge.to === "widen")!.when = "visits('nope') < 2"; })).toContain("condition");
    expect(edit((workflow) => { workflow.edges.find((edge) => edge.from === "collect" && edge.to === "widen")!.when = "collect.count < $inputs.nothing"; })).toContain("condition_field");
    expect(edit((workflow) => { workflow.edges.find((edge) => edge.from === "collect" && edge.to === "widen")!.when = "collect.count <"; })).toContain("bad_expr");
    // A loop with neither maxVisits nor a visits() condition is refused.
    expect(edit((workflow) => {
      for (const node of workflow.nodes) delete (node as { maxVisits?: number }).maxVisits;
      workflow.edges.find((edge) => edge.from === "collect" && edge.to === "widen")!.when = "collect.count < $inputs.min_items";
      workflow.edges.find((edge) => edge.from === "ask_thin" && edge.to === "widen")!.when = "ask_thin.answer_kind == 'widen'";
    })).toContain("cycle_unbounded");
  });

  it("the JSON the loader reads is the same value whether it comes as text or as an object", () => {
    const text = readFileSync(join(dir, "review-fix.json"), "utf8");
    const a = loadWorkflow(text), b = loadWorkflow(JSON.parse(text));
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.workflow).toEqual(b.workflow);
  });
});

// ---------------------------------------------------------------- x-to-telegram-digest, run on stubs (its test.sim)

const posts = (count: number, dupes = 0) => Array.from({ length: count }, (_, index) => ({ url: `https://x.example/p/${index % Math.max(1, count - dupes)}`, text: `post ${index}` }));

function stubs(world: { collect: unknown[]; sent: string[]; log: string[] }) {
  const agent: NodeExecutor = { reentrant: true, run: async (ctx: StepContext) => {
    world.log.push(ctx.nodeId);
    const done = (output: Record<string, unknown>) => ({ output: { handoff: `${ctx.nodeId} done`, ...output } });
    switch (ctx.nodeId) {
      case "collect": return done({ items: world.collect, count: world.collect.length, status: "done", reason: "" });
      case "widen": return done({ query: "design systems OR design-system", period: "30d" });
      case "score:child": return done({ scores: (ctx.input.item as unknown[]).map((item) => ({ item, keep: true })) });
      case "summarize": return done({ summary_md: "# Digest", top: [], themes: ["a", "b"], quote_count: 3 });
      default: throw new Error(`no stub for ${ctx.nodeId}`);
    }
  } };
  const action = (name: string, fn: (ctx: StepContext) => Record<string, unknown>): [string, NodeExecutor] => [name, ok(fn)];
  return {
    agent,
    ...Object.fromEntries([
      action("items.dedupe", () => { const items = [...new Map((world.collect as Array<{ url: string }>).map((item) => [item.url, item])).values()]; return { items, count: items.length }; }),
      action("digest.check", () => ({ ok: true, violations: [], parts: 1 })),
      action("telegram.send_rich", () => { world.sent.push("sent"); return { message_id: "stub-1", message_url: "", status: "ok" }; }),
      action("fs.write", () => ({ archive_path: ".lane-pilot/digests/x" })),
    ]),
    "reduce.x-to-telegram-digest.score": ok((ctx) => {
      const kept = (ctx.input.with.results as Array<{ scores: Array<{ item: unknown }> }>).flatMap((row) => row.scores.map((score) => score.item));
      return { kept, topics: ["design"], kept_count: kept.length };
    }),
  } as Record<string, NodeExecutor>;
}

describe("x-to-telegram-digest runs on stubs, as its test.sim says", () => {
  const start = async (collect: unknown[], inputs: Record<string, unknown> = {}) => {
    const store = await load();
    const world = { collect, sent: [] as string[], log: [] as string[] };
    const db = journalDb();
    const engine = engineOn(db, stubs(world), { resolveWorkflow: store.resolve });
    const started = engine.start({ workflow: store.get("x-to-telegram-digest")!.workflow, inputs: { query: "дизайн-системы", chat: "me", ...inputs } });
    return { engine, db, world, started, summary: await started.done };
  };

  it("collects, dedupes, scores in batches, writes, checks, sends and archives; the confirmation is skipped by its input", async () => {
    const { db, world, summary } = await start(posts(34, 3));
    expect(summary).toMatchObject({ status: "succeeded", output: { status: "sent", items_count: 31, kept_count: 31, message_id: "stub-1", thin: false } });
    expect(world.sent).toEqual(["sent"]);
    const states = stepStates(db, summary.runId);
    expect(Object.keys(states).filter((key) => key.startsWith("score:child"))).toHaveLength(4);
    expect(states["approve_send#1"]).toBe("skipped");
    const path = rows<{ node_id: string }>(db, "SELECT node_id FROM lane_pilot_wf_step WHERE run_id=? AND state IN ('succeeded','skipped') ORDER BY rowid", summary.runId).map((row) => row.node_id);
    expect(path.filter((id) => !id.startsWith("score:"))).toEqual(["collect", "dedupe", "score", "summarize", "check", "approve_send", "send", "archive", "sent"]);
  });

  it("with few posts it widens twice, asks the owner, and ends as a thin digest", async () => {
    const { engine, db, world, summary } = await start(posts(4));
    expect(summary.status).toBe("waiting");
    expect(summary.waiting[0]).toMatchObject({ nodeId: "ask_thin", await: { kind: "human" } });
    expect(world.log.filter((id) => id === "widen")).toHaveLength(2);
    expect(world.log.filter((id) => id === "collect")).toHaveLength(3);
    await engine.resolve(summary.runId, summary.waiting[0]!.stepKey, { answer: "", answer_kind: "send_thin" });
    expect(engine.get(summary.runId)).toMatchObject({ status: "succeeded", output: { status: "thin_sent", thin: true, items_count: 4 } });
    expect(world.sent).toEqual(["sent"]);
    expect(rows(db, "SELECT 1 FROM lane_pilot_wf_event WHERE run_id=? AND kind='edge_skipped'", summary.runId)).toEqual([]);
  });

  it("the owner can abort the thin digest: nothing is sent", async () => {
    const { engine, world, summary } = await start(posts(4));
    await engine.resolve(summary.runId, summary.waiting[0]!.stepKey, { answer: "", answer_kind: "abort" });
    expect(engine.get(summary.runId)).toMatchObject({ status: "succeeded", output: { status: "aborted" } });
    expect(world.sent).toEqual([]);
  });

  it("a human question whose answer kinds include timeout is answered by the clock", async () => {
    let now = 1_000_000;
    const store = await load();
    const world = { collect: posts(4), sent: [] as string[], log: [] as string[] };
    const db = journalDb();
    const engine = engineOn(db, stubs(world), { resolveWorkflow: store.resolve, now: () => now });
    const first = await engine.start({ workflow: store.get("x-to-telegram-digest")!.workflow, inputs: { query: "q", chat: "me" } }).done;
    expect(first.status).toBe("waiting");
    now += 241 * 60_000;
    await engine.poll();
    expect(engine.get(first.runId)).toMatchObject({ status: "succeeded", output: { status: "aborted" } });
  });

  it("with the confirmation on, an edit sends the digest back to its author in the same session, at most twice more", async () => {
    const { engine, world, summary } = await start(posts(34), { confirm_before_send: true });
    expect(summary.waiting[0]).toMatchObject({ nodeId: "approve_send" });
    await engine.resolve(summary.runId, summary.waiting[0]!.stepKey, { answer: "shorter", answer_kind: "edit" });
    const again = engine.get(summary.runId)!;
    expect(again.waiting[0]).toMatchObject({ nodeId: "approve_send" });
    expect(world.log.filter((id) => id === "summarize")).toHaveLength(2);
    await engine.resolve(summary.runId, again.waiting[0]!.stepKey, { answer: "", answer_kind: "send" });
    expect(engine.get(summary.runId)).toMatchObject({ status: "succeeded", output: { status: "sent" } });
  });
});

describe("modes and typed skips", () => {
  const analyze = async (mode: string) => {
    const store = await load();
    const ran: string[] = [];
    const h = { handoff: "done" };
    const agent: NodeExecutor = { reentrant: true, run: async (ctx) => {
      ran.push(ctx.nodeId);
      if (ctx.nodeId === "gather") return { output: { anchors: [], modules: [], conventions: [], summary: "s", ...h } };
      if (ctx.nodeId === "assess") return { output: { decisions: [], risks: [], scores_min: 90, scope_verdict: "small", recommendation: "go", confidence: 90, stalled: false, pressure_pass: true, open_questions: [], residual_risks: [], ...h } };
      return { output: { consensus: [], conflicts: [], unique: [], consensus_level: 80, ...h } };
    } };
    const engine = engineOn(journalDb(), { agent }, { resolveWorkflow: store.resolve });
    const summary = await engine.start({ workflow: store.get("lp.analyze")!.workflow, inputs: { goal: "g" }, mode: mode as "quick" | "standard" | "full" }).done;
    return { summary, ran };
  };

  it("$mode picks the branch: the second opinion runs in full mode only", async () => {
    for (const mode of ["quick", "standard"]) {
      const { summary, ran } = await analyze(mode);
      expect(summary).toMatchObject({ status: "succeeded", output: { scope_verdict: "small", confidence: 90 } });
      expect(ran).toEqual(["gather", "assess"]);
    }
    const full = await analyze("full");
    expect(full.summary.status).toBe("succeeded");
    expect(full.ran).toEqual(["gather", "assess", "second_opinion"]);
  });

  it("a node outside its modes is skipped with the typed output skip_out gives, and the path goes on", async () => {
    const workflow = wf({
      outputs: [{ name: "level", type: "number" }],
      nodes: [
        { id: "think", type: "agent", prompt: "x", out: { text: "string" } },
        { id: "extra", type: "agent", prompt: "y", applicable_modes: ["full"], skip_out: { level: 100 }, out: { level: "int", text: "string" } },
        { id: "done", type: "action", action: "emit", map: { level: "extra.level" } },
      ],
      edges: [{ from: "start", to: "think" }, { from: "think", to: "extra" }, { from: "extra", to: "done", when: "extra.level >= 50" }, { from: "extra", to: "done" }],
      entry: undefined,
    });
    const seen: string[] = [];
    const agent: NodeExecutor = { reentrant: true, run: async (ctx) => { seen.push(ctx.nodeId); return { output: ctx.nodeId === "think" ? { text: "t", handoff: "h" } : { level: 7, text: "u", handoff: "h" } }; } };
    const quick = engineOn(journalDb(), { agent }, {});
    const skipped = await quick.start({ workflow, inputs: { query: "q" }, mode: "quick" }).done;
    expect(skipped).toMatchObject({ status: "succeeded", output: { level: 100 } });
    expect(seen).toEqual(["think"]);
    seen.length = 0;
    const full = await engineOn(journalDb(), { agent }, {}).start({ workflow, inputs: { query: "q" }, mode: "full" }).done;
    expect(full.output).toEqual({ level: 7 });
    expect(seen).toEqual(["think", "extra"]);
  });

  it("a condition on a node that never ran fails the run closed", async () => {
    const workflow = wf({
      outputs: [{ name: "level", type: "number" }],
      nodes: [
        { id: "a", type: "action", action: "a", out: { level: "int" } },
        { id: "b", type: "action", action: "b", out: { level: "int" } },
        { id: "c", type: "action", action: "c", out: { level: "int" } },
        { id: "done", type: "action", action: "emit", map: { level: "c.level" } },
      ],
      edges: [{ from: "start", to: "a" }, { from: "a", to: "b", when: "a.level > 5" }, { from: "a", to: "c" }, { from: "b", to: "c" },
        { from: "c", to: "done", when: "b.level > 1" }, { from: "c", to: "done" }],
    });
    const executors = { a: ok(() => ({ level: 1 })), b: ok(() => ({ level: 9 })), c: ok(() => ({ level: 3 })) };
    const run = await engineOn(journalDb(), executors, {}).start({ workflow, inputs: { query: "q" } }).done;
    expect(run.status).toBe("failed");
    expect(run.reason).toContain("condition_field_missing:c");
  });
});
