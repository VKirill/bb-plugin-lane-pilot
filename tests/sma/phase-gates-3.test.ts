import { describe, expect, it } from "vitest";
import {
  blindVerdict, designDecision, designGate, issuable, nextAction, wavesOf,
  type Phase, type PhaseRecord, type PlanItem, type TaskFact,
} from "../../src/rooms/phase/logic";

const piece = (id: string, wave: number, owns: string[]): PlanItem => ({
  id, title: id, wave, promise: { given: "g", when: "w", then: "t" },
  task: { id, owns_paths: owns, verification: [{ command: "npm test" }], acceptance: ["works"] },
});

const phase = (stage: Phase["stage"], record: PhaseRecord, state: Phase["state"] = "active"): Phase => ({
  id: "ph_1", projectId: "p", pmThreadId: "t", runId: "r", title: "Sums", goal: "sums are right",
  stage, state, record, edition: 1, createdAt: 0, updatedAt: 0,
});

const fact = (id: string, extra: Partial<TaskFact> = {}): TaskFact => ({
  taskId: id, state: "accepted", planFact: "passed", verification: "passed", codeCritique: "passed", ...extra,
});

describe("phase gates", () => {
  it("[sma:p3_needed] asks for a drawing only when a piece changes a screen", () => {
    expect(designDecision([piece("a", 1, ["src/a.ts"])])).toMatchObject({ decision: "not_needed" });
    const needed = designDecision([piece("ui", 1, ["src/App.tsx"])]);
    expect(needed.decision).toBe("needed");
    expect(needed.why).toContain("ui");
  });

  it("[sma:p3_feas_state] holds the drawing until feasibility is answered", () => {
    const drawing = { paths: [".agents/phases/ph_1/design/UI-SPEC.md"], sha256: "d", designer: "design-lead" };
    const waiting = designGate({ design: { decision: "needed", why: "screens", drawing } });
    expect(waiting.ok).toBe(false);
    if (!waiting.ok) expect(waiting.why.join(" ")).toContain("no feasibility answer");
  });

  it("[sma:p3_start] [sma:p3_task] tells the control work to have design-lead draw, and does not issue", () => {
    const action = nextAction(phase("design", { design: { decision: "needed", why: "screens" } }), new Map());
    expect(action.text).toContain("stage 3, design");
    expect(action.text).toContain("Have design-lead draw the screens");
    expect(action.waitsForPm).toBe(true);
  });

  it("[sma:p4_wave_addr] issues the earliest wave first, whatever order the pieces were written", () => {
    const items = [piece("later", 2, ["src/b.ts"]), piece("now", 0, ["src/a.ts"])];
    expect(wavesOf(items)).toEqual([0, 2]);
    expect(issuable(items, {}, new Map()).map((item) => item.id)).toEqual(["now"]);
    const held = issuable(items, { now: "task-now" }, new Map([["now", fact("task-now", { state: "running" })]]));
    expect(held).toEqual([]);
  });

  it("[sma:p5_blind_frozen] freezes the verdict on the facts, so the clock does not make a new one", () => {
    const items = [piece("a", 1, ["src/a.ts"])];
    const facts = new Map([["a", fact("a")]]);
    const goal = { state: "passed", headSha: "abc" };
    const first = blindVerdict(items, facts, goal, 1);
    const later = blindVerdict(items, facts, goal, 9_000);
    expect(first.state).not.toBe("pending");
    expect(later.inputSha).toBe(first.inputSha);
    expect(later.at).not.toBe(first.at);
    const claimed = blindVerdict(items, new Map([["a", fact("a", { planFact: "failed" })]]), goal, 1);
    expect(claimed.state).toBe("failed");
    expect(claimed.detail).toContain("plan-fact failed");
    expect(claimed.inputSha).not.toBe(first.inputSha);
  });

  it("[sma:px_paused] stands a paused phase until resume, and does not ask the PM to issue", () => {
    const action = nextAction(phase("execution", {}, "paused"), new Map());
    expect(action.waitsForPm).toBe(false);
    expect(action.text).toContain("is paused");
    expect(action.text).toContain("resume");
    expect(action.text).not.toContain("issues the next wave");
  });

  it.todo("[sma:k_lib_landing] accepting a merge runs the suite and stamps the badge — createMergeIntentRecovery only reconciles a merge that already landed"); // deferral:dfr_seed_skip_sma_gaps
});
