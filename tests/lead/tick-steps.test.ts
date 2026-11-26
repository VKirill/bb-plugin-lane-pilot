import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { GLOBAL_SETTINGS_PROJECT_ID } from "@lane-pilot/settings-catalog";
import { setSandboxProjects } from "../../src/rooms/owner-waiting";
import { addRoad, getRoad, listRoad, registerLeadTickActions } from "../../src/rooms/lead/server";
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

const proposal = (over: Record<string, unknown> = {}) => ({
  title: "Close the stale branch", class: "next_step", risk: "low",
  why: "nothing moved for two weeks", evidence: [{ kind: "run", ref: "lprun_1" }], cost_estimate: "2h", ...over,
});
const propose = (run: ReturnType<typeof world>["run"], refs: Record<string, unknown>, tick = "tick_a") =>
  run("lp.lead_propose", { "$inputs.tickId": tick, "think.proposals": [], "think.branches": [], ...refs });
const dropped = async (out: Promise<{ output: Record<string, unknown> }>) => JSON.parse((await out).output.dropped_json as string) as Array<{ title: string; reason: string }>;



describe("lp.lead_propose keeps a proposal inside the lead's zone", () => {
  it("drops a proposal whose project_id is outside lead.projects: no road row, no owner item", async () => {
    // Astra F-010a: the zone check must run before anything is written.
    const { db, run, zone, ownerItems } = world([{ id: "p_a", name: "A" }, { id: "p_out", name: "Out" }]);
    zone(["p_a"]);
    const list = await dropped(propose(run, { "think.proposals": [proposal({ project_id: "p_out" })] }));
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toContain("outside lead.projects");
    expect(listRoad(db)).toHaveLength(0);
    expect(ownerItems()).toHaveLength(0);
  });

  it("drops a proposal on a sandbox project when the zone does not name it", async () => {
    // 0.1.460: a sandbox or bench project's rows never reach the owner.
    setSandboxProjects(["p_bench"]);
    const { db, run, ownerItems } = world([{ id: "p_bench", name: "LP bench" }]);
    const list = await dropped(propose(run, { "think.proposals": [proposal({ project_id: "p_bench" })] }));
    expect(list).toHaveLength(1);
    expect(list[0]!.reason).toContain("sandbox");
    expect(listRoad(db)).toHaveLength(0);
    expect(ownerItems()).toHaveLength(0);
  });

  it("writes accepted proposals only to the road / evolve ledger and never to lane_pilot_owner_item", async () => {
    const { db, run, zone, ownerItems } = world([{ id: "p_a", name: "A" }]);
    zone(["p_a"]);
    const out = await propose(run, { "think.proposals": [proposal({ project_id: "p_a", risk: "high" })] });
    expect(out.output.proposed).toBe(1);
    const roads = listRoad(db, { projectId: "p_a", state: "proposed" });
    expect(roads).toHaveLength(1);
    expect(roads[0]).toMatchObject({ title: "Close the stale branch", state: "proposed", project_id: "p_a" });
    expect(ownerItems()).toHaveLength(0);
  });

  it("an existing branch keeps its own project whatever the proposal's project_id says, with zero owner cards posted", async () => {
    for (const claimed of [null, "p_other"] as Array<string | null>) {
      const { db, run, zone, ownerItems } = world([{ id: "p_a", name: "A" }, { id: "p_other", name: "Other" }]);
      zone(["p_a", "p_other"]);
      const branch = addRoad(db, { title: "An open direction", kind: "direction", source: "lead", why: "the owner wants it kept", projectId: "p_a" });
      await propose(run, { "think.proposals": [proposal({ road_id: branch.id, project_id: claimed, risk: "high" })] });
      expect(ownerItems()).toHaveLength(0);
      expect(getRoad(db, branch.id)!.project_id).toBe("p_a");
    }
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
