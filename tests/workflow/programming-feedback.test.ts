import { describe, expect, it } from "vitest";
import { runSim } from "./chain-harness";

/**
 * Rework edges must carry the producer's findings to the revisited step: a same-session loop-back continues the target's own
 * thread, so without an explicit `with` mapping the critic's output never reaches it (native580 audit).
 */

const FINDING = (id: string) => ({ id, severity: "high", description: `${id} detail` });

const LIFECYCLE_STUBS = {
  "lp.analyze": { status: "done" },
  "lp.plan": { status: "ok", has_ui: true, tasks: [{ id: "t1", objective: "t1" }], waves: [["t1"]] },
  "lp.build": { status: "done", merged_commits: ["c1"] },
  "lp.close": { status: "closed", report_path: "close.md" },
};

describe("full-lifecycle replan feedback", () => {
  it("qa rework delivers qa.findings to replan gaps, not the passed review's findings", async () => {
    const reviewFinding = FINDING("review-pass-note");
    const qaFinding = FINDING("qa-rework-finding");
    const r = await runSim("full-lifecycle", {
      mode: "full",
      input: { goal: "g" },
      stubs: {
        ...LIFECYCLE_STUBS,
        contract: {},
        "lp.review": { status: "pass", findings: [reviewFinding] },
        qa: [
          { status: "rework", findings: [qaFinding] },
          { status: "pass", findings: [] },
        ],
      },
      humans: { uat: { answer_kind: "ok" } },
    });
    expect(r.summary.status).toBe("succeeded");
    const replans = r.called("replan");
    expect(replans).toHaveLength(1);
    expect(replans[0]!.input.mode).toBe("gaps");
    expect(replans[0]!.input.gaps).toEqual([qaFinding]);
    expect(replans[0]!.input.gaps).not.toEqual([reviewFinding]);
  });

  it("uat issues deliver uat.issues to replan gaps", async () => {
    const uatIssue = FINDING("uat-owner-issue");
    const r = await runSim("full-lifecycle", {
      mode: "full",
      input: { goal: "g" },
      stubs: {
        ...LIFECYCLE_STUBS,
        contract: {},
        "lp.review": { status: "pass", findings: [] },
        qa: { status: "pass", findings: [] },
      },
      humans: {
        uat: [
          { answer_kind: "issues", issues: [uatIssue], blocker_count: 1 },
          { answer_kind: "ok" },
        ],
      },
    });
    expect(r.summary.status).toBe("succeeded");
    const replans = r.called("replan");
    expect(replans).toHaveLength(1);
    expect(replans[0]!.input.gaps).toEqual([uatIssue]);
  });

  it("review rework still delivers review.findings to replan gaps", async () => {
    const reviewFinding = FINDING("review-rework-finding");
    const r = await runSim("full-lifecycle", {
      mode: "full",
      input: { goal: "g" },
      stubs: {
        ...LIFECYCLE_STUBS,
        contract: {},
        "lp.review": [
          { status: "rework", findings: [reviewFinding] },
          { status: "pass", findings: [] },
        ],
        qa: { status: "pass", findings: [] },
      },
      humans: { uat: { answer_kind: "ok" } },
    });
    expect(r.summary.status).toBe("succeeded");
    const replans = r.called("replan");
    expect(replans).toHaveLength(1);
    expect(replans[0]!.input.gaps).toEqual([reviewFinding]);
  });
});

describe("debug ask_more feedback", () => {
  it("a provided human answer reaches the revisited investigate step", async () => {
    const answer = "the price cache key ignores the locale — check the i18n middleware";
    const confirmed = { status: "confirmed", confidence: 80, pressure_pass: true, contradictions: 0, affected_files: ["src/price.ts"] };
    const r = await runSim("debug", {
      input: { symptom: "checkout total is wrong" },
      stubs: {
        investigate: [
          { status: "inconclusive", refuted: 5 },
          confirmed,
        ],
      },
      humans: { ask_more: { answer_kind: "provide", answer } },
    });
    expect(r.summary.status).toBe("succeeded");
    const investigates = r.called("investigate");
    // verify_cause is full-mode only: skipped here, its skip_out.confirmed routes to `confirmed`, so the loop ends at two.
    expect(investigates).toHaveLength(2);
    expect(investigates[1]!.input.answer).toBe(answer);
  });
});

describe("roadmap-driven rework feedback", () => {
  const roadmap = {
    sessions: [{ id: "s1", intent: "session one", scope: "s", goals: [] }],
    mode: "single",
    session_count: 1,
    requirement_map: {},
  };
  const tail = {
    probe: { has_passport: true, open_tasks: 0, plan_exists: true, has_ui: false },
    "lp.analyze": { status: "done" },
    "analyze-plan-execute": { status: "done", merged_commits: ["c1"] },
    "lp.close": { status: "closed", report_path: "close.md" },
  };

  it("validator errors and cycles reach the revisited roadmap step", async () => {
    const errors = ["sessions[0].depends_on references missing id 's9'"];
    const cycles = ["s1->s2->s1"];
    const r = await runSim("roadmap-driven", {
      input: { goal: "g", requirements: "r" },
      stubs: {
        ...tail,
        roadmap,
        validate: [
          { ok: false, errors, cycles },
          { ok: true, errors: [], cycles: [] },
        ],
      },
      humans: { approve: { answer_kind: "approve" } },
    });
    expect(r.summary.status).toBe("succeeded");
    const roadmaps = r.called("roadmap");
    expect(roadmaps).toHaveLength(2);
    expect(roadmaps[1]!.input.errors).toEqual(errors);
    expect(roadmaps[1]!.input.cycles).toEqual(cycles);
  });

  it("the owner's modify answer reaches the revisited roadmap step", async () => {
    const modify = "merge s1 and s2, drop the reporting session";
    const r = await runSim("roadmap-driven", {
      input: { goal: "g", requirements: "r" },
      stubs: {
        ...tail,
        roadmap,
        validate: { ok: true, errors: [], cycles: [] },
      },
      humans: {
        approve: [
          { answer_kind: "modify", answer: modify },
          { answer_kind: "approve" },
        ],
      },
    });
    expect(r.summary.status).toBe("succeeded");
    const roadmaps = r.called("roadmap");
    expect(roadmaps).toHaveLength(2);
    expect(roadmaps[1]!.input.answer).toBe(modify);
  });
});
