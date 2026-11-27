import { EVOLVE_THRESHOLDS } from "@lane-pilot/contracts";
import { describe, expect, it } from "vitest";
import {
  OUTPUT_DEFECT_KINDS,
  plantOutputDefect,
  scoreVerifier,
  type OutputVerifierCase,
} from "../../src/rooms/checkers";
import { CRITIC_BAR } from "../../src/rooms/checkers/models/score";
import {
  compareArms,
  computeNoise,
  costPerAccepted,
  pairedBootstrapInterval,
  summarizeArm,
  type BenchResult,
  type NoiseRecord,
} from "../../src/rooms/evolve";

function makeRow(
  taskId: string,
  accepted: boolean,
  overrides: Partial<BenchResult> = {},
): BenchResult {
  return {
    taskId,
    state: accepted ? "accepted" : "not_accepted",
    accepted,
    stagesPassed: accepted ? 2 : 1,
    stagesFailed: accepted ? 0 : 1,
    tokens: 100,
    costUsd: 0.1,
    costState: "measured",
    seconds: 20,
    ...overrides,
  };
}

function makeNoise(partial: Partial<NoiseRecord["noise"]>): NoiseRecord {
  return {
    armA: "ctrl-1",
    armB: "ctrl-2",
    noise: {
      unstableTasks: [],
      flipShare: 0,
      costRel: 0.05,
      secondsRel: 0.05,
      stagesSlack: 0,
      tasks: 10,
      ...partial,
    },
  };
}

describe("Task 28: evolve comparison rules and output mutators", () => {
  it("allows writer mismatches for model arms and uses pairedBootstrapInterval when options are passed", () => {
    const tasks = Array.from({ length: 10 }, (_, idx) => `t${idx}`);
    const armA = summarizeArm("sonnet", [tasks.map((id) => makeRow(id, true, { costUsd: 0.2 }))]);
    armA.writer = { providerId: "anthropic", model: "claude-sonnet-5-5" };
    const armB = summarizeArm("haiku", [tasks.map((id) => makeRow(id, true, { costUsd: 0.05 }))]);
    armB.writer = { providerId: "anthropic", model: "claude-haiku-5-5" };

    const blocked = compareArms(armA, armB);
    expect(blocked.verdict).toBe("inconclusive");
    expect(blocked.checks.some((check) => check.name === "writer" && check.ok === null)).toBe(true);

    const compared = compareArms(armA, armB, null, { allowWriterMismatch: true });
    expect(compared.verdict).toBe("pass");
    expect(compared.checks.some((check) => check.name === "writer")).toBe(false);
    expect(compared.nonInferior).toBe(true);
    expect(compared.gain).toBe("cost");

    // Verify pairedBootstrapInterval is used when options are supplied.
    const aPass = Array.from({ length: 12 }, (_, idx) => makeRow(`t${idx}`, idx < 10));
    const bPass = Array.from({ length: 12 }, (_, idx) => makeRow(`t${idx}`, idx < 9));
    const sumA = summarizeArm("A", [aPass]);
    const sumB = summarizeArm("B", [bPass]);
    const withOptions = compareArms(sumA, sumB, null, { allowWriterMismatch: true });
    const boot = pairedBootstrapInterval(
      aPass.map((r) => r.accepted),
      bPass.map((r) => r.accepted),
    );
    expect(withOptions.passCi.diff).toEqual({ low: boot.low, high: boot.high });
    expect(withOptions.nonInferior).toBe(boot.low >= EVOLVE_THRESHOLDS.nonInferiority - 1e-12);
  });

  it("fails noRegressionByClass on a per-class drop while aggregate passes look equal, and excludes unstable tasks", () => {
    const classOf = (id: string) => (id.startsWith("rush_") ? "rush" : "standard");
    const baseRows = [
      makeRow("rush_1", true),
      makeRow("rush_2", true),
      makeRow("std_1", false),
      makeRow("std_2", true),
    ];
    const candRows = [
      makeRow("rush_1", false),
      makeRow("rush_2", true),
      makeRow("std_1", true),
      makeRow("std_2", true),
    ];

    const a = summarizeArm("base", [baseRows]);
    const b = summarizeArm("cand", [candRows]);
    // Aggregate passed count is 3 vs 3, yet rush_1 regressed in class "rush".
    expect(a.tasks.get("rush_1")?.passed).toBe(true);
    const res = compareArms(a, b, null, { allowWriterMismatch: true, classOf });
    expect(res.passed).toEqual({ a: 3, b: 3 });
    expect(res.noRegressionByClass).toBe(false);

    // When rush_1 is marked unstable by baseline noise calibration, it does not fail noRegressionByClass.
    const controlTwo = summarizeArm("base-ctrl", [
      baseRows.map((r) => (r.taskId === "rush_1" ? makeRow("rush_1", false) : r)),
    ]);
    const noise: NoiseRecord = { armA: "base", armB: "base-ctrl", noise: computeNoise(a, controlTwo) };
    expect(noise.noise.unstableTasks).toContain("rush_1");
    const withNoise = compareArms(a, b, noise, { allowWriterMismatch: true, classOf });
    expect(withNoise.noRegressionByClass).toBe(true);

    // A drop from 3/3 to 2/3 repeats on a stable baseline case also fails noRegressionByClass.
    const r1 = [makeRow("rush_1", true), makeRow("std_1", true), makeRow("std_2", true)];
    const a3 = summarizeArm("base3", [r1, r1, r1]);
    const b3 = summarizeArm("cand3", [
      r1,
      r1,
      [makeRow("rush_1", false), makeRow("std_1", true), makeRow("std_2", true)],
    ]);
    const res3 = compareArms(a3, b3, null, { allowWriterMismatch: true, classOf });
    expect(res3.noRegressionByClass).toBe(false);
  });

  it("computes gain as cost, time, none, or unknown (never coercing not_measured to 0)", () => {
    const ids = ["t1", "t2", "t3", "t4"];
    const base = summarizeArm("base", [ids.map((id) => makeRow(id, true, { costUsd: 0.2, seconds: 20 }))]);
    const cheaper = summarizeArm("cheaper", [ids.map((id) => makeRow(id, true, { costUsd: 0.1, seconds: 20 }))]);
    const faster = summarizeArm("faster", [ids.map((id) => makeRow(id, true, { costUsd: 0.2, seconds: 10 }))]);
    const same = summarizeArm("same", [ids.map((id) => makeRow(id, true, { costUsd: 0.2, seconds: 20 }))]);
    const withinNoise = summarizeArm("withinNoise", [ids.map((id) => makeRow(id, true, { costUsd: 0.195, seconds: 19.5 }))]);
    const unmeasured = summarizeArm("unmeasured", [
      ids.map((id, idx) =>
        idx === 0
          ? makeRow(id, true, { costUsd: null, costState: "not_measured", tokens: null, seconds: 20 })
          : makeRow(id, true, { costUsd: 0.05, seconds: 20 }),
      ),
    ]);

    const noise = makeNoise({ costRel: 0.05, secondsRel: 0.05 });

    expect(costPerAccepted(base)).toBeCloseTo(0.2, 6);
    expect(costPerAccepted(cheaper)).toBeCloseTo(0.1, 6);
    expect(costPerAccepted(unmeasured)).toBeNull();

    expect(compareArms(base, cheaper, noise, { allowWriterMismatch: true }).gain).toBe("cost");
    expect(compareArms(base, faster, noise, { allowWriterMismatch: true }).gain).toBe("time");
    expect(compareArms(base, same, noise, { allowWriterMismatch: true }).gain).toBe("none");
    expect(compareArms(base, withinNoise, noise, { allowWriterMismatch: true }).gain).toBe("none");
    expect(compareArms(base, unmeasured, noise, { allowWriterMismatch: true }).gain).toBe("unknown");
  });

  it("computes passK across k >= 3 repeats with one flaky case", () => {
    const rep1 = [makeRow("t1", true), makeRow("t2", true), makeRow("t3", true), makeRow("t4", true)];
    const rep2 = [makeRow("t1", true), makeRow("t2", true), makeRow("t3", true), makeRow("t4", false)];
    const rep3 = [makeRow("t1", true), makeRow("t2", true), makeRow("t3", true), makeRow("t4", true)];

    const base = summarizeArm("base", [rep1, rep1, rep1]);
    const cand = summarizeArm("cand", [rep1, rep2, rep3]);
    const cmp = compareArms(base, cand, null, { allowWriterMismatch: true });

    expect(cmp.passK.a).toBe(1);
    expect(cmp.passK.b).toBe(0.75);
  });

  it("plants structured workflow output defects and scores a verifier catching 9/10 at 0.9", () => {
    expect(CRITIC_BAR).toBe(0.6);

    const sample = {
      status: "sent",
      amount: 1500,
      tax: 300,
      file_path: "/tmp/invoice.pdf",
      recipient: "alice@example.invalid",
    };

    for (const kind of OUTPUT_DEFECT_KINDS) {
      const mutated = plantOutputDefect(sample, kind);
      expect(mutated, `mutator ${kind} should apply`).not.toBeNull();
      expect(mutated).not.toEqual(sample);
    }
    // Input must remain untouched.
    expect(sample.amount).toBe(1500);
    expect(sample.file_path).toBe("/tmp/invoice.pdf");

    expect(plantOutputDefect({ status: "done" }, "swap_number")).toBeNull();
    expect(plantOutputDefect({ status: "done" }, "empty_artifact")).toBeNull();
    expect(plantOutputDefect({ status: "done" }, "claim_done_without_artifact")).toBeNull();

    // 10 clean cases, each targeted with drop_required_field => 10 planted defects.
    // A verifier that misses only case id 10 catches 9/10 => 0.9, passing EVOLVE_THRESHOLDS.checkerCatch.
    const tenCases: OutputVerifierCase[] = Array.from({ length: 10 }, (_, idx) => ({
      output: {
        id: idx + 1,
        status: "done",
        amount: 100 + idx,
        artifact_path: `/tmp/doc-${idx + 1}.pdf`,
      },
      kinds: ["drop_required_field"],
    }));

    const nineOfTen = (out: Record<string, unknown>) => {
      if (out.id === 10 && out.amount === undefined) return true; // intentional miss on 1/10
      return (
        typeof out.id === "number" &&
        out.status === "done" &&
        typeof out.amount === "number" &&
        typeof out.artifact_path === "string" &&
        out.artifact_path.length > 0
      );
    };

    const score90 = scoreVerifier(nineOfTen, tenCases, { requiredFields: ["amount"] });
    expect(score90.planted).toBe(10);
    expect(score90.caught).toBe(9);
    expect(score90.catchRate).toBe(0.9);
    expect(score90.falseAlarms).toBe(0);
    expect(score90.falseAlarmRate).toBe(0);
    expect(score90.bar).toBe(EVOLVE_THRESHOLDS.checkerCatch);
    expect(score90.passed).toBe(true);

    const eightOfTen = (out: Record<string, unknown>) => {
      if ((out.id === 9 || out.id === 10) && out.amount === undefined) return true;
      return nineOfTen(out);
    };
    const score80 = scoreVerifier(eightOfTen, tenCases, { requiredFields: ["amount"] });
    expect(score80.catchRate).toBe(0.8);
    expect(score80.passed).toBe(false);
  });
});
