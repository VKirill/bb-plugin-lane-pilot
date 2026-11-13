import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
const evalRunner = { load: () => ({ notes: [], questions: [], origin: "live" as const }), run: async () => ({ sizes: [], caveats: [] }) };
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../server";
import { LEAD_DEFAULTS } from "../src/rooms/lead/settings";
import { openDecision } from "../src/rooms/lead/server/journal";
import { addRoad, getRoad, listRoad, proposeRoad, roadPayload } from "../src/rooms/lead/server/road";
import { lanePilotProjectOrNotice } from "../src/rooms/self-repair/server";
import { createLeadService } from "../src/rooms/lead/server/service";
import { architectPrompt, graphlessErrands, hubSnapshot, processPartsOf, processStemOf, proposalDecisionId, proposalItemKey, registerLeadTickActions, seedForm, tickBrief } from "../src/rooms/lead/server/tick";
import { errandStem } from "../src/rooms/errands";
import { postOwnerItem } from "../src/rooms/owner-waiting";
import { migrations, openDatabase, saveProjectSetting } from "../src/rooms/plugin-db";

const NOW = Date.now();
let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "lead-gl-")); process.env.LANE_PILOT_LEAD_DIR = dir; });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); delete process.env.LANE_PILOT_LEAD_DIR; });

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
    expect(brief).toContain("Скрипт для:");
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
  project_id: "p_a", architectSeed: { form: "graph", kind: "computer", stem: "партия моделей арендованной gpu", threadIds: ["thr_1", "thr_2", "thr_3"], samples: ["Тест: партия"] },
  ...over,
});

describe("a process proposal with architectSeed", () => {
  it("lands on the road branch with the seed intact in payload_json; the same stem is never proposed twice", async () => {
    const { db, run } = steps([{ id: "p_a", name: "Alpha" }]);
    // risk high never acts even on a decides class (mayAct's guard), so the seed proposal still reaches the owner as a card.
    const out = await run("lp.lead_propose", { "$inputs.tickId": "tick_a", "think.proposals": [seedProposal({ risk: "high" })], "think.branches": [] });
    expect(out.output.proposed).toBe(1);
    const branch = listRoad(db).find((row) => row.kind === "option")!;
    expect(branch.state).toBe("proposed");
    expect(branch.class).toBe("process");
    expect(roadPayload(branch)).toEqual({ architectSeed: { form: "graph", kind: "computer", stem: "партия моделей арендованной gpu", threadIds: ["thr_1", "thr_2", "thr_3"], samples: ["Тест: партия"] } });
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
    laneProject: lanePilotProjectOrNotice,
      workflowEngine: { register: () => undefined, get: () => null },
      phaseIntake: { handOver: async () => { throw new Error("must not be called: a seeded process goes to the architect"); } },
    } as unknown as Services;
    const lead = createLeadService(createCore(bb, db), services, { load: () => ({ notes: [], questions: [], origin: "live" }), run: async () => ({ sizes: [], caveats: [] }) }, migrations);
    const seed = { form: "graph", kind: "computer", stem: "партия моделей арендованной gpu", threadIds: ["thr_1", "thr_2"], samples: ["Тест: партия моделей"] };
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

describe("the five forms (stream G/R8)", () => {
  it("every form round-trips through seedForm; anything else is refused, never bent into a graph", () => {
    for (const form of ["rule", "reference", "script", "skill", "graph"] as const) expect(seedForm({ form })).toBe(form);
    expect(seedForm({})).toBeNull();
    expect(seedForm({ form: "chart" })).toBeNull();
    expect(seedForm({ form: "Graph" })).toBeNull();
    expect(seedForm({ form: 42 })).toBeNull();
  });

  it("each form gets its own hand-over text and its own title stem; a formless seed takes the writer path", () => {
    const base = { stem: "ss-photo доставка", kind: "computer", threadIds: ["thr_1"], samples: ["ss-photo: выдать фотографии"], nearest: [{ kind: "skill", id: "selfystudio", score: 0.8 }] };
    expect(architectPrompt({ ...base, form: "rule" }, "Правило для: ss-photo доставка")).toContain("RULE");
    expect(architectPrompt({ ...base, form: "reference" }, "Справка для: ss-photo доставка")).toContain("references/");
    expect(architectPrompt({ ...base, form: "script" }, "Скрипт для: ss-photo доставка")).toContain("command sequence");
    expect(architectPrompt({ ...base, form: "skill" }, "Навык для: ss-photo доставка")).toMatch(/^Write a skill/u);
    expect(architectPrompt({ ...base, form: "graph" }, "Граф для: ss-photo доставка")).toMatch(/^Build a tested graph/u);
    for (const form of ["rule", "reference", "script", "skill"] as const) {
      const prompt = architectPrompt({ ...base, form }, "x");
      expect(prompt).toContain("nothing is written into the canon");
      expect(prompt).toContain("skill:selfystudio");
    }
    // A stored seed from before the five forms has no readable form: the writer path, not the architect.
    expect(architectPrompt({}, "Навык для: без формы")).toContain("Write a skill");
    expect(processStemOf("Навык для: Партия моделей")).toBe(processStemOf("Скрипт для: партия моделей"));
    expect(processStemOf("Справка для: Партия моделей")).toBe(processStemOf("Правило для: партия моделей"));
    expect(processPartsOf("Скрипт для: Партия моделей")).toEqual({ form: "script", stem: "партия моделей" });
    expect(processPartsOf("Другое предложение")).toEqual({ form: null, stem: "другое предложение" });
  });

  it("the dedupe key is form + stem: «Скрипт для: X» does not swallow «Навык для: X», the same pair twice does", async () => {
    const { db, run } = steps([{ id: "p_a", name: "Alpha" }]);
    const script = seedProposal({ title: "Скрипт для: партия моделей арендованной gpu", architectSeed: { form: "script", kind: "computer", stem: "партия моделей арендованной gpu", threadIds: ["thr_1"], samples: ["Партия"] } });
    const skill = seedProposal({ title: "Навык для: партия моделей арендованной gpu", architectSeed: { form: "skill", kind: "computer", stem: "партия моделей арендованной gpu", threadIds: ["thr_1"], samples: ["Партия"] } });
    const first = await run("lp.lead_propose", { "$inputs.tickId": "tick_s1", "think.proposals": [script, skill], "think.branches": [] });
    expect(first.output.proposed).toBe(2);
    const titles = listRoad(db).filter((row) => row.kind === "option").map((row) => row.title).sort();
    expect(titles).toEqual(["Навык для: партия моделей арендованной gpu", "Скрипт для: партия моделей арендованной gpu"]);
    // The same script again is refused; the same stem under the graph form is a different proposal.
    const again = await run("lp.lead_propose", { "$inputs.tickId": "tick_s2", "think.proposals": [script, seedProposal()], "think.branches": [] });
    expect(again.output.proposed).toBe(1);
    expect(listRoad(db).filter((row) => row.kind === "option")).toHaveLength(3);
    const dropped = JSON.parse(again.output.dropped_json as string) as Array<{ reason: string }>;
    expect(dropped.some((item) => item.reason.includes("already"))).toBe(true);
  });

  it("a process proposal with an unknown form is refused and logged, never routed to the architect", async () => {
    const { db, run } = steps([{ id: "p_a", name: "Alpha" }]);
    const out = await run("lp.lead_propose", { "$inputs.tickId": "tick_u", "think.proposals": [seedProposal({ architectSeed: { form: "origami", stem: "x" } })], "think.branches": [] });
    expect(out.output.proposed).toBe(0);
    expect(listRoad(db).filter((row) => row.kind === "option")).toHaveLength(0);
    const dropped = JSON.parse(out.output.dropped_json as string) as Array<{ reason: string }>;
    expect(dropped[0]!.reason).toContain("unknown process form");
  });
});


describe("process-key grouping and run signals (stream G/R8)", () => {
  type Db = ReturnType<typeof openDatabase>;
  const episode = (db: Db, runId: string, fields: Record<string, string> = {}) => {
    db.prepare(`INSERT INTO lane_pilot_errand_episode (run_id, extractor_version, project_id, workflow_id, status, outcome, created_at, updated_at) VALUES (?, 1, 'p_a', 'errand', 'succeeded', 'done', ?, ?)`)
      .run(runId, NOW, NOW);
    for (const [column, value] of Object.entries(fields)) db.prepare(`UPDATE lane_pilot_errand_episode SET ${column}=? WHERE run_id=?`).run(value, runId);
  };

  it("without the process-key columns the stem grouping stands; rows wait for the tick's nearest and hint", () => {
    const { db } = world();
    const rows = graphlessErrands(db, new Set(["p_a"]), NOW - 30 * 86_400_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ nearest: [], hint: null, signals: { repeatedTrace: null, providers: 0 } });
  });

  it("shadow mode groups by process_key_proposed; a confirmed process_key wins only when the setting is active", () => {
    const { db } = world();
    episode(db, "wf_1", { process_key_proposed: "selfystudio|photo|deliver" });
    episode(db, "wf_2", { process_key_proposed: "selfystudio|photo|deliver" });
    episode(db, "wf_3", { process_key_proposed: "other|key|here" });
    // Same stems, different proposed keys: the proposed key splits the old stem group in two, the singleton drops out.
    let rows = graphlessErrands(db, new Set(["p_a"]), NOW - 30 * 86_400_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "computer:selfystudio|photo|deliver", count30d: 2 });
    // Active: the confirmed key groups all three even though the proposed keys differ.
    for (const runId of ["wf_1", "wf_2", "wf_3"]) db.prepare("UPDATE lane_pilot_errand_episode SET process_key=? WHERE run_id=?").run("gpu|batch|run", runId);
    saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "episodes.process_key", "active");
    rows = graphlessErrands(db, new Set(["p_a"]), NOW - 30 * 86_400_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ key: "computer:gpu|batch|run", count30d: 3 });
  });

  it("the same tool+args sequence in three episodes is an ok script signal; a failed call makes it a trap; two is not enough", () => {
    const { db } = world();
    const seq = (ok: boolean) => JSON.stringify([{ tool: "bb", argsSha256: "a".repeat(64), ok }, { tool: "rsync", argsSha256: "b".repeat(64), ok }]);
    episode(db, "wf_1", { trace_json: seq(true), provider_id: "claude" });
    episode(db, "wf_2", { trace_json: seq(true), provider_id: "claude" });
    let rows = graphlessErrands(db, new Set(["p_a"]), NOW - 30 * 86_400_000);
    expect(rows[0]!.signals).toEqual({ repeatedTrace: null, providers: 1 });
    episode(db, "wf_3", { trace_json: seq(true), provider_id: "codex" });
    rows = graphlessErrands(db, new Set(["p_a"]), NOW - 30 * 86_400_000);
    expect(rows[0]!.signals).toEqual({ repeatedTrace: "ok", providers: 2 });
    for (const runId of ["wf_1", "wf_2", "wf_3"]) db.prepare("UPDATE lane_pilot_errand_episode SET trace_json=? WHERE run_id=?").run(seq(false), runId);
    rows = graphlessErrands(db, new Set(["p_a"]), NOW - 30 * 86_400_000);
    expect(rows[0]!.signals.repeatedTrace).toBe("failed");
  });
});
