import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it } from "vitest";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { setJevForTests } from "@lane-pilot/jev";
import { setSandboxProjects } from "../../src/rooms/owner-waiting";
import { answerDecision, getDecision, listDecisions } from "../../src/rooms/lead/server/journal";
import { addRoad, decideRoad, getRoad, listRoad, proposeRoad, rejectRoad } from "../../src/rooms/lead/server/road";
import { projectRoot, registerLeadTickActions } from "../../src/rooms/lead/server/tick";
import { openDatabase, saveProjectSetting } from "../../src/rooms/plugin-db";

/**
 * Executor-level tests of `lp.lead_propose` and `lp.lead_act`: a tiny engine that only stores the registered executors,
 * and a step context carrying only what the code reads — `resolve(ref)` over a refs map (with "$inputs.tickId" for the
 * tick id), `runId`, and `effect` that calls the function at once. Settings come from `lane_pilot_project_settings` at
 * project "*" exactly like production; `services` is stubbed at the two points act uses (phaseIntake.handOver,
 * workflowTriggers.pmOf). Everything else the executors touch is the real database.
 */
const world = (projects: Array<{ id: string; name: string }> = []) => {
  const { bb } = createFakePluginHost({ pluginId: "lane-pilot", sdk: { projects: { list: async () => projects } } as never });
  const db = openDatabase(bb);
  const executors = new Map<string, { run(c: unknown): Promise<{ output: Record<string, unknown> }> }>();
  const calls = { handOver: [] as unknown[], pmOf: [] as string[] };
  const services = {
    phaseIntake: { handOver: async (input: unknown) => { calls.handOver.push(input); return { started: false, kind: null, reason: "stubbed" }; } },
    workflowTriggers: { pmOf: async (projectId: string) => { calls.pmOf.push(projectId); return { pmThreadId: "thr_pm", runId: "lprun_pm" }; } },
  };
  registerLeadTickActions({ register: (name: string, executor: never) => { executors.set(name, executor); } } as never, { db, bb } as never, services as never);
  const run = (name: string, refs: Record<string, unknown>) =>
    executors.get(name)!.run({
      runId: "lprun_ticktest", stepKey: name, nodeId: name,
      resolve: (ref: string) => refs[ref],
      effect: (_key: string, _kind: string, fn: () => Promise<unknown>) => fn(),
    } as never);
  const zone = (projects_: string[]) => saveProjectSetting(db, GLOBAL_SETTINGS_PROJECT_ID, "lead.projects", projects_);
  const ownerItems = () => db.prepare("SELECT key, project_id, state FROM lane_pilot_owner_item").all() as Array<{ key: string; project_id: string | null; state: string }>;
  return { bb, db, run, zone, ownerItems, calls };
};

const shadowJev = (option: string | null = "yes", p = 0.9) => setJevForTests({ enabled: () => true, judge: async () => ({ by: "fallback", status: "shadow", decision: { option: null, p: 0 }, shadow: { decision: { option, p } } }) } as never);
const proposal = (over: Record<string, unknown> = {}) => ({
  title: "Close the stale branch", class: "next_step", risk: "low",
  why: "nothing moved for two weeks", evidence: [{ kind: "run", ref: "lprun_1" }], cost_estimate: "2h", ...over,
});
const propose = (run: ReturnType<typeof world>["run"], refs: Record<string, unknown>, tick = "tick_a") =>
  run("lp.lead_propose", { "$inputs.tickId": tick, "think.proposals": [], "think.branches": [], ...refs });
const dropped = async (out: Promise<{ output: Record<string, unknown> }>) => JSON.parse((await out).output.dropped_json as string) as Array<{ title: string; reason: string }>;

afterEach(() => setJevForTests(null));

describe("lp.lead_propose keeps a proposal inside the lead's zone", () => {
  it("drops a proposal whose project_id is outside lead.projects: no road row, no decision, no owner item", async () => {
    // Astra F-010a: the zone check must run before anything is written.
    const { db, run, zone, ownerItems } = world([{ id: "p_a", name: "A" }, { id: "p_out", name: "Out" }]);
    zone(["p_a"]);
    shadowJev();
    const list = await dropped(propose(run, { "think.proposals": [proposal({ project_id: "p_out" })] }));
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toContain("outside lead.projects");
    expect(listRoad(db)).toHaveLength(0);
    expect(listDecisions(db)).toHaveLength(0);
    expect(ownerItems()).toHaveLength(0);
  });

  it("drops a proposal on a sandbox project when the zone does not name it", async () => {
    // 0.1.460: a sandbox or bench project's rows never reach the owner, so its card would be invisible.
    setSandboxProjects(["p_bench"]);
    const { db, run, ownerItems } = world([{ id: "p_bench", name: "LP bench" }]);
    shadowJev();
    const list = await dropped(propose(run, { "think.proposals": [proposal({ project_id: "p_bench" })] }));
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toContain("sandbox");
    expect(listRoad(db)).toHaveLength(0);
    expect(listDecisions(db)).toHaveLength(0);
    expect(ownerItems()).toHaveLength(0);
  });

  it("a zone that names the sandbox project still fails at the owner's list: the branch ends rejected, its decision answered no by lane-pilot", async () => {
    // 0.1.460 card refused: lead.projects passes the zone check, but postOwnerItem still refuses the card —
    // the branch must not stay proposed with a question nobody sees.
    setSandboxProjects(["p_bench"]);
    const { db, run, zone, ownerItems } = world([{ id: "p_bench", name: "LP bench" }]);
    zone(["p_bench"]);
    shadowJev();
    const list = await dropped(propose(run, { "think.proposals": [proposal({ project_id: "p_bench", risk: "high" })] }));
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toContain("refused the card");
    const road = listRoad(db).find((row) => row.kind === "option")!;
    expect(road.state).toBe("rejected");
    const decision = getDecision(db, road.decision_id!)!;
    expect(decision).toMatchObject({ answered_by: "lane-pilot" });
    expect(JSON.parse(decision.answer_json!)).toMatchObject({ option: "no" });
    expect(ownerItems()).toHaveLength(0);
  });

  it("a «later» branch is proposed again under a new decision id and a new owner item", async () => {
    // Gemini F-002 / Astra F-002: the first presentation keeps `lead:<road>`; the re-presentation opens
    // `lead:<road>:<tick>` so the old «later» never swallows the new question.
    const { db, run, zone, ownerItems } = world([{ id: "p_a", name: "A" }]);
    zone(["p_a"]);
    shadowJev();
    // risk high never acts (mayAct's guard), so the proposal still goes to the owner as a card.
    await propose(run, { "think.proposals": [proposal({ project_id: "p_a", risk: "high" })] }, "tick_a");
    const road = listRoad(db).find((row) => row.kind === "option")!;
    expect(road.decision_id).toBe(`lead:${road.id}`);
    answerDecision(db, `lead:${road.id}`, { option: "later" }, "owner");
    decideRoad(db, road.id, "later");
    expect(getRoad(db, road.id)!.state).toBe("later");
    await propose(run, { "think.proposals": [proposal({ road_id: road.id, risk: "high" })] }, "tick_b");
    const again = getRoad(db, road.id)!;
    expect(again.state).toBe("proposed");
    expect(again.decision_id).toBe(`lead:${road.id}:tick_b`);
    expect(getDecision(db, `lead:${road.id}:tick_b`)).toMatchObject({ answered_at: null });
    expect(ownerItems().map((item) => item.key)).toContain(`lead:${road.id}:tick_b`);
  });

  it("an existing branch keeps its own project whatever the proposal's project_id says", async () => {
    // Astra F-003/F-010b: the journal row and the owner's card must carry the branch's project, not the agent's.
    for (const claimed of [null, "p_other"] as Array<string | null>) {
      const { db, run, zone, ownerItems } = world([{ id: "p_a", name: "A" }, { id: "p_other", name: "Other" }]);
      zone(["p_a", "p_other"]);
      shadowJev();
      const branch = addRoad(db, { title: "An open direction", kind: "direction", source: "lead", why: "the owner wants it kept", projectId: "p_a" });
      await propose(run, { "think.proposals": [proposal({ road_id: branch.id, project_id: claimed, risk: "high" })] });
      expect(getDecision(db, `lead:${branch.id}`)).toMatchObject({ project_id: "p_a" });
      const card = ownerItems().find((item) => item.key === `lead:${branch.id}`)!;
      expect(card.project_id).toBe("p_a");
      expect(getRoad(db, branch.id)!.project_id).toBe("p_a");
    }
  });
});

describe("lp.lead_act re-reads the branch and the rights before acting", () => {
  it("defers a branch rejected between propose and act, posts no owner item for it, and hands nothing over", async () => {
    // Astra H-001: the act step must not act on a state that no longer is proposed — and must not post the withheld
    // card either (a question nobody asked), unlike the other deferral paths.
    const { db, run, zone, ownerItems, calls } = world([{ id: "p_a", name: "A" }]);
    zone(["p_a"]);
    const root = projectRoot(db, "p_a", "A", 1);
    const branch = addRoad(db, { parentId: root.id, projectId: "p_a", title: "Ship paid plans", kind: "option", source: "lead", why: "users asked for it twice" });
    proposeRoad(db, branch.id, `lead:${branch.id}`);
    rejectRoad(db, branch.id, "the owner killed it himself", "owner");
    const actable = JSON.stringify([{ roadId: branch.id, decisionId: `lead:${branch.id}`, class: "next_step", risk: "low", projectId: "p_a", title: branch.title, why: "users asked", cost: "2h", evidence: [], tickId: "tick_a", payload: null }]);
    const out = await run("lp.lead_act", { "$inputs.tickId": "tick_b", "propose.actable_json": actable });
    const deferred = JSON.parse(out.output.deferred_json as string) as Array<{ roadId: string; reason: string }>;
    expect(deferred).toHaveLength(1);
    expect(deferred[0]).toMatchObject({ roadId: branch.id });
    expect(deferred[0]!.reason).toContain("not proposed");
    expect(ownerItems()).toHaveLength(0);
    expect(calls.handOver).toHaveLength(0);
    expect(calls.pmOf).toHaveLength(0);
    expect(getRoad(db, branch.id)!.state).toBe("rejected");
  });
});

describe("think.branches stays inside the zone too", () => {
  it("writes no road row for a branch of a project outside lead.projects or of a sandbox project", async () => {
    // Astra F-010c: the tree is bound to lead.projects like the proposals.
    setSandboxProjects(["p_bench"]);
    const { db, run, zone } = world([{ id: "p_a", name: "A" }, { id: "p_out", name: "Out" }, { id: "p_bench", name: "LP bench" }]);
    zone(["p_a"]);
    const out = await propose(run, { "think.branches": [
      { title: "Outside direction", kind: "direction", why: "a reason long enough to pass", project_id: "p_out" },
      { title: "Bench direction", kind: "direction", why: "a reason long enough to pass", project_id: "p_bench" },
      { title: "In-zone direction", kind: "direction", why: "a reason long enough to pass", project_id: "p_a" },
    ] });
    expect(out.output.branches_added).toBe(1);
    expect(listRoad(db).map((row) => row.project_id)).toEqual(["p_a"]);
    // And with an empty zone the sandbox branch is skipped while a normal project is written.
    const { db: db2, run: run2 } = world([{ id: "p_b", name: "B" }, { id: "p_bench", name: "LP bench" }]);
    const out2 = await propose(run2, { "think.branches": [
      { title: "Bench direction", kind: "direction", why: "a reason long enough to pass", project_id: "p_bench" },
      { title: "Normal direction", kind: "direction", why: "a reason long enough to pass", project_id: "p_b" },
    ] });
    expect(out2.output.branches_added).toBe(1);
    expect(listRoad(db2).map((row) => row.project_id)).toEqual(["p_b"]);
  });
});
