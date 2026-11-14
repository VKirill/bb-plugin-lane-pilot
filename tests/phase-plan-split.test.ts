import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import { createCore } from "../src/rooms/core/server/core";
import type { Services } from "../server";
import { createPhaseDriver } from "./phase-driver";
import { planGate, planSignature, waveProblems, withComputedWaves, type PlanItem } from "../src/rooms/phase/logic";
import { getPhase, savePhase } from "../src/rooms/phase/store";
import { createAttempt, createRun, openDatabase } from "../src/rooms/plugin-db";

// The owner's rule for a big plan (ТЗ sma-parity 4д) on the phase path: the waves are computed from depends_on, a cycle is a plan error
// before anything is issued, and a piece is issued once its own dependencies are accepted — a broken piece holds only its dependents.
const OFF = { branch: "phase/test", trees: {}, off: "no phase branch in this test" };
const piece = (id: string, dependsOn: string[] = [], wave?: number): PlanItem => ({ id, title: id, wave: wave as number, promise: { given: "g", when: "w", then: "t" },
  task: { id, owns_paths: [`notes/${id}.md`], verification: [{ command: `grep -q ${id} notes/${id}.md` }], acceptance: ["the note exists"], depends_on: dependsOn } });

describe("[sma:p2_waves] a phase plan whose waves cannot be computed is not admitted", () => {
  it("a cycle among the pieces is named by the plan gate; pieces on it get no wave", () => {
    const items = withComputedWaves([piece("a", ["c"]), piece("b", ["a"]), piece("c", ["b"]), piece("free")]);
    expect(items.map((item) => [item.id, item.wave])).toEqual([["a", 0], ["b", 0], ["c", 0], ["free", 1]]);
    const why = waveProblems(items);
    expect(why[0]).toBe("the pieces depend on each other in a cycle (a → c → b → a): no wave can be computed for them — drop the link that is not a real output dependency");
    expect(why).toContain("a has no wave: a piece's wave is computed from its depends_on, submit it without one");
    const sha = planSignature(items, "ctx");
    const gate = planGate({ context: { docs: [], sha: "ctx", signedAt: 1 }, plan: { items, contextSha: "ctx", sha } } as never);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.why.join("\n")).toContain("cycle (a → c → b → a)");
  });

  it("[sma:bf_waves] pieces submitted without a wave get the wave their links give; a given wave stays an address", () => {
    const items = withComputedWaves([piece("d", ["b", "c"]), piece("b", ["a"]), piece("c", ["a"]), piece("a"), piece("e", [], 4)]);
    expect(items.map((item) => [item.id, item.wave])).toEqual([["d", 3], ["b", 2], ["c", 2], ["a", 1], ["e", 4]]);
    expect(waveProblems(items)).toEqual([]);
  });
});

describe("[sma:p4_deps] the phase issues a piece when its own dependencies are accepted", () => {
  it("diamond with a failed piece in the middle: D waits for C's redo; B, the independent E and G (which needs only B) are not held", async () => {
    const { bb, harness } = createFakePluginHost({ pluginId: "lane-pilot" });
    harness.sdk.stub("threads.send", async () => ({}));
    harness.sdk.stub("threads.get", async () => ({ status: "active", environmentId: "env_pm" }));
    harness.sdk.stub("environments.get", async () => ({ path: "/work/bot", hostId: "h1" }));
    const db = openDatabase(bb);
    createRun(db, "run1", "projA");
    const sent: string[] = [];
    const services = { dispatchWriter: async (input: { task: Record<string, unknown> }) => { sent.push(String(input.task.id)); return { taskId: input.task.id, runId: "run1" }; }, runBudgets: { get: () => undefined } } as unknown as Services;
    const phases = createPhaseDriver(createCore(bb, db), services).phases;
    const opened = await phases.open({ projectId: "projA", pmThreadId: "thr_pm", title: "Diamond", goal: "six notes" });
    // The planner wrote no waves: they are laid out from depends_on.
    const items = withComputedWaves([piece("a"), piece("b", ["a"]), piece("c", ["a"]), piece("d", ["b", "c"]), piece("e"), piece("f", ["d"]), piece("g", ["b"])]);
    expect(items.map((item) => item.wave)).toEqual([1, 2, 2, 3, 1, 4, 3]);
    const sha = planSignature(items, "ctx");
    savePhase(db, opened.id, { stage: "execution", runId: "run1", record: { ...opened.record, candidate: OFF, plan: { items, contextSha: "ctx", sha, admittedSha: sha, critique: { decision: "approve", by: "critic" } } } as never, at: 2 });
    let n = 0;
    const settle = (taskId: string, state: string) => { const id = `att_${++n}`; createAttempt(db, { id, runId: "run1", taskId }); db.prepare("UPDATE lane_pilot_attempt SET state=? WHERE id=?").run(state, id); };
    const drive = async () => { await phases.drive(getPhase(db, opened.id)!); };

    await drive();
    expect(sent).toEqual(["a", "e"]);
    settle("e", "accepted");
    await drive();
    expect(sent).toEqual(["a", "e"]);
    settle("a", "accepted");
    await drive();
    expect(sent).toEqual(["a", "e", "b", "c"]);
    // C breaks, B is accepted: D waits for C (and so does F behind it); G needs only B and goes — wave 2 is not a barrier.
    settle("b", "accepted");
    settle("c", "blocked");
    await drive();
    expect(sent).toEqual(["a", "e", "b", "c", "g"]);
    // C is redone and accepted: D goes, and only then F.
    settle("c", "accepted");
    await drive();
    expect(sent).toEqual(["a", "e", "b", "c", "g", "d"]);
    settle("d", "accepted");
    await drive();
    expect(sent).toEqual(["a", "e", "b", "c", "g", "d", "f"]);
  });
});
