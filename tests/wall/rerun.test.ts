import { describe, expect, it } from "vitest";
import { JUDGE_STAGES, RESTARTABLE_STAGES, STAGE_HEAD_DEPS, STAGE_IDS, STAGE_INPUTS, TASK_STAGE_ORDER, affectedFrom, type ReceiptSummary } from "@lane-pilot/contracts";
import { executable, failedStageOf, headPartsOf, planClassRerun, recordRerun } from "../../src/rooms/wall/rerun";
import { wallSignature } from "../../src/rooms/wall/signature";
import { NOW, freshDb } from "./helpers";

const passed = (...stages: string[]): ReceiptSummary[] => stages.map((stage) => ({ stage, state: "passed", inputSha256: `${stage}-in` }));

describe("the registries are exhaustive", () => {
  it("every stage declares what it reads and which part of the head it depends on", () => {
    for (const stage of STAGE_IDS) {
      expect(STAGE_INPUTS[stage], stage).toBeDefined();
      expect(STAGE_HEAD_DEPS[stage], stage).toBeDefined();
    }
    for (const stage of TASK_STAGE_ORDER) expect(STAGE_INPUTS[stage].length, stage).toBeGreaterThan(0);
    expect(JUDGE_STAGES.every((stage) => (TASK_STAGE_ORDER as readonly string[]).includes(stage))).toBe(true);
  });
});

describe("which stages run again (affectedFrom)", () => {
  const all = passed(...TASK_STAGE_ORDER);

  it("nothing changed and nothing failed: every receipt is kept", () => {
    expect(affectedFrom({ receipts: all })).toMatchObject({ from: null, mode: "none", stale: [] });
  });

  it("a failure at verification re-runs from there and keeps the writer's candidate (the judging stages only)", () => {
    const receipts = [...passed("pm-read", "plan-critique", "specialist-review", "writer-agent"), { stage: "verification", state: "failed", inputSha256: "v" }];
    const result = affectedFrom({ receipts, failedStage: failedStageOf(receipts) });
    expect(result.from).toBe("verification");
    expect(result.reused).toEqual(["pm-read", "plan-critique", "specialist-review", "writer-agent"]);
    expect(result.stale.map((row) => row.stage)).toEqual(["verification", "code-critique", "plan-fact", "acceptance-receipt"]);
    expect(result.mode).toBe("rejudge");
  });

  it("the head changes where it matters: a gate change re-judges only; a plan critic change restarts from stage 2 and skips none after it", () => {
    const gates = affectedFrom({ receipts: all, headParts: ["gates"] });
    expect(gates.from).toBe("verification");
    expect(gates.mode).toBe("rejudge");
    const critic = affectedFrom({ receipts: all, headParts: ["plan_critic"] });
    expect(critic.from).toBe("plan-critique");
    expect(critic.reused).toEqual(["pm-read"]);
    expect(critic.mode).toBe("rerun");
    expect(critic.stale.find((row) => row.stage === "plan-critique")!.why).toMatch(/plan_critic/);
    expect(affectedFrom({ receipts: all, headParts: ["code_critic"] }).from).toBe("code-critique");
  });

  it("a changed input key or hash makes only the stages that read it stale", () => {
    expect(affectedFrom({ receipts: all, changedInputs: ["contract.read_first"] }).from).toBe("pm-read");
    expect(affectedFrom({ receipts: all, changedInputs: ["contract.verification"] }).from).toBe("plan-critique");
    expect(affectedFrom({ receipts: all, changedInputs: ["candidate_diff"] }).from).toBe("verification");
    const byHash = affectedFrom({ receipts: all, currentInputSha: { "specialist-review": "different" } });
    expect(byHash.from).toBe("specialist-review");
    expect(byHash.stale[0]!.why).toBe("its input hash changed");
  });

  it("a stage with no passed receipt is stale however early it is", () => {
    const result = affectedFrom({ receipts: [{ stage: "pm-read", state: "blocked", inputSha256: "x" }, ...passed("plan-critique")] });
    expect(result.from).toBe("pm-read");
    expect(result.reused).toEqual([]);
  });
});

describe("the head of a change", () => {
  it("comes from the files and settings the policy descriptor already names", () => {
    expect(headPartsOf({ files: ["src/rooms/critique/code-critique.ts"] })).toEqual(["code_critic"]);
    expect(headPartsOf({ files: ["src/rooms/verification/gate-output.ts", "src/rooms/writer/server/start.ts"] }).sort()).toEqual(["gates", "stage_prompts"]);
    expect(headPartsOf({ settings: ["plan_critique.enabled", "critic.code.default_for_risk"] }).sort()).toEqual(["code_critic", "plan_critic"]);
    expect(headPartsOf({ files: ["docs/x.md"] })).toEqual([]);
  });
});

describe("re-running the failed attempts of a class", () => {
  function seeded() {
    const h = freshDb();
    const reason = "internal_error: another writer integration holds the base checkout lpattempt_aaa";
    const failing = (id: string, task: string, run: string, at: number) => h.attempt("blocked", reason, at, { id, task, run });
    failing("a1", "t1", "run_real", NOW - 3600_000);
    h.receipt("t1", "pm-read", "passed"); h.receipt("t1", "plan-critique", "passed"); h.receipt("t1", "specialist-review", "passed");
    h.receipt("t1", "writer-agent", "failed");
    failing("a2", "t2", "run_sand", NOW - 3000_000);
    h.receipt("t2", "pm-read", "passed", "i", "run_sand"); h.receipt("t2", "plan-critique", "failed", "i", "run_sand");
    failing("a3", "t3", "run_real", NOW - 2000_000);
    h.attempt("accepted", null, NOW - 1000_000, { id: "a3b", task: "t3", run: "run_real" });   // t3 was accepted later: done
    h.attempt("blocked", "something else entirely", NOW - 500_000, { id: "a4", task: "t4" });
    return { ...h, classKey: wallSignature("blocked", reason).classKey };
  }

  it("plans each task's earliest affected stage, skips the ones accepted later and other classes", () => {
    const { db, classKey } = seeded();
    const plans = planClassRerun(db, { classKey, since: NOW - 86_400_000, head: [], scopeOf: (project) => (project === "proj_sand" ? "sandbox" : "real") });
    expect(plans.map((plan) => plan.taskId).sort()).toEqual(["t1", "t2"]);
    const t1 = plans.find((plan) => plan.taskId === "t1")!;
    expect(t1.failedStage).toBe("writer-agent");
    expect(t1.affected.from).toBe("writer-agent");
    expect(t1.affected.reused).toEqual(["pm-read", "plan-critique", "specialist-review"]);
    const t2 = plans.find((plan) => plan.taskId === "t2")!;
    expect(t2.affected.from).toBe("plan-critique");
  });

  it("runs only what Lane Pilot restarts in place, and never a real project when sandbox-only", () => {
    const { db, classKey } = seeded();
    const plans = planClassRerun(db, { classKey, since: NOW - 86_400_000, head: [], scopeOf: (project) => (project === "proj_sand" ? "sandbox" : "real") });
    const [t1, t2] = [plans.find((p) => p.taskId === "t1")!, plans.find((p) => p.taskId === "t2")!];
    expect(executable(t1, true)).toBe(false);          // real project
    expect(executable(t1, false)).toBe(true);          // writer stage, real allowed by the setting
    expect(executable({ ...t1, scope: "sandbox" }, true)).toBe(true);
    expect(executable(t2, true)).toBe(false);          // plan-critique needs return-to-stage
    expect((RESTARTABLE_STAGES as readonly string[]).includes("plan-critique")).toBe(false);
    expect(recordRerun(db, t1, "listed", "a real project", NOW)).toBe(true);
    expect((db.prepare("SELECT state, from_stage, reused_json FROM lane_pilot_wall_rerun").get() as { state: string; from_stage: string; reused_json: string })).toMatchObject({ state: "listed", from_stage: "writer-agent" });
  });
});
