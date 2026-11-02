import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setJevForTests } from "@lane-pilot/jev";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../src/rooms/core/server";
import { LEAD_DEFAULTS } from "../src/rooms/lead/settings";
import { openDecision } from "../src/rooms/lead/server/journal";
import { addRoad, getRoad, listRoad, proposeRoad, roadPayload } from "../src/rooms/lead/server/road";
import { createLeadService } from "../src/rooms/lead/server/service";
import { architectPrompt, errandStem, graphlessErrands, hubSnapshot, processStemOf, proposalDecisionId, proposalItemKey, registerLeadTickActions, seedForm, tickBrief } from "../src/rooms/lead/server/tick";
import { postOwnerItem } from "../src/rooms/owner-waiting";
import { openDatabase, saveProjectSetting } from "../src/rooms/storage/database";

const NOW = Date.now();
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lead-gl-")); process.env.LANE_PILOT_LEAD_DIR = dir; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.LANE_PILOT_LEAD_DIR; setJevForTests(null); });

/** Five errand runs: three sharing one stem, one routed at 95 confidence, one 40 days old. */
function world(projects: Array<{ id: string; name: string }> = [{ id: "p_a", name: "Alpha" }]) {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { projects: { list: async () => projects } } as never });
  const db = openDatabase(bb);
  const seed = (run: { id: string; inputs: Record<string, unknown>; ago?: number; thread?: string; cost?: number }) => {
    const at = NOW - (run.ago ?? 60_000);
    db.prepare(`INSERT INTO lane_pilot_wf_run (id, workflow_id, workflow_version, workflow_sha256, definition_json, project_id, link_run_id, status, reason, inputs_json, output_json, tokens_used, cost_micro_usd, created_at, updated_at)
      VALUES (?, 'errand', 1, 'sha', '{}', 'p_a', ?, 'succeeded', NULL, ?, '{"state":"done"}', 1000, ?, ?, ?)`)
      .run(run.id, null, JSON.stringify(run.inputs), Math.round((run.cost ?? 0) * 1e6), at, at + 30_000);
    if (run.thread) db.prepare("INSERT INTO lane_pilot_wf_effect (id, run_id, step_key, effect_key, kind, state, result_json, created_at, updated_at) VALUES (?, ?, 'work', 'spawn', 'errand.spawn', 'done', ?, ?, ?)")
      .run(`eff_${run.id}`, run.id, JSON.stringify({ threadId: run.thread, browserMachine: null }), at, at);
  };
  seed({ id: "wf_1", thread: "thr_1", cost: 0.5, inputs: { title: "Тест: партия моделей на арендованной GPU", kind: "computer" } });
  seed({ id: "wf_2", thread: "thr_2", cost: 0.25, inputs: { title: "Партия 2-5-10-50 моделей на арендованной GPU (Opus)", kind: "computer" } });
  seed({ id: "wf_3", thread: "thr_3", cost: 0.25, inputs: { task: "Партия моделей на арендованной GPU через MCP\nDetails follow", kind: "computer" } });
  seed({ id: "wf_4", inputs: { title: "Счёт и отложенное сообщение в Telegram", routeTop: "invoice-send:95" } });
  seed({ id: "wf_5", ago: 40 * 86_400_000, inputs: { title: "Партия моделей на арендованной GPU", kind: "computer" } });
  return { bb, db };
}

describe("the snapshot's graphless list (stream G2)", () => {
  it("groups 30-day errand runs without a confident route by (kind, stem); a routed and an old run stay out", async () => {
    const { db, bb } = world();
    expect(errandStem("Тест: партия моделей на арендованной GPU")).toBe("партия моделей арендованной gpu");
    expect(errandStem("Партия 2-5-10-50 моделей на арендованной GPU (Opus)")).toBe("партия моделей арендованной gpu");
    expect(errandStem("Партия моделей на арендованной GPU через MCP")).toBe("партия моделей арендованной gpu");
    const rows = graphlessErrands(db, new Set(["p_a"]), NOW - 30 * 86_400_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "computer:партия моделей арендованной gpu", kind: "computer", count30d: 3, projects: ["p_a"], threadIds: ["thr_1", "thr_2", "thr_3"] });
    expect(rows[0]!.costUsd).toBeCloseTo(1, 5);
    expect(rows[0]!.samples).toHaveLength(3);
    const snapshot = await hubSnapshot({ db, bb } as never, { ...LEAD_DEFAULTS, projects: [] }, { tickId: "tick_g", trigger: "manual" }, NOW);
    expect(snapshot.graphless).toEqual(rows);
  });

  it("a run outside the zone and a run routed below 90 follow the rules: the first is out, the second counts", () => {
    const { db } = world([]);
    // No projects listed: the zone is empty, a run of p_a is out of it.
    expect(graphlessErrands(db, new Set(), NOW - 30 * 86_400_000)).toHaveLength(0);
    // A route under 90 confidence is not a route: the run joins its stem's group.
    db.prepare("UPDATE lane_pilot_wf_run SET inputs_json=? WHERE id='wf_4'").run(JSON.stringify({ title: "Партия моделей на арендованной GPU снова", kind: "computer", routeTop: "invoice-send:60" }));
    const rows = graphlessErrands(db, new Set(["p_a"]), NOW - 30 * 86_400_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "computer:партия моделей арендованной gpu", count30d: 4 });
  });

  it("the think brief carries the graphless rule and the rows", async () => {
    const { db, bb } = world();
    const snapshot = await hubSnapshot({ db, bb } as never, { ...LEAD_DEFAULTS, projects: [] }, { tickId: "tick_g", trigger: "manual" }, NOW);
    const brief = tickBrief(snapshot, "# Штурман");
    expect(brief).toContain("graphless");
    expect(brief).toContain("Граф для:");
    expect(brief).toContain("architectSeed");
    expect(brief).toContain("партия моделей арендованной gpu");
    expect(brief).toContain("count30d");
  });
});

/** Executor-level world, the same shape as tests/lead/tick-steps.test.ts. */
const steps = (projects: Array<{ id: string; name: string }> = []) => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { projects: { list: async () => projects } } as never });
  const db = openDatabase(bb);
  const executors = new Map<string, { run(c: unknown): Promise<{ output: Record<string, unknown> }> }>();
  registerLeadTickActions({ register: (name: string, executor: never) => { executors.set(name, executor); } } as never, { db, bb } as never,
    { phaseIntake: { handOver: async () => ({ started: false, reason: "stubbed" }) }, workflowTriggers: { pmOf: async () => ({ pmThreadId: "thr_pm", runId: "lprun_pm" }) } } as never);
  const run = (name: string, refs: Record<string, unknown>) =>
    executors.get(name)!.run({ runId: "lprun_gl", stepKey: name, nodeId: name, resolve: (ref: string) => refs[ref], effect: (_k: string, _t: string, fn: () => Promise<unknown>) => fn() } as never);
  saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "lead.projects", projects.map((project) => project.id));
  return { db, run };
};

const seedProposal = (over: Record<string, unknown> = {}) => ({
  title: "Граф для: партия моделей арендованной gpu", class: "process", risk: "low",
  why: "три одинаковых поручения за месяц, доллар на каждое", evidence: [{ kind: "run", ref: "thr_1" }], cost_estimate: "$1/month",
  project_id: "p_a", architectSeed: { kind: "computer", stem: "партия моделей арендованной gpu", threadIds: ["thr_1", "thr_2", "thr_3"], samples: ["Тест: партия"] },
  ...over,
});

describe("a process proposal with architectSeed", () => {
  it("lands on the road branch with the seed intact in payload_json; the same stem is never proposed twice", async () => {
    const { db, run } = steps([{ id: "p_a", name: "Alpha" }]);
    setJevForTests({ enabled: () => true, judge: async () => ({ by: "fallback", status: "shadow", decision: { option: null, p: 0 }, shadow: { decision: { option: "yes", p: 0.9 } } }) } as never);
    // risk high never acts even on a decides class (mayAct's guard), so the seed proposal still reaches the owner as a card.
    const out = await run("lp.lead_propose", { "$inputs.tickId": "tick_a", "think.proposals": [seedProposal({ risk: "high" })], "think.branches": [] });
    expect(out.output.proposed).toBe(1);
    const branch = listRoad(db).find((row) => row.kind === "option")!;
    expect(branch.state).toBe("proposed");
    expect(branch.class).toBe("process");
    expect(roadPayload(branch)).toEqual({ architectSeed: { kind: "computer", stem: "партия моделей арендованной gpu", threadIds: ["thr_1", "thr_2", "thr_3"], samples: ["Тест: партия"] } });
    // The waiting card carries the architect button next to да / потом / нет.
    const item = db.prepare("SELECT actions_json FROM lane_pilot_owner_item WHERE key=?").get(proposalItemKey(`lead:${branch.id}`)) as { actions_json: string };
    const actions = JSON.parse(item.actions_json) as Array<{ id: string; rpc?: { method: string; input: Record<string, unknown> } }>;
    expect(actions.map((action) => action.id)).toEqual(["yes", "later", "no", "architect"]);
    expect(actions[3]!.rpc).toEqual({ method: "prepare_native_session", input: { projectId: "p_a", agentId: "workflow-architect" } });
    // A second tick with the same stem adds no second branch (the title is the dedupe, in any state).
    const again = await run("lp.lead_propose", { "$inputs.tickId": "tick_b", "think.proposals": [seedProposal({ risk: "high" })], "think.branches": [] });
    expect(again.output.proposed).toBe(0);
    expect(listRoad(db).filter((row) => row.kind === "option")).toHaveLength(1);
    const dropped = JSON.parse(again.output.dropped_json as string) as Array<{ reason: string }>;
    expect(dropped[0]!.reason).toContain("already proposed");
  });
});

describe("«да» on a seeded process proposal", () => {
  it("hands the seed to the Workflow architect through the owner's list, not to the PM intake", async () => {
    const { bb } = createFakePluginHost({ pluginId: "lane-pilot" });
    const db = openDatabase(bb);
    const services = {
      workflowTriggers: { start: async () => ({ ok: true, runId: "wf_1" }), pmOf: async () => ({ pmThreadId: "thr_pm", runId: "lprun_pm" }) },
      docsPlaces: async () => [],
      workflowEngine: { register: () => undefined, get: () => null },
      phaseIntake: { handOver: async () => { throw new Error("must not be called: a seeded process goes to the architect"); } },
    } as unknown as Services;
    const lead = createLeadService(createCore(bb, db), services);
    const seed = { kind: "computer", stem: "партия моделей арендованной gpu", threadIds: ["thr_1", "thr_2"], samples: ["Тест: партия моделей"] };
    addRoad(db, { id: "d1", title: "Grow", kind: "direction", source: "lead", why: "growth" }, 1);
    addRoad(db, { id: "o1", parentId: "d1", projectId: "p_a", title: "Граф для: партия моделей арендованной gpu", kind: "option", source: "lead", why: "три поручения за месяц", class: "process", payload: { architectSeed: seed } }, 2);
    const decisionId = proposalDecisionId("o1");
    openDecision(db, { id: decisionId, surface: "lead", class: "process", situation: { title: "o1" }, options: ["yes", "later", "no"] }, 3);
    proposeRoad(db, "o1", decisionId, 4);
    postOwnerItem(db, { key: proposalItemKey("o1"), source: "lead", kind: "proposal", what: "o1", why: "три поручения" }, 4);
    const result = await lead.decide("o1", "yes", "да", "owner", 10);
    expect(result).toMatchObject({ ok: true, handover: { state: "started", via: "architect", id: "workflow-architect" } });
    expect(getRoad(db, "o1")!.state).toBe("accepted");
    const item = db.prepare("SELECT kind, state, why, actions_json FROM lane_pilot_owner_item WHERE key='lead-handed:o1'").get() as { kind: string; state: string; why: string; actions_json: string };
    expect(item).toMatchObject({ kind: "handed", state: "open" });
    expect(item.why).toContain("партия моделей арендованной gpu");
    expect(item.why).toContain("@thread:thr_1");
    const actions = JSON.parse(item.actions_json) as Array<{ id: string; rpc?: { method: string; input: Record<string, unknown> } }>;
    expect(actions[0]).toMatchObject({ id: "architect", rpc: { method: "prepare_native_session", input: { projectId: "p_a", agentId: "workflow-architect" } } });
  });
});

describe("skill before graph (harness batch 2026-11-02)", () => {
  it("a seed names its form; a skill is written, a graph is built; the two titles of one stem are one process", () => {
    expect(seedForm({})).toBe("graph");
    expect(seedForm({ form: "skill" })).toBe("skill");
    const skill = architectPrompt({ form: "skill", stem: "партия моделей", kind: "devops", threadIds: ["thr_1"], samples: ["Партия моделей на GPU"] }, "Навык для: партия моделей");
    expect(skill).toMatch(/^Write a skill/u);
    expect(skill).toContain("SKILL.md");
    expect(skill).toContain("@thread:thr_1");
    expect(architectPrompt({ form: "graph", stem: "счёт" }, "Граф для: счёт")).toMatch(/^Build a tested graph/u);
    expect(architectPrompt({}, "Навык для: без формы")).toContain("«без формы»");
    expect(processStemOf("Навык для: Партия моделей")).toBe(processStemOf("Граф для: партия моделей"));
    expect(processStemOf("Другое предложение")).toBe("другое предложение");
  });
});

